// @vitest-environment jsdom
/**
 * 手机连上桌面之后的「交接」（2026-09-27 他点名的三条）。
 *
 * 这条测试盯的是三件只有在这里才定得下来的事：
 *  ① 落地的是**桌面上正看着的那一份**，其余桌面标签排在后面安静补进来（不抢前台）；
 *  ② 桌面设了共享根才换手机那棵文件夹树，没设就一律不动手机自己的；
 *  ③ 什么时候算失败 —— 桌面拒了、等不到回应、以及"连上了但一份都接不过来"各走各的口，
 *     不能都糊成一句「连不上」。
 * 还钉住一条安全性：同一路径手机里已经开着（可能正被用户改着）就不重开，
 * 免扫重连那类"再连一次"不该把磁盘内容盖到他没保存的改动上。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const DEV = 'ab12cd34ef56ab78';

let emit: ((s: unknown) => void) | null = null;
/** 挂上状态订阅的次数：一次挂载就该只有一次，宿主每轮渲染都重挂会把事件挂在空档里 */
let subs = 0;
const userClosed: boolean[] = [];
let tabs: unknown[] = [];
let scope: { hasRoot: boolean } = { hasRoot: false };
const tabsCalls = vi.fn(async () => tabs);
const scopeCalls = vi.fn(async () => scope);

vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    subscribeLinkStatus: (cb: (s: unknown) => void) => { subs += 1; emit = cb; return () => { emit = null; }; },
    markLinkUserClosed: (on: boolean) => { userClosed.push(on); },
  };
});
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return {
    ...real,
    remoteTabs: () => tabsCalls(),
    remoteScope: () => scopeCalls(),
  };
});
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

import { useLinkHandoff, HANDOFF_MAX_TABS, type HandoffOptions } from './useLinkHandoff';
import { EMPTY_STATUS, type LinkStatus } from '../lib/link';
import type { RemoteTabView } from '../lib/remote';
import { RemoteError } from '../lib/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let begin: (() => () => void) | null = null;
let opts: HandoffOptions;
const opened: Array<{ path: string; activate: boolean }> = [];
const revealed: string[] = [];
const roots: string[] = [];
const nothing: number[] = [];
const failed: string[] = [];

function Probe() {
  begin = useLinkHandoff(opts);
  return null;
}

const st = (patch: Partial<LinkStatus>): LinkStatus => ({ ...EMPTY_STATUS, role: 'client', ...patch });
const onLine = { connected: true, peerKeyId: DEV, peerAddr: '192.168.31.87:47123', peerDevice: 'PC' };

const tab = (over: Partial<RemoteTabView>): RemoteTabView => ({
  title: 'a.md', language: 'markdown', mdView: 'edit', dirty: false, readOnly: false,
  line: 0, col: 0, rel: '', reason: '', active: false, ...over,
});

async function mount(over: Partial<HandoffOptions> = {}) {
  opened.length = 0;
  revealed.length = 0;
  roots.length = 0;
  nothing.length = 0;
  failed.length = 0;
  opts = {
    enabled: true,
    hasTab: () => false,
    openRemote: async (path, activate) => { opened.push({ path, activate }); },
    reveal: (p) => { revealed.push(p); },
    adoptRoot: (r) => { roots.push(r); },
    onNothing: () => { nothing.push(1); },
    onFailed: (m) => { failed.push(m); },
    ...over,
  };
  root = createRoot(document.createElement('div'));
  act(() => { root!.render(<Probe />); });
  await act(async () => { await Promise.resolve(); });
}

/**
 * 让宿主（也就是 App）正常渲染一轮。真机上这一下是免不了的：顶栏「扫一扫」扫到码，
 * 第一件事就是 `onOpenChange(false)` 收相机 —— 那是 App 自己的 state，必然重渲染。
 */
function hostRerender() {
  act(() => { root!.render(<Probe />); });
}

