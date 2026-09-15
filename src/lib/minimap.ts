/**
 * 画布小地图的几何计算与降级阈值（纯函数，供 CodeEditor 使用）。
 *
 * 2026-09-15 实测结论（Edge/Blink 152 headless，与 WebView2 同内核，探针见 ROADMAP v1.2 第 30 项）：
 * - 单个 canvas 单边上限为 **65535 设备像素**：65535 可正常绘制，65536 起静默失效
 *   （宽度 60 / 158 / 316 / 1000、面积至 6555 万像素均不影响该上限）；
 * - 越界后的 canvas 元素 **永久失效**：再设置回合法尺寸也画不出内容，只有新建元素才恢复。
 *   旧实现 contentH = 行数 × 5px + padding 正是"每帧重设同一元素尺寸"，因此
 *   dpr=1 超过约 1.31 万行、dpr=2 超过约 6.55 千行以后，该标签页小地图会永久空白；
 * - 因此画布高度固定为容器可见高度（不再随行数增长），整篇高度只作为滚动映射的逻辑值，
 *   canvas 尺寸从此与文档规模无关（恒等于 boxHeight × dpr ≤ 视口高度 × dpr）。
 *
 * 2026-09-15 补充实测（同环境，样本 `node_modules/mermaid/dist/mermaid.js` = 12.7MB / 315,016 行 / 1330 万字符）：
 * - 语言扩展开着时，**打开瞬间语法树只覆盖 0.775%**（约 10 万字符，即视口附近），视口内正常着色；
 * - 逐块代价：整篇强制解析一次（等价于从头滚到尾的极端情况）滞留 ≈ 2.3 字节/字符
 *   （1330 万字符 ≈ 31MB，解析瞬时峰值 ≈ 128MB）；解析完整篇后仍只渲染约 500 个高亮片段。
 *   结论：「大文件」不必关闭语法高亮与小地图着色 —— 成本随"实际浏览过的区域"增长，而不是随文件大小。
 *   小地图着色因此只看"有没有语法树"（语言没加载时树为空 → 单色行条），未解析到的窗口先单色，
 *   解析推进时由 CodeEditor 的语法树监听补一次重绘（先单色、后着色）。
 */

/** 每行在小地图上的行块高度（CSS px） */
export const MINIMAP_BLOCK_HEIGHT = 3;
/** 行块之间的空隙（CSS px） */
export const MINIMAP_LINE_GAP = 2;
/** 行距 = 行块 + 空隙 */
export const MINIMAP_LINE_PITCH = MINIMAP_BLOCK_HEIGHT + MINIMAP_LINE_GAP;
/** 一个字符在小地图上的横向宽度（CSS px，近似值） */
export const MINIMAP_CHAR_WIDTH = 1.15;
/** 画布左右内边距（CSS px） */
export const MINIMAP_PADDING = 6;
/** 视口滑块最小高度（CSS px） */
export const MINIMAP_MIN_VIEWPORT_H = 30;
/** 小地图宽度范围（CSS px） */
export const MINIMAP_WIDTH_MIN = 60;
export const MINIMAP_WIDTH_MAX = 170;
/** 行窗口上下各多画的行数（滚动中避免窗口边缘出现空白） */
export const MINIMAP_DRAW_BUFFER_LINES = 15;

/** 实测的画布单边上限（设备像素）；仅用于测试断言与文档，绘制侧已不依赖它 */
export const MINIMAP_MAX_CANVAS_DEVICE_PX = 65535;

/** 小地图宽度：编辑器宽度的 8%，夹在 [60, 170] */
export function minimapWidthFor(editorWidth: number): number {
  const scaled = Math.round((Number.isFinite(editorWidth) ? editorWidth : 0) * 0.08);
  return Math.min(MINIMAP_WIDTH_MAX, Math.max(MINIMAP_WIDTH_MIN, scaled));
}

