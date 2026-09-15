/**
 * 色彩空间纯函数：RGB / HSV / HSL 互转与 CSS 字符串生成。
 * 全部无副作用，取色器浮层与颜色字面量解析共用。
 */

export interface Rgb { r: number; g: number; b: number }
/** r/g/b ∈ [0,255]，a ∈ [0,1] */
export interface Rgba extends Rgb { a: number }
/** h ∈ [0,360]，s/v ∈ [0,1] */
export interface Hsv { h: number; s: number; v: number }
/** h ∈ [0,360]，s/l ∈ [0,1] */
export interface Hsl { h: number; s: number; l: number }

export const clampByte = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** alpha → 最短字符串：1 / 0.5 / 0.3（最多 3 位小数，去尾零） */
export function formatAlpha(a: number): string {
  return Number(clamp01(a).toFixed(3)).toString();
}

function hueOf(r: number, g: number, b: number, max: number, delta: number): number {
  if (delta === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const delta = max - Math.min(rn, gn, bn);
  return {
    h: hueOf(rn, gn, bn, max, delta),
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(hh / 60) % 6;
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [rr, gg, bb] = table[seg];
  return { r: clampByte((rr + m) * 255), g: clampByte((gg + m) * 255), b: clampByte((bb + m) * 255) };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h: hueOf(rn, gn, bn, max, delta), s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hh / 60) % 6;
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [rr, gg, bb] = table[seg];
  return { r: clampByte((rr + m) * 255), g: clampByte((gg + m) * 255), b: clampByte((bb + m) * 255) };
}

/** 画布 / 渐变用的 CSS 字符串：不透明 → rgb()，带透明 → rgba() */
export function cssColor({ r, g, b, a }: Rgba): string {
  const base = `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
  return a >= 1 ? `rgb(${base})` : `rgba(${base}, ${formatAlpha(a)})`;
}
