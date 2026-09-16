import { describe, expect, it, beforeEach } from 'vitest';
import {
  sessionKeyForLabel, MANIFEST_KEY,
  readManifest, writeManifest, registerWindowInManifest, unregisterWindowFromManifest,
  loadSessionForLabel, saveSessionForLabel, clearSessionForLabel, releaseWindowSession,
} from './sessionWindows';
import { saveSessionState, type SessionState } from './session';

/** 基于 Map 的 Storage 桩(vitest node 环境无 localStorage) */
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

const sample: SessionState = { tabs: [{ kind: 'virtual', title: 'welcome.ts' }], activePath: null };

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
});

describe('sessionKeyForLabel', () => {
  it('主窗口沿用旧键(老用户会话无缝升级)', () => {
    expect(sessionKeyForLabel('main')).toBe('heid-session');
  });

  it('子窗口按键隔离', () => {
    expect(sessionKeyForLabel('win-1')).toBe('heid-session:win-1');
    expect(sessionKeyForLabel('win-2')).toBe('heid-session:win-2');
  });
});

describe('manifest 读写', () => {
  it('空 storage 读出空列表', () => {
    expect(readManifest(storage)).toEqual([]);
  });

  it('损坏 JSON / 非数组 / 非字符串项收敛为合法列表', () => {
    storage.setItem(MANIFEST_KEY, '{bad');
    expect(readManifest(storage)).toEqual([]);
    storage.setItem(MANIFEST_KEY, '"str"');
    expect(readManifest(storage)).toEqual([]);
    storage.setItem(MANIFEST_KEY, JSON.stringify(['main', 3, null, 'win-1', 'main']));
    expect(readManifest(storage)).toEqual(['main', 'win-1']);
  });

  it('注册去重、注销保留其余、整体写入', () => {
    registerWindowInManifest(storage, 'main');
    registerWindowInManifest(storage, 'win-1');
    registerWindowInManifest(storage, 'main');
    expect(readManifest(storage)).toEqual(['main', 'win-1']);
    unregisterWindowFromManifest(storage, 'main');
    expect(readManifest(storage)).toEqual(['win-1']);
    writeManifest(storage, ['a', 'b']);
    expect(readManifest(storage)).toEqual(['a', 'b']);
  });

  it('storage 不可用时全部静默', () => {
    expect(() => registerWindowInManifest(null, 'win-1')).not.toThrow();
    expect(readManifest(null)).toEqual([]);
    expect(() => unregisterWindowFromManifest(null, 'win-1')).not.toThrow();
    expect(() => writeManifest(null, ['x'])).not.toThrow();
  });
});

describe('按 label 读写快照', () => {
  it('主窗口写旧键,子窗口写隔离键;互相不可见', () => {
    saveSessionForLabel(storage, 'main', sample);
    expect(storage.getItem('heid-session')).not.toBeNull();
    expect(storage.getItem('heid-session:win-1')).toBeNull();

    saveSessionForLabel(storage, 'win-1', sample);
    expect(loadSessionForLabel(storage, 'win-1')).toEqual(sample);
    /* 与 session.ts 的旧入口同键互通(主窗口) */
    saveSessionState(sample, storage);
    expect(loadSessionForLabel(storage, 'main')).toEqual(sample);
  });

  it('清除按 label 精确删除', () => {
    saveSessionForLabel(storage, 'win-1', sample);
    saveSessionForLabel(storage, 'win-2', sample);
    clearSessionForLabel(storage, 'win-1');
    expect(loadSessionForLabel(storage, 'win-1')).toBeNull();
    expect(loadSessionForLabel(storage, 'win-2')).toEqual(sample);
  });

  it('storage 不可用:读 null、写静默', () => {
    expect(loadSessionForLabel(null, 'win-1')).toBeNull();
    expect(() => saveSessionForLabel(null, 'win-1', sample)).not.toThrow();
    expect(() => clearSessionForLabel(null, 'win-1')).not.toThrow();
  });
});

describe('releaseWindowSession(窗口关闭规则)', () => {
  it('非最后窗口:清自己的快照并从清单注销,他人不受影响', () => {
    saveSessionForLabel(storage, 'main', sample);
    saveSessionForLabel(storage, 'win-1', sample);
    saveSessionForLabel(storage, 'win-2', sample);
    writeManifest(storage, ['main', 'win-1', 'win-2']);

    expect(releaseWindowSession(storage, 'win-1', false)).toBe('cleared');
    expect(loadSessionForLabel(storage, 'win-1')).toBeNull();
    expect(readManifest(storage)).toEqual(['main', 'win-2']);
    expect(loadSessionForLabel(storage, 'main')).toEqual(sample);
    expect(loadSessionForLabel(storage, 'win-2')).toEqual(sample);
  });

  it('最后窗口(=退出应用):保留全部快照,清单不动,下次启动整体还原', () => {
    saveSessionForLabel(storage, 'main', sample);
    saveSessionForLabel(storage, 'win-1', sample);
    writeManifest(storage, ['main', 'win-1']);

    expect(releaseWindowSession(storage, 'win-1', true)).toBe('kept');
    expect(loadSessionForLabel(storage, 'win-1')).toEqual(sample);
    expect(readManifest(storage)).toEqual(['main', 'win-1']);
  });
});
