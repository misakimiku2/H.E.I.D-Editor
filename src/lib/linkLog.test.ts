/**
 * 互联日志环：钉的是「一次状态跃迁记一行、重复推过来的不记、同一种高频事件并成一行」，
 * 以及环的上限与订阅通知 —— 这几条决定了那行「互联日志 · N 条」报的数与点进去看见的是否一致。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_STATUS, type LinkStatus } from './link';

type LogModule = typeof import('./linkLog');

const s = (patch: Partial<LinkStatus>): LinkStatus => ({ ...EMPTY_STATUS, ...patch });

/** 每个用例都换一个新模块：环缓冲与「上一份快照」是模块级状态，不隔离就会串台 */
let mod: LogModule;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mod = await import('./linkLog');
});

describe('logStatusChange：跃迁而不是全量', () => {
  it('第一份只报当前那一档，不铺成几行', () => {
    mod.logStatusChange(s({ role: 'server', listening: true, port: 47123 }));
    const lines = mod.linkLogSnapshot();
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe('link.log.listening');
    expect(lines[0].params).toEqual({ port: 47123 });
  });

  it('连上/断开这里一行都不记 —— 那两件事由 Rust 那侧的 up/down 说（带模式、keyId、耗时）', () => {
    mod.logStatusChange(s({ role: 'server', listening: true, port: 47123 }));
    const n0 = mod.linkLogSnapshot().length;
    mod.logStatusChange(s({ role: 'server', listening: true, connected: true, peerDevice: 'Mate', peerAddr: '192.168.1.9:52134' }));
    expect(mod.linkLogSnapshot()).toHaveLength(n0);
    mod.logStatusChange(s({ role: 'server', listening: true, connected: false }));
    expect(mod.linkLogSnapshot()).toHaveLength(n0);
  });

  it('共享范围变了要记一行（暴露面多一分就得留一条凭据）', () => {
    mod.logStatusChange(s({ role: 'server', listening: true }));
    mod.logStatusChange(s({ role: 'server', listening: true, rootDisplay: 'D:\\proj' }));
    const last = mod.linkLogSnapshot().at(-1);
    expect(last?.key).toBe('link.log.scope');
    expect(last?.params).toEqual({ root: 'D:\\proj' });
  });

  it('同一句失败反复推过来只记一次，换了内容才是新的一次', () => {
    mod.logStatusChange(s({ role: 'client' }));
    mod.logStatusChange(s({ role: 'client', lastError: '端口被占用' }));
    mod.logStatusChange(s({ role: 'client', lastError: '端口被占用' }));
    expect(mod.linkLogSnapshot().filter((l) => l.level === 'error')).toHaveLength(1);
    mod.logStatusChange(s({ role: 'client', lastError: '对端已关闭连接' }));
    expect(mod.linkLogSnapshot().filter((l) => l.level === 'error')).toHaveLength(2);
  });
});

describe('renderLogText：日志标签页与另存出去的那份', () => {
  const t = (key: string, p?: Record<string, string | number>) => `${key}${p?.type ? ':' + p.type : ''}`;

  it('一行一条、带上合并计数，头部那一行只在导出时加', () => {
    mod.logLink('info', 'link.log.push', { type: 'tabs' }, 'push:tabs');
    mod.logLink('info', 'link.log.push', { type: 'tabs' }, 'push:tabs');
    const body = mod.renderLogText(t as never);
    expect(body.split('\n')).toHaveLength(1);
    expect(body.endsWith('link.log.push:tabs ×2')).toBe(true);
    expect(mod.renderLogText(t as never, '# 导出').split('\n')[0]).toBe('# 导出');
  });
});

describe('logLink：合并与上限', () => {
  it('同 merge 的重复事件并成一行、计数往上加', () => {
    mod.logLink('info', 'link.log.push', { type: 'tabs' }, 'push:tabs');
    mod.logLink('info', 'link.log.push', { type: 'tabs' }, 'push:tabs');
    mod.logLink('info', 'link.log.push', { type: 'tabs' }, 'push:tabs');
    const lines = mod.linkLogSnapshot();
    expect(lines).toHaveLength(1);
    expect(lines[0].n).toBe(3);
  });

  it('没给 merge 的每一行都算一次发生', () => {
    mod.logLink('info', 'link.log.listening', { port: 1 });
    mod.logLink('info', 'link.log.listening', { port: 2 });
    expect(mod.linkLogSnapshot()).toHaveLength(2);
  });

  it('环只留最近 200 条，最旧的那些自己掉出去', () => {
    for (let i = 0; i < 260; i++) mod.logLink('info', 'link.log.off');
    const lines = mod.linkLogSnapshot();
    expect(lines).toHaveLength(200);
  });

  it('清空之后界面读到的是空数组，而不是上一次那份', () => {
    mod.logLink('info', 'link.log.off');
    mod.clearLinkLog();
    expect(mod.linkLogSnapshot()).toHaveLength(0);
  });

  it('订阅者在每次写入时都被通知', () => {
    const cb = vi.fn();
    const off = mod.subscribeLinkLog(cb);
    mod.logLink('info', 'link.log.off');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    mod.logLink('info', 'link.log.off');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
