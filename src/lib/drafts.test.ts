import { describe, expect, it } from 'vitest';
import { deleteDraft, draftKeyForTab, getDraft, loadDrafts, saveDraft, MAX_DRAFT_CHARS } from './drafts';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
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
