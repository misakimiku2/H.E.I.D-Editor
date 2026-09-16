/**
 * 标签拖拽纯逻辑(不触 DOM):插入点计算与数组移动。
 * 拖拽 UI 与指针事件在 components/TabBar,跨窗口编排在 App。
 */

/** 进入拖拽的位移阈值(px):低于此值的松手仍是普通点击切换 */
export const DRAG_THRESHOLD_PX = 6;

export interface RectLike {
  left: number;
  right: number;
}

/**
 * 指针 x 在标签条上的插入位置,返回 0..n(n=rects.length),语义「插到 rects[i] 之前」。
 * 以每个标签的水平中点为界:x < 中点落在该标签前,否则落在其后。
 */
export function insertionIndex(rects: RectLike[], x: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x < (r.left + r.right) / 2) return i;
  }
  return rects.length;
}

/**
 * 把 from 位置的元素移动到插入点 to(插入点按「含被拖元素」的列表坐标计,
 * 与 insertionIndex 的返回值直接配合)。返回新数组;位置无变化或 from 越界返回 null,
 * 调用方以 null 跳过重排,避免无意义的 setState 提交。
 */
export function applyMove<T>(arr: T[], from: number, to: number): T[] | null {
  if (from < 0 || from >= arr.length) return null;
  const t = to > from ? to - 1 : to;
  if (t === from) return null;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(t, 0, item);
  return next;
}
