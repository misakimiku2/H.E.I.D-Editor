/**
 * 颜色字面量识别与保格式序列化（纯函数，不依赖 CodeMirror）：
 * 支持 hex（3/4/6/8 位）、rgb()/rgba()、hsl()/hsla()（逗号与现代空格写法、百分比）。
 * 序列化保持原写法的「格式家族」：#abc 尽量回 3 位、RGB() 保持大写、
 * rgb() 不擅自变 rgba()——只有 alpha 真的调到 <1 才升级为带 alpha 的写法。
 */
import { type Rgba, type Rgb, clampByte, clamp01, formatAlpha, rgbToHsl, hslToRgb } from './colorMath';

export interface LiteralStyle {
  kind: 'hex' | 'rgb' | 'hsl';
  /** hex 位数（3/4/6/8）；函数式固定 6（占位，不参与序列化） */
  digits: number;
  /** 原文大小写风格（hex 字母 / 函数名任一大写字母即视为大写） */
  upper: boolean;
  /** 原文带 alpha 槽（rgba()/hsla()、4/8 位 hex、`/ alpha`） */
  hasAlpha: boolean;
  /** 函数式为现代空格写法 `rgb(1 2 3 / .5)`（hex 恒为 false，可省略） */
  spaceSyntax?: boolean;
  /** rgb 三通道均为百分比（可省略） */
  percent?: boolean;
}

export interface ColorLiteral {
  from: number;
  to: number;
  rgba: Rgba;
  style: LiteralStyle;
}

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(%?)$/;

interface NumArg { v: number; pct: boolean }

function parseArg(raw: string): NumArg | null {
  const m = NUM_RE.exec(raw.trim());
  if (!m) return null;
  return { v: parseFloat(m[1]), pct: m[2] === '%' };
}

const HEX_SHAPE = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function parseHex(raw: string): { rgba: Rgba; style: LiteralStyle } | null {
  const run = raw.slice(1);
  if (!HEX_SHAPE.test(run)) return null;
  const len = run.length;
  const nib = (i: number) => parseInt(run[i], 16) * 0x11;
  const byte = (i: number) => parseInt(run.slice(i, i + 2), 16);
  const r = len <= 4 ? nib(0) : byte(0);
  const g = len <= 4 ? nib(1) : byte(2);
  const b = len <= 4 ? nib(2) : byte(4);
  const a = len === 4 || len === 8 ? (len === 4 ? nib(3) : byte(6)) / 255 : 1;
  return {
    rgba: { r, g, b, a },
    style: {
      kind: 'hex', digits: len, upper: /[A-F]/.test(run),
      hasAlpha: len === 4 || len === 8, spaceSyntax: false, percent: false,
    },
  };
}

function parseFunction(raw: string): { rgba: Rgba; style: LiteralStyle } | null {
  const m = /^([a-zA-Z]+)\s*\(([\s\S]*)\)$/.exec(raw);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const isRgb = name === 'rgb' || name === 'rgba';
  const isHsl = name === 'hsl' || name === 'hsla';
  if (!isRgb && !isHsl) return null;
  const body = m[2];

  /* 两种参数写法：逗号 `r, g, b[, a]`；现代空格 `r g b[/ a]` */
  let args: NumArg[];
  let alpha: NumArg | null = null;
  let spaceSyntax = false;
  if (body.includes(',')) {
    const parts = body.split(',');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const parsed = parts.map(parseArg);
    if (parsed.some(a => a === null)) return null;
    args = parsed as NumArg[];
    if (parts.length === 4) alpha = args[3];
  } else {
    spaceSyntax = true;
    const [main, alphaPart] = body.split('/');
    const parsed = main.split(/\s+/).filter(Boolean).map(parseArg);
    if (parsed.length !== 3 || parsed.some(a => a === null)) return null;
    args = parsed as NumArg[];
    if (alphaPart !== undefined) alpha = parseArg(alphaPart);
  }
  if (args.slice(0, 3).some(a => a === null)) return null;
  const hasAlpha = alpha !== null || name.length > 3;
  const [a0, a1, a2] = args as [NumArg, NumArg, NumArg];

  let rgbOut: Rgb;
  let percent = false;
  if (isRgb) {
    if (a0.pct && a1.pct && a2.pct) percent = true;
    const ch = (x: NumArg) => clampByte(x.pct ? (x.v / 100) * 255 : x.v);
    rgbOut = { r: ch(a0), g: ch(a1), b: ch(a2) };
  } else {
    if (a0.pct) return null; /* 色相不接受百分比 */
    rgbOut = hslToRgb({ h: ((a0.v % 360) + 360) % 360, s: clamp01(a1.pct ? a1.v / 100 : a1.v), l: clamp01(a2.pct ? a2.v / 100 : a2.v) });
  }
  const rgba: Rgba = { ...rgbOut, a: alpha ? clamp01(alpha.pct ? alpha.v / 100 : alpha.v) : 1 };
  return {
    rgba,
    style: {
      kind: isRgb ? 'rgb' : 'hsl', digits: 6, upper: /[A-Z]/.test(m[1]),
      hasAlpha, spaceSyntax, percent,
    },
  };
}