export interface MinimapMetricsInput {
  /** 文档总行数（至少 1） */
  lineCount: number;
  /** 小地图容器可见高度 = 画布高度（CSS px） */
  boxHeight: number;
  /** 编辑器滚动容器：可见高度（CSS px） */
  scrollerHeight: number;
  /** 编辑器滚动容器：内容总高度（CSS px） */
  scrollHeight: number;
  /** 编辑器滚动容器：当前滚动位置（CSS px） */
  scrollTop: number;
}

export interface MinimapMetrics {
  /** 整篇在小地图上的逻辑总高度（CSS px，含上下 padding；仅用于滚动映射） */
  contentHeight: number;
  /** 视口滑块（容器坐标系，CSS px） */
  viewportTop: number;
  viewportHeight: number;
  /** 画布内容纵向偏移：画布内 y = 逻辑 y - windowScrollTop */
  windowScrollTop: number;
  /** 需要绘制的行窗口（1-based，含端点，已夹在 [1, lineCount]） */
  firstLine: number;
  lastLine: number;
}

/** 行号 → 该行在画布内的 y（CSS px；可为负，表示在窗口上方，由容器裁剪） */
export function minimapLineY(line: number, windowScrollTop: number): number {
  return MINIMAP_PADDING + (line - 1) * MINIMAP_LINE_PITCH - windowScrollTop;
}

/**
 * 画布后端存储尺寸（设备像素）：只与容器高度和 dpr 有关，**与文档行数无关**。
 * 这是画布永不触碰 65535 上限的结构性保证（视口高度 × dpr 远小于上限）。
 */
export function minimapCanvasDeviceSize(displayWidth: number, boxHeight: number, dpr: number): { width: number; height: number } {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const w = Number.isFinite(displayWidth) ? displayWidth : 0;
  const h = Number.isFinite(boxHeight) ? boxHeight : 0;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** 由滚动状态推导小地图的窗口与滑块几何（窗口只覆盖可见区域，与文档规模无关） */
export function computeMinimapMetrics(input: MinimapMetricsInput): MinimapMetrics {
  const lineCount = Math.max(1, Math.floor(input.lineCount) || 1);
  const boxHeight = Math.max(0, input.boxHeight);
  const scrollerHeight = Math.max(0, input.scrollerHeight);
  const scrollHeight = Math.max(0, input.scrollHeight);
  const scrollTop = Math.max(0, Math.min(input.scrollTop, Math.max(0, scrollHeight - scrollerHeight)));

  const contentHeight = Math.max(lineCount * MINIMAP_LINE_PITCH + MINIMAP_PADDING * 2, boxHeight);
  const maxScroll = Math.max(0, scrollHeight - scrollerHeight);

  const naturalVpH = scrollHeight > 0 ? (scrollerHeight / scrollHeight) * boxHeight : boxHeight;
  const viewportHeight = Math.min(boxHeight, Math.max(naturalVpH, Math.max(MINIMAP_MIN_VIEWPORT_H, boxHeight * 0.08)));
  const viewportTop = maxScroll > 0
    ? (scrollTop / maxScroll) * Math.max(0, boxHeight - viewportHeight)
    : 0;

  const vpYInContent = scrollHeight > 0 ? (scrollTop / scrollHeight) * contentHeight : 0;
  const maxWindowScroll = Math.max(0, contentHeight - boxHeight);
  const windowScrollTop = maxWindowScroll > 0
    ? Math.max(0, Math.min(maxWindowScroll, vpYInContent - viewportTop))
    : 0;

  const firstLine = Math.floor((windowScrollTop - MINIMAP_PADDING) / MINIMAP_LINE_PITCH) + 1 - MINIMAP_DRAW_BUFFER_LINES;
  const lastLine = Math.ceil((windowScrollTop + boxHeight - MINIMAP_PADDING) / MINIMAP_LINE_PITCH) + MINIMAP_DRAW_BUFFER_LINES;

  return {
    contentHeight,
    viewportTop,
    viewportHeight,
    windowScrollTop,
    /* 两端都夹进 [1, lineCount]：调用方据此直接取 doc.line()，不需要再做防御 */
    firstLine: Math.min(Math.max(1, firstLine), lineCount),
    lastLine: Math.min(lineCount, Math.max(1, lastLine)),
  };
}
