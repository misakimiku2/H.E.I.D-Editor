// @vitest-environment jsdom
/**
 * clipboardReadPermissionState：只读的权限查询封装（绝不触发授权弹窗）。
 * 浏览器里 navigator.clipboard.readText 探测会弹「查看剪贴板」授权框，
 * 探测/降级路径一律改走本查询。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { clipboardReadPermissionState } from './fileOps';

const setNavigator = (key: string, value: unknown) => {
  Object.defineProperty(window.navigator, key, { value, configurable: true });
};

describe('clipboardReadPermissionState', () => {
  beforeEach(() => {
    delete (window.navigator as any).permissions;
  });

  it('查询结果原样透传（granted / prompt / denied）', async () => {
    for (const state of ['granted', 'prompt', 'denied']) {
      setNavigator('permissions', { query: async () => ({ state }) });
      await expect(clipboardReadPermissionState()).resolves.toBe(state);
    }
  });

  it('query 拒绝（Firefox 等不支持该名称）→ unknown', async () => {
    setNavigator('permissions', { query: () => Promise.reject(new Error('unsupported')) });
    await expect(clipboardReadPermissionState()).resolves.toBe('unknown');
  });

  it('query 同步抛错 → unknown', async () => {
    setNavigator('permissions', { query: () => { throw new TypeError('bad name'); } });
    await expect(clipboardReadPermissionState()).resolves.toBe('unknown');
  });

  it('permissions 不可用 → unknown', async () => {
    await expect(clipboardReadPermissionState()).resolves.toBe('unknown');
  });
});
