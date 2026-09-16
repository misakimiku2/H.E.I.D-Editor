/**
 * 标签条（桌面布局）：渲染 + 原生 HTML5 拖拽（浏览器/记事本式）。
 * 拖起瞬间由系统渲染拖拽图像(setDragImage)——图像跟随全局光标,越出窗口也不消失,
 * 与桌面端直觉一致;松手在标签条外即脱离,拖到其它 H.I.D.E 窗口标签条上即合并
 * (目标窗口直接收到 dragover/drop,由 OS 命中测试,无重叠窗口歧义)。
 * 标签载荷经 Rust 暂存区(tabTransfer 协议)在窗口间传递;插入指示线/悬停高亮
 * 内聚在本组件,重排/脱离/合并真正发生时才经回调上抛。
 * 纯逻辑见 lib/tabDragCore;事件与载荷协议见 lib/tabTransfer。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { insertionIndex, type RectLike } from '../lib/tabDragCore';
import type { FileTab } from '../lib/tabModel';
import { useT } from '../lib/i18nContext';

/** 本应用自定义拖拽 MIME 标记:用于区分「我们的标签拖拽」与外部拖入(文件/文本) */
const HEID_TAB_MIME = 'application/x-heid-tab';

export interface TabBarProps {
  tabs: FileTab[];
  activeTabId: string;
  isDarkMode: boolean;
  /** 脏且存在未处理外部 diff 的标签 id（橙点提示） */
  conflictedIds: Set<string>;
  /** Tauri 桌面：允许拖出脱离 / 跨窗口合并 */
  canDetach: boolean;
  newTabTitle: string;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onContextMenu: (x: number, y: number, tabId: string | null) => void;
  onNewTab: () => void;
  /** 栏内实时重排：dropIndex 为「含被拖标签」坐标的插入点（tabDragCore 语义） */
  onMoveTab: (tabId: string, dropIndex: number) => void;
  /** 原生拖拽开始:注册标签载荷到 Rust 暂存区 */
  onNativeDragStart: (tabId: string) => void;
  /** 原生拖拽结束:handled=拖放发生在本窗口标签条(重排完成);
      未 handled=拖到了别处,由 App 决定脱离(若其它窗口已收下则什么都不做) */
  onNativeDragEnd: (tabId: string, handled: boolean, grab: { grabDx: number; grabDy: number }) => void;
  /** 其它窗口把标签放到了本窗口标签条:收下并激活(App 负责载荷消费与 ack) */
  onAdoptForeignDrop: (insertIndex: number) => void;
}

interface ForeignHover {
  index: number;
  /** 插入指示线在滚动内容坐标系里的 x */
  caretX: number;
}

