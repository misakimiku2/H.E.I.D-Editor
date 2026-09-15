/**
 * 跨文件搜索（桌面）：Rust search_in_dir 命令封装 + 结果分组/高亮区间纯函数。
 * 按需触发、无索引、无常驻后台——一次调用一次全量扫描（黑名单目录与
 * >32MB / 二进制文件在 Rust 侧跳过，计数随结果返回）。
 */

export interface FileHit {
  path: string;
  /** 1-based 行号 */
  line: number;
  /** 1-based 字符列 */
  col: number;
  /** 匹配字符数 */
  len: number;
  /** 行片段（≤200 字符，命中可见） */
  text: string;
  /** 片段在原行内的字符起点 */
  offset: number;
}

export interface DirSearchResult {
  matches: FileHit[];
  filesScanned: number;
  filesMatched: number;
  matchTotal: number;
  truncated: boolean;
  skippedLarge: number;
  skippedBinary: number;
  skippedDirs: number;
  filesCapped: boolean;
  error: string | null;
}

export interface DirSearchOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

/** 触发目录搜索（桌面 Tauri；返回 error 字段而非 reject 正则编译错误） */
export async function searchInDir(
  root: string,
  query: string,
  opts: DirSearchOptions,
): Promise<DirSearchResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<DirSearchResult>('search_in_dir', {
    root,
    query,
    caseSensitive: opts.caseSensitive,
    regexp: opts.regexp,
    wholeWord: opts.wholeWord,
  });
}

export interface FileGroup {
  path: string;
  hits: FileHit[];
}

/** 命中按文件分组（保持到达顺序） */
export function groupByFile(matches: readonly FileHit[]): FileGroup[] {
  const groups: FileGroup[] = [];
  const index = new Map<string, FileGroup>();
  for (const hit of matches) {
    let g = index.get(hit.path);
    if (!g) {
      g = { path: hit.path, hits: [] };
      index.set(hit.path, g);
      groups.push(g);
    }
    g.hits.push(hit);
  }
  return groups;
}

/** 命中在片段文本内的字符区间（0-based [from, to)，mark 高亮用） */
export function hitRangeInSnippet(hit: FileHit): { from: number; to: number } {
  const from = Math.max(0, hit.col - 1 - hit.offset);
  return { from, to: Math.min(hit.text.length, from + hit.len) };
}
