// @vitest-environment jsdom
/**
 * 手机上"掉线了自己接回来"的节奏（`startLinkKeepAlive`）。
 *
 * 这里钉的是两条容易写歪的：
 *  ① **一次拨号还在路上时不许再补一枪**。桌面在拨号那一刻就把 `peerAddr` 写上、握手却还在
 *     连接线程里跑，此时 `connected` 仍是 false —— 只看这两个字段就会把"正在连"当成"掉线了"，
 *     于是用户刚扫完码 2 秒后又自动拨一次。两条连接前后脚到桌面，旧那条的读循环撞上
 *     新那条的密文，报出来的是一句指向加密的「帧解密失败」（2026-09-27 他手机上撞的就是这个）。
 *  ② 用户主动点「断开」之后不再自动接回 —— 那是他的决定，不该被后台重试覆盖。
 *
 * 打桩打在 Tauri 的命令与事件边界上（不是本模块），所以走的仍是真实的 `normalizeStatus`
 * 与真实的退避表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ IS_ANDROID_APP: true }));
vi.mock('./fileIO', () => ({ isTauri: true }));

const invokes: Array<[string, Record<string, unknown> | undefined]> = [];
let linkCb: ((raw: unknown) => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    invokes.push([cmd, args]);
    return Promise.resolve({ role: 'client', connected: false, peerAddr: '192.168.31.87:47123' });
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_e: string, cb: (x: { payload: unknown }) => void) => {
    linkCb = (raw: unknown) => cb({ payload: raw });
    return Promise.resolve(() => { linkCb = null; });
  },
}));

import { EMPTY_STATUS, linkRedialSnapshot, markLinkUserClosed, startLinkKeepAlive } from './link';

const st = (patch: Record<string, unknown>) => ({ ...EMPTY_STATUS, role: 'client', ...patch });
const dials = () => invokes.filter(([c]) => c === 'link_client_reconnect').length;

beforeEach(() => {
  vi.useFakeTimers();
  invokes.length = 0;
  linkCb = null;
  localStorage.setItem('heid-link-prefs', JSON.stringify({
    enabled: false, port: 47123, host: '192.168.31.87', ticket: '', keyId: 'ab12cd34ef56ab78', peerName: 'PC',
  }));
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('掉线自动接回', () => {
  it('拨号还在路上时不再补一枪', async () => {
    const off = startLinkKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    // 已配上、正在握手：peerAddr 有值而 connected 还没转 —— 这一档不是"掉线"
    linkCb!(st({ peerAddr: '192.168.31.87:47123' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dials(), '等满整个退避表也不该自己再拨一次').toBe(0);
    off();
  });

  it('断开之后（地址被清掉）按第一档 2 秒接回来', async () => {
    const off = startLinkKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    linkCb!(st({ peerAddr: '' }));
    await vi.advanceTimersByTimeAsync(1_900);
    expect(dials()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(dials()).toBe(1);
    off();
  });

  it('连上即停表并把退避归零；用户主动断开之后不再自动接回', async () => {
    const off = startLinkKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    linkCb!(st({ peerAddr: '' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dials()).toBe(1);
    linkCb!(st({ connected: true, peerAddr: '192.168.31.87:47123', peerKeyId: 'ab12cd34ef56ab78' }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dials(), '连上之后手里那发定时器该掐掉').toBe(1);

    // 再掉一次：退避要从第一档重来，而不是接着上次那 60 秒等
    linkCb!(st({ peerAddr: '' }));
    await vi.advanceTimersByTimeAsync(1_900);
    expect(dials(), '第一档就是 2 秒：桌面多数时候收到 RST，那种情况不用等').toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(dials()).toBe(2);

    markLinkUserClosed(true);
    linkCb!(st({ peerAddr: '' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dials(), '他点了断开，这个决定要留到最后').toBe(2);
    markLinkUserClosed(false);
    off();
  });

  it('桌面端（server）永远不自己拨号', async () => {
    const off = startLinkKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    linkCb!({ ...EMPTY_STATUS, role: 'server', listening: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dials()).toBe(0);
    off();
  });

  /* 顶栏那颗转圈读的是这里那份信号（`linkRedialSnapshot` → 手机顶栏 `ScanLinkEntry`）：
     它只说"还在按你定的那张表试"，表跑完就自己收 —— 收掉不等于放弃，后台仍按最后一档重试。
     一直转的转圈会被读成"卡住了"，那是比不转更糟的说法。 */
  it('转圈跟着退避表跑完整张表，之后图标收掉而重试还在继续', async () => {
    const off = startLinkKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    linkCb!(st({ peerAddr: '' }));
    expect(linkRedialSnapshot().spinning, '刚掉线就该开始转，别摆一颗扫码让人自己动手').toBe(true);
    await vi.advanceTimersByTimeAsync(106_000);
    expect(dials()).toBe(4);
    expect(linkRedialSnapshot().spinning, '最后一档还在等，表没跑完').toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(dials(), '2+5+10+30+60 = 107 秒，五档正好跑完').toBe(5);
    expect(linkRedialSnapshot().spinning, '整套退避跑完了就别再预告结果').toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dials(), '图标收掉之后仍在按 60 秒一档试下去').toBe(6);
    off();
  });

  it('用户点过断开：既不补那一枪，也不亮"正在接回"', async () => {
    markLinkUserClosed(true);
    const off = startLinkKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    linkCb!(st({ peerAddr: '' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dials()).toBe(0);
    expect(linkRedialSnapshot().spinning, '他刚做的决定是断开，转圈说的是反方向的话').toBe(false);
    markLinkUserClosed(false);
    off();
  });
});
