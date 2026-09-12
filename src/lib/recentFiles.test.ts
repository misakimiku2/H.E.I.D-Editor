import { describe, expect, it } from 'vitest';
import { addRecentFile, clearRecentFiles, listRecentFiles, type RecentFile } from './recentFiles';

function mockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const items = (s: Storage): RecentFile[] => JSON.parse(s.getItem('heid-recent-files')!);

describe('recentFiles', () => {
  it('空存储返回空列表', () => {
    expect(listRecentFiles(mockStorage())).toEqual([]);
  });

  it('新增置顶，name 缺省回退 path', () => {
    const s = mockStorage();
    addRecentFile('C:\\a.md', 'a.md', s);
    expect(listRecentFiles(s)[0]).toMatchObject({ path: 'C:\\a.md', name: 'a.md' });
  });

  it('同路径去重并移到最前', () => {
    const s = mockStorage();
    addRecentFile('a.txt', 'a.txt', s);
    addRecentFile('b.txt', 'b.txt', s);
    addRecentFile('a.txt', 'a.txt', s);
    const list = listRecentFiles(s);
    expect(list.map(f => f.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('超出上限丢弃最旧', () => {
    const s = mockStorage();
    for (let i = 0; i < 20; i++) addRecentFile(`f${i}.txt`, `f${i}.txt`, s);
    const list = listRecentFiles(s);
    expect(list.length).toBe(15);
    expect(list[0].path).toBe('f19.txt');
    expect(list[14].path).toBe('f5.txt');
  });

  it('损坏 JSON 视为空列表', () => {
    const s = mockStorage();
    s.setItem('heid-recent-files', '{broken');
    expect(listRecentFiles(s)).toEqual([]);
  });

  it('损坏条目逐条丢弃，合法条目保留', () => {
    const s = mockStorage();
    s.setItem('heid-recent-files', JSON.stringify([
      { path: 'ok.txt' },
      { nope: 1 },
      null,
      { path: '', name: 'empty' },
    ]));
    expect(listRecentFiles(s).map(f => f.path)).toEqual(['ok.txt']);
  });

  it('清空', () => {
    const s = mockStorage();
    addRecentFile('a.txt', 'a.txt', s);
    clearRecentFiles(s);
    expect(items(s)).toEqual([]);
  });
});
