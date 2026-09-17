/**
 * SVG 源码解析（手术式写回的基石）：
 * 1) 轻量 XML 扫描器带位置追踪地扫一遍标签流，栈式配对产出每个元素的源码区间 [start, end)（先序）；
 * 2) DOMParser（image/svg+xml，严格 XML）建权威树；
 * 3) 两条序列都按先序排列，逐位 zip 到一起。
 * 任何一步对不上（畸形 XML / 计数不一致 / 无 svg 根）返回 null，调用方降级为纯预览。
 * 扫描器只认标签结构不建树：文本与属性值里 XML 禁止裸 `<`，按 `<` 分割是安全的。
 */

export interface SvgElementInfo {
  /** 权威树中的元素（与 DOMParser 产物同一对象） */
  node: Element;
  /** 源码中开标签 `<` 的偏移 */
  start: number;
  /** 源码中闭合标签 `>` 之后（自闭合即 `/>` 之后）的偏移 */
  end: number;
}

export interface SvgParseResult {
  /** 权威 DOM（未 sanitize；修改与序列化都发生在它身上） */
  dom: XMLDocument;
  /** 全部元素，先序（与 dom.getElementsByTagName('*') 同序） */
  elements: SvgElementInfo[];
}

/** 跳过一段以 `>` 结束的结构（声明/PI/注释等）；遇到引号/CDATA 段先整段吃掉 */
function skipStruct(src: string, i: number, len: number): number {
  while (i < len) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return len;
      i = end + 1;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      i = end === -1 ? len : end + 3;
    } else if (ch === '>') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return len;
}

/** 扫描开标签：返回自闭合标记的 `>` 之后偏移；未闭合到 EOF 返回 -1 */
function scanOpenTagEnd(src: string, i: number, len: number): { end: number; selfClosing: boolean } {
  while (i < len) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return { end: -1, selfClosing: false };
      i = end + 1;
    } else if (ch === '>') {
      /* 回看判断 `/>`：跳过 `>` 前的空白 */
      let j = i - 1;
      while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j -= 1;
      return { end: i + 1, selfClosing: src[j] === '/' };
    } else {
      i += 1;
    }
  }
  return { end: -1, selfClosing: false };
}

interface OpenEntry {
  start: number;
  index: number;
}

export function parseSvg(source: string): SvgParseResult | null {
  const len = source.length;

  /* ---- 第一遍：扫描标签流，产出先序区间 ---- */
  const starts: OpenEntry[] = [];
  const spans: { start: number; end: number }[] = [];
  const stack: OpenEntry[] = [];
  let i = 0;
  while (i < len) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    if (source.startsWith('</', lt)) {
      const top = stack.pop();
      if (!top) return null; /* 多余的闭合标签：未配对，放弃 */
      const close = skipStruct(source, lt + 2, len);
      if (close >= len && source[close - 1] !== '>') return null;
      spans[top.index] = { start: top.start, end: close };
      i = close;
    } else if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      i = end === -1 ? len : end + 3;
    } else if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      i = skipStruct(source, lt + 2, len);
    } else {
      const { end, selfClosing } = scanOpenTagEnd(source, lt + 1, len);
      if (end === -1) return null; /* 开标签未闭合 */
      const index = starts.length;
      starts.push({ start: lt, index });
      if (selfClosing) {
        spans[index] = { start: lt, end };
      } else {
        stack.push({ start: lt, index });
      }
      i = end;
    }
  }
  if (stack.length > 0) return null; /* 有开标签没等到闭合 */
  if (starts.length === 0) return null; /* 一个元素都没有 */

  /* ---- 第二遍：权威 DOM ---- */
  let dom: XMLDocument;
  try {
    dom = new DOMParser().parseFromString(source, 'image/svg+xml');
  } catch {
    return null;
  }
  if (dom.getElementsByTagName('parsererror').length > 0) return null;
  const all = dom.getElementsByTagName('*');
  if (all.length !== starts.length) return null; /* 扫描器与 DOM 元素计数不一致 */
  if (!all[0] || all[0].tagName !== 'svg') return null; /* 根不是 svg */

  const elements: SvgElementInfo[] = new Array(starts.length);
  for (let k = 0; k < starts.length; k++) {
    elements[k] = { node: all[k], start: starts[k].start, end: spans[k].end };
  }
  return { dom, elements };
}
