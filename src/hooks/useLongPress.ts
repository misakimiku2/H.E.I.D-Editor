/**
 * 触屏长按手势 → 弹出与桌面右键同一个菜单。
 *
 * 桌面右键菜单的触屏等价物（desktop-to-android 映射：右键 → 长按）。
 * 设计约定：
 * - 仅响应非 mouse 指针（桌面路径走原生 onContextMenu，行为零变化）；
 * - 500ms 阈值；期间移动超过阈值、抬起、第二指按下（捏合）均取消；
 *   浏览器接管滚动会发 pointercancel，天然覆盖「长按期间滚走」的场景；
 * - 触发时轻触觉反馈（vibrate 不支持则静默）；
 * - 长按触发后吞掉紧随的 click（触屏抬手即 click，否则长按弹菜单会顺带
 *   误触发元素自身的选中/打开）；桌面 onClick 原样透传；
 * - bind() 同时接管 onContextMenu：触屏上吞掉原生 contextmenu（部分 WebView
 *   长按文本仍会发），防止与长按双开菜单；桌面原样透传调用方的右键回调；
 * - 指针事件 stopPropagation：嵌套 bind（如树行与树空白区）只触发最内层。
 */
import { useCallback, useRef } from 'react';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

/** 长按触发阈值（ms） */
export const LONG_PRESS_MS = 500;
/** 位移取消阈值（px）：超过视为滚动/拖拽而非长按 */
export const LONG_PRESS_MOVE_THRESHOLD = 10;
/** 长按触发后吞 click 的窗口（ms）：覆盖「触发 → 抬手」的间隔 */
const CLICK_SUPPRESS_MS = 500;

export interface LongPressPos {
  x: number;
  y: number;
}

export interface LongPressOptions {
  /** 长按触发回调（pos 为触发点的视口坐标，与 contextmenu 的 clientX/Y 同口径） */
  onLongPress: (pos: LongPressPos) => void;
  /** 桌面右键回调（仅桌面调用；触屏上原生 contextmenu 被吞掉） */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 点击回调（触屏上，长按触发后紧随的 click 被吞掉；桌面原样透传） */
  onClick?: (e: React.MouseEvent) => void;
}

interface PendingPress {
  pointerId: number;
  startX: number;
  startY: number;
  timer: number;
}

function vibrateTick() {
  try {
    navigator.vibrate?.(10);
  } catch {
    /* 无振动能力则静默 */
  }
}

export function useLongPress() {
  const pendingRef = useRef<PendingPress | null>(null);
  const firedAtRef = useRef(0);

  const cancel = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingRef.current = null;
  }, []);

  const bind = useCallback((opts: LongPressOptions) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!IS_TOUCH_PRIMARY || e.pointerType === 'mouse') return;
      /* 已有待定长按时再来第二根手指：取消（捏合缩放优先） */
      if (pendingRef.current) { cancel(); return; }
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      const timer = window.setTimeout(() => {
        pendingRef.current = null;
        firedAtRef.current = Date.now();
        vibrateTick();
        opts.onLongPress({ x: startX, y: startY });
      }, LONG_PRESS_MS);
      pendingRef.current = { pointerId, startX, startY, timer };
      /* 捕获指针：移出元素后的 move/up 仍送回本元素，阈值判定与取消才可靠 */
      try { e.currentTarget.setPointerCapture(pointerId); } catch { /* 指针已失效则忽略 */ }
      /* 嵌套 bind（树行 vs 树空白、标签 vs 标签栏）只让最内层长按生效 */
      e.stopPropagation();
    },
    onPointerMove: (e: React.PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    /* 触屏抬手后 WebView 会合成 mousedown/mouseup/click——不拦住 mousedown，
       刚弹出的菜单会被「点击外部关闭」逻辑立刻关掉（桌面路径不经过此分支） */
    onMouseDown: (e: React.MouseEvent) => {
      if (!IS_TOUCH_PRIMARY) return;
      if (Date.now() - firedAtRef.current < CLICK_SUPPRESS_MS) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onClick: (e: React.MouseEvent) => {
      if (IS_TOUCH_PRIMARY && Date.now() - firedAtRef.current < CLICK_SUPPRESS_MS) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      opts.onClick?.(e);
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (!IS_TOUCH_PRIMARY) { opts.onContextMenu?.(e); return; }
      /* 触屏：菜单由长按负责，吞掉原生 contextmenu 防双开 */
      e.preventDefault();
      e.stopPropagation();
    },
  }), [cancel]);

  return { bind };
}
