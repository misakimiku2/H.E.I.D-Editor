/**
 * 标签条（桌面布局）：渲染 + 原生 HTML5 拖拽（浏览器/记事本式）。
 * 拖起瞬间由系统渲染拖拽图像(setDragImage)——图像跟随全局光标,越出窗口也不消失;
 * 松手在标签条外即脱离,拖到其它 H.I.D.E 窗口标签条上即合并
 * (目标窗口直接收到 dragover/drop,由 OS 命中测试,无重叠窗口歧义)。
 *
 * 悬停指示为 Chrome 式重排:系统拖拽图像隐藏(1px 透明图),被拖标签自身平滑
 * 滑动到落点槽位(半透明+投影),其余标签以过渡动画让位;落点回到原位时原地不动。
 * 文档级 dragover/drop 对自家 MIME 拖拽全程放行(否则光标为🚫),
 * 脱离语义=任意非标签条位置松手皆可。跨窗合并的落点为实心槽位剪影。
 * 纯逻辑见 lib/tabDragCore;事件与载荷协议见 lib/tabTransfer。
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { gapIndexFromRects, isPrematureDragEnd, ownDropIndexOf, ownShiftFor, ownSlideOffsetX } from '../lib/tabDragCore';
import type { FileTab } from '../lib/tabModel';
import { useT } from '../lib/i18nContext';
import { useLongPress } from '../hooks/useLongPress';

/** 本应用自定义拖拽 MIME 标记:用于区分「我们的标签拖拽」与外部拖入(文件/文本) */
const HEID_TAB_MIME = 'application/x-heid-tab';
/** 外源合并占位符宽度(px):与标签同为流内元素,插入后 + 按钮自然右移 */
const FOREIGN_GAP_W = 96;
/** 标签条 flex 间距(gap-0.5) */
const STRIP_GAP = 2;
/** 1px 透明图:隐藏系统拖拽快照,重排视觉由被拖标签自身滑动呈现 */
const TRANSPARENT_DRAG_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
let transparentDragImg: HTMLImageElement | null = null;

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
  /** 拖拽异常中止(dragend 早到,按钮未松):清掉暂存载荷,不重排不脱离 */
  onNativeDragCancel: (tabId: string) => void;
  /** 其它窗口把标签放到了本窗口标签条:收下并激活(App 负责载荷消费与 ack) */
  onAdoptForeignDrop: (insertIndex: number) => void;
}

interface ForeignHover {
  /** 插入点(含被拖标签坐标的外部视角,即「落在第 index 个标签之前」) */
  index: number;
}

