/**
 * 浮层定位（纯函数）：把锚点（通常是弹出瞬间的鼠标位置）钳制为
 * 完整容纳 w×h 浮层的视口坐标——优先出现在锚点右下方，放不下则翻到左/上方。
 */

export function clampBarPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  gap = 10,
): { left: number; top: number } {
  const margin = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  /* 锚点无效（指针未移动过）：落在视口右上区域 */
  if (x < 0 || y < 0) {
    return { left: Math.max(margin, vw - width - 16), top: 12 };
  }
  let left = x + gap;
  let top = y + gap;
  if (left + width + margin > vw) left = x - width - gap;
  if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
  if (left < margin) left = margin;
  if (top + height + margin > vh) top = y - height - gap;
  if (top + height + margin > vh) top = Math.max(margin, vh - height - margin);
  if (top < margin) top = margin;
  return { left, top };
}