/** 走一遍真实的时序：发起 → 状态说连上了 → 让那一串 await 都落定 */
async function pairAndConnect() {
  let cancel = () => {};
  act(() => { cancel = begin!(); });
  await act(async () => { emit?.(st(onLine)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return cancel;
}

beforeEach(() => {
  vi.useFakeTimers();
  tabs = [];
  scope = { hasRoot: false };
  userClosed.length = 0;
  /** `mockClear` 不清实现：某一条用例用 `mockRejectedValue` 打过桩，不还原就会漏到后面几条 */
  tabsCalls.mockImplementation(async () => tabs);
  scopeCalls.mockImplementation(async () => scope);
  tabsCalls.mockClear();
  scopeCalls.mockClear();
  emit = null;
  subs = 0;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  vi.useRealTimers();
});

describe('连上之后接到手机上', () => {
  it('桌面上正看着的那一份先到前台，其余排在后面不抢前台', async () => {
    tabs = [
      tab({ rel: 'notes/a.md', title: 'a.md' }),
      tab({ rel: 'notes/b.md', title: 'b.md', active: true }),
      tab({ rel: 'notes/c.md', title: 'c.md' }),
    ];
    await mount();
    await pairAndConnect();
    expect(opened.map(o => o.path)).toEqual([
      `hide-remote://${DEV}/notes/b.md`,
      `hide-remote://${DEV}/notes/a.md`,
      `hide-remote://${DEV}/notes/c.md`,
    ]);
    expect(opened.map(o => o.activate)).toEqual([true, false, false]);
  });

  it('没有一份标着「正看着」时按桌面的顺序开第一份', async () => {
    tabs = [tab({ rel: 'x.md' }), tab({ rel: 'y.md' })];
    await mount();
    await pairAndConnect();
    expect(opened[0].path).toBe(`hide-remote://${DEV}/x.md`);
    expect(opened[0].activate).toBe(true);
  });

  it('接管不了的行（脏 / 没存盘 / 读不到）不开', async () => {
    tabs = [
      tab({ rel: 'ok.md' }),
      tab({ rel: '', reason: 'dirty', dirty: true, active: true }),
      tab({ rel: '', reason: 'novirtual' }),
      tab({ rel: '', reason: 'missing' }),
    ];
    await mount();
    await pairAndConnect();
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/ok.md`]);
  });

  it('手机里已经开着的同一路径不重读磁盘；正看着那份已经开着就只切到前台', async () => {
    /* openPathIntoTab 对已存在的标签会用磁盘内容盖掉它，正被用户改着的那一份就没了 */
    tabs = [tab({ rel: 'a.md', active: true }), tab({ rel: 'b.md' })];
    await mount({ hasTab: (p) => p.endsWith('/a.md') });
    await pairAndConnect();
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/b.md`]);
    expect(revealed, '电脑上正看着那一份手机里开着：切到前台就行').toEqual([`hide-remote://${DEV}/a.md`]);
    expect(nothing, '已经摊开了一份，不算"接不过来"').toEqual([]);
  });

  it('一次最多接 12 份', async () => {
    tabs = Array.from({ length: HANDOFF_MAX_TABS + 6 }, (_, i) => tab({ rel: `f${i}.md` }));
    await mount();
    await pairAndConnect();
    expect(opened).toHaveLength(HANDOFF_MAX_TABS);
  });

  it('一份都接不过来时回落到「电脑上正打开的文件」那一屏，而不是报一次失败', async () => {
    tabs = [tab({ rel: '', reason: 'dirty', dirty: true })];
    await mount();
    await pairAndConnect();
    expect(nothing).toHaveLength(1);
    expect(failed).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('桌面没开标签也算接不过来', async () => {
    tabs = [];
    await mount();
    await pairAndConnect();
    expect(nothing).toHaveLength(1);
  });
});

describe('文件夹树按桌面那边定', () => {
  it('桌面设了共享根：手机这棵换成那台电脑的', async () => {
    scope = { hasRoot: true };
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await pairAndConnect();
    expect(roots).toEqual([`hide-remote://${DEV}`]);
  });

  it('桌面没设共享根：保留手机自己那棵（一次都不提）', async () => {
    scope = { hasRoot: false };
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await pairAndConnect();
    expect(roots).toEqual([]);
  });

  it('问不到共享范围只是不换树，标签该开还是要开', async () => {
    scopeCalls.mockRejectedValue(new Error('nolink: 没这条链路'));
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await pairAndConnect();
    expect(roots).toEqual([]);
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`]);
    expect(failed, '这不算失败').toEqual([]);
  });
});

describe('这趟没成的三种说法', () => {
  it('桌面拒了：把它的原话说出去，并且一个字都不读', async () => {
    await mount();
    act(() => { begin!(); });
    await act(async () => {
      emit?.(st({ connected: false, peerAddr: '', lastError: '配对码和电脑上当前这张对不上了' }));
    });
    expect(failed).toEqual(['配对码和电脑上当前这张对不上了']);
    expect(tabsCalls).not.toHaveBeenCalled();
  });

  it('还在拨过去时（有地址、没原因）不算失败也不算成功', async () => {
    await mount();
    act(() => { begin!(); });
    await act(async () => { emit?.(st({ peerAddr: '192.168.31.87:47123' })); });
    expect(failed).toEqual([]);
    expect(tabsCalls).not.toHaveBeenCalled();
  });

  it('等不到回应：报的是那句带下一步的超时', async () => {
    await mount();
    act(() => { begin!(); });
    await act(async () => { vi.advanceTimersByTime(25_000); });
    expect(failed).toEqual(['link.handoffTimeout']);
  });

  it('收回之后连上不再说话，但交接照做（那已经是自动接回那档的默认行为）', async () => {
    /* 配对命令本身没过（地址为空那类）时调用方会收回：那次拨号根本没发生，
       之后任何一次真连上都不该被它触发一句「超时」。
       而 2026-09-27 之后"连上就要交接"不再只由用户发起，所以收回只收回**说话**这一半。 */
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    let cancel = () => {};
    act(() => { cancel = begin!(); });
    act(() => { cancel(); });
    await act(async () => { emit?.(st(onLine)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`]);
    expect(failed).toEqual([]);
  });

  it('没连着时来的状态一律不动手', async () => {
    await mount();
    act(() => { begin!(); });
    await act(async () => { emit?.(st({ connected: true, peerKeyId: '' })); });
    await act(async () => { emit?.(st({ connected: false, peerAddr: '', lastError: '' })); });
    expect(tabsCalls).not.toHaveBeenCalled();
    expect(failed).toEqual([]);
  });

  /* 「链路已断开：连接已结束」那一类是**自愈中的中间态**：息屏、桌面重启、第二条连接顶上来都会
     走到这里，而掉线之后本来就会自动接回来。为它弹一屏模态，用户读到的是"我配对失败了"。 */
  it('链路级失败不弹模态：等下一次连上再跑一遍', async () => {
    tabs = [tab({ rel: 'a.md', active: true })];
    tabsCalls.mockRejectedValueOnce(new RemoteError('dropped', '链路已断开：连接已结束'));
    await mount();
    act(() => { begin!(); });
    await act(async () => { emit?.(st(onLine)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(failed, '一次掐线不该说话').toEqual([]);
    expect(opened).toEqual([]);

    await act(async () => { emit?.(st({ connected: false, peerAddr: '', lastError: '' })); });
    await act(async () => { emit?.(st(onLine)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(opened.map(o => o.path), '接回来之后把刚才没做完的做完').toEqual([`hide-remote://${DEV}/a.md`]);
    expect(failed).toEqual([]);
  });

  it('链路级失败一直回不来时，由那只表说话', async () => {
    tabsCalls.mockRejectedValue(new RemoteError('dropped', '链路已断开：连接已结束'));
    await mount();
    act(() => { begin!(); });
    await act(async () => { emit?.(st(onLine)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(failed).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(25_000); });
    expect(failed).toEqual(['link.handoffTimeout']);
  });
});

describe('发起这条动作本身', () => {
  it('发起就是「用户主动要连」：之前那次断开作废', async () => {
    await mount();
    act(() => { begin!(); });
    expect(userClosed).toEqual([false]);
  });

  it('状态事件先到时交接已经做了，begin 不再重跑一遍', async () => {
    /* 局域网里握手不到 100 ms，事件常常抢在 begin 之前 —— 那时候同一条连接的交接已经落地了，
       begin 再跑一遍就是白读十几份远程文件 */
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    act(() => { emit?.(st(onLine)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`]);
    opened.length = 0;
    act(() => { begin!(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(tabsCalls, '一条连接只交接一次').toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);
    expect(failed, '也不留一只要报超时的表').toEqual([]);
  });

  it('非手机端什么都不做，交出的收回也是空操作', async () => {
    await mount({ enabled: false });
    let cancel: (() => void) | null = null;
    act(() => { cancel = begin!(); });
    expect(() => cancel!()).not.toThrow();
    expect(userClosed, '不碰那份"用户主动断开"的标记').toEqual([]);
    await act(async () => { emit?.(st(onLine)); });
    expect(tabsCalls).not.toHaveBeenCalled();
  });

  it('中途掉线就停手：剩下的不补，已打开的留着', async () => {
    tabs = [tab({ rel: 'a.md', active: true }), tab({ rel: 'b.md' }), tab({ rel: 'c.md' })];
    await mount({
      openRemote: async (path, activate) => {
        opened.push({ path, activate });
        if (path.endsWith('/a.md')) {
          // 第一份读回来的那一刻链路断了（息屏就是这个形状）
          act(() => { emit?.(st({ connected: false, peerAddr: '', peerKeyId: '' })); });
        }
      },
    });
    await pairAndConnect();
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`]);
  });
});

/* 2026-09-27 他手机上「扫完码标签页没变、树也没换，而且一句错都不报」。
   交接的意图与状态订阅都得活过宿主的一轮普通渲染 —— 上面那些用例的宿主从头到尾只渲染一次，
   正好把这条漏掉了。 */
describe('宿主重渲染冲不掉交接', () => {
  it('发起之后 App 渲染一轮：连上了照样摊开电脑上那份、换掉手机那棵树', async () => {
    scope = { hasRoot: true };
    tabs = [tab({ rel: 'a.md', active: true }), tab({ rel: 'b.md' })];
    await mount();
    act(() => { begin!(); });
    hostRerender();
    hostRerender();
    await act(async () => { emit?.(st(onLine)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`, `hide-remote://${DEV}/b.md`]);
    expect(roots).toEqual([`hide-remote://${DEV}`]);
    expect(failed).toEqual([]);
  });

  it('那只等超时的表也活得过一轮渲染：一直连不上要说一句，不能静默', async () => {
    await mount();
    act(() => { begin!(); });
    hostRerender();
    await act(async () => { vi.advanceTimersByTime(25_000); });
    expect(failed).toEqual(['link.handoffTimeout']);
    expect(opened).toEqual([]);
  });

  it('状态订阅一次挂定：宿主渲染十轮也只挂一次', async () => {
    await mount();
    for (let i = 0; i < 10; i += 1) hostRerender();
    expect(subs, '每轮都退订再订阅，事件就可能落在空档里').toBe(1);
  });

  it('收回之后就算宿主又渲染几轮，那一次也不会再替自己说话', async () => {
    await mount();
    let cancel = () => {};
    act(() => { cancel = begin!(); });
    act(() => { cancel(); });
    hostRerender();
    await act(async () => { emit?.(st({ connected: false, peerAddr: '', lastError: '上一次拨号留下的一句原因' })); });
    await act(async () => { await Promise.resolve(); });
    expect(failed, '收回的是「说话」那一半；交接本身照做，见上面那条').toEqual([]);
  });
});

/* 2026-09-27 他补的第三条：冷启动的免扫重连、息屏亮屏后自动接回来，也要把电脑上正看着那一份
   摊开、把那棵树换过来。与主动那次的区别只在**说不说话**：后台自己接回来的几次一律安静。 */
describe('自动接回也交接，但不说话', () => {
  const settle = async (n = 3) => { await act(async () => { for (let i = 0; i < n; i += 1) await Promise.resolve(); }); };

  it('没人 begin 过：连上了照样摊开电脑上那份、换掉手机那棵树', async () => {
    scope = { hasRoot: true };
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await act(async () => { emit?.(st(onLine)); });
    await settle();
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`]);
    expect(roots, '树也一样换过来').toEqual([`hide-remote://${DEV}`]);
    expect(failed).toEqual([]);
    expect(nothing).toEqual([]);
  });

  it('同一条连接只交接一次（状态连着推几帧不该重跑）', async () => {
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await act(async () => { emit?.(st(onLine)); });
    await settle(2);
    await act(async () => { emit?.(st(onLine)); });
    await settle(2);
    expect(tabsCalls).toHaveBeenCalledTimes(1);
  });

  it('断开之后再接回来重新交接一次（电脑上换了正看着那一份）', async () => {
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await act(async () => { emit?.(st(onLine)); });
    await settle(2);
    await act(async () => { emit?.(st({ connected: false, peerAddr: '', peerKeyId: '' })); });
    tabs = [tab({ rel: 'b.md', active: true })];
    await act(async () => { emit?.(st(onLine)); });
    await settle(2);
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`, `hide-remote://${DEV}/b.md`]);
  });

  it('后台接回来时读不到标签列表：不弹模态、不报超时，断开再接回来才补做', async () => {
    tabsCalls.mockRejectedValueOnce(new RemoteError('dropped', '链路已断开：连接已结束'));
    tabs = [tab({ rel: 'a.md', active: true })];
    await mount();
    await act(async () => { emit?.(st(onLine)); });
    await settle(2);
    expect(failed).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(25_000); });
    expect(failed, '没人发起的那一次，超时也不该说话').toEqual([]);
    await act(async () => { emit?.(st({ connected: false, peerAddr: '', peerKeyId: '' })); });
    await act(async () => { emit?.(st(onLine)); });
    await settle();
    expect(opened.map(o => o.path)).toEqual([`hide-remote://${DEV}/a.md`]);
  });

  it('只有用户主动发起的那一次会报失败', async () => {
    await mount();
    act(() => { begin!(); });
    await act(async () => { emit?.(st({ connected: false, peerAddr: '', lastError: '桌面拒了这次配对' })); });
    expect(failed).toEqual(['桌面拒了这次配对']);
    await act(async () => { emit?.(st({ connected: false, peerAddr: '', lastError: '后台重试留下的一句原因' })); });
    expect(failed, '没有意图在下的一次不该开口').toHaveLength(1);
  });
});
