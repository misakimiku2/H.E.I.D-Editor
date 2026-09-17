import { describe, expect, it } from 'vitest';
import {
  SVG_SPLIT_DEFAULT_RATIO, SVG_SPLIT_MAX_RATIO, SVG_SPLIT_MIN_RATIO,
  clampSvgSplitRatio, loadSvgSplitRatio, saveSvgSplitRatio, splitRatioFromClientX,
} from './svgLayout';

describe('clampSvgSplitRatio', () => {
  it('钳制到 [0.2, 0.8] 并收敛浮点尘埃', () => {
    expect(clampSvgSplitRatio(0.1)).toBe(SVG_SPLIT_MIN_RATIO);
    expect(clampSvgSplitRatio(0.9)).toBe(SVG_SPLIT_MAX_RATIO);
    expect(clampSvgSplitRatio(0.4)).toBe(0.4);
    expect(clampSvgSplitRatio(0.5500001)).toBe(0.55);
  });

  it('非有限值回退默认 0.55', () => {
    expect(clampSvgSplitRatio(NaN)).toBe(SVG_SPLIT_DEFAULT_RATIO);
    expect(clampSvgSplitRatio(Infinity)).toBe(SVG_SPLIT_DEFAULT_RATIO);
  });
});

describe('splitRatioFromClientX', () => {
  it('指针 x 换算为工作台内的宽度占比', () => {
    /* 工作台 [100, 500)，指针在 300 → 占比 0.5 */
    expect(splitRatioFromClientX(300, 100, 400)).toBe(0.5);
  });

  it('越界自动钳制（宽度非法时回退默认）', () => {
    expect(splitRatioFromClientX(50, 100, 400)).toBe(SVG_SPLIT_MIN_RATIO);
    expect(splitRatioFromClientX(600, 100, 400)).toBe(SVG_SPLIT_MAX_RATIO);
    expect(splitRatioFromClientX(0, 100, 0)).toBe(SVG_SPLIT_DEFAULT_RATIO);
  });
});

describe('持久化', () => {
  it('保存后读取往返一致；未保存时回默认', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    } as Storage;
    expect(loadSvgSplitRatio(fake)).toBe(SVG_SPLIT_DEFAULT_RATIO);
    saveSvgSplitRatio(0.7, fake);
    expect(loadSvgSplitRatio(fake)).toBe(0.7);
    /* 越界值在读取时也被钳制 */
    saveSvgSplitRatio(5, fake);
    expect(loadSvgSplitRatio(fake)).toBe(SVG_SPLIT_MAX_RATIO);
  });
});
