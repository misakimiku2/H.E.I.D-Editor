/**
 * 跨文件搜索（桌面）：Rust search_in_dir 命令封装 + 结果分组/高亮区间纯函数。
 * 按需触发、无索引、无常驻后台——一次调用一次全量扫描（黑名单目录与
 * >32MB / 二进制文件在 Rust 侧跳过，计数随结果返回）。
 * 进度：Rust 限频更新快照，前端按 searchId 轮询 search_in_dir_progress；
 * 取消：search_in_dir_cancel 置位标志，扫描任务逐文件检查快速排空。
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
  /** 收到取消请求提前结束（结果不完整，应丢弃） */
  cancelled: boolean;
  error: string | null;
}

export interface DirSearchOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

/** 进度快照（轮询 search_in_dir_progress 的返回；id 不存在/已结束时为 null） */
export interface SearchProgress {
  id: number;
  /** 已处理文件数（含二进制/超限跳过） */
  filesDone: number;
  /** 枚举出的文件总数 */
  filesTotal: number;
  /** 实时累计命中数 */
  matchTotal: number;
}

/** 触发目录搜索（桌面 Tauri；返回 error 字段而非 reject 正则编译错误） */
export async function searchInDir(
  root: string,
  query: string,
  opts: DirSearchOptions,
  searchId: number,
): Promise<DirSearchResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<DirSearchResult>('search_in_dir', {
    root,
    query,
    caseSensitive: opts.caseSensitive,
    regexp: opts.regexp,
    wholeWord: opts.wholeWord,
    searchId,
  });
}

/** 轮询运行中搜索的进度快照（搜索已结束/未注册时返回 null） */
export async function searchProgress(searchId: number): Promise<SearchProgress | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SearchProgress | null>('search_in_dir_progress', { searchId });
}

/** 取消运行中的搜索（Rust 侧按 id 置位取消标志，扫描任务快速排空） */
export async function cancelInDirSearch(searchId: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('search_in_dir_cancel', { searchId });
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

/** 窗口内命中前保留的显示宽度单位数（CJK 记 2），保证高亮落入窄侧栏可见区 */
export const HIT_DISPLAY_LEAD_UNITS = 18;

export interface HitDisplayText {
  /** 窗口/片段之外的行首内容标记（无则空串） */
  prefix: string;
  /** 窗口内文本 */
  text: string;
  /** 高亮区间（text 内 0-based [from, to)） */
  from: number;
  to: number;
}

/** 字符显示宽度：CJK/全角记 2 个单位，其余（含 ASCII）记 1 */
function charUnits(cp: number): number {
  return cp >= 0x2e80 ? 2 : 1;
}

/**
 * 命中行的显示窗口：按显示宽度（非字符数）把窗口左移到命中前 lead 个单位处。
 * 中文占两倍宽度，按字符数留白会把高亮重新推出窄栏可视区；行内容被 CSS 裁剪，
 * 命中必须落进开头几十个单位内才可见。片段本身带偏移（长行截取）时补 … 前缀。
 */
export function hitDisplay(hit: FileHit, lead: number = HIT_DISPLAY_LEAD_UNITS): HitDisplayText {
  const { from, to } = hitRangeInSnippet(hit);
  /* 命中前文本的显示宽度 */
  let unitsBefore = 0;
  for (let i = 0; i < from;) {
    const cp = hit.text.codePointAt(i) ?? 0;
    unitsBefore += charUnits(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  if (unitsBefore <= lead) {
    return { prefix: hit.offset > 0 ? '…' : '', text: hit.text, from, to };
  }
  /* 从命中处往前消费 lead 个显示单位，确定窗口起点（不拆开代理对） */
  let start = from;
  let budget = lead;
  let i = from;
  while (i > 0) {
    let j = i - 1;
    while (j > 0 && (hit.text.codePointAt(j) ?? 0) >= 0xdc00 && (hit.text.codePointAt(j) ?? 0) <= 0xdfff) j--;
    const w = charUnits(hit.text.codePointAt(j) ?? 0);
    if (budget - w < 0) break;
    budget -= w;
    start = j;
    i = j;
  }
  return { prefix: '…', text: hit.text.slice(start), from: from - start, to: to - start };
}

/** 每页展示的命中条数 */
export const HITS_PER_PAGE = 100;

export interface PagedGroups {
  groups: FileGroup[];
  /** 总页数（≥1） */
  pageTotal: number;
}

/**
 * 命中分页：把按文件分组的列表按每页 pageSize 条命中切片，允许一个文件跨页续显。
 * page 越界时钳制到最后一页。
 */
export function pageGroups(matches: readonly FileHit[], page: number, pageSize: number = HITS_PER_PAGE): PagedGroups {
  const all = groupByFile(matches);
  const pageTotal = Math.max(1, Math.ceil(matches.length / pageSize));
  const cur = Math.min(Math.max(0, page), pageTotal - 1);
  const from = cur * pageSize;
  const to = from + pageSize;
  const groups: FileGroup[] = [];
  let consumed = 0;
  for (const g of all) {
    const groupStart = consumed;
    consumed += g.hits.length;
    if (consumed <= from) continue;
    const start = Math.max(from - groupStart, 0);
    const end = Math.min(to - groupStart, g.hits.length);
    groups.push({ path: g.path, hits: g.hits.slice(start, end) });
    if (consumed >= to) break;
  }
  return { groups, pageTotal };
}
