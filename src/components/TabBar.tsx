/**
 * 标签条（桌面布局）：渲染 + 指针自绘拖拽（浏览器式：栏内重排 / 拖出脱离成窗 /
 * 跨窗口拖入合并）。拖拽状态内聚在本组件——浮影与插入指示线经 ref 直改样式与
 * 局部 state 呈现，拖动过程不触达 App；只有重排/脱离/合并真正发生才经回调上抛。
 *
 * 手势：pointerdown 起手（关闭按钮除外），位移超阈值进入拖拽并 setPointerCapture——
 * 指针移出窗口后事件仍派发给源元素，借此持续查询 Rust「光标在哪个窗口」，
 * 命中其他窗口即向其转发 hover 事件（目标窗口显示插入指示），松手即并入。
 * 事件名与载荷协议见 lib/tabTransfer；插入点计算等纯逻辑见 lib/tabDragCore。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { DRAG_THRESHOLD_PX, insertionIndex, type RectLike } from '../lib/tabDragCore';
import {
  EV_TAB_DRAG_HOVER, EV_TAB_DRAG_LEAVE, EV_TAB_TRANSFER, makeDragId,
  type TabTransferPayload,
} from '../lib/tabTransfer';
import type { FileTab } from '../lib/tabModel';
import { useT } from '../lib/i18nContext';
import { currentWindowLabel, listenTabEvent, sendToWindow, windowUnderCursor } from '../lib/windows';

type DragMode = 'bar' | 'detach' | 'merge';

interface OwnDrag {
  tabId: string;
  dragId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** 起手点在标签矩形内的偏移（浮影按原位跟随） */
  grabDX: number;
  grabDY: number;
  tabWidth: number;
  rects: { id: string; left: number; right: number }[] | null;
  stripLeft: number;
  baseScroll: number;
  fromIndex: number;
  active: boolean;
  mode: DragMode;
  dropIndex: number;
  mergeTarget: string | null;
  lastPollAt: number;
  lastX: number;
  lastY: number;
}

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
  /** 拖出脱离（含拖到无窗口区域松手）：新建窗口装载 */
  onDetachTab: (tabId: string, dragId: string) => void;
  /** 拖到其他窗口标签条松手：并入目标窗口 */
  onMergeDrop: (tabId: string, dragId: string, targetLabel: string) => void;
  /** 收下其他窗口拖来的标签（App 负责插入与 ack） */
  onAdoptTransfer: (payload: TabTransferPayload, insertIndex: number) => void;
}

interface ForeignHover {
  dragId: string;
  index: number;
  /** 插入指示线在滚动内容坐标系里的 x */
  caretX: number;
}

