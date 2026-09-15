/**
 * 鼠标按住拖动平移容器内容（横向 / 纵向都支持，哪边超出滚哪边）。
 * Markdown 预览的图表容器与图表编辑器预览共用。
 *
 * 约定：
 * - 移动超过阈值才算拖拽，单击、双击、右键菜单、图内交互都不受影响；
 * - 触屏交给原生手指滑动，不走这套逻辑；
 * - 返回的 dragging 供调用方切换光标并临时禁用文本选择。
 */
import { useCallback, useRef, useState, type PointerEventHandler } from 'react';

/** 拖拽启动阈值（px）：小于它仍按点击处理 */
const DRAG_THRESHOLD = 4;

interface DragState {
  x: number;
  y: number;
  left: number;
  top: number;
  moved: boolean;
  id: number;
}

export function useDragScroll<T extends HTMLElement = HTMLElement>(): {
  dragging: boolean;
  handlers: {
    onPointerDown: PointerEventHandler<T>;
    onPointerMove: PointerEventHandler<T>;
    onPointerUp: PointerEventHandler<T>;
    onPointerCancel: PointerEventHandler<T>;
  };
} {
  const stateRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback<PointerEventHandler<T>>((e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const el = e.currentTarget;
    const canX = el.scrollWidth > el.clientWidth + 1;
    const canY = el.scrollHeight > el.clientHeight + 1;
    if (!canX && !canY) return;
    stateRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, id: e.pointerId };
  }, []);

  const onPointerMove = useCallback<PointerEventHandler<T>>((e) => {
    const st = stateRef.current;
    if (!st || st.id !== e.pointerId) return;
    const el = e.currentTarget;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (!st.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      st.moved = true;
      setDragging(true);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已失效则忽略 */
      }
    }
    el.scrollLeft = st.left - dx;
    el.scrollTop = st.top - dy;
  }, []);

  const onPointerUp = useCallback<PointerEventHandler<T>>((e) => {
    const st = stateRef.current;
    if (!st) return;
    stateRef.current = null;
    if (!st.moved) return;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 未捕获则忽略 */
    }
  }, []);

  return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}
