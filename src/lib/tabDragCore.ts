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
 * 三分位悬停判定(占位符语义):指针落在某标签左/右三分之一内 → 插到其前/后;
 * 悬在中间三分之一 → 粘滞保持 prev(防抖,占位符不闪烁)。无命中返回 prev。
 */
export function gapIndexFromRects(rects: RectLike[], x: number, prev: number): number {
  for (let i = 0; i < rects.length; i++) {
    const { left, right } = rects[i];
    const w = right - left;
    if (x < left) return i;                    /* 落在间隙 → 插到本标签前 */
    if (x <= left + w * 0.33) return i;        /* 左 1/3 → 前 */
    if (x > right) continue;                   /* 越过本标签,看下一个 */
    if (x >= right - w * 0.33) return i + 1;   /* 右 1/3 → 后 */
    /* 中 1/3:粘滞保持 prev(紧邻本标签时),否则就近 */
    if (prev === i || prev === i + 1) return prev;
    return x < left + w * 0.5 ? i : i + 1;
  }
  return rects.length;                          /* 越出最右 → 末尾 */
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

/* ---- 自家拖拽的收尾防护与让位几何(源标签保持原位半透明,不折叠) ---- */

/** dragend 历时下限(ms):真拖拽(OLE 起步 + 移动 + 松手)远超此值 */
export const DRAGEND_MIN_MS = 200;

/**
 * dragend 是否异常早到:Chromium 在拖拽源被同步折叠/隐藏等情形下会立即中止
 * 拖拽循环,dragend 在鼠标未松时触发;此时不能按「松手」收尾(会误脱离成窗),
 * 应按取消处理。
 */
export function isPrematureDragEnd(startedAtMs: number, endedAtMs: number): boolean {
  return endedAtMs - startedAtMs < DRAGEND_MIN_MS;
}

/** 落点空隙是否可见:dropIndex(非拖标签坐标)回到原位时无空隙 */
export function ownGapVisible(dropIndex: number, startIndex: number): boolean {
  return dropIndex !== startIndex;
}

/** 让位位移:显示空隙时,序号(非拖标签坐标) >= dropIndex 的标签右移一个占位宽 */
export function ownShiftFor(collapsedIdx: number, dropIndex: number, startIndex: number, gapW: number): number {
  return dropIndex !== startIndex && collapsedIdx >= dropIndex ? gapW : 0;
}

/**
 * 被拖标签自身的滑动位移(Chrome 式重排视觉):按 dragstart 时刻的各标签宽度,
 * 计算落点槽位(p,非拖标签坐标)相对原位(startIndex)的水平偏移。
 * p 回到原位时为 0;配合 CSS transition 即为标签平滑滑入落点的效果。
 */
export function ownSlideOffsetX(widths: number[], startIndex: number, dropIndex: number, gap: number): number {
  let originalLeft = 0;
  for (let i = 0; i < startIndex; i++) originalLeft += widths[i] + gap;
  let slotLeft = 0;
  let taken = 0;
  for (let i = 0; i < widths.length && taken < dropIndex; i++) {
    if (i === startIndex) continue;
    slotLeft += widths[i] + gap;
    taken += 1;
  }
  return slotLeft - originalLeft;
}

/**
 * dropIndex(非拖标签坐标,gapIndexFromRects 的返回值)→ applyMove 所需的
 * 「含被拖标签」插入点坐标。右移时差一:插到非拖标签第 i 个之前 = 含拖坐标 i+1。
 */
export function ownDropIndexOf(dropIndex: number, startIndex: number): number {
  return dropIndex > startIndex ? dropIndex + 1 : dropIndex;
}
