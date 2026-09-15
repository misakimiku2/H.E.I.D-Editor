/**
 * 平台适配 effects（桌面 Tauri / 安卓 WebView / 浏览器三端差异全部收敛在此）：
 * - 拖拽文件入窗口打开（Tauri drag-drop 事件）
 * - 渲染内容 <a> 导航守卫（http(s) 交系统浏览器，其余拦截）
 * - 窗口关闭统一拦截（自定义按钮 / Alt+F4 / 任务栏关闭都走未保存确认）
 * - 安卓系统返回键逐层关闭弹层 + 安全区 insets 注入
 * - 浏览器模式的 beforeunload 兜底
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_ANDROID_APP } from '../lib/platform';
import { openExternal } from '../lib/openExternal';
import { READ_EXTENSIONS, isTauri } from '../lib/fileIO';
import type { PendingDiscardConfirm } from './useDiscardConfirm';

/** 安卓返回键可见的弹层快照（App 层每次渲染回填） */
export interface OverlayState {
  tabSheetOpen: boolean;
  menuOpen: boolean;
  aboutOpen: boolean;
  pendingDiscard: PendingDiscardConfirm | null;
  findOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  tabMenuOpen: boolean;
  releaseNotesOpen: boolean;
}

export interface OverlayActions {
  cancelDiscard: () => void;
  closeFind: () => void;
  closeSettings: () => void;
  closeShortcuts: () => void;
  closeTabMenu: () => void;
  closeTabSheet: () => void;
  closeMenu: () => void;
  closeAbout: () => void;
  closeReleaseNotes: () => void;
}

export interface PlatformIntegrationOptions {
  openPathIntoTab: (path: string) => Promise<void>;
  tabsRef: RefObject<{ isDirty: boolean }[]>;
  confirmWindowCloseRef: RefObject<() => Promise<boolean>>;
  overlayState: OverlayState;
  overlayActions: OverlayActions;
}

