// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pngFileName } from './svgExport';

describe('pngFileName', () => {
  it('替换扩展名为 .png 并带倍率标注', () => {
    expect(pngFileName('icon.svg', 2)).toBe('icon@2x.png');
    expect(pngFileName('a.b.icon.SVG', 4)).toBe('a.b.icon@4x.png');
  });

  it('无扩展名直接追加', () => {
    expect(pngFileName('icon', 2)).toBe('icon@2x.png');
  });

  it('1 倍不标注倍率', () => {
    expect(pngFileName('icon.svg', 1)).toBe('icon.png');
  });
});
