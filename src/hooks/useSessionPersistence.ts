/**
 * 会话持久化（仅 Tauri 桌面）：多窗口版。
 * - 快照按窗口隔离（lib/sessionWindows）：主窗口沿用旧键，子窗口写 heid-session:<label>；
 *   manifest 登记窗口列表，主窗口启动并完成自身恢复后，按清单拉起其余窗口
 *   （载荷 = 各窗口快照，子窗口经 useWindowBootstrap 拿到后走同一恢复例程）；
 * - 恢复例程在 lib/sessionRestore：file 条目并行重读磁盘，virtual 确定性重建；
 * - 恢复尝试完成前不写入快照，避免启动瞬间把上次会话覆盖为空；
 *   hadSession 供主区域显示「恢复中」占位（而非 welcome.ts 假标签）；
 * - 「退出并保存」在销毁窗口前也显式调用 writeSessionSnapshot 一次，
 *   避免状态更新对应的 effect 尚未执行、窗口已被销毁。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { SessionState } from '../lib/session';
import {
  clearSessionForLabel, loadSessionForLabel, readManifest, registerWindowInManifest,
  safeLocalStorage, saveSessionForLabel, unregisterWindowFromManifest,
} from '../lib/sessionWindows';
import { restoreSessionTabs } from '../lib/sessionRestore';
import { isTauri } from '../lib/fileIO';
import { createDocumentWindow } from '../lib/windows';
import { IS_ANDROID_APP } from '../lib/platform';
import { INITIAL_WELCOME_ID, RELEASE_NOTES_TAB_ID, type FileTab } from '../lib/tabModel';

export interface SessionPersistenceOptions {
  /** 本窗口 label（main / win-N）：决定快照键与多窗口拉起职责 */
  windowLabel: string;
  /** 启动快照：主窗口 = localStorage 同步读取；子窗口 = bootstrap 载荷携带 */
  startupSession: SessionState | null;
  /** 启动快照是否就绪（子窗口等 bootstrap IPC；主窗口/浏览器恒真） */
  startupReady: boolean;
  tabsRef: RefObject<FileTab[]>;
  activeTabIdRef: RefObject<string>;
  setTabs: React.Dispatch<React.SetStateAction<FileTab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string>>;
}

export function useSessionPersistence({
  windowLabel, startupSession, startupReady, tabsRef, activeTabIdRef, setTabs, setActiveTabId,
}: SessionPersistenceOptions) {
  const canMultiWindow = isTauri && !IS_ANDROID_APP;
  /* 恢复尝试完成前不写入会话快照，避免启动瞬间把上次会话覆盖为空。
     hydrated 状态供「依赖会话就绪」的启动逻辑（如更新说明标签自动打开）按序执行 */
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(!isTauri);
  const markHydrated = useCallback(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      setHydrated(true);
    }
  }, []);

  const hadSession = !!startupSession && startupSession.tabs.length > 0;

  useEffect(() => {
    if (!isTauri) return;
    if (!startupReady) return;
    const session = startupSession;
    if (!session || session.tabs.length === 0) {
      markHydrated();
      return;
    }
    let disposed = false;
    (async () => {
      const result = await restoreSessionTabs(session);
      if (disposed) return;
      if (!result) {
        // 全部失效：清掉快照，保留初始 welcome 标签
        const storage = safeLocalStorage();
        if (storage) {
          if (windowLabel === 'main') unregisterWindowFromManifest(storage, 'main');
          clearSessionForLabel(storage, windowLabel);
        }
        markHydrated();
        return;
      }
      setTabs(prev => {
        // 快照完整描述上次会话：移除未被编辑过的初始 welcome 标签（若快照含 welcome 会随之重建）；
        // 恢复期间用户新建/编辑过的标签保留
        const kept = prev.filter(t => !(t.id === INITIAL_WELCOME_ID && !t.isDirty));
        return [...kept, ...result.tabs];
      });
      setActiveTabId(result.activeId);
      markHydrated();
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupReady]);

  /* 恢复完成：向 manifest 登记本窗口（顺序即窗口序），主窗口继续拉起清单里其余窗口 */
  useEffect(() => {
    if (!canMultiWindow || !hydrated) return;
    const storage = safeLocalStorage();
    if (!storage) return;
    registerWindowInManifest(storage, windowLabel);
    if (windowLabel !== 'main') return;
    /* 顺序创建（create 命令取最小空闲 label，并发可能撞号）：失效条目（快照缺失/为空）
       顺手从清单剔除——窗口已不存在，其标签不应复活 */
    void (async () => {
      for (const label of readManifest(storage)) {
        if (label === 'main') continue;
        const state = loadSessionForLabel(storage, label);
        if (!state || state.tabs.length === 0) {
          unregisterWindowFromManifest(storage, label);
          continue;
        }
        await createDocumentWindow('main', { kind: 'session', state });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMultiWindow, hydrated, windowLabel]);

  /* ---- 会话快照：跟随标签页变化持续写入（按窗口隔离键） ----
     file 标签存路径；无路径标签仅在未编辑时存为 virtual（内容可确定性重建）；
     脏的无路径标签不持久化——其存亡由退出确认决定，用户确认放弃后不应「复活」；
     更新说明标签（固定 id）是瞬态只读文档，virtual 重建不出内容，同样不进快照。 */
  const writeSessionSnapshot = useCallback(() => {
    if (!isTauri || !hydratedRef.current) return;
    const active = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    saveSessionForLabel(safeLocalStorage(), windowLabel, {
      tabs: tabsRef.current.flatMap((t): SessionState['tabs'] => {
        if (t.id === RELEASE_NOTES_TAB_ID) return [];
        if (t.path) return [{ kind: 'file' as const, path: t.path, mdView: t.mdView }];
        /* 脏的无路径标签：内容在草稿（lib/drafts），快照只记 draft 标志；
           用户确认「不保存」退出时草稿与快照条目一并清除（见 confirmWindowClose / closeTab） */
        return [{ kind: 'virtual' as const, title: t.title, draft: !t.readOnly || undefined, mdView: t.mdView }];
      }),
      activePath: active?.path ?? null,
      activeVirtualTitle: active && !active.path ? active.title : null,
    });
  }, [activeTabIdRef, tabsRef, windowLabel]);

  return { writeSessionSnapshot, hydratedRef, hydrated, hadSession };
}
