import { describe, expect, it } from 'vitest';
import { deleteDraft, draftKeyForTab, getDraft, loadDrafts, saveDraft, syncDrafts, MAX_DRAFT_CHARS } from './drafts';

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

describe('draftKeyForTab', () => {
  it('有路径按 file 键，无路径按 untitled 键', () => {
    expect(draftKeyForTab({ path: 'C:/a.md', title: 'a.md' })).toBe('file:C:/a.md');
    expect(draftKeyForTab({ path: null, title: 'untitled-1.txt' })).toBe('untitled:untitled-1.txt');
  });
});

describe('drafts 存取', () => {
  it('写入后可读取，内容一致则不重复写', () => {
    const s = memoryStorage();
    expect(saveDraft('k', 'v1', s)).toBe(true);
    expect(getDraft('k', s)).toBe('v1');
    expect(saveDraft('k', 'v1', s)).toBe(false);
  });

  it('删除后读取为 null；删除不存在的键静默', () => {
    const s = memoryStorage();
    saveDraft('k', 'v', s);
    deleteDraft('k', s);
    expect(getDraft('k', s)).toBeNull();
    expect(() => deleteDraft('missing', s)).not.toThrow();
  });

  it('超过大小上限跳过写入', () => {
    const s = memoryStorage();
    expect(saveDraft('big', 'x'.repeat(MAX_DRAFT_CHARS + 1), s)).toBe(false);
    expect(getDraft('big', s)).toBeNull();
  });

  it('存储不可用时全部安全空操作', () => {
    expect(saveDraft('k', 'v', null)).toBe(false);
    expect(getDraft('k', null)).toBeNull();
    expect(() => deleteDraft('k', null)).not.toThrow();
    expect(loadDrafts(null)).toEqual({});
  });

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
});

describe('syncDrafts 批量对齐', () => {
  it('多个键只写一遍存储', () => {
    const s = memoryStorage();
    const n = syncDrafts([
      { key: 'file:a.md', content: 'A' },
      { key: 'file:b.md', content: 'B' },
      { key: 'untitled:c.txt', content: 'C' },
    ], s);
    expect(n).toBe(3);
    expect(s.writes).toBe(1);
    expect(getDraft('file:b.md', s)).toBe('B');
  });

  it('内容一致不动、null 清除既有、全一致时一次都不写', () => {
    const s = memoryStorage();
    syncDrafts([{ key: 'k1', content: 'v1' }, { key: 'k2', content: 'v2' }], s);
    const base = s.writes;
    expect(syncDrafts([{ key: 'k1', content: 'v1' }, { key: 'k2', content: null }], s)).toBe(1);
    expect(s.writes).toBe(base + 1);
    expect(getDraft('k2', s)).toBeNull();
    /* 再对一次：k1 已一致、k2 本就没有 → 零写 */
    expect(syncDrafts([{ key: 'k1', content: 'v1' }, { key: 'k2', content: null }], s)).toBe(0);
    expect(s.writes).toBe(base + 1);
  });

  it('超限条目跳过并留着旧草稿（与 saveDraft 同一纪律）', () => {
    const s = memoryStorage();
    syncDrafts([{ key: 'big', content: 'old' }], s);
    const tooBig = 'x'.repeat(MAX_DRAFT_CHARS + 1);
    expect(syncDrafts([{ key: 'big', content: tooBig }], s)).toBe(0);
    expect(getDraft('big', s)).toBe('old');
  });

  it('存储不可用时安全空操作', () => {
    expect(syncDrafts([{ key: 'k', content: 'v' }], null)).toBe(0);
    expect(syncDrafts([{ key: 'k', content: null }], null)).toBe(0);
  });
});
