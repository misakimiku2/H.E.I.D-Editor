/**
 * 未保存内容草稿（纯函数 + localStorage 持久化）：
 * 周期性把脏标签内容写入草稿，异常退出后随会话恢复；
 * 保存成功或用户明确放弃后由调用方删除对应条目。
 * 键：file:<路径> / untitled:<标题>（见 draftKeyForTab）。
 * 单条超过 MAX_DRAFT_CHARS 跳过写入（localStorage 配额有限，大文件放弃草稿保护）。
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

export function getDraft(key: string, storage: Storage | null = defaultStorage()): string | null {
  return loadDrafts(storage)[key]?.content ?? null;
}

/** 写入草稿（内容超限或存储失败时静默跳过）；返回是否实际写入 */
export function saveDraft(
  key: string,
  content: string,
  storage: Storage | null = defaultStorage(),
  maxChars: number = MAX_DRAFT_CHARS,
): boolean {
  if (!storage || content.length > maxChars) return false;
  try {
    const drafts = loadDrafts(storage);
    const existing = drafts[key];
    if (existing && existing.content === content) return false;
    drafts[key] = { content, at: Date.now() };
    storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
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
 * 超限条目与 saveDraft 同一纪律：跳过（旧草稿原样留着），不冒配额风险。
 * 返回实际变更条数（配额写失败按 0 计，与 saveDraft 一样静默）。
 */
export function syncDrafts(
  entries: { key: string; content: string | null }[],
  storage: Storage | null = defaultStorage(),
  maxChars: number = MAX_DRAFT_CHARS,
): number {
  if (!storage) return 0;
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
  if (changed === 0) return 0;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    return 0;
  }
  return changed;
}
