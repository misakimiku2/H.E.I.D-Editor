import { describe, it, expect } from 'vitest';
import {
  compareVersions, consumeStartupReleaseNotes, getIgnoredVersion, isNewerVersion,
  loadReleaseNotes, parseLatestJson, saveReleaseNotes, setIgnoredVersion,
  shouldNotifyUpdate, summarizeNotes,
} from './update';

function fakeStorage(): { store: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: k => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, v),
  };
}
const asStorage = (s: ReturnType<typeof fakeStorage>) => s as unknown as Storage;

describe('compareVersions', () => {
  it('主.次.修订 逐段比较', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('忽略 v 前缀与首尾空白', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions(' V2.0.0 ', '2.0.0')).toBe(0);
  });

  it('段数不齐按 0 补齐', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('预发布版小于同号正式版', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
  });
});

describe('isNewerVersion', () => {
  it('仅严格更新返回 true，同版本与回退返回 false', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });
});

describe('parseLatestJson', () => {
  it('解析 updater 静态 JSON 格式', () => {
    const info = parseLatestJson(JSON.stringify({
      version: '1.0.1',
      notes: '修复若干问题',
      pub_date: '2026-09-15T00:00:00Z',
      platforms: {
        'windows-x86_64': { signature: 'xxx', url: 'https://example.com/app.nsis.zip' },
      },
    }));
    expect(info).toEqual({ version: '1.0.1', notes: '修复若干问题' });
  });

  it('notes 缺省时为 undefined', () => {
    expect(parseLatestJson('{"version":"2.0.0"}')).toEqual({ version: '2.0.0', notes: undefined });
  });

  it('非法 JSON / 缺 version / 非对象返回 null', () => {
    expect(parseLatestJson('not json')).toBe(null);
    expect(parseLatestJson('{"notes":"no version"}')).toBe(null);
    expect(parseLatestJson('[]')).toBe(null);
    expect(parseLatestJson('null')).toBe(null);
  });
});

describe('忽略版本持久化', () => {
  it('未忽略返回 null，忽略后可读回', () => {
    const s = fakeStorage();
    expect(getIgnoredVersion(asStorage(s))).toBe(null);
    setIgnoredVersion('1.2.1', asStorage(s));
    expect(getIgnoredVersion(asStorage(s))).toBe('1.2.1');
  });

  it('shouldNotifyUpdate：未忽略弹；同版本不弹；比忽略版本新则弹', () => {
    expect(shouldNotifyUpdate('1.2.1', null)).toBe(true);
    expect(shouldNotifyUpdate('1.2.1', '1.2.1')).toBe(false);
    expect(shouldNotifyUpdate('1.2.2', '1.2.1')).toBe(true);
    expect(shouldNotifyUpdate('1.2.0', '1.2.1')).toBe(false);
  });
});

describe('发行说明持久化', () => {
  it('保存后可读回；notes 缺省存为空串', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.2.1', notes: '# 更新说明' }, asStorage(s));
    expect(loadReleaseNotes(asStorage(s))).toEqual({ version: '1.2.1', notes: '# 更新说明', shown: false });
    saveReleaseNotes({ version: '1.2.2' }, asStorage(s));
    expect(loadReleaseNotes(asStorage(s))!.notes).toBe('');
  });

  it('consume：当前版本且未展示 → 返回并标记已展示；再次 consume 返回 null', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.2.1', notes: 'notes' }, asStorage(s));
    const first = consumeStartupReleaseNotes('1.2.1', asStorage(s));
    expect(first).toEqual({ version: '1.2.1', notes: 'notes', shown: false });
    expect(loadReleaseNotes(asStorage(s))!.shown).toBe(true);
    expect(consumeStartupReleaseNotes('1.2.1', asStorage(s))).toBe(null);
  });

  it('consume：版本不匹配 / 无记录 / 损坏 JSON 返回 null 且不改动存储', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.2.1', notes: 'n' }, asStorage(s));
    expect(consumeStartupReleaseNotes('1.3.0', asStorage(s))).toBe(null);
    expect(loadReleaseNotes(asStorage(s))!.shown).toBe(false);

    const empty = fakeStorage();
    expect(consumeStartupReleaseNotes('1.2.1', asStorage(empty))).toBe(null);

    const bad = fakeStorage();
    bad.store.set('heid-update-release-notes', 'garbage');
    expect(loadReleaseNotes(asStorage(bad))).toBe(null);
    expect(consumeStartupReleaseNotes('1.2.1', asStorage(bad))).toBe(null);
  });
});

describe('summarizeNotes', () => {
  it('压缩空白为单行', () => {
    expect(summarizeNotes('# 标题\n\n- 甲\n- 乙')).toBe('# 标题 - 甲 - 乙');
  });

  it('超长截断加省略号', () => {
    const out = summarizeNotes('a'.repeat(200), 160);
    expect(out).toHaveLength(161);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('空 / 缺省返回 null', () => {
    expect(summarizeNotes(undefined)).toBe(null);
    expect(summarizeNotes('')).toBe(null);
    expect(summarizeNotes('   \n\t')).toBe(null);
  });
});
