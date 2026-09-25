/**
 * 互联入口那颗状态点的判定与配色：桌面菜单栏按钮、手机顶栏按钮、面板头部三处共用一份，
 * 免得同一个连接状态在三个地方显示出三种样子。
 *
 * 四档沿用应用里已有的那套状态色（`TabBar.tsx` 的标签点、`FileTreeSidebar` 离线横幅）：
 * 绿=已连上、琥珀=要等一等（待同步 / 等电脑确认 / 测试配对开着）、红=要我处理（冲突待确认）、
 * 灰=开着但没人连。链路完全没起来时不给点 —— 一颗常灭的灰点等于噪音。
 */
import type { LinkStatus } from './link';

export type LinkBadge = 'idle' | 'connected' | 'pending' | 'attention';

/** 判定输入：链路状态 + 手机侧离线队列的计数 + 这一端是不是客户端 */
export interface LinkBadgeExtra {
  pending?: number;
  conflicts?: number;
  asClient?: boolean;
}

export function linkBadge(s: LinkStatus, extra: LinkBadgeExtra = {}): LinkBadge | null {
  const pending = extra.pending ?? 0;
  const conflicts = extra.conflicts ?? 0;
  if (extra.asClient) {
    if (s.role !== 'client') return null;
    if (conflicts > 0) return 'attention';
    if (s.connected) return 'connected';
    if (s.waitingConfirm || pending > 0) return 'pending';
    return 'idle';
  }
  if (!s.listening && !s.connected) return null;
  /* 测试配对开着 = 局域网内谁都能连且不用点允许，优先级高于「已连上」这个好消息 */
  if (s.testPair) return 'pending';
  return s.connected ? 'connected' : 'idle';
}

/** 状态点的底色。深浅两档的「灰」取自 TabBar 同一对值，不另发明第三种灰 */
export function linkDotCls(badge: LinkBadge, dark: boolean): string {
  switch (badge) {
    case 'connected': return 'bg-emerald-500';
    case 'pending': return 'bg-amber-500';
    case 'attention': return 'bg-red-500';
    case 'idle': return dark ? 'bg-zinc-500' : 'bg-zinc-400';
  }
}
