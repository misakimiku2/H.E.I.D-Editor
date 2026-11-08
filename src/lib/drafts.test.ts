import { describe, expect, it, vi } from 'vitest';
import {
  deleteDraft, draftKeyForTab, loadDrafts, syncDrafts, MAX_DRAFT_CHARS,
} from './drafts';

function memoryStorage() {
  const map = new Map<string, string>();
  const state = { writes: 0 };
  return {
    get length() { return map.size; },
    /** setItem 次数：批量对齐的「只写一遍」就靠它钉住 */
    get writes() { return state.writes; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { state.writes++; map.set(k, String(v)); },
  };
}

/** 只认 heid-drafts 这一份的当前内容 */
function draftOf(key: string, s: Storage): string | null {
  return loadDrafts(s)[key]?.content ?? null;
}

describe('draftKeyForTab', () => {
  it('有路径按 file 键，无路径按 untitled 键', () => {
    expect(draftKeyForTab({ path: 'C:/a.md', title: 'a.md' })).toBe('file:C:/a.md');
    expect(draftKeyForTab({ path: null, title: 'untitled-1.txt' })).toBe('untitled:untitled-1.txt');
  });
});

describe('drafts 读取', () => {
  it('损坏数据视为空 map', () => {
    const s = memoryStorage();
    s.setItem('heid-drafts', '{bad');
    expect(loadDrafts(s)).toEqual({});
  });

  it('非法条目逐条丢弃，合法条目保留', () => {
    const s = memoryStorage();
    s.setItem('heid-drafts', JSON.stringify({
      ok: { content: 'hello', at: 1 },
      bad: { nope: 1 },
      worse: 'str',
    }));
    expect(loadDrafts(s)).toEqual({ ok: { content: 'hello', at: 1 } });
  });

  it('存储不可用时读取为空 map', () => {
    expect(loadDrafts(null)).toEqual({});
  });

  it('删除后读取为 null；删除不存在的键静默', () => {
    const s = memoryStorage();
    syncDrafts([{ key: 'k', content: 'v' }], s);
    deleteDraft('k', s);
    expect(draftOf('k', s)).toBeNull();
    expect(() => deleteDraft('missing', s)).not.toThrow();
  });
});

describe('syncDrafts 批量对齐', () => {
  it('多个键只写一遍存储', () => {
    const s = memoryStorage();
    const r = syncDrafts([
      { key: 'file:a.md', content: 'A' },
      { key: 'file:b.md', content: 'B' },
      { key: 'untitled:c.txt', content: 'C' },
    ], s);
    expect(r.changed).toBe(3);
    expect(s.writes).toBe(1);
    expect(draftOf('file:b.md', s)).toBe('B');
  });

  it('内容一致不动、null 清除既有、全一致时一次都不写', () => {
    const s = memoryStorage();
    syncDrafts([{ key: 'k1', content: 'v1' }, { key: 'k2', content: 'v2' }], s);
    const base = s.writes;
    expect(syncDrafts([{ key: 'k1', content: 'v1' }, { key: 'k2', content: null }], s).changed).toBe(1);
    expect(s.writes).toBe(base + 1);
    expect(draftOf('k2', s)).toBeNull();
    /* 再对一次：k1 已一致、k2 本就没有 → 零写 */
    expect(syncDrafts([{ key: 'k1', content: 'v1' }, { key: 'k2', content: null }], s).changed).toBe(0);
    expect(s.writes).toBe(base + 1);
  });

  it('超限条目不写、留着旧草稿，并随结果回报（调用方据此说出来）', () => {
    const s = memoryStorage();
    syncDrafts([{ key: 'big', content: 'old' }], s);
    const tooBig = 'x'.repeat(MAX_DRAFT_CHARS + 1);
    const r = syncDrafts([{ key: 'big', content: tooBig }], s);
    expect(r.changed).toBe(0);
    expect(r.overCap).toEqual(['big']);
    expect(r.failed).toBe(false);
    expect(draftOf('big', s)).toBe('old');
  });

  it('没超限的键不会被误报成无保护', () => {
    const s = memoryStorage();
    const r = syncDrafts([{ key: 'ok', content: 'x'.repeat(MAX_DRAFT_CHARS) }], s);
    expect(r.overCap).toEqual([]);
    expect(r.changed).toBe(1);
  });

  it('存储不可用时安全空操作，并且如实回报 failed', () => {
    const r = syncDrafts([{ key: 'k', content: 'v' }], null);
    expect(r).toEqual({ changed: 0, overCap: [], failed: true });
    /* 一批里没有任何要写的东西（全是清除）时不该报警 */
    expect(syncDrafts([{ key: 'k', content: null }], null).failed).toBe(false);
    expect(() => deleteDraft('k', null)).not.toThrow();
  });

  it('配额写满时 setItem 抛错被吞下，回报 failed 而不是崩掉', () => {
    const s = memoryStorage();
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    const r = syncDrafts([{ key: 'k', content: 'v' }], s);
    expect(r.changed).toBe(0);
    expect(r.failed).toBe(true);
  });

  it('写入时刻随内容一起记下（恢复通知要说「最后记录于」）', () => {
    const s = memoryStorage();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    syncDrafts([{ key: 'k', content: 'v' }], s);
    expect(loadDrafts(s).k.at).toBe(1_700_000_000_000);
    vi.restoreAllMocks();
  });
});
