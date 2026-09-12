/**
 * 查找引擎（纯函数）：在文档字符串上扫描匹配区间，供查找栏计数、导航与替换使用。
 * 支持普通文本 / 正则、大小写敏感、全词匹配；返回不重叠且升序的匹配区间。
 * 性能护栏：匹配数与扫描字符数设上限，避免超大文档下 UI 卡死。
 */

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

export interface MatchRange {
  from: number;
  to: number;
}

export interface ScanResult {
  matches: MatchRange[];
  /** 命中数达到上限，实际数量更多 */
  capped: boolean;
  /** 正则表达式非法等原因导致无法扫描 */
  error: string | null;
}

/** 单次扫描的匹配数上限（达到即停止，UI 显示 5000+） */
export const MAX_MATCHES = 5000;
/** 单次扫描的字符上限（超出部分不扫描） */
export const MAX_SCAN_CHARS = 2_000_000;

/** 单次重扫的文档规模上限：超过则仅在查询变化时重扫，输入过程跳过 */
export const RESCAN_DOC_LIMIT = 5_000_000;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词字符（Unicode 字母/数字/下划线/$），全词匹配的边界判定用 */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{L}\p{N}_$]/u.test(ch);
}

interface CompiledPattern {
  regex: RegExp | null;
  error: string | null;
}

/** 构造用于单个匹配求替换结果的局部正则（无 g 标志，支持 $1 引用） */
function compileLocal(opts: SearchOptions): CompiledPattern {
  if (!opts.regexp) {
    const source = opts.wholeWord
      ? `(?<![\\p{L}\\p{N}_$])${escapeRegExp(opts.query)}(?![\\p{L}\\p{N}_$])`
      : escapeRegExp(opts.query);
    try {
      return { regex: new RegExp(source, opts.caseSensitive ? '' : 'iu'), error: null };
    } catch (e) {
      return { regex: null, error: String(e) };
    }
  }
  try {
    return {
      regex: new RegExp(opts.query, opts.caseSensitive ? '' : 'iu'),
      error: null,
    };
  } catch (e) {
    return { regex: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 扫描 [start, end) 区间内的全部匹配。
 * 普通文本走 indexOf 顺序扫描；正则走全局正则迭代；零宽匹配一律跳过。
 */
export function findMatches(
  text: string,
  opts: SearchOptions,
  start = 0,
  end: number = text.length,
): ScanResult {
  const matches: MatchRange[] = [];
  if (!opts.query) return { matches, capped: false, error: null };
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  /* 超大文档截断扫描（UI 不会传 start/end，此护栏兜底超大文件） */
  const scope = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const bound = Math.min(to, scope.length);
  if (from >= bound) return { matches, capped: false, error: null };

  const local = compileLocal(opts);
  if (!local.regex) return { matches, capped: false, error: local.error };

  if (!opts.regexp) {
    const haystack = opts.caseSensitive ? scope : scope.toLowerCase();
    const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
    let idx = haystack.indexOf(needle, from);
    while (idx !== -1 && idx < bound) {
      const endIdx = idx + needle.length;
      if (!opts.wholeWord || (!isWordChar(scope[idx - 1]) && !isWordChar(scope[endIdx]))) {
        matches.push({ from: idx, to: endIdx });
        if (matches.length >= MAX_MATCHES) {
          return { matches, capped: true, error: null };
        }
      }
      idx = haystack.indexOf(needle, idx + Math.max(needle.length, 1));
    }
    return { matches, capped: false, error: null };
  }

  // 正则模式：仅追加 g 旗标做全局迭代（其余语义保持用户正则原样）
  let global: RegExp;
  try {
    global = new RegExp(local.regex.source, local.regex.flags.includes('g') ? local.regex.flags : local.regex.flags + 'g');
  } catch (e) {
    return { matches, capped: false, error: e instanceof Error ? e.message : String(e) };
  }
  global.lastIndex = from;
  for (;;) {
    const m = global.exec(scope);
    if (!m || m.index >= bound) break;
    if (m[0].length === 0) {
      global.lastIndex += 1;
      continue;
    }
    matches.push({ from: m.index, to: m.index + m[0].length });
    if (matches.length >= MAX_MATCHES) {
      return { matches, capped: true, error: null };
    }
  }
  return { matches, capped: false, error: null };
}

/**
 * 求单个匹配的替换文本：
 * - 普通模式：原样使用替换串（$ 等不做展开）；
 * - 正则模式：对匹配原文做单次正则替换，支持 $1、$& 等引用。
 */
export function replacementFor(
  originalText: string,
  match: MatchRange,
  opts: SearchOptions,
  replaceWith: string,
): string {
  if (!opts.regexp) return replaceWith;
  const local = compileLocal(opts);
  if (!local.regex) return replaceWith;
  return originalText.slice(match.from, match.to).replace(local.regex, replaceWith);
}

/**
 * 光标处「下一个匹配」的下标：第一个 from >= head 的匹配，无则回绕到 0。
 */
export function nextMatchIndex(matches: MatchRange[], head: number): number {
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].from >= head) return i;
  }
  return matches.length > 0 ? 0 : -1;
}

/** 光标处「上一个匹配」的下标：最后一个 to <= head 的匹配，无则回绕到末尾 */
export function prevMatchIndex(matches: MatchRange[], head: number): number {
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].to <= head) return i;
  }
  return matches.length > 0 ? matches.length - 1 : -1;
}

/** 选区是否恰好覆盖某个匹配（替换当前项判定用） */
export function matchAtSelection(matches: MatchRange[], from: number, to: number): number {
  return matches.findIndex(m => m.from === from && m.to === to);
}
