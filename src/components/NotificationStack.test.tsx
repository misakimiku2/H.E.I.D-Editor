// @vitest-environment jsdom
/**
 * NotificationStack 冒烟：store 直连渲染
 * ① 标题/说明/动作按钮按 store 内容渲染；
 * ② 动作点击回调触发且不冒泡成卡片点击；关闭按钮移除卡片（store 同步清空）；
 * ③ timeoutMs 到时自动消失（fake timers）；closable=false 不渲染关闭按钮。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

import { NotificationStack } from './NotificationStack';
import {
  dismissNotification, resetNotificationsForTest, showNotification,
} from '../lib/notifications';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

beforeEach(() => {
  resetNotificationsForTest();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

describe('NotificationStack', () => {
  it('无通知时不渲染任何内容', () => {
    render(<NotificationStack isDarkMode={false} />);
    expect(container!.children).toHaveLength(0);
  });

  it('渲染标题、说明与动作按钮，点击动作回调且不触发卡片点击', () => {
    const onSelect = vi.fn();
    const onCardClick = vi.fn();
    showNotification({
      id: 'u1', kind: 'update', title: '发现新版本 v2.0',
      message: '更新内容摘要', timeoutMs: 0,
      actions: [
        { id: 'ignore', label: '忽略', onSelect: () => {}, emphasis: 'plain' },
        { id: 'install', label: '下载', onSelect, emphasis: 'primary' },
      ],
      onCardClick,
    });
    render(<NotificationStack isDarkMode={false} />);
    expect(container!.textContent).toContain('发现新版本 v2.0');
    expect(container!.textContent).toContain('更新内容摘要');
    const install = [...container!.querySelectorAll('button')].find(b => b.textContent === '下载')!;
    act(() => { install.click(); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('点击卡片主体触发 onCardClick；点击关闭按钮移除卡片', () => {
    const onCardClick = vi.fn();
    showNotification({ id: 'c1', kind: 'info', title: '提示', onCardClick });
    render(<NotificationStack isDarkMode />);
    const card = container!.firstElementChild!.firstElementChild!;
    act(() => { (card as HTMLElement).click(); });
    expect(onCardClick).toHaveBeenCalledTimes(1);

    const close = [...container!.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'close')!;
    act(() => { close.click(); });
    expect(container!.textContent).not.toContain('提示');
  });

  it('closable=false 不渲染关闭按钮', () => {
    showNotification({ id: 'p1', kind: 'info', title: '下载中', closable: false });
    render(<NotificationStack isDarkMode={false} />);
    expect([...container!.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'close')).toBe(false);
  });

  it('timeoutMs 到时自动消失', () => {
    vi.useFakeTimers();
    try {
      showNotification({ id: 't1', kind: 'success', title: '完成', timeoutMs: 1000 });
      render(<NotificationStack isDarkMode={false} />);
      expect(container!.textContent).toContain('完成');
      act(() => { vi.advanceTimersByTime(1100); });
      expect(container!.textContent).not.toContain('完成');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismiss 后联动清空渲染', () => {
    showNotification({ id: 'd1', kind: 'error', title: '失败' });
    render(<NotificationStack isDarkMode={false} />);
    act(() => { dismissNotification('d1'); });
    expect(container!.textContent).not.toContain('失败');
  });
});
