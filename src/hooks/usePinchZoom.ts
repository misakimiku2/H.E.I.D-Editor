/**
 * 触屏双指捏合缩放 + 单指平移的手势识别（替代桌面滚轮缩放 / 中键拖动平移）。
 *
 * 职责边界：本钩子只识别手势并给出**增量**语义回调，不持有也不理解 scale/offset
 * 状态——锚点折算（视口中心 / viewBox 等）由调用方按各自的变换模型实现：
 * - onPan(dx, dy)：单指平移增量（相对上次事件）；
 * - onPinch(ratio, midX, midY, midDx, midDy)：双指缩放增量——ratio = 本次两指距离 / 上次，
 *   (midX, midY) 为当前双指中点视口坐标，(midDx, midDy) 为中点位移（双指整体拖动 =
 *   纯平移，ratio≈1；调用方按「以上一中点为锚缩放 + 中点位移平移」叠加）；
 * - 任一指抬起 / pointercancel 即手势结束；仅响应非 mouse 指针（桌面路径不变）；
 * - onMoved 供调用方抑制「手势结束后误触发 click 关闭」等行为。
 */
import { useCallback, useRef } from 'react';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

export interface PinchZoomOptions {
  onPan: (dx: number, dy: number) => void;
  onPinch: (ratio: number, midX: number, midY: number, midDx: number, midDy: number) => void;
  onMoved?: () => void;
}

interface Point { x: number; y: number }

export function usePinchZoom() {
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const prevPinchRef = useRef<{ dist: number; mx: number; my: number } | null>(null);
  const lastPanRef = useRef<Point | null>(null);

  const bind = useCallback((opts: PinchZoomOptions) => {
    const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

    const onPointerDown = (e: React.PointerEvent) => {
      if (!IS_TOUCH_PRIMARY || e.pointerType === 'mouse') return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 指针已失效则忽略 */ }
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointersRef.current.values()];
      if (pts.length === 2) {
        /* 第二指按下：以双指中点/距离为捏合基准，取消单指平移 */
        const [a, b] = pts;
        prevPinchRef.current = { dist: dist(a, b), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        lastPanRef.current = null;
      } else if (pts.length === 1) {
        lastPanRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const onPointerMove = (e: React.PointerEvent) => {
      const prev = pointersRef.current.get(e.pointerId);
      if (!prev) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointersRef.current.values()];
      if (pts.length >= 2 && prevPinchRef.current) {
        const [a, b] = pts;
        const d = dist(a, b);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (d > 0) {
          const ratio = d / prevPinchRef.current.dist;
          const midDx = mx - prevPinchRef.current.mx;
          const midDy = my - prevPinchRef.current.my;
          if (ratio !== 1 || midDx !== 0 || midDy !== 0) opts.onMoved?.();
          opts.onPinch(ratio, mx, my, midDx, midDy);
        }
        prevPinchRef.current = { dist: d, mx, my };
        return;
      }
      if (pts.length === 1 && lastPanRef.current) {
        const dx = e.clientX - lastPanRef.current.x;
        const dy = e.clientY - lastPanRef.current.y;
        if (dx !== 0 || dy !== 0) {
          opts.onMoved?.();
          opts.onPan(dx, dy);
        }
        lastPanRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const onPointerUp = (e: React.PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) prevPinchRef.current = null;
      if (pointersRef.current.size === 0) lastPanRef.current = null;
      else if (pointersRef.current.size === 1) {
        /* 双指松开一指：剩余指重新作为平移起点 */
        const [p] = [...pointersRef.current.values()];
        lastPanRef.current = { x: p.x, y: p.y };
      }
    };

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
  }, []);

  return { bind };
}
