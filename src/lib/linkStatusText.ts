/**
 * 互联状态那句人话（「已连接：Pixel 7」/「正在等待连接 · 端口 47123」…）。
 *
 * 设置里的面板、一级入口的按钮悬停说明、浮层头部读的是同一份 `link_status`，
 * 说出来的也必须是同一句话 —— 所以这段判定只在这里写一次。
 */
import type { LinkStatus } from './link';
import type { MessageKey } from './i18n';

type TFn = (k: MessageKey, vars?: Record<string, string | number>) => string;

/** 手机/桌面各只看到自己那一半：手机的中档是「握手已过、桌面还没开始服务」 */
export function isLinkEnabled(s: LinkStatus | null, asClient: boolean): boolean {
  return asClient ? s?.role === 'client' : s?.listening === true;
}

export function linkStateText(
  t: TFn,
  s: LinkStatus | null,
  asClient: boolean,
  fallbackPeerName = '',
): string {
  if (!s || (!isLinkEnabled(s, asClient) && s.role === 'off')) return t('link.stateOff');
  if (s.connected) return t('link.stateConnected', { device: s.peerDevice || fallbackPeerName || s.peerAddr });
  if (asClient) {
    /* 既不能显示成「已连接」（做什么都没反应），也不该显示成「没连上」（明明配好了） */
    return s.waitingConfirm ? t('link.stateAwaitConfirm') : t('link.stateIdle');
  }
  return t('link.stateListening');
}
