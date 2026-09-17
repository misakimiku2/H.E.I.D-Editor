/**
 * 手术式源码写回：可视化编辑的一切改动最终都落成一小段「区间替换」补丁，
 * 由 applyPatches 从后往前套用——未触碰的源码（注释/缩进/兄弟元素）逐字节保留。
 */
import type { SvgElementInfo } from './svgParse';

export interface SourcePatch {
  start: number;
  end: number;
  text: string;
}

/** 补丁按 start 降序逐个套用（同区间内乱序传入也安全），偏移不失效 */
export function applyPatches(source: string, patches: SourcePatch[]): string {
  const sorted = [...patches].sort((a, b) => b.start - a.start);
  let out = source;
  for (const p of sorted) {
    out = out.slice(0, p.start) + p.text + out.slice(p.end);
  }
  return out;
}

/** 首个标签内引号感知地找 `>`（属性值可能含 `>`），返回其下标 */
function firstTagEnd(s: string): number {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const e = s.indexOf(ch, i + 1);
      if (e === -1) return s.length;
      i = e + 1;
    } else if (ch === '>') {
      return i;
    } else {
      i += 1;
    }
  }
  return s.length;
}

/**
 * 权威树元素序列化为替换补丁。XMLSerializer 会给非根元素补 `xmlns` 默认命名空间声明
 * 以保证孤立良构——在文档上下文里这是冗余的：仅当原源码本身没写它时剥掉
 * （嵌套 svg 等自带 xmlns 的元素原样保留）。
 */
export function elementPatch(source: string, el: SvgElementInfo): SourcePatch {
  let text = new XMLSerializer().serializeToString(el.node);
  const rootNs = el.node.ownerDocument.documentElement?.namespaceURI ?? '';
  const token = `xmlns="${rootNs}"`;
  const firstTag = text.slice(0, firstTagEnd(text));
  if (el.node !== el.node.ownerDocument.documentElement && firstTag.includes(token)) {
    const originalFirstTag = source.slice(el.start, el.start + firstTagEnd(source.slice(el.start, el.end)));
    if (!originalFirstTag.includes(token)) {
      /* 只剥第一个标签里的那一份；后面的 xmlns:xlink 等前缀声明不动 */
      text = text.replace(token + ' ', '').replace(token, '');
    }
  }
  return { start: el.start, end: el.end, text };
}

/**
 * 删除元素补丁：若元素（连同两侧空白）独占一行则整行吞掉（含缩进与换行），
 * 否则只删自身区间。根元素不可删，返回 null。
 */
export function deletePatch(source: string, el: SvgElementInfo): SourcePatch | null {
  if (el.node === el.node.ownerDocument.documentElement) return null;

  const lineStart = source.lastIndexOf('\n', el.start - 1) + 1;
  const nlAfter = source.indexOf('\n', el.end);
  const lineEnd = nlAfter === -1 ? source.length : nlAfter;
  const onlyWs = (s: string) => /^[ \t]*$/.test(s);
  const wholeLine = onlyWs(source.slice(lineStart, el.start)) && onlyWs(source.slice(el.end, lineEnd));

  if (wholeLine) {
    if (nlAfter !== -1) return { start: lineStart, end: nlAfter + 1, text: '' };
    /* 无尾随换行（文件末行）：连前导换行一起收掉 */
    return { start: lineStart > 0 ? lineStart - 1 : lineStart, end: lineEnd, text: '' };
  }
  return { start: el.start, end: el.end, text: '' };
}
