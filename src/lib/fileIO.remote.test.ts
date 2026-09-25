// @vitest-environment node
/**
 * 远程保存在**断连**时的分岔（v1.5 阶段 5 的入口）：这一份该交给离线队列，而不是报错。
 *
 * 判据只有一条 —— 是不是链路级失败（`remote.ts` 的 LINK_DOWN_CODES）。
 * 认错方向的两种后果都不对称，所以两边都要钉：
 * 把桌面对路径的永久拒绝当成断连，就会拿一份改错的内容在队列里每次重连重试一遍；
 * 把断连当成永久失败，就是「拔网线编辑会丢」—— 那正是这一版要堵的洞。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const alerts: string[] = [];
vi.mock('./appAlert', () => ({
  appAlert: (m: string) => { alerts.push(m); },
  registerAppAlert: () => {},
}));

const remoteWrite = vi.fn();
vi.mock('./remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('./remote')>();
  return { ...real, remoteWrite: (args: unknown) => remoteWrite(args) };
});

import { saveFileToDisk } from './fileIO';
import { parseRemoteError } from './remote';
import type { FileTab } from './tabModel';

const REL = 'notes/todo.md';
const DEV = 'a1b2c3d4e5f6a7b8';
const PATH = `hide-remote://${DEV}/${REL}`;

function remoteTab(over: Partial<FileTab> = {}): FileTab {
  return {
    id: 't1', title: 'todo.md', path: PATH, handle: null,
    content: '- 买牛奶\n- 修水龙头\n', originalContent: '- 买牛奶\n',
    language: 'markdown', isDirty: true, readOnly: false, mdView: 'edit',
    encoding: 'utf-8', bom: false, eol: 'crlf', originalEol: 'crlf',
    remoteBaseHash: 'base-from-read',
    ...over,
  } as FileTab;
}

const OK_WRITE = { conflict: false, hash: 'hash-after', size: 9, mtimeMs: 1, serverBom: false, serverBinary: false };

beforeEach(() => {
  remoteWrite.mockReset();
  alerts.length = 0;
});

describe('saveFileToDisk 的远程分支', () => {
  it('链路断了：不当失败弹告警，而是把这一份交给离线队列', async () => {
    remoteWrite.mockRejectedValue(parseRemoteError('dropped: 链路已断开，这次没有送达桌面'));
    const r = await saveFileToDisk(remoteTab(), remoteTab().content);
    expect(r.ok).toBe(false);
    expect(r.remoteOffline).toMatchObject({
      deviceId: DEV, relPath: REL, path: PATH, encoding: 'utf-8', bom: false,
      baseHash: 'base-from-read',
    });
    expect(alerts).toEqual([]);
  });

  it('交给队列的是**落盘态**那份（换行符已还原），回放原样重发不再二次转换', async () => {
    remoteWrite.mockRejectedValue(parseRemoteError('nolink: 手机上还没有连着桌面，请先完成配对'));
    const r = await saveFileToDisk(remoteTab({ eol: 'crlf' }), '- 买牛奶\n- 修水龙头\n');
    expect(r.remoteOffline!.text).toBe('- 买牛奶\r\n- 修水龙头\r\n');
    const r2 = await saveFileToDisk(remoteTab({ eol: 'lf' }), '- 买牛奶\n');
    expect(r2.remoteOffline!.text).toBe('- 买牛奶\n');
  });

  it('超时也算断了：真关 WiFi 之后头几十秒的保存就是等出一个 timeout', async () => {
    remoteWrite.mockRejectedValue(parseRemoteError('timeout: 桌面 30 秒内没有回话，请检查连接'));
    const r = await saveFileToDisk(remoteTab(), 'x');
    expect(r.remoteOffline).toBeTruthy();
  });

  it('桌面按路径拒绝（永久失败）：照原样报错，不许压进队列', async () => {
    for (const code of ['outside', 'notopen', 'noroot', 'badpath', 'toobig', 'badparams']) {
      remoteWrite.mockRejectedValueOnce(`${code}: 桌面的原话`);
      const r = await saveFileToDisk(remoteTab(), 'x');
      expect(r.remoteOffline).toBeUndefined();
      expect(r.ok).toBe(false);
    }
    expect(alerts.length).toBe(6);
  });

  it('没有基线时不排队：拿空基线落盘等于覆盖桌面的改动', async () => {
    remoteWrite.mockRejectedValue(parseRemoteError('dropped: 链路已断开'));
    const r = await saveFileToDisk(remoteTab({ remoteBaseHash: undefined }), 'x');
    expect(r.remoteOffline).toBeUndefined();
    expect(alerts.length).toBe(1);
  });

  it('基线不符走冲突那条路，不是离线', async () => {
    remoteWrite.mockResolvedValue({
      ...OK_WRITE, conflict: true, serverHash: 'srv', serverText: '桌面上改的', serverEncoding: 'utf-8',
    });
    const r = await saveFileToDisk(remoteTab(), 'x');
    expect(r.remoteOffline).toBeUndefined();
    expect(r.remoteConflict).toMatchObject({ serverText: '桌面上改的', serverTooLarge: false });
  });

  it('桌面那份太大没带回正文：如实标出来，别让前端摆一份空的「桌面版本」让人采纳', async () => {
    remoteWrite.mockResolvedValue({ ...OK_WRITE, conflict: true, serverHash: 'srv' });
    const r = await saveFileToDisk(remoteTab(), 'x');
    expect(r.remoteConflict!.serverTooLarge).toBe(true);
    // 空的桌面版本是另一回事：那种情况 serverText 是货真价实的空串
    remoteWrite.mockResolvedValue({ ...OK_WRITE, conflict: true, serverHash: 'srv', serverText: '' });
    const empty = await saveFileToDisk(remoteTab(), 'x');
    expect(empty.remoteConflict!.serverTooLarge).toBe(false);
  });

  it('写成功：带回新基线，且没有离线载荷', async () => {
    remoteWrite.mockResolvedValue(OK_WRITE);
    const r = await saveFileToDisk(remoteTab(), 'x');
    expect(r).toMatchObject({ ok: true, savedPath: PATH, remoteBaseHash: 'hash-after' });
    expect(r.remoteOffline).toBeUndefined();
  });
});
