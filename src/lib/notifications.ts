/**
 * 通用应用内通知（左下角毛玻璃卡片）的全局状态：
 * - 模块级发布/订阅，非组件层（lib/hooks）可直接 showNotification() 触发；
 * - NotificationStack 组件订阅本模块渲染，未挂载时通知留存于队列，挂载后立即可见；
 * - 相同 id 重复 show 视为「原地替换」（更新场景：同一张卡片从发现新版本渐变为下载中）；
 * - 超出容量丢弃最旧；自动消失计时由渲染层负责（store 保持无定时器、可测）。
 */

export type NotificationKind = 'info' | 'success' | 'error' | 'update';

/** 卡片动作按钮：primary 蓝色强调（主操作），plain 灰调（次操作） */
export interface NotificationAction {
  id: string;
  label: string;
  onSelect: () => void;
  emphasis?: 'primary' | 'plain';
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  /** 次要说明（纯文本，渲染层截断展示） */
  message?: string;
  actions?: NotificationAction[];
  /** 点击卡片主体时触发（如更新卡片直接开始下载）；缺省卡片整体无点击态 */
  onCardClick?: () => void;
  /** 是否显示关闭按钮；缺省 true（下载进度等必须可见的状态可关掉关闭） */
  closable?: boolean;
  /** 自动消失毫秒数；缺省常驻（更新下载等长任务状态用常驻） */
  timeoutMs?: number;
}

/** 同屏上限：超出丢弃最旧，避免通知淹没界面 */
export const MAX_NOTIFICATIONS = 4;

let items: AppNotification[] = [];
let seq = 0;
const listeners = new Set<(items: readonly AppNotification[]) => void>();

function emit(): void {
  for (const listener of listeners) listener(listNotifications());
}

/** getSnapshot 用：数组以不可变方式替换，引用稳定 */
export function listNotifications(): readonly AppNotification[] {
  return items;
}

/** 订阅变化；立即回调一次当前列表。返回退订函数 */
export function subscribeNotifications(
  listener: (items: readonly AppNotification[]) => void,
): () => void {
  listeners.add(listener);
  listener(listNotifications());
  return () => { listeners.delete(listener); };
}

/**
 * 展示（或替换）一条通知。id 缺省时自动生成。
 * 返回最终 id，供后续替换（同 id）或 dismissNotification。
 */
export function showNotification(
  notification: Omit<AppNotification, 'id'> & { id?: string },
): string {
  const id = notification.id ?? `ntf-${++seq}`;
  const next: AppNotification = { ...notification, id };
  const index = items.findIndex(n => n.id === id);
  if (index >= 0) {
    const copy = items.slice();
    copy[index] = next;
    items = copy;
  } else {
    items = [...items, next].slice(-MAX_NOTIFICATIONS);
  }
  emit();
  return id;
}

export function dismissNotification(id: string): void {
  if (!items.some(n => n.id === id)) return;
  items = items.filter(n => n.id !== id);
  emit();
}

/** 测试隔离：清空全部状态（生产代码勿用） */
export function resetNotificationsForTest(): void {
  items = [];
  seq = 0;
}
