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
