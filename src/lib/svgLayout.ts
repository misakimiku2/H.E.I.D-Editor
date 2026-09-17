/**
 * SVG 工作台布局：编辑区|预览区分隔条的宽度状态。
 * 对齐文件树侧栏的模式：lib 纯函数钳制/换算，组件拖拽实时更新、释放时持久化（全局）。
 */

export const SVG_SPLIT_MIN_RATIO = 0.2;
export const SVG_SPLIT_MAX_RATIO = 0.8;
export const SVG_SPLIT_DEFAULT_RATIO = 0.55;

const STORAGE_KEY = 'heid-svg-split-ratio';

/** 收敛到 [0.2, 0.8]，两位小数；非有限值回退默认 */
export function clampSvgSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SVG_SPLIT_DEFAULT_RATIO;
  return Math.min(
    SVG_SPLIT_MAX_RATIO,
    Math.max(SVG_SPLIT_MIN_RATIO, Math.round(ratio * 100) / 100),
  );
}

/** 指针 clientX → 编辑区宽度占比（相对工作台起点与总宽），越界/非法自动收敛 */
export function splitRatioFromClientX(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return SVG_SPLIT_DEFAULT_RATIO;
  return clampSvgSplitRatio((clientX - left) / width);
}

export function loadSvgSplitRatio(storage: Storage | null = defaultStorage()): number {
  try {
    const raw = storage?.getItem(STORAGE_KEY) ?? null;
    const parsed = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) return clampSvgSplitRatio(parsed);
  } catch { /* 忽略持久化失败 */ }
  return SVG_SPLIT_DEFAULT_RATIO;
}

export function saveSvgSplitRatio(ratio: number, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, String(clampSvgSplitRatio(ratio)));
  } catch { /* 忽略持久化失败 */ }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
