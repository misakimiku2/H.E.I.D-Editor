import { describe, expect, it } from 'vitest';
import { loadSessionState, saveSessionState, type SessionState } from './session';

/** 基于 Map 的 Storage 桩（vitest node 环境无 localStorage） */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

const sample: SessionState = {
  tabs: [
    { kind: 'virtual', title: 'welcome.ts' },
    { kind: 'file', path: 'C:/notes/a.md', mdView: 'split' },
    { kind: 'file', path: 'C:/src/main.rs', mdView: 'edit' },
  ],
  activePath: 'C:/notes/a.md',
};

describe('saveSessionState / loadSessionState', () => {
  it('保存后读取得到等价会话（往返一致）', () => {
    const storage = memoryStorage();
    saveSessionState(sample, storage);
    expect(loadSessionState(storage)).toEqual(sample);
  });

  it('storage 不可用时：保存静默忽略、读取返回 null', () => {
    expect(() => saveSessionState(sample, null)).not.toThrow();
    expect(loadSessionState(null)).toBeNull();
  });

  it('空 storage 读取返回 null', () => {
    expect(loadSessionState(memoryStorage())).toBeNull();
  });

  it('损坏的 JSON 返回 null', () => {
    const storage = memoryStorage();
    storage.setItem('heid-session', '{not json');
    expect(loadSessionState(storage)).toBeNull();
  });

  it('非对象 JSON 返回 null', () => {
    const storage = memoryStorage();
    storage.setItem('heid-session', '"just a string"');
    expect(loadSessionState(storage)).toBeNull();
  });

  it('tabs 不是数组返回 null', () => {
    const storage = memoryStorage();
    storage.setItem('heid-session', JSON.stringify({ tabs: 'oops', activePath: null }));
    expect(loadSessionState(storage)).toBeNull();
  });

  it('非法条目被逐条丢弃，非法 mdView 回退 edit，非法 activePath 归一为 null', () => {
    const storage = memoryStorage();
    storage.setItem('heid-session', JSON.stringify({
      tabs: [
        null,
        { kind: 'file', path: '', mdView: 'edit' },      // 空路径：丢弃
        { kind: 'file', path: 'C:/keep.md' },            // 缺 mdView：回退 edit
        { kind: 'file', path: 'C:/x.ts', mdView: 'bogus' }, // 非法 mdView：回退 edit
        { kind: 'virtual', title: '' },                  // 空标题：丢弃
        { kind: 'virtual' },                             // 缺标题：丢弃
        { kind: 'weird', path: 'C:/y.ts' },              // 未知 kind：丢弃
        { kind: 'file', path: 'C:/ok.md', mdView: 'preview' },
        { kind: 'virtual', title: 'welcome.ts' },
      ],
      activePath: 42,
    }));
    expect(loadSessionState(storage)).toEqual({
      tabs: [
        { kind: 'file', path: 'C:/keep.md', mdView: 'edit' },
        { kind: 'file', path: 'C:/x.ts', mdView: 'edit' },
        { kind: 'file', path: 'C:/ok.md', mdView: 'preview' },
        { kind: 'virtual', title: 'welcome.ts' },
      ],
      activePath: null,
    });
  });

  it('兼容旧版快照：无 kind 但有 path 的条目按 file 解析', () => {
    const storage = memoryStorage();
    storage.setItem('heid-session', JSON.stringify({
      tabs: [{ path: 'C:/old.md', mdView: 'preview' }],
      activePath: 'C:/old.md',
    }));
    expect(loadSessionState(storage)).toEqual({
      tabs: [{ kind: 'file', path: 'C:/old.md', mdView: 'preview' }],
      activePath: 'C:/old.md',
    });
  });
});
