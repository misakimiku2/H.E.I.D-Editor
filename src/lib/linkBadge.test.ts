/**
 * 互联入口状态点的判定（桌面按钮 / 手机顶栏按钮 / 抽屉头部共用一份）。
 * 这里钉的是"什么时候亮哪一档"，配色本身在 linkDotCls 里一并钉住，
 * 免得日后有人在某处另写一套颜色语言。
 */
import { describe, it, expect } from 'vitest';
import { linkBadge, linkDotCls } from './linkBadge';
import { EMPTY_STATUS, type LinkStatus } from './link';

const s = (patch: Partial<LinkStatus>): LinkStatus => ({ ...EMPTY_STATUS, ...patch });

describe('linkBadge：桌面（服务端）', () => {
  it('共享没开不给点，避免一颗常灭的点', () => {
    expect(linkBadge(s({ role: 'off' }))).toBeNull();
    expect(linkBadge(s({ role: 'server', listening: false }))).toBeNull();
  });

  it('端口开着没人来连是灰点，连上了转绿', () => {
    expect(linkBadge(s({ role: 'server', listening: true, port: 47123 }))).toBe('idle');
    expect(linkBadge(s({ role: 'server', listening: true, connected: true, peerDevice: 'Pixel' }))).toBe('connected');
  });

  it('测试配对开着时优先报警示档，即使已经连上一台', () => {
    expect(linkBadge(s({ role: 'server', listening: true, connected: true, testPair: true }))).toBe('pending');
  });

  it('桌面不看离线队列：那是手机侧的事', () => {
    expect(linkBadge(s({ role: 'server', listening: true }), { pending: 4, conflicts: 2 })).toBe('idle');
  });
});

describe('linkBadge：手机（客户端）', () => {
  const client = { asClient: true };

  it('没链路时不亮（连手机侧也不给一颗常灭的点）', () => {
    expect(linkBadge(s({ role: 'off' }), client)).toBeNull();
  });

  it('配好了但没连上是灰点，连上了转绿', () => {
    expect(linkBadge(s({ role: 'client' }), client)).toBe('idle');
    expect(linkBadge(s({ role: 'client', connected: true, peerDevice: 'PC' }), client)).toBe('connected');
  });

  it('等电脑上确认与有待同步项都算「要等一等」这一档', () => {
    expect(linkBadge(s({ role: 'client', waitingConfirm: true }), client)).toBe('pending');
    expect(linkBadge(s({ role: 'client', connected: true }), { ...client, pending: 3 })).toBe('connected');
    expect(linkBadge(s({ role: 'client' }), { ...client, pending: 3 })).toBe('pending');
  });

  it('有冲突要人决定时压过一切，包括「已连接」这个好消息', () => {
    expect(linkBadge(s({ role: 'client', connected: true }), { ...client, pending: 3, conflicts: 1 }))
      .toBe('attention');
  });
});

describe('linkBadge：配色沿用既有那四色', () => {
  it('绿 / 琥珀 / 红 / 灰各一档，深浅两档的灰才分两套', () => {
    expect(linkDotCls('connected', true)).toContain('emerald');
    expect(linkDotCls('pending', true)).toContain('amber');
    expect(linkDotCls('attention', true)).toContain('red');
    expect(linkDotCls('idle', true)).not.toBe(linkDotCls('idle', false));
  });
});
