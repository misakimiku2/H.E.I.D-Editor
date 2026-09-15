import { describe, expect, it } from 'vitest';
import {
  computeMinimapMetrics,
  minimapCanvasDeviceSize,
  minimapLineY,
  minimapWidthFor,
  MINIMAP_DRAW_BUFFER_LINES,
  MINIMAP_LINE_PITCH,
  MINIMAP_MAX_CANVAS_DEVICE_PX,
  MINIMAP_PADDING,
} from './minimap';

const BOX_H = 800;
/** 一屏约 40 行、行高 20px 的常规编辑器视口 */
const SCROLLER_H = 800;
const LINE_H = 20;

function metrics(lineCount: number, scrollTop: number, opts: { boxHeight?: number; scrollerHeight?: number; scrollHeight?: number } = {}) {
  const scrollerHeight = opts.scrollerHeight ?? SCROLLER_H;
  const scrollHeight = opts.scrollHeight ?? lineCount * LINE_H;
  return computeMinimapMetrics({
    lineCount,
    boxHeight: opts.boxHeight ?? BOX_H,
    scrollerHeight,
    scrollHeight,
    scrollTop,
  });
}

describe('minimap', () => {
  it('宽度按编辑器宽度 8% 计算并夹在 [60, 170]', () => {
    expect(minimapWidthFor(100)).toBe(60);
    expect(minimapWidthFor(1000)).toBe(80);
    expect(minimapWidthFor(1600)).toBe(128);
    expect(minimapWidthFor(4000)).toBe(170);
    expect(minimapWidthFor(Number.NaN)).toBe(60);
  });

  it('画布设备尺寸只跟容器高度与 dpr 有关，永不接近 65535 上限', () => {
    for (const boxHeight of [120, 400, 800, 1440, 2160, 4000]) {
      for (const dpr of [1, 1.25, 1.5, 2, 3, 4]) {
        const { width, height } = minimapCanvasDeviceSize(158, boxHeight, dpr);
        expect(height).toBe(Math.round(boxHeight * dpr));
        expect(height).toBeLessThanOrEqual(MINIMAP_MAX_CANVAS_DEVICE_PX);
        expect(width).toBeGreaterThan(0);
      }
    }
    /* 极端但合法的容器高度也不越界 */
    expect(minimapCanvasDeviceSize(158, 20000, 1).height).toBeLessThanOrEqual(MINIMAP_MAX_CANVAS_DEVICE_PX);
  });

  it('小文档：窗口从第 1 行开始、无窗口滚动，逻辑高度不小于容器高度', () => {
    const m = metrics(50, 0);
    expect(m.firstLine).toBe(1);
    expect(m.lastLine).toBe(50);
    expect(m.windowScrollTop).toBe(0);
    expect(m.contentHeight).toBe(BOX_H);
    expect(m.viewportTop).toBe(0);
    expect(m.viewportHeight).toBeGreaterThan(0);
  });

  it('大文档：行窗口大小与文档规模无关', () => {
    const bound = Math.ceil(BOX_H / MINIMAP_LINE_PITCH) + MINIMAP_DRAW_BUFFER_LINES * 2 + 2;
    for (const lineCount of [1_000, 10_000, 100_000, 1_000_000, 10_000_000]) {
      const mid = metrics(lineCount, (lineCount * LINE_H - SCROLLER_H) / 2);
      expect(mid.lastLine - mid.firstLine + 1).toBeLessThanOrEqual(bound);
      expect(mid.firstLine).toBeGreaterThanOrEqual(1);
      expect(mid.lastLine).toBeLessThanOrEqual(lineCount);
    }
  });

  it('行窗口完整覆盖画布（上下不留空白带）', () => {
    for (const lineCount of [5_000, 200_000, 2_000_000]) {
      const maxScroll = Math.max(0, lineCount * LINE_H - SCROLLER_H);
      for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
        const m = metrics(lineCount, maxScroll * ratio);
        const topY = minimapLineY(m.firstLine, m.windowScrollTop);
        const bottomY = minimapLineY(m.lastLine, m.windowScrollTop) + MINIMAP_LINE_PITCH;
        /* 顶层留 1 个 padding 带（顶部 padding），其余位置必须被行窗口盖满 */
        expect(topY).toBeLessThanOrEqual(MINIMAP_PADDING);
        expect(bottomY).toBeGreaterThanOrEqual(BOX_H - MINIMAP_PADDING * 2);
      }
    }
  });

  it('窗口随滚动单调推进，滚到底部时贴住文档末尾', () => {
    const lineCount = 50_000;
    const maxScroll = lineCount * LINE_H - SCROLLER_H;
    const top = metrics(lineCount, 0);
    const mid = metrics(lineCount, maxScroll / 2);
    const bottom = metrics(lineCount, maxScroll);
    expect(top.windowScrollTop).toBe(0);
    expect(mid.windowScrollTop).toBeGreaterThan(top.windowScrollTop);
    expect(bottom.windowScrollTop).toBeGreaterThan(mid.windowScrollTop);
    expect(bottom.windowScrollTop).toBeLessThanOrEqual(bottom.contentHeight - BOX_H + 1e-6);
    /* 滑块有最小高度（MIN_VP_HEIGHT）：窗口不必顶到逻辑末尾，缺口不超过「一屏所占比例 × 逻辑高度」 */
    const visibleContentH = (SCROLLER_H / (lineCount * LINE_H)) * bottom.contentHeight;
    expect(bottom.contentHeight - BOX_H - bottom.windowScrollTop).toBeLessThanOrEqual(visibleContentH);
    expect(bottom.viewportTop + bottom.viewportHeight).toBeCloseTo(BOX_H, 6);
  });

  it('视口滑块与滚动位置成比例，且不超出画布', () => {
    const lineCount = 100_000;
    const maxScroll = lineCount * LINE_H - SCROLLER_H;
    const m = metrics(lineCount, maxScroll * 0.5);
    expect(m.viewportHeight).toBeGreaterThanOrEqual(Math.max(30, BOX_H * 0.08));
    expect(m.viewportTop).toBeGreaterThanOrEqual(0);
    expect(m.viewportTop + m.viewportHeight).toBeLessThanOrEqual(BOX_H + 1e-6);
  });

  it('滚动状态异常（未布局 / 越界 scrollTop）不产生 NaN 或负值', () => {
    const notLaidOut = metrics(100, 0, { scrollerHeight: 0, scrollHeight: 0 });
    expect(notLaidOut.windowScrollTop).toBe(0);
    expect(Number.isNaN(notLaidOut.contentHeight)).toBe(false);
    expect(notLaidOut.viewportTop).toBe(0);

    const over = metrics(1000, 10_000_000);
    expect(over.windowScrollTop).toBeLessThanOrEqual(over.contentHeight - BOX_H + 1e-6);
    expect(over.windowScrollTop).toBeGreaterThanOrEqual(0);

    const degenerate = computeMinimapMetrics({ lineCount: 0, boxHeight: 0, scrollerHeight: 0, scrollHeight: 0, scrollTop: -50 });
    expect(degenerate.firstLine).toBe(1);
    expect(degenerate.lastLine).toBeGreaterThanOrEqual(1);
    /* 行数至少按 1 计：逻辑高度退化为「1 行 + 上下 padding」，不出现负数或 NaN */
    expect(degenerate.contentHeight).toBe(MINIMAP_LINE_PITCH + MINIMAP_PADDING * 2);
    expect(degenerate.viewportTop).toBe(0);

    /* 行窗口两端永远落在 [1, lineCount]：调用方可以直接 doc.line(窗口) */
    const tinyBox = computeMinimapMetrics({ lineCount: 20, boxHeight: 8, scrollerHeight: 8, scrollHeight: 100000, scrollTop: 99999 });
    expect(tinyBox.firstLine).toBeGreaterThanOrEqual(1);
    expect(tinyBox.firstLine).toBeLessThanOrEqual(20);
    expect(tinyBox.lastLine).toBeLessThanOrEqual(20);
  });
});
