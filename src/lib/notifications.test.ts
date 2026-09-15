import { describe, it, expect, vi } from 'vitest';
import {
  MAX_NOTIFICATIONS, dismissNotification, listNotifications, resetNotificationsForTest,
  showNotification, subscribeNotifications,
} from './notifications';

describe('notifications store', () => {
  it('show 后可在列表中读到，缺省 id 自动生成且唯一', () => {
    resetNotificationsForTest();
    const a = showNotification({ kind: 'info', title: 'A' });
    const b = showNotification({ kind: 'info', title: 'B' });
    expect(a).not.toBe(b);
    expect(listNotifications().map(n => n.title)).toEqual(['A', 'B']);
  });

  it('同 id 重复 show 原地替换，不新增条目', () => {
    resetNotificationsForTest();
    showNotification({ id: 'update', kind: 'update', title: '发现新版本' });
    showNotification({ id: 'update', kind: 'update', title: '下载中' });
    expect(listNotifications()).toHaveLength(1);
    expect(listNotifications()[0].title).toBe('下载中');
  });

  it('dismiss 移除对应条目；未知 id 静默', () => {
    resetNotificationsForTest();
    showNotification({ id: 'x', kind: 'info', title: 'X' });
    dismissNotification('x');
    dismissNotification('nope');
    expect(listNotifications()).toHaveLength(0);
  });

  it('超出容量上限丢弃最旧', () => {
    resetNotificationsForTest();
    for (let i = 0; i <= MAX_NOTIFICATIONS; i++) {
      showNotification({ id: `n${i}`, kind: 'info', title: `N${i}` });
    }
    expect(listNotifications().map(n => n.id)).toEqual(
      Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => `n${i + 1}`),
    );
  });

  it('订阅者立即收到当前列表，并在变化时收到新列表；退订后不再收到', () => {
    resetNotificationsForTest();
    showNotification({ id: 'seed', kind: 'info', title: 'seed' });
    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(1);

    showNotification({ id: 'next', kind: 'info', title: 'next' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0]).toHaveLength(2);

    dismissNotification('seed');
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    showNotification({ id: 'after', kind: 'info', title: 'after' });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('替换保留最新字段（message/actions 覆盖）', () => {
    resetNotificationsForTest();
    showNotification({ id: 'u', kind: 'update', title: 'v2', message: 'old', actions: [{ id: 'a', label: 'old', onSelect: () => {} }] });
    showNotification({ id: 'u', kind: 'update', title: 'v2', message: 'new' });
    expect(listNotifications()[0].message).toBe('new');
    expect(listNotifications()[0].actions).toBeUndefined();
  });
});
