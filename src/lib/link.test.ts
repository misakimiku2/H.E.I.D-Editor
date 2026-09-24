import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINK_PORT, autoReconnectFromPrefs, autoStartFromPrefs, deviceName, isKeyId,
  isTicket, isUsablePort, linkRole, normalizePairReq, normalizeStatus, parsePrefs,
  subscribeLinkStatus, tabReports,
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
      enabled: true, port: DEFAULT_LINK_PORT, host: '', ticket: '', keyId: '', peerName: '',
    });
  });

  it('记住的设备 keyId 形状合法才采信（供免扫重连）', () => {
    expect(parsePrefs(`{"keyId":"${'ab'.repeat(8)}"}`).keyId).toBe('ab'.repeat(8));
    expect(parsePrefs('{"keyId":"nope"}').keyId).toBe('');
    expect(parsePrefs('{"keyId":"abc"}').keyId).toBe('');
    expect(parsePrefs('{"peerName":"MISAKI-PC"}').peerName).toBe('MISAKI-PC');
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

  it('keyId 必须是 16 位十六进制（LS 哈希前 8 字节）', () => {
    expect(isKeyId('0123456789abcdef')).toBe(true);
    expect(isKeyId('0123456789abcde')).toBe(false);
    expect(isKeyId('0123456789abcdef00')).toBe(false);
    expect(isKeyId('zzzzzzzzzzzzzzzz')).toBe(false);
  });
});

describe('normalizePairReq', () => {
  it('形状合法按原样返回', () => {
    const r = normalizePairReq({ device: 'SM-X808U', keyId: '0123456789abcdef' });
    expect(r.device).toBe('SM-X808U');
    expect(r.keyId).toBe('0123456789abcdef');
  });

  it('缺字段与坏 keyId 归零，绝不让 TOFU 弹窗崩', () => {
    expect(normalizePairReq(undefined)).toEqual({ device: '', keyId: '' });
    expect(normalizePairReq({ device: 123, keyId: 'short' }).keyId).toBe('');
    expect(normalizePairReq({ device: 123 }).device).toBe('');
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

  it('非 Tauri 环境：订阅是空操作、自动开启与自动重连直接返回 null', async () => {
    expect(typeof subscribeLinkStatus(() => {})).toBe('function');
    expect(await autoStartFromPrefs()).toBeNull();
    expect(await autoReconnectFromPrefs()).toBeNull();
  });
});

/* -------------------------------------------------- 阶段 3：标签上报 */

describe('tabReports', () => {
  const t = (over: Partial<Parameters<typeof tabReports>[0][number]> & { id: string }) => ({
    path: 'C:\\notes\\' + over.id + '.md',
    title: `${over.id}.md`,
    language: 'markdown',
    mdView: 'edit',
    isDirty: false,
    readOnly: false,
    ...over,
  });

  it('只报元数据：内容一个字都不上手（两份"正在改的"是设计明确排除的）', () => {
    const [one] = tabReports([t({ id: 'a', ...({ content: '秘密正文' } as object) })], 'a', { line: 3, col: 4 });
    expect(JSON.stringify(one)).not.toContain('秘密正文');
    expect(one).not.toHaveProperty('content');
    expect(one).toEqual({
      path: 'C:\\notes\\a.md', title: 'a.md', language: 'markdown', mdView: 'edit',
      dirty: false, readOnly: false, line: 3, col: 4,
    });
  });

  it('光标只给激活标签，别的标签是 0', () => {
    const list = tabReports([t({ id: 'a' }), t({ id: 'b' })], 'b', { line: 12, col: 7 });
    expect([list[0].line, list[0].col]).toEqual([0, 0]);
    expect([list[1].line, list[1].col]).toEqual([12, 7]);
  });

  it('非磁盘路径（content:// 与 hide-remote://）报成无路径，绝不当本地文件报上去', () => {
    const list = tabReports(
      [t({ id: 'a', path: 'content://com.android.externalstorage/tree/x.md' }),
       t({ id: 'b', path: 'hide-remote://a1b2c3d4e5f6/notes/x.md' }),
       t({ id: 'c', path: null })],
      '', null,
    );
    expect(list.map(x => x.path)).toEqual([null, null, null]);
    // 路径没了但标题还在：手机上那份列表仍要读得出"桌面上开着什么"
    expect(list.map(x => x.title)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('无激活标签（activeId 为空串）时谁都不带光标', () => {
    const list = tabReports([t({ id: 'a' })], '', { line: 9, col: 9 });
    expect([list[0].line, list[0].col]).toEqual([0, 0]);
  });
});

describe('openShared 归一化', () => {
  it('缺字段与脏类型都归 0（这条数字是暴露面，宁可少报也不报个假的）', () => {
    expect(normalizeStatus({}).openShared).toBe(0);
    expect(normalizeStatus({ openShared: '3' }).openShared).toBe(0);
    expect(normalizeStatus({ openShared: 3 }).openShared).toBe(3);
  });
});
