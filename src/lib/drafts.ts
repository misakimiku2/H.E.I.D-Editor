/**
 * 未保存内容草稿（纯函数 + localStorage 持久化）：
 * 打字期间按节流把脏标签内容写入草稿，异常退出后随会话恢复；
 * 保存成功或用户明确放弃后由调用方删除对应条目。
 * 键：file:<路径> / untitled:<标题>（见 draftKeyForTab）。
 * 写入只有 `syncDrafts` 一个入口（整批读一遍、最多写一遍）；
 * 单条超过 MAX_DRAFT_CHARS 或存储写不进去时不写，随结果回报，由调用方说出来。
 */

export interface DraftEntry {
  content: string;
  at: number;
}

export type DraftMap = Record<string, DraftEntry>;

export const MAX_DRAFT_CHARS = 2_000_000;

const STORAGE_KEY = 'heid-drafts';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 草稿键：有路径按路径（含安卓 content URI），无路径按标题 */
export function draftKeyForTab(tab: { path: string | null; title: string }): string {
  return tab.path ? `file:${tab.path}` : `untitled:${tab.title}`;
}

function parse(raw: string | null): DraftMap {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: DraftMap = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const rec = value as Record<string, unknown>;
      if (typeof rec.content !== 'string') continue;
      out[key] = { content: rec.content, at: typeof rec.at === 'number' ? rec.at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadDrafts(storage: Storage | null = defaultStorage()): DraftMap {
  if (!storage) return {};
  try {
    return parse(storage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function deleteDraft(key: string, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const drafts = loadDrafts(storage);
    if (!(key in drafts)) return;
    delete drafts[key];
    storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* 忽略 */
  }
}

/**
 * 批量对齐草稿（读一遍、最多写一遍）：`content` 是字符串 = 这份草稿应当存在，
 * null = 这个键应当不再有草稿。与已存内容一致或本就不存在的条目不动，
 * 全一致时一次都不写——多标签每 3 秒对齐一次，逐个 saveDraft 会把整份 map
 * 反复 parse/stringify，大文档下就是打字时的顿挫。
 * 两种「这一轮没有保护」的情况随结果回报（超限、存储写不进去），由调用方说出来：
 * 它们过去都是静默的，用户看到的仍是一个正常的脏点，直到崩溃那天才发现什么都没有。
 */
export interface DraftSyncResult {
  /** 实际写入存储的变更条数；0 = 一次都没写（可能本来就不需要写） */
  changed: number;
  /** 超过 MAX_DRAFT_CHARS、这一份没有草稿保护的键 */
  overCap: string[];
  /** 存储不可用或写失败（配额 / 隐私模式）：这一轮的脏内容一份都没落下 */
  failed: boolean;
}

export function syncDrafts(
  entries: { key: string; content: string | null }[],
  storage: Storage | null = defaultStorage(),
  maxChars: number = MAX_DRAFT_CHARS,
): DraftSyncResult {
  const overCap = entries
    .filter(e => e.content !== null && e.content.length > maxChars)
    .map(e => e.key);
  const wantsWrite = entries.some(e => e.content !== null);
  if (!storage) {
    return { changed: 0, overCap, failed: wantsWrite };
  }
  const drafts = loadDrafts(storage);
  const now = Date.now();
  let changed = 0;
  for (const { key, content } of entries) {
    if (content === null) {
      if (key in drafts) {
        delete drafts[key];
        changed++;
      }
      continue;
    }
    if (content.length > maxChars || drafts[key]?.content === content) continue;
    drafts[key] = { content, at: now };
    changed++;
  }
  if (changed === 0) return { changed: 0, overCap, failed: false };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    return { changed: 0, overCap, failed: true };
  }
  return { changed, overCap, failed: false };
}
