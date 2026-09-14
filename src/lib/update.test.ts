import { describe, it, expect } from 'vitest';
import {
  compareVersions, isNewerVersion, parseLatestJson, shouldAutoCheck, markAutoChecked,
  AUTO_CHECK_INTERVAL_MS,
} from './update';

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

describe('shouldAutoCheck / markAutoChecked', () => {
  function fakeStorage(): { store: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
    const store = new Map<string, string>();
    return {
      store,
      getItem: k => (store.has(k) ? store.get(k)! : null),
      setItem: (k, v) => void store.set(k, v),
    };
  }

  it('从未检查过返回 true', () => {
    expect(shouldAutoCheck(1000, fakeStorage() as unknown as Storage)).toBe(true);
  });

  it('间隔内返回 false，超过间隔返回 true', () => {
    const s = fakeStorage();
    markAutoChecked(1_000, s as unknown as Storage);
    expect(shouldAutoCheck(1_000 + AUTO_CHECK_INTERVAL_MS - 1, s as unknown as Storage)).toBe(false);
    expect(shouldAutoCheck(1_000 + AUTO_CHECK_INTERVAL_MS, s as unknown as Storage)).toBe(true);
  });

  it('损坏的时间值视为从未检查', () => {
    const s = fakeStorage();
    s.store.set('heid-update-last-check', 'garbage');
    expect(shouldAutoCheck(1000, s as unknown as Storage)).toBe(true);
  });
});
