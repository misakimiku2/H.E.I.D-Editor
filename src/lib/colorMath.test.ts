import { describe, it, expect } from 'vitest';
import {
  rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb, cssColor,
  type Rgba,
} from './colorMath';

describe('rgbToHsv', () => {
  it('纯红 → h=0 s=1 v=1', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
  });
  it('绿色 → h=120', () => {
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
  });
  it('蓝色 → h=240', () => {
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 });
  });
  it('白色/黑色/灰色 s=0', () => {
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, v: 128 / 255 });
  });
});

describe('hsvToRgb', () => {
  it('基础色往返', () => {
    expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
    expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
    expect(hsvToRgb({ h: 0, s: 0, v: 1 })).toEqual({ r: 255, g: 255, b: 255 });
    expect(hsvToRgb({ h: 0, s: 0, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
  });
  it('h=360 等价 h=0', () => {
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
  });
});

describe('RGB↔HSV 往返', () => {
  it('任意颜色往返误差 ≤ 1', () => {
    const samples = [
      { r: 78, g: 201, b: 176 }, { r: 206, g: 145, b: 120 },
      { r: 1, g: 2, b: 3 }, { r: 254, g: 253, b: 0 }, { r: 12, g: 34, b: 56 },
    ];
    for (const rgb of samples) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
});

describe('hslToRgb', () => {
  it('标准值', () => {
    expect(hslToRgb({ h: 120, s: 0.5, l: 0.5 })).toEqual({ r: 64, g: 191, b: 64 });
    expect(hslToRgb({ h: 0, s: 1, l: 0.5 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hslToRgb({ h: 240, s: 0, l: 1 })).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('rgbToHsl', () => {
  it('标准值', () => {
    const hsl = rgbToHsl({ r: 64, g: 191, b: 64 });
    expect(hsl.h).toBeCloseTo(120, 5);
    expect(hsl.s).toBeCloseTo(0.5, 2);
    expect(hsl.l).toBeCloseTo(0.5, 3);
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, l: 0.5 });
  });
});

describe('cssColor', () => {
  it('不透明 → rgb()，带透明 → rgba()', () => {
    const c: Rgba = { r: 12, g: 34, b: 56, a: 1 };
    expect(cssColor(c)).toBe('rgb(12, 34, 56)');
    expect(cssColor({ ...c, a: 0.5 })).toBe('rgba(12, 34, 56, 0.5)');
  });
});
