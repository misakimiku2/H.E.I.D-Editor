import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { clampBarToViewport } from '../lib/position';

export interface FloatingDragPos {
  left: number;
  top: number;
}

/** 超过这个位移才算拖动：小于它的按下-抬起仍是一次正常点按（按钮照常响应） */
const DRAG_COMMIT_PX = 4;

/** 这些控件内部是选字/放光标，不接管拖拽 */
const NO_DRAG_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

/**
 * 浮层拖拽：除输入框以外，按住栏面任何位置拖动都算（按钮、间距、把手都行）。
 * - 按钮不因拖拽失灵：位移没超过阈值就只是点按，click 照常派发；
 * - 真拖起来后才抓 pointer 并吞掉紧随其后的那次 click，避免拖一下误触「全部替换」；
 * - 位置钳制在视口内。只给桌面浮层挂——安卓停靠条贴窗口底缘，没有可拖的意义。
 * pos 为 null（首帧还没按指针定位）时不响应，免得拖到左上角又被定位覆盖。
 */
export function useFloatingDrag(
  panelRef: RefObject<HTMLElement | null>,
  pos: FloatingDragPos | null,
  setPos: (p: FloatingDragPos) => void,
) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    left: number;
    top: number;
    width: number;
    height: number;
    pointerId: number;
    claimed: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !pos) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(NO_DRAG_SELECTOR)) return;
    /* 拦默认动作：按在按钮/栏面上不该把焦点从查找框抢走，也不该开始选字 */
    e.preventDefault();
    const r = panelRef.current?.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      left: pos.left,
      top: pos.top,
      width: r?.width ?? 0,
      height: r?.height ?? 0,
      pointerId: e.pointerId,
      claimed: false,
    };
    suppressClickRef.current = false;
  }, [panelRef, pos]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.claimed) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_COMMIT_PX) return;
      d.claimed = true;
      setDragging(true);
      /* 抓在面板上：指针移出按钮/移出面板后仍收得到 move 与 up */
      panelRef.current?.setPointerCapture?.(d.pointerId);
      /* 真正拖起来了：这次按下不再算点按，紧随的 click 由 onClickCapture 吞掉 */
      suppressClickRef.current = true;
    }
    setPos(clampBarToViewport(
      d.left + e.clientX - d.startX,
      d.top + e.clientY - d.startY,
      d.width,
      d.height,
    ));
  }, [panelRef, setPos]);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (!d.claimed) return;
    panelRef.current?.releasePointerCapture?.(d.pointerId);
    setDragging(false);
  }, [panelRef]);

  /** 挂在面板捕获阶段：拖动结束后浏览器仍可能在原按钮上补一次 click */
  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    dragging,
    panelDragProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    onClickCapture,
  };
}