export function TabBar({
  tabs, activeTabId, isDarkMode, conflictedIds, canDetach, newTabTitle,
  onSelect, onCloseTab, onContextMenu, onNewTab,
  onMoveTab, onNativeDragStart, onNativeDragEnd, onNativeDragCancel, onAdoptForeignDrop,
}: TabBarProps) {
  const t = useT();
  const stripRef = useRef<HTMLDivElement | null>(null);
  /* 本窗口正在进行的原生拖拽(dragstart→dragend 之间有效) */
  const nativeDragRef = useRef<{
    tabId: string; grabDx: number; grabDy: number; tabWidth: number; dropIndex: number; startIndex: number; startTs: number;
  } | null>(null);
  /* 本次原生拖拽是否已在本窗口标签条上完成放置(重排) */
  const ownDropHandledRef = useRef(false);
  /* 拖拽起始时各标签宽度(数组序),用于占位符定位 */
  const widthsRef = useRef<number[]>([]);
  const suppressClickRef = useRef(false);

  const [dragView, setDragView] = useState<{ tabId: string; dropIndex: number; startIndex: number; gapW: number } | null>(null);
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
    /* 隐藏系统拖拽快照:模块级预加载,避免 dragstart 时图片未解码而退回默认快照 */
    try {
      if (!transparentDragImg) {
        transparentDragImg = new Image();
        transparentDragImg.src = TRANSPARENT_DRAG_GIF;
      }
      e.dataTransfer.setDragImage(transparentDragImg, 0, 0);
    } catch { /* 退回默认图像 */ }
    const startIndex = tabs.findIndex(tb => tb.id === tabId);
    nativeDragRef.current = { tabId, grabDx, grabDy, tabWidth: rect.width, dropIndex: startIndex, startIndex, startTs: performance.now() };
    widthsRef.current = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])
      .map(wEl => wEl.getBoundingClientRect().width);
    ownDropHandledRef.current = false;
    setDragView({ tabId, dropIndex: startIndex, startIndex, gapW: rect.width });
    onNativeDragStart(tabId);
  };

  const handleTabDragEnd = () => {
    const own = nativeDragRef.current;
    nativeDragRef.current = null;
    setDragView(null);
    if (!own) return;
    /* dragend 早到 = 拖拽被 Chromium 异常中止(按钮可能未松):按取消处理,
       不重排、不脱离——否则轻微拖一下就会脱离成窗并自毁源窗口 */
    if (isPrematureDragEnd(own.startTs, performance.now())) {
      ownDropHandledRef.current = false;
      onNativeDragCancel(own.tabId);
      return;
    }
    const handled = ownDropHandledRef.current;
    ownDropHandledRef.current = false;
    if (handled && own.dropIndex !== own.startIndex) {
      onMoveTab(own.tabId, ownDropIndexOf(own.dropIndex, own.startIndex));
    }
    onNativeDragEnd(own.tabId, handled, { grabDx: own.grabDx, grabDy: own.grabDy });
  };

  /* ---- 标签条作为放置目标:自身重排 + 收下其它窗口的标签 ---- */

  /* 布局矩形(offsetLeft/Width = 内容坐标):不含让位 transform 动画,
     占位符/落点判定锚定在稳定边界上,不会追逐滑动中的标签 */
  const freshRects = (strip: HTMLDivElement, excludeTabId?: string) =>
    Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'))
      .filter(el => el.dataset.tabId !== excludeTabId)
      .map(el => ({ left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth }));

  const handleStripDragOver = (e: React.DragEvent) => {
    const strip = stripRef.current;
    if (!strip) return;
    if (e.dataTransfer.types.includes('Files')) return; /* 文件拖放交给系统打开通道 */
    const own = nativeDragRef.current;
    const rects = freshRects(strip, own?.tabId);
    /* 指针 x 换算为内容坐标(与 offsetLeft 同一坐标系,不受让位动画影响) */
    const contentX = e.clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
    if (own) {
      /* 自家标签:三分位判定落点(占位符),dragend 时提交重排 */
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const idx = gapIndexFromRects(rects, contentX, own.dropIndex);
      if (idx !== own.dropIndex) {
        own.dropIndex = idx;
        setDragView(v => (v && v.tabId === own.tabId ? { ...v, dropIndex: idx } : v));
      }
      return;
    }
    /* 其它窗口的标签悬停:显示占位符,允许放置。占位符是流内元素,
       由 foreign.index 决定插入位置,已有标签不会被覆盖或裁切 */
    const prev = foreignRef.current?.index ?? tabs.length;
    const idx = gapIndexFromRects(rects, contentX, prev);
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    /* TEMP-DEBUG:控制台诊断(F12 打开开发者工具查看),定位后可移除 */
    console.debug('[foreign-slot]', { idx, contentX: Math.round(contentX), tabs: tabs.length });
    setForeign({ index: idx });
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

  /* 触屏：长按标签/空白区弹右键同款菜单（桌面走原生 onContextMenu） */
  const { bind: bindMenu } = useLongPress();

  /* 外源合并占位符:普通标签造型(绿框)的流内元素——出现在插入点上,
     + 按钮与已有标签自然让位,松手后新标签恰好落进这个位置 */
  const foreignSlot = foreign && (
    <div
      className={cn(
        "w-24 h-6 shrink-0 rounded-md border pointer-events-none",
        isDarkMode ? "border-emerald-400/60 bg-emerald-500/10" : "border-emerald-500/70 bg-emerald-500/10",
      )}
    />
  );

  return (
    <>
      <div
        ref={stripRef}
        data-tauri-drag-region={!IS_ANDROID_APP}
        className="relative min-w-0 flex items-center gap-0.5 overflow-x-auto"
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
        {...bindMenu({
          onLongPress: (pos) => onContextMenu(pos.x, pos.y, null),
          onContextMenu: (e) => {
            /* 空白处右键：无锚点标签，只提供新建与全部关闭 */
            e.preventDefault();
            onContextMenu(e.clientX, e.clientY, null);
          },
        })}
      >
        {(() => {
          /* 逐标签计算让位:被拖标签滑向落点槽位,其后的标签右移一个占位宽 */
          let collapsed = 0;
          return tabs.map((tab, i) => (
            <Fragment key={tab.id}>
              {foreign && foreign.index === i && foreignSlot}
              {(() => {
                const isDragged = dragView?.tabId === tab.id;
                const collapsedIdx = collapsed;
                if (!isDragged) collapsed += 1;
                const dragging = isDragged;
                const conflicted = conflictedIds.has(tab.id);
                let shift = 0;
                if (dragView && !isDragged) {
                  shift = ownShiftFor(collapsedIdx, dragView.dropIndex, dragView.startIndex, dragView.gapW);
                }
                const slideX = dragView && isDragged
                  ? ownSlideOffsetX(widthsRef.current, dragView.startIndex, dragView.dropIndex, STRIP_GAP)
                  : 0;
                const tabStyle = isDragged
                  ? { transform: slideX ? `translateX(${slideX}px)` : undefined, zIndex: 10 }
                  : shift
                    ? { transform: `translateX(${shift}px)` }
                    : undefined;
                return (
                  <div
                    data-tab-id={tab.id}
                    draggable={!IS_TOUCH_PRIMARY}
                    {...bindMenu({
                      onClick: () => {
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        onSelect(tab.id);
                      },
                      onLongPress: (pos) => onContextMenu(pos.x, pos.y, tab.id),
                      onContextMenu: (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onContextMenu(e.clientX, e.clientY, tab.id);
                      },
                    })}
                    onDragStart={(e) => handleTabDragStart(e, tab.id)}
                    onDragEnd={handleTabDragEnd}
                    style={tabStyle}
                    className={cn(
                      IS_TOUCH_PRIMARY
                        ? "px-2.5 py-2 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] overflow-hidden select-none"
                        : "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] overflow-hidden",
                      /* 外源悬停期间允许压缩:为占位符腾位时不裁切(平时仍不收缩) */
                      foreign && !dragging ? "shrink" : "shrink-0",
                      /* 拖拽中的标签半透明滑向落点;同步折叠(width:0/opacity:0)会令
                         Chromium 立即中止拖拽并在按钮未松时触发 dragend → 轻微拖拽即脱离成窗 */
                      dragging && "opacity-90 shadow-lg z-10",
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
                        IS_TOUCH_PRIMARY
                          ? "min-w-[28px] min-h-[28px] -mr-1 rounded-sm flex items-center justify-center hover:bg-zinc-500/20 active:bg-zinc-500/40 transition-all shrink-0 opacity-100"
                          : "p-0.5 rounded-sm opacity-0 group-hover:opacity-100 hover:bg-zinc-500/20 transition-all shrink-0"
                      )}
                    >
                      <X size={IS_TOUCH_PRIMARY ? 14 : 10} />
                    </button>
                  </div>
                );
              })()}
            </Fragment>
          ));
        })()}

        {/* 外源拖拽:拖到最右(追加)时占位符落在全部标签之后 */}
        {foreign && foreign.index >= tabs.length && foreignSlot}
      </div>

      <button
        onClick={onNewTab}
        className={cn(
          "rounded-md transition-colors shrink-0 flex items-center justify-center",
          IS_TOUCH_PRIMARY ? "w-11 h-11 -mr-1" : "p-1.5",
          isDarkMode ? "hover:bg-zinc-600/70 text-zinc-300" : "hover:bg-zinc-200/70 text-zinc-600"
        )}
        title={newTabTitle}
      >
        <Plus size={IS_TOUCH_PRIMARY ? 18 : 15} />
      </button>
    </>
  );
}