/** 单个字面量 → RGBA + 格式信息；不认识返回 null */
export function parseColorLiteral(raw: string): { rgba: Rgba; style: LiteralStyle } | null {
  if (raw.startsWith('#')) return parseHex(raw);
  return parseFunction(raw);
}

/** 扫描一段文本里的所有颜色字面量（按出现顺序、偏移为全文坐标） */
export function findColorLiterals(text: string): ColorLiteral[] {
  const out: ColorLiteral[] = [];
  const scan = /(#[0-9a-fA-F]+)|\b(rgba?|hsla?)\s*\(/gi;
  const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
  for (let m = scan.exec(text); m; m = scan.exec(text)) {
    if (m[1] !== undefined) {
      /* hex 必须是完整词：#define 的 `def`、5 位长度都不算 */
      const from = m.index;
      const to = from + m[1].length;
      if (isWord(text[from - 1]) || isWord(text[to])) continue;
      const parsed = parseColorLiteral(m[1]);
      if (parsed) out.push({ from, to, ...parsed });
    } else {
      const open = m.index + m[0].length - 1;
      const close = text.indexOf(')', open);
      if (close === -1) continue;
      const parsed = parseColorLiteral(text.slice(m.index, close + 1));
      if (parsed) out.push({ from: m.index, to: close + 1, ...parsed });
    }
  }
  return out;
}

function serializeHex(rgba: Rgba, style: LiteralStyle): string {
  const r = clampByte(rgba.r), g = clampByte(rgba.g), b = clampByte(rgba.b);
  const aByte = Math.round(clamp01(rgba.a) * 255);
  const nibbleShort = (v: number) => (v >> 4) === (v & 0xf);
  const rgbShort = nibbleShort(r) && nibbleShort(g) && nibbleShort(b);
  const wantAlpha = style.hasAlpha || aByte < 255;
  let digits: number;
  if (!wantAlpha) {
    digits = style.digits <= 4 && rgbShort ? 3 : 6;
  } else {
    digits = style.digits <= 4 && rgbShort && nibbleShort(aByte) ? 4 : 8;
  }
  let out: string;
  if (digits <= 4) {
    out = '#' + [r, g, b, ...(digits === 4 ? [aByte] : [])].map(v => (v >> 4).toString(16)).join('');
  } else {
    out = '#' + [r, g, b, ...(digits === 8 ? [aByte] : [])].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  return style.upper ? out.toUpperCase() : out;
}

function serializeFunction(rgba: Rgba, style: LiteralStyle): string {
  const r = clampByte(rgba.r), g = clampByte(rgba.g), b = clampByte(rgba.b);
  const a = clamp01(rgba.a);
  const emitAlpha = style.hasAlpha || a < 1;
  const toUpper = (s: string) => (style.upper ? s.toUpperCase() : s);
  /* 逗号写法 alpha 升级用 rgba()/hsla() 名；现代空格写法按 CSS Color 4 规范形式保持 rgb/hsl 名 + 斜杠 */
  const base = toUpper(style.kind === 'rgb' ? 'rgb' : 'hsl');
  const name = emitAlpha && !style.spaceSyntax ? toUpper(base + 'a') : base;

  let chans: string[];
  if (style.kind === 'rgb' && style.percent) {
    chans = [r, g, b].map(v => `${Math.round((v / 255) * 100)}%`);
  } else if (style.kind === 'rgb') {
    chans = [String(r), String(g), String(b)];
  } else {
    const hsl = rgbToHsl({ r, g, b });
    chans = [String(Math.round(hsl.h)), `${Math.round(hsl.s * 100)}%`, `${Math.round(hsl.l * 100)}%`];
  }

  const sep = style.spaceSyntax ? ' ' : ', ';
  const alphaPart = !emitAlpha ? '' : style.spaceSyntax ? ` / ${formatAlpha(a)}` : `, ${formatAlpha(a)}`;
  return `${toUpper(name)}(${chans.join(sep)}${alphaPart})`;
}

/** 按原格式家族回写（规则见文件头注释） */
export function serializeColorLiteral(rgba: Rgba, style: LiteralStyle): string {
  if (style.kind === 'hex') return serializeHex(rgba, style);
  return serializeFunction(rgba, style);
}

export type { Rgb };