export function TabBar({
  tabs, activeTabId, isDarkMode, conflictedIds, canDetach, newTabTitle,
  onSelect, onCloseTab, onContextMenu, onNewTab,
  onMoveTab, onDetachTab, onMergeDrop, onAdoptTransfer,
}: TabBarProps) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<OwnDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const [dragView, setDragView] = useState<{ tabId: string; mode: DragMode; dropIndex: number } | null>(null);
  const [foreign, setForeign] = useState<ForeignHover | null>(null);

  /* onAdoptTransfer 回调里要读最新悬停位置与标签数:经 ref 中转 */
  const foreignRef = useRef<ForeignHover | null>(null);
  foreignRef.current = foreign;
  const tabsRefLen = useRef(tabs.length);
  tabsRefLen.current = tabs.length;

  /* ---- 矩形抓取:视口坐标 + 基准滚动,用减去滚动差补偿拖拽期间的边缘横滚 ---- */
  const captureTabs = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return null;
    const stripRect = strip.getBoundingClientRect();
    const rects = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]')).map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.tabId ?? '', left: r.left, right: r.right };
    });
    return { rects, stripLeft: stripRect.left, baseScroll: strip.scrollLeft };
  }, []);

  const adjustedRects = (d: OwnDrag): { id: string; left: number; right: number }[] | null => {
    if (d.rects) {
      const ds = (stripRef.current?.scrollLeft ?? d.baseScroll) - d.baseScroll;
      return d.rects.map(r => ({ ...r, left: r.left - ds, right: r.right - ds }));
    }
    const fresh = captureTabs();
    if (!fresh) return null;
    d.rects = fresh.rects;
    d.stripLeft = fresh.stripLeft;
    d.baseScroll = fresh.baseScroll;
    return fresh.rects;
  };

  const caretContentX = (d: OwnDrag, index: number): number | null => {
    const rects = adjustedRects(d);
    if (!rects || rects.length === 0) return null;
    const base = index < rects.length ? rects[index].left : rects[rects.length - 1].right;
    /* 视口坐标 → 滚动内容坐标(absolute 子元素随内容滚动) */
    return base - d.stripLeft + d.baseScroll;
  };

  /* ---- 自绘拖拽 ---- */

  const positionGhost = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    const ghost = ghostRef.current;
    if (!d || !ghost) return;
    ghost.style.left = `${clientX - d.grabDX}px`;
    ghost.style.top = `${clientY - d.grabDY}px`;
  };

  const handleTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    if (e.button !== 0 || IS_TOUCH_PRIMARY) return;
    if ((e.target as HTMLElement).closest('button')) return; /* 关闭按钮照常点击 */
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const dragId = makeDragId();
    dragRef.current = {
      tabId,
      dragId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - rect.left,
      grabDY: e.clientY - rect.top,
      tabWidth: rect.width,
      rects: null,
      stripLeft: 0,
      baseScroll: 0,
      fromIndex: tabs.findIndex(t => t.id === tabId),
      active: false,
      mode: 'bar',
      dropIndex: tabs.findIndex(t => t.id === tabId),
      mergeTarget: null,
      lastPollAt: 0,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* 捕获失败则无法拖出窗口,栏内仍可用 */ }
  };

  const clearMergeTarget = (d: OwnDrag) => {
    if (d.mergeTarget) {
      void sendToWindow(d.mergeTarget, EV_TAB_DRAG_LEAVE, { dragId: d.dragId });
      d.mergeTarget = null;
    }
  };

  const pollMergeTarget = useCallback(async (clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    const now = Date.now();
    if (now - d.lastPollAt < 100) return;
    d.lastPollAt = now;
    const hit = await windowUnderCursor();
    const cur = dragRef.current;
    if (!cur || cur !== d) return; /* 拖拽已结束 */
    const label = hit && hit.label !== currentWindowLabel() ? hit.label : null;
    if (label !== d.mergeTarget) {
      clearMergeTarget(d);
      d.mergeTarget = label;
    }
    if (label && hit) {
      void sendToWindow(label, EV_TAB_DRAG_HOVER, { dragId: d.dragId, x: hit.x, y: hit.y });
    }
    const mode: DragMode = d.mergeTarget ? 'merge' : 'detach';
    if (mode !== d.mode) {
      d.mode = mode;
      setDragView(v => (v ? { ...v, mode } : v));
    }
  }, []);

  const handleTabPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.active) {
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (dist < DRAG_THRESHOLD_PX) return;
      d.active = true;
      suppressClickRef.current = true;
      d.rects = null;
      setDragView({ tabId: d.tabId, mode: 'bar', dropIndex: d.dropIndex });
    }
    positionGhost(e.clientX, e.clientY);

    const strip = stripRef.current;
    const stripRect = strip?.getBoundingClientRect();
    const inStrip = !!strip && !!stripRect && (() => {
      return e.clientY >= stripRect.top && e.clientY <= stripRect.bottom
        && e.clientX >= stripRect.left - 8 && e.clientX <= stripRect.right + 8;
    })();

    if (inStrip && strip) {
      /* 拖近边缘自动横滚;滚动后矩形失效,下次 move 重新抓取 */
      const r = stripRect!;
      const margin = 28;
      if (e.clientX < r.left + margin) strip.scrollLeft -= 14;
      else if (e.clientX > r.right - margin) strip.scrollLeft += 14;

      const rects = adjustedRects(d);
      if (rects) {
        const plain: RectLike[] = rects;
        const idx = insertionIndex(plain, e.clientX);
        if (idx !== d.dropIndex) {
          d.dropIndex = idx;
          setDragView(v => (v ? { ...v, dropIndex: idx } : v));
          onMoveTab(d.tabId, idx);
          d.rects = null; /* 重排后 DOM 次序已变,重新抓取 */
        }
      }
      if (d.mode !== 'bar') {
        clearMergeTarget(d);
        d.mode = 'bar';
        setDragView(v => (v ? { ...v, mode: 'bar' } : v));
      }
      return;
    }

    /* 指针出了本窗口:查询是否悬停在其他窗口上(节流);浏览器/安卓不脱离 */
    const outside = e.clientX < 0 || e.clientY < 0
      || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
    if (canDetach && outside) {
      void pollMergeTarget(e.clientX, e.clientY);
    } else if (canDetach && d.mode !== 'detach') {
      clearMergeTarget(d);
      d.mode = 'detach';
      setDragView(v => (v ? { ...v, mode: 'detach' } : v));
    }
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try { e.currentTarget.releasePointerCapture(d.pointerId); } catch { /* 已释放 */ }
    dragRef.current = null;
    if (!d.active) {
      setDragView(null);
      return;
    }
    if (!cancelled) {
      if (d.mode === 'bar') {
        /* 重排已在 move 中实时生效 */
      } else if (d.mergeTarget) {
        onMergeDrop(d.tabId, d.dragId, d.mergeTarget);
      } else {
        onDetachTab(d.tabId, d.dragId);
      }
    }
    clearMergeTarget(d);
    setDragView(null);
  };

  /* ---- 作为合并目标:监听其他窗口的 hover/leave/transfer ---- */
  useEffect(() => {
    if (!canDetach) return;
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void (async () => {
      const hover = await listenTabEvent<{ dragId?: string; x?: number; y?: number }>(EV_TAB_DRAG_HOVER, (p) => {
        if (disposed || !p || typeof p.dragId !== 'string') return;
        const strip = stripRef.current;
        if (!strip) return;
        const r = strip.getBoundingClientRect();
        const onStrip = p.y != null && p.y >= r.top && p.y <= r.bottom && p.x != null && p.x >= r.left - 8 && p.x <= r.right + 8;
        if (!onStrip) {
          setForeign(null);
          return;
        }
        const rects = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]')).map(el => {
          const b = el.getBoundingClientRect();
          return { left: b.left, right: b.right };
        });
        const index = insertionIndex(rects, p.x ?? r.left);
        const base = index < rects.length ? rects[index].left : rects[rects.length - 1]?.right ?? r.left;
        setForeign({ dragId: p.dragId, index, caretX: base - r.left + strip.scrollLeft });
      });
      const leave = await listenTabEvent<{ dragId?: string }>(EV_TAB_DRAG_LEAVE, (p) => {
        if (disposed) return;
        setForeign(cur => (cur && (!p || p.dragId === cur.dragId) ? null : cur));
      });
      const transfer = await listenTabEvent<unknown>(EV_TAB_TRANSFER, (p) => {
        if (disposed) return;
        setForeign(null);
        /* insertIndex:悬停指示的最后位置;未在标签条上悬停过则追加到末尾 */
        onAdoptTransfer(p as TabTransferPayload, foreignRef.current?.index ?? tabsRefLen.current);
      });
      if (disposed) {
        [hover, leave, transfer].forEach(fn => fn());
        return;
      }
      unlistens.push(hover, leave, transfer);
    })();
    return () => {
      disposed = true;
      unlistens.forEach(fn => fn());
    };
  }, [canDetach, onAdoptTransfer]);

  /* 外源悬停超过 600ms 无刷新即过期清除(源窗口异常退出时的兜底) */
  useEffect(() => {
    if (!foreign) return;
    const t = window.setTimeout(() => setForeign(null), 600);
    return () => window.clearTimeout(t);
  }, [foreign]);

  const dragTab = dragView ? tabs.find(t => t.id === dragView.tabId) : null;
  const showOwnCaret = dragView?.mode === 'bar'
    && dragView.dropIndex !== tabs.findIndex(t => t.id === dragView.tabId);

  /* 浮影挂载即落位(首个 move 事件晚于挂载一帧,不补会闪现在屏幕外) */
  useLayoutEffect(() => {
    if (dragView) positionGhost(dragRef.current?.lastX ?? -9999, dragRef.current?.lastY ?? -9999);
  }, [dragView]);

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
              onClick={() => {
                if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                onSelect(tab.id);
              }}
              onPointerDown={(e) => handleTabPointerDown(e, tab.id)}
              onPointerMove={handleTabPointerMove}
              onPointerUp={(e) => finishDrag(e, false)}
              onPointerCancel={(e) => finishDrag(e, true)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e.clientX, e.clientY, tab.id);
              }}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] shrink-0 touch-none",
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

        {/* 自身拖拽的插入指示线(滚动内容坐标系,随内容横滚) */}
        {dragView && showOwnCaret && dragTab && (() => {
          const d = dragRef.current;
          const x = d ? caretContentX(d, dragView.dropIndex) : null;
          return x != null ? (
            <div
              className="absolute top-1 bottom-1 w-0.5 rounded-full bg-emerald-500 pointer-events-none"
              style={{ left: x - 1 }}
            />
          ) : null;
        })()}

        {/* 外源拖拽的插入指示线(与自身拖拽互斥:自己拖时不接收 hover) */}
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

      {/* 拖拽浮影:portal 到 body,位置经 ref 直改(不逐帧重渲染) */}
      {dragView && dragTab && createPortal(
        <div
          ref={ghostRef}
          className={cn(
            "fixed z-[200] pointer-events-none select-none flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium",
            dragView.mode === 'bar'
              ? (isDarkMode ? "bg-zinc-700 text-zinc-100 shadow-md" : "bg-white text-zinc-800 shadow-md")
              : (isDarkMode ? "bg-zinc-700 text-zinc-100 shadow-2xl ring-1 ring-emerald-500/40" : "bg-white text-zinc-800 shadow-2xl ring-1 ring-emerald-500/40"),
            dragView.mode !== 'bar' && "scale-105",
          )}
          style={{ width: dragRef.current?.tabWidth, left: -9999, top: -9999 }}
        >
          <FileText size={12} className="shrink-0 opacity-60" />
          <span className="truncate">{dragTab.title}</span>
        </div>,
        document.body,
      )}
    </>
  );
}
