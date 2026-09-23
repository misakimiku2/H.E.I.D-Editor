import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINK_PORT, autoStartFromPrefs, deviceName, isTicket, isUsablePort,
  linkRole, normalizeStatus, parsePrefs, subscribeLinkStatus,
} from './link';

describe('normalizeStatus', () => {
  it('完整载荷按字段透传', () => {
    const s = normalizeStatus({
      role: 'server', listening: true, port: 47123, connected: true,
      peerDevice: 'SM-X808U', peerAddr: '192.168.31.202:52114',
      ticket: 'ab'.repeat(16), lastError: '', protocol: 1,
    });
    expect(s.peerDevice).toBe('SM-X808U');
    expect(s.role).toBe('server');
    expect(s.listening).toBe(true);
    expect(s.port).toBe(47123);
    expect(s.protocol).toBe(1);
  });

  it('缺字段与脏类型一律按关闭处理，不抛错', () => {
    expect(normalizeStatus(undefined).role).toBe('off');
    expect(normalizeStatus(null).listening).toBe(false);
    const dirty = normalizeStatus({ role: 'weird', port: '47123', connected: 1 });
    expect(dirty.role).toBe('off');
    expect(dirty.port).toBe(0);
    expect(dirty.connected).toBe(false);
  });

  it('客户端角色保留（手机侧 UI 靠它区分两半）', () => {
    expect(normalizeStatus({ role: 'client' }).role).toBe('client');
  });
});

describe('parsePrefs', () => {
  it('缺失与坏 JSON 都回落到默认值', () => {
    expect(parsePrefs(null).enabled).toBe(false);
    expect(parsePrefs(null).port).toBe(DEFAULT_LINK_PORT);
    expect(parsePrefs('{ not json').port).toBe(DEFAULT_LINK_PORT);
    expect(parsePrefs('{"enabled":true}')).toEqual({
      enabled: true, port: DEFAULT_LINK_PORT, host: '', ticket: '',
    });
  });

  it('越界端口与不合法配对码不采信', () => {
    expect(parsePrefs('{"port":80}').port).toBe(DEFAULT_LINK_PORT);
    expect(parsePrefs(`{"port":${DEFAULT_LINK_PORT}}`).port).toBe(DEFAULT_LINK_PORT);
    expect(parsePrefs('{"ticket":"zzzz"}').ticket).toBe('');
    expect(parsePrefs(`{"ticket":"${'0f'.repeat(16)}"}`).ticket).toBe('0f'.repeat(16));
  });

  it('enabled 只认真正的 true', () => {
    expect(parsePrefs('{"enabled":"yes"}').enabled).toBe(false);
    expect(parsePrefs('{"enabled":true}').enabled).toBe(true);
  });
});

describe('输入校验', () => {
  it('端口区间与 Rust 侧一致（1024–65535，且必须是整数）', () => {
    expect(isUsablePort(1023)).toBe(false);
    expect(isUsablePort(1024)).toBe(true);
    expect(isUsablePort(65535)).toBe(true);
    expect(isUsablePort(65536)).toBe(false);
    expect(isUsablePort(47123.5)).toBe(false);
    expect(isUsablePort(NaN)).toBe(false);
  });

  it('配对码必须是 32 位十六进制', () => {
    expect(isTicket('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isTicket('0123456789ABCDEF0123456789ABCDEF')).toBe(true);
    expect(isTicket('0123456789abcdef0123456789abcde')).toBe(false);
    expect(isTicket('0123456789abcdef0123456789abcdef00')).toBe(false);
    expect(isTicket('g123456789abcdef0123456789abcdef')).toBe(false);
  });
});

describe('平台分派', () => {
  it('浏览器壳里角色按桌面算（本用例跑在非安卓环境）', () => {
    expect(linkRole()).toBe('server');
  });

  it('桥不可用时设备名回落到固定串，不发空字符串', () => {
    // 空设备名会让配对确认框显示成「允许  访问」
    expect(deviceName()).toBe('H.I.D.E');
  });

  it('非 Tauri 环境：订阅是空操作、自动开启直接返回 null', async () => {
    expect(typeof subscribeLinkStatus(() => {})).toBe('function');
    expect(await autoStartFromPrefs()).toBeNull();
  });
});