export function usePlatformIntegration({
  openPathIntoTab, tabsRef, confirmWindowCloseRef, overlayState, overlayActions,
}: PlatformIntegrationOptions) {
  /* ---- 文件关联与单实例（桌面）：首实例启动路径经 take_launch_paths 取走；
     二次实例启动由 Rust 侧聚焦窗口并转发 heid-open-paths 事件 ---- */
  useEffect(() => {
    if (!isTauri || IS_ANDROID_APP) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/event'),
        ]);
        const fn = await listen<string[]>('heid-open-paths', (e) => {
          for (const p of e.payload ?? []) void openPathIntoTab(p);
        });
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
        const initial = await invoke<string[]>('take_launch_paths');
        for (const p of initial ?? []) void openPathIntoTab(p);
      } catch (e) {
        console.error('launch-paths 初始化失败:', e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathIntoTab]);

  /* ---- Tauri: drag files onto the window to open them ---- */
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
          const paths = event.payload?.paths || [];
          const exts = new Set(READ_EXTENSIONS);
          paths
            .filter(p => exts.has('.' + (p.split('.').pop()?.toLowerCase() || '')))
            .forEach(p => openPathIntoTab(p));
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (e) {
        console.error('drag-drop listener failed:', e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathIntoTab]);

  /* ---- 全局链接导航守卫：渲染内容里的 <a>（预览正文、导入的来源链接等）不允许让应用 WebView 真实导航 ----
     http(s) 交给系统浏览器打开，其余非锚点协议（javascript: / 相对路径 / 空链接）直接拦截。
     放行两类：# 开头的文档内锚点跳转、带 download / blob: / data: 的下载链接（导出 HTML 走这里）。
     否则点击链接会把整个应用导航成网页，WebView2 的鼠标侧键（历史前进/后退）随之在应用与网页间切换。 */
  useEffect(() => {
    const anchorOf = (target: EventTarget | null): HTMLAnchorElement | null => {
      let el = target as HTMLElement | null;
      while (el && el.tagName !== 'A') el = el.parentElement;
      return el as HTMLAnchorElement | null;
    };
    const guard = (e: MouseEvent) => {
      const a = anchorOf(e.target);
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;
      if (a.hasAttribute('download') || /^(blob:|data:)/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      if (/^https?:\/\//i.test(href)) void openExternal(href);
    };
    document.addEventListener('click', guard, true);
    document.addEventListener('auxclick', guard, true);
    return () => {
      document.removeEventListener('click', guard, true);
      document.removeEventListener('auxclick', guard, true);
    };
  }, []);

  /* ---- 窗口关闭统一拦截（仅 Tauri）----
     Tauri 在存在 close-requested 监听时自动拦截系统关闭并转发事件；
     一律 preventDefault 后自行决定是否 destroy，避免事件处理器未阻止时被立即关闭。 */
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const appWindow = getCurrentWindow();
        const fn = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            const confirmed = await confirmWindowCloseRef.current();
            if (confirmed) await appWindow.destroy();
          } catch (e) {
            // 确认流程出错：宁可关不掉也不静默丢数据
            console.error('窗口关闭确认失败:', e);
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (e) {
        console.error('注册窗口关闭拦截失败:', e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 安卓系统返回键：逐层关闭弹层，最后走与桌面一致的未保存退出确认 ---- */
  const overlayStateRef = useRef<OverlayState>(overlayState);
  overlayStateRef.current = overlayState;
  const overlayActionsRef = useRef(overlayActions);
  overlayActionsRef.current = overlayActions;
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    const onBack = () => {
      const o = overlayStateRef.current;
      const a = overlayActionsRef.current;
      if (o.pendingDiscard) { a.cancelDiscard(); return; }
      if (o.findOpen) { a.closeFind(); return; }
      if (o.settingsOpen) { a.closeSettings(); return; }
      if (o.shortcutsOpen) { a.closeShortcuts(); return; }
      if (o.tabMenuOpen) { a.closeTabMenu(); return; }
      if (o.tabSheetOpen) { a.closeTabSheet(); return; }
      if (o.menuOpen) { a.closeMenu(); return; }
      if (o.releaseNotesOpen) { a.closeReleaseNotes(); return; }
      if (o.aboutOpen) { a.closeAbout(); return; }
      void (async () => {
        if (await confirmWindowCloseRef.current()) {
          /* window.destroy 在 Android 上不可用，走原生桥退出 */
          if (IS_ANDROID_APP) {
            (window as any).HeidBridge?.exitApp?.();
          } else {
            try { await getCurrentWindow().destroy(); } catch (e) { console.error('退出失败:', e); }
          }
        }
      })();
    };
    window.addEventListener('heid-back', onBack);
    return () => window.removeEventListener('heid-back', onBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 安全区：MainActivity 经 heid-insets 桥推送状态栏/手势条高度（css px），
     写入 :root 的 --heid-safe-top/bottom 供 safe-top/safe-bottom 与标题栏内联样式使用；
     WebView 的 env() 不可靠，必须走此桥 ---- */
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    const root = document.documentElement;
    const apply = (top: number, bottom: number) => {
      root.style.setProperty('--heid-safe-top', `${top}px`);
      root.style.setProperty('--heid-safe-bottom', `${bottom}px`);
    };
    const bridge = (window as any).HeidBridge;
    try { apply(bridge?.top?.() ?? 0, bridge?.bottom?.() ?? 0); } catch { /* 桥不可用时等事件 */ }
    const onInsets = (e: Event) => {
      const d = (e as CustomEvent<{ top: number; bottom: number }>).detail;
      if (d) apply(d.top, d.bottom);
    };
    window.addEventListener('heid-insets', onInsets);
    return () => window.removeEventListener('heid-insets', onInsets);
  }, []);

  /* 浏览器模式兜底：有未保存修改时拦截刷新/关闭（浏览器原生离开确认） */
  useEffect(() => {
    if (isTauri) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (tabsRef.current.some(t => t.isDirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [tabsRef]);
}