export function TabBar({
  tabs, activeTabId, isDarkMode, conflictedIds, canDetach, newTabTitle,
  onSelect, onCloseTab, onContextMenu, onNewTab,
  onMoveTab, onNativeDragStart, onNativeDragEnd, onAdoptForeignDrop,
}: TabBarProps) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  /* 本窗口正在进行的原生拖拽(dragstart→dragend 之间有效) */
  const nativeDragRef = useRef<{ tabId: string; grabDx: number; grabDy: number } | null>(null);
  /* 本次原生拖拽是否已在本窗口标签条上完成放置(重排) */
  const ownDropHandledRef = useRef(false);
  const [dragView, setDragView] = useState<{ tabId: string; dropIndex: number; caretX: number | null } | null>(null);
  const [foreign, setForeign] = useState<ForeignHover | null>(null);

  /* 最新的悬停位置/标签数供拖放落点读取:经 ref 中转 */
  const foreignRef = useRef<ForeignHover | null>(null);
  foreignRef.current = foreign;
  const tabsRefLen = useRef(tabs.length);
  tabsRefLen.current = tabs.length;

  const freshRects = (strip: HTMLDivElement) =>
    Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]')).map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });

  /* 指示线 x(滚动内容坐标系:可absolute 子元素随内容横滚) */
  const caretXFromRects = (strip: HTMLDivElement, rects: RectLike[], index: number): number => {
    const stripLeft = strip.getBoundingClientRect().left;
    const base = index < rects.length ? rects[index].left : rects[rects.length - 1]?.right ?? stripLeft;
    return base - stripLeft + strip.scrollLeft;
  };

  /* ---- 原生拖拽:本窗口作为拖拽源 ---- */

  const handleTabDragStart = (e: React.DragEvent<HTMLDivElement>, tabId: string) => {
    if (IS_TOUCH_PRIMARY || !canDetach) { e.preventDefault(); return; }
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const grabDx = e.clientX - rect.left;
    const grabDy = e.clientY - rect.top;
    /* Windows 的 OLE 拖拽需要至少一个数据格式才会真正开始 */
    e.dataTransfer.setData('text/plain', tabs.find(tb => tb.id === tabId)?.title ?? '');
    e.dataTransfer.setData(HEID_TAB_MIME, tabId);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setDragImage(el, Math.max(0, grabDx), Math.max(0, grabDy)); } catch { /* 退回默认图像 */ }
    nativeDragRef.current = { tabId, grabDx, grabDy };
    ownDropHandledRef.current = false;
    setDragView({ tabId, dropIndex: tabs.findIndex(tb => tb.id === tabId), caretX: null });
    onNativeDragStart(tabId);
  };

  const handleTabDragEnd = () => {
    const own = nativeDragRef.current;
    nativeDragRef.current = null;
    setDragView(null);
    if (!own) return;
    const handled = ownDropHandledRef.current;
    ownDropHandledRef.current = false;
    onNativeDragEnd(own.tabId, handled, { grabDx: own.grabDx, grabDy: own.grabDy });
  };

  /* ---- 标签条作为放置目标:自身重排 + 收下其它窗口的标签 ---- */

  const handleStripDragOver = (e: React.DragEvent) => {
    const strip = stripRef.current;
    if (!strip) return;
    if (e.dataTransfer.types.includes('Files')) return; /* 文件拖放交给系统打开通道 */
    const rects = freshRects(strip);
    if (nativeDragRef.current) {
      /* 自家标签:实时重排 + 插入指示 */
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const idx = insertionIndex(rects, e.clientX);
      onMoveTab(nativeDragRef.current.tabId, idx);
      setDragView({ tabId: nativeDragRef.current.tabId, dropIndex: idx, caretX: caretXFromRects(strip, rects, idx) });
      return;
    }
    /* 其它窗口的标签悬停:显示插入指示,允许放置 */
    const index = insertionIndex(rects, e.clientX);
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setForeign({ index, caretX: caretXFromRects(strip, rects, index) });
  };

  const handleStripDragLeave = (e: React.DragEvent) => {
    if (e.relatedTarget && stripRef.current?.contains(e.relatedTarget as Node)) return;
    setForeign(null);
    setDragView(v => (v ? { ...v, caretX: null } : v));
  };

  const handleStripDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) return; /* 文件拖放交给系统打开通道 */
    e.preventDefault();
    if (nativeDragRef.current) {
      ownDropHandledRef.current = true; /* 重排已在 dragover 中实时完成 */
      return;
    }
    setForeign(null);
    onAdoptForeignDrop(foreignRef.current?.index ?? tabsRefLen.current);
  };

  /* 外源悬停指示超过 600ms 无刷新即过期清除(源异常时的兜底) */
  useEffect(() => {
    if (!foreign) return;
    const t = window.setTimeout(() => setForeign(null), 600);
    return () => window.clearTimeout(t);
  }, [foreign]);

  const dragTab = dragView ? tabs.find(tb => tb.id === dragView.tabId) : null;
  const showOwnCaret = !!dragView
    && dragView.caretX != null
    && dragView.dropIndex !== tabs.findIndex(tb => tb.id === dragView.tabId);

  return (
    <>
      <div
        ref={stripRef}
        data-tauri-drag-region={!IS_ANDROID_APP}
        className={cn(
          "relative min-w-0 flex items-center gap-0.5 overflow-x-auto",
          foreign && (isDarkMode ? "ring-1 ring-inset ring-emerald-500/30 rounded-md" : "ring-1 ring-inset ring-emerald-500/40 rounded-md"),
        )}
        onWheel={(e) => {
          /* 桌面滚轮→横滚（滚动条已隐藏）；触摸端走原生滑动 */
          const el = e.currentTarget;
          if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            el.scrollLeft += e.deltaY;
          }
        }}
        onDragOver={handleStripDragOver}
        onDragLeave={handleStripDragLeave}
        onDrop={handleStripDrop}
        onContextMenu={(e) => {
          /* 空白处右键：无锚点标签，只提供新建与全部关闭 */
          e.preventDefault();
          onContextMenu(e.clientX, e.clientY, null);
        }}
      >
        {tabs.map((tab) => {
          /* 脏且存在未处理外部 diff：橙色提示点（外圈样式区别于琥珀色脏状态点） */
          const conflicted = conflictedIds.has(tab.id);
          const dragging = dragView?.tabId === tab.id;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              draggable={!IS_TOUCH_PRIMARY}
              onClick={() => {
                if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                onSelect(tab.id);
              }}
              onDragStart={(e) => handleTabDragStart(e, tab.id)}
              onDragEnd={handleTabDragEnd}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e.clientX, e.clientY, tab.id);
              }}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] shrink-0",
                dragging && "opacity-40",
                activeTabId === tab.id
                  ? (isDarkMode ? "bg-zinc-700 text-zinc-100" : "bg-zinc-200 text-zinc-800")
                  : (isDarkMode ? "text-zinc-500 hover:bg-zinc-700/50" : "text-zinc-500 hover:bg-zinc-100")
              )}
            >
              <span
                title={conflicted ? t('tab.conflictedTitle') : undefined}
                className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0",
                  conflicted
                    ? "bg-orange-500 ring-2 ring-orange-400/40"
                    : tab.isDirty ? "bg-amber-500" : (activeTabId === tab.id ? "bg-emerald-500" : (isDarkMode ? "bg-zinc-600" : "bg-zinc-300"))
                )} />
              <FileText size={12} className="shrink-0 opacity-60" />
              <span className="truncate">{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                className={cn(
                  "p-0.5 rounded-sm hover:bg-zinc-500/20 transition-all shrink-0",
                  IS_TOUCH_PRIMARY ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                <X size={10} />
              </button>
            </div>
          );
        })}

        {/* 自家拖拽的插入指示线(滚动内容坐标系,随内容横滚) */}
        {dragView && showOwnCaret && (
          <div
            className="absolute top-1 bottom-1 w-0.5 rounded-full bg-emerald-500 pointer-events-none"
            style={{ left: dragView.caretX! - 1 }}
          />
        )}

        {/* 外源拖拽的插入指示线 */}
        {foreign && !dragView && (
          <div
            className="absolute top-1 bottom-1 w-0.5 rounded-full bg-emerald-500 pointer-events-none"
            style={{ left: foreign.caretX - 1 }}
          />
        )}
      </div>

      <button
        onClick={onNewTab}
        className={cn(
          "p-1.5 rounded-md transition-colors shrink-0",
          isDarkMode ? "hover:bg-zinc-600/70 text-zinc-300" : "hover:bg-zinc-200/70 text-zinc-600"
        )}
        title={newTabTitle}
      >
        <Plus size={15} />
      </button>
    </>
  );
}
