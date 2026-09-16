/**
 * 标签条（桌面布局）：渲染 + 原生 HTML5 拖拽（浏览器/记事本式）。
 * 拖起瞬间由系统渲染拖拽图像(setDragImage)——图像跟随全局光标,越出窗口也不消失;
 * 松手在标签条外即脱离,拖到其它 H.I.D.E 窗口标签条上即合并
 * (目标窗口直接收到 dragover/drop,由 OS 命中测试,无重叠窗口歧义)。
 *
 * 悬停指示为「空占位符 + 让位动画」:指针进入标签左右各三分之一区域,
 * 占位符出现在该处、其余标签以过渡动画让位(中间三分之一粘滞防抖);
 * 松手后标签落进占位符;拖走则让位复位。文档级 dragover/drop 对自家
 * MIME 拖拽全程放行(否则光标为🚫),脱离语义=任意位置松手皆可。
 * 纯逻辑见 lib/tabDragCore;事件与载荷协议见 lib/tabTransfer。
 */
import { useEffect, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { gapIndexFromRects } from '../lib/tabDragCore';
import type { FileTab } from '../lib/tabModel';
import { useT } from '../lib/i18nContext';

/** 本应用自定义拖拽 MIME 标记:用于区分「我们的标签拖拽」与外部拖入(文件/文本) */
const HEID_TAB_MIME = 'application/x-heid-tab';
/** 外源合并占位符宽度(px) */
const FOREIGN_GAP_W = 96;
/** 标签条 flex 间距(gap-0.5) */
const STRIP_GAP = 2;

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
  /** 占位符在滚动内容坐标系里的左缘 x */
  caretX: number;
}

