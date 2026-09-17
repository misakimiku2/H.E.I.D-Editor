/**
 * SVG 调色板：扫描全文档 fill / stroke / stop-color（属性 + 内联 style 声明），
 * 按归一化颜色聚合成调色板；全局换色 = 逐个改权威树节点 → 手术式补丁一次成型。
 * 仅面向「直接颜色字面量」：none / url(#ref) / currentColor / inherit 不进调色板。
 */
import type { SvgParseResult } from './svgParse';
import { elementPatch, applyPatches } from './svgWrite';

const COLOR_ATTRS = ['fill', 'stroke', 'stop-color'] as const;

export interface ColorUse {
  /** 权威树先序下标 */
  idx: number;
  /** 颜色出处：属性名，或 style 声明里的属性名（inStyle = true） */
  attr: (typeof COLOR_ATTRS)[number];
  inStyle: boolean;
}

export interface PaletteEntry {
  /** 归一化颜色文本（小写、去空白） */
  color: string;
  count: number;
  uses: ColorUse[];
}

/** 可换色的直接颜色：排除 none / url() 引用 / CSS 关键字 */
function isSwappableColor(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (!s || s === 'none' || s === 'inherit' || s === 'currentcolor') return false;
  if (s.startsWith('url(') || s.startsWith('var(')) return false;
  return true;
}

const norm = (v: string) => v.trim().toLowerCase();

export function collectPalette(res: SvgParseResult): PaletteEntry[] {
  const byColor = new Map<string, PaletteEntry>();
  res.elements.forEach((el, idx) => {
    const node = el.node;
    const push = (attr: ColorUse['attr'], raw: string, inStyle: boolean) => {
      if (!isSwappableColor(raw)) return;
      const color = norm(raw);
      let entry = byColor.get(color);
      if (!entry) {
        entry = { color, count: 0, uses: [] };
        byColor.set(color, entry);
      }
      entry.count += 1;
      entry.uses.push({ idx, attr, inStyle });
    };
    for (const attr of COLOR_ATTRS) {
      const v = node.getAttribute(attr);
      if (v !== null) push(attr, v, false);
    }
    const style = node.getAttribute('style');
    if (style) {
      for (const decl of style.split(';')) {
        const colon = decl.indexOf(':');
        if (colon === -1) continue;
        const name = decl.slice(0, colon).trim().toLowerCase();
        if ((COLOR_ATTRS as readonly string[]).includes(name)) push(name as ColorUse['attr'], decl.slice(colon + 1), true);
      }
    }
  });
  return Array.from(byColor.values());
}

/** style 属性里只替换对应声明的值，其余声明逐字保留 */
function replaceInStyle(style: string, attr: string, next: string): string {
  return style
    .split(';')
    .map(decl => {
      const colon = decl.indexOf(':');
      if (colon === -1) return decl;
      if (decl.slice(0, colon).trim().toLowerCase() !== attr) return decl;
      return `${decl.slice(0, colon)}:${next}`;
    })
    .join(';');
}

/** 全局换色：改权威树 → 受影响元素补丁从后往前套用，一步写回 */
export function replaceColor(source: string, res: SvgParseResult, color: string, next: string): string {
  const entry = collectPalette(res).find(e => e.color === norm(color));
  if (!entry) return source;
  for (const use of entry.uses) {
    const node = res.elements[use.idx].node;
    if (use.inStyle) {
      const style = node.getAttribute('style');
      if (style !== null) node.setAttribute('style', replaceInStyle(style, use.attr, next));
    } else {
      node.setAttribute(use.attr, next);
    }
  }
  /* 同一元素可能承载多处替换：去重后按区间从后往前 */
  const idxs = Array.from(new Set(entry.uses.map(u => u.idx)));
  const patches = idxs.map(idx => elementPatch(source, res.elements[idx]));
  return applyPatches(source, patches);
}