export function TabBar({
  tabs, activeTabId, isDarkMode, conflictedIds, canDetach, newTabTitle,
  onSelect, onCloseTab, onContextMenu, onNewTab,
  onMoveTab, onNativeDragStart, onNativeDragEnd, onAdoptForeignDrop,
}: TabBarProps) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement | null>(null);
  /* 本窗口正在进行的原生拖拽(dragstart→dragend 之间有效) */
  const nativeDragRef = useRef<{
    tabId: string; grabDx: number; grabDy: number; tabWidth: number; dropIndex: number; startIndex: number;
  } | null>(null);
  /* 本次原生拖拽是否已在本窗口标签条上完成放置(重排) */
  const ownDropHandledRef = useRef(false);
  /* 拖拽起始时各标签宽度(数组序),用于占位符定位 */
  const widthsRef = useRef<number[]>([]);
  const suppressClickRef = useRef(false);

  const [dragView, setDragView] = useState<{ tabId: string; dropIndex: number; gapW: number } | null>(null);
  const [foreign, setForeign] = useState<ForeignHover | null>(null);

  /* 最新的悬停落点供 drop 读取:经 ref 中转 */
  const foreignRef = useRef<ForeignHover | null>(null);
  foreignRef.current = foreign;

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
    const startIndex = tabs.findIndex(tb => tb.id === tabId);
    nativeDragRef.current = { tabId, grabDx, grabDy, tabWidth: rect.width, dropIndex: startIndex, startIndex };
    widthsRef.current = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])
      .map(wEl => wEl.getBoundingClientRect().width);
    ownDropHandledRef.current = false;
    setDragView({ tabId, dropIndex: startIndex, gapW: rect.width });
    onNativeDragStart(tabId);
  };

  const handleTabDragEnd = () => {
    const own = nativeDragRef.current;
    nativeDragRef.current = null;
    setDragView(null);
    if (!own) return;
    const handled = ownDropHandledRef.current;
    ownDropHandledRef.current = false;
    if (handled && own.dropIndex !== own.startIndex) onMoveTab(own.tabId, own.dropIndex);
    onNativeDragEnd(own.tabId, handled, { grabDx: own.grabDx, grabDy: own.grabDy });
  };

  /* ---- 标签条作为放置目标:自身重排 + 收下其它窗口的标签 ---- */

  const freshRects = (strip: HTMLDivElement) =>
    Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'))
      .map(el => el.getBoundingClientRect())
      .filter(r => r.right - r.left > 4) /* 折叠中的源标签不计入插入点判定 */;

  const caretXFromRects = (strip: HTMLDivElement, rects: { left: number; right: number }[], index: number): number => {
    const stripLeft = strip.getBoundingClientRect().left;
    const base = index < rects.length ? rects[index].left : rects[rects.length - 1]?.right ?? stripLeft;
    return base - stripLeft + strip.scrollLeft;
  };

  const handleStripDragOver = (e: React.DragEvent) => {
    const strip = stripRef.current;
    if (!strip) return;
    if (e.dataTransfer.types.includes('Files')) return; /* 文件拖放交给系统打开通道 */
    const own = nativeDragRef.current;
    const rects = freshRects(strip);
    if (own) {
      /* 自家标签:三分位判定落点(占位符),dragend 时提交重排 */
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const idx = gapIndexFromRects(rects, e.clientX, own.dropIndex);
      if (idx !== own.dropIndex) {
        own.dropIndex = idx;
        setDragView(v => (v && v.tabId === own.tabId ? { ...v, dropIndex: idx } : v));
      }
      return;
    }
    /* 其它窗口的标签悬停:显示占位符,允许放置 */
    const prev = foreignRef.current?.index ?? tabs.length;
    const idx = gapIndexFromRects(rects, e.clientX, prev);
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const stripLeft = strip.getBoundingClientRect().left;
    const base = idx < rects.length ? rects[idx].left : rects[rects.length - 1]?.right ?? stripLeft;
    setForeign({ index: idx, caretX: base - stripLeft + strip.scrollLeft });
  };

  const handleStripDragLeave = (e: React.DragEvent) => {
    if (e.relatedTarget && stripRef.current?.contains(e.relatedTarget as Node)) return;
    setForeign(null);
  };

  const handleStripDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) return; /* 文件拖放交给系统打开通道 */
    e.preventDefault();
    if (nativeDragRef.current) {
      ownDropHandledRef.current = true; /* 重排在 dragend 时提交 */
      return;
    }
    setForeign(null);
    onAdoptForeignDrop(foreignRef.current?.index ?? tabs.length);
  };

  /* 外源悬停指示超过 600ms 无刷新即过期清除(源异常时的兜底) */
  useEffect(() => {
    if (!foreign) return;
    const t = window.setTimeout(() => setForeign(null), 600);
    return () => window.clearTimeout(t);
  }, [foreign]);

  /* 文档级放行自家 MIME 拖拽:任何位置松手都有效(=脱离),光标不再显示🚫 */
  useEffect(() => {
    if (!canDetach) return;
    const accept = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(HEID_TAB_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    };
    document.addEventListener('dragover', accept);
    document.addEventListener('drop', accept);
    return () => {
      document.removeEventListener('dragover', accept);
      document.removeEventListener('drop', accept);
    };
  }, [canDetach]);

  const dragTab = dragView ? tabs.find(tb => tb.id === dragView.tabId) : null;

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
        {(() => {
          /* 逐标签计算让位:被拖标签折叠腾位,折叠列表中其后的标签右移一个占位宽 */
          let collapsed = 0;
          return tabs.map((tab, i) => {
            const isDragged = dragView?.tabId === tab.id;
            const collapsedIdx = collapsed;
            if (!isDragged) collapsed += 1;
            const dragging = isDragged;
            const conflicted = conflictedIds.has(tab.id);
            let shift = 0;
            if (dragView && !isDragged && collapsedIdx >= dragView.dropIndex) shift = dragView.gapW;
            if (foreign && !dragView && i >= foreign.index) shift = FOREIGN_GAP_W;
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
                style={dragging ? { width: 0, minWidth: 0, paddingLeft: 0, paddingRight: 0, opacity: 0, transform: shift ? `translateX(${shift}px)` : undefined }
                  : shift ? { transform: `translateX(${shift}px)` } : undefined}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] shrink-0 overflow-hidden",
                  dragging && "opacity-0",
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
                  onClick={(e2) => { e2.stopPropagation(); onCloseTab(tab.id); }}
                  className={cn(
                    "p-0.5 rounded-sm hover:bg-zinc-500/20 transition-all shrink-0",
                    IS_TOUCH_PRIMARY ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                >
                  <X size={10} />
                </button>
              </div>
            );
          });
        })()}

        {/* 自家拖拽:空占位符(虚线框指示落点;dragend 提交重排后由真实标签归位) */}
        {dragView && dragTab && (() => {
          let acc = 0;
          let taken = 0;
          for (let i = 0; i < tabs.length && taken < dragView.dropIndex; i++) {
            if (tabs[i].id === dragView.tabId) continue;
            acc += (widthsRef.current[i] ?? 0) + STRIP_GAP;
            taken += 1;
          }
          return (
            <div
              className={cn(
                "absolute top-1 bottom-1 rounded-md border border-dashed pointer-events-none",
                isDarkMode ? "border-emerald-400/50 bg-emerald-500/10" : "border-emerald-500/60 bg-emerald-500/10"
              )}
              style={{ left: acc, width: dragView.gapW }}
            />
          );
        })()}

        {/* 外源拖拽:空占位符 */}
        {foreign && (
          <div
            className={cn(
              "absolute top-1 bottom-1 rounded-md border border-dashed pointer-events-none",
              isDarkMode ? "border-emerald-400/50 bg-emerald-500/10" : "border-emerald-500/60 bg-emerald-500/10"
            )}
            style={{ left: foreign.caretX, width: FOREIGN_GAP_W }}
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
