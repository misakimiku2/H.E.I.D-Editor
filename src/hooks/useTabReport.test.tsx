// @vitest-environment jsdom
/**
 * 桌面标签上报的节流与去重（v1.5 阶段 3）。
 *
 * 这条测试盯的是一件事：**敲字不该往局域网推帧**。手机上那份列表只反映
 * 「开着什么、脏不脏、叫什么名」，而编辑器每击一键都会换一次光标与脏标记；
 * 不设节流就等于把编辑动作直播给局域网，还会把对端的推送队列刷爆。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const reportTabs = vi.fn(async (..._args: [string, unknown[]]) => {});
const setSharedRoot = vi.fn(async (..._args: [string, string | null]) => {});
vi.mock('../lib/link', async () => {
  const actual = await import('../lib/link');
  return {
    reportTabs: (label: string, tabs: unknown[]) => reportTabs(label, tabs),
    setSharedRoot: (label: string, path: string | null) => setSharedRoot(label, path),
    // tabReports 用真实实现（它的字段映射在 link.test.ts 里单独验）
    tabReports: actual.tabReports,
  };
});

import { useTabReport, TAB_REPORT_THROTTLE_MS } from './useTabReport';
import type { FileTab } from '../lib/tabModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function tab(over: Partial<FileTab> & { id: string }): FileTab {
  return {
    title: over.title ?? `${over.id}.md`,
    path: over.path ?? `C:\\notes\\${over.id}.md`,
    language: over.language ?? 'markdown',
    mdView: over.mdView ?? 'edit',
    isDirty: over.isDirty ?? false,
    readOnly: over.readOnly ?? false,
    ...over,
  } as FileTab;
}

let root: Root | null = null;
let props: Record<string, unknown> = {};

function Probe() {
  useTabReport(props as never);
  return null;
}

function renderWith(p: Record<string, unknown>) {
  props = { enabled: true, windowLabel: 'main', rootPath: null, tabs: [], activeTabId: '', cursor: { line: 1, col: 1 }, ...p };
  if (!root) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
  }
  act(() => { root!.render(<Probe />); });
}

beforeEach(() => {
  vi.useFakeTimers();
  reportTabs.mockClear();
  setSharedRoot.mockClear();
  root = null;
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  vi.useRealTimers();
});

const sent = () => reportTabs.mock.calls.map(c => c[1] as { title: string; dirty: boolean }[]);

describe('useTabReport', () => {
  it('第一份立刻上报，不等节流', () => {
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a' });
    expect(reportTabs).toHaveBeenCalledTimes(1);
    expect(sent()[0][0].title).toBe('a.md');
  });

  it('同一份列表重渲染不再上报', () => {
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a' });
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a' });
    expect(reportTabs).toHaveBeenCalledTimes(1);
  });

  it('光标移动不触发上报（列表上看不见它）', () => {
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a' });
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a', cursor: { line: 40, col: 9 } });
    expect(reportTabs).toHaveBeenCalledTimes(1);
  });

  it('节流窗口内的连续变化只发最后一份', () => {
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a' });
    // 敲第一下：脏了 —— 落在节流窗口里，此刻不该再发
    renderWith({ tabs: [tab({ id: 'a', isDirty: true })], activeTabId: 'a', cursor: { line: 1, col: 2 } });
    expect(reportTabs).toHaveBeenCalledTimes(1);
    // 接着敲：只有最后那一份会在尾沿发出去
    renderWith({ tabs: [tab({ id: 'a', isDirty: true }), tab({ id: 'b' })], activeTabId: 'a', cursor: { line: 1, col: 3 } });
    expect(reportTabs).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(TAB_REPORT_THROTTLE_MS); });
    expect(reportTabs).toHaveBeenCalledTimes(2);
    expect(sent()[1].map(t => t.title)).toEqual(['a.md', 'b.md']);
  });

  it('非可见字段变化（如只读切换）也照发，因为它在列表上看得见', () => {
    renderWith({ tabs: [tab({ id: 'a' })], activeTabId: 'a' });
    act(() => { vi.advanceTimersByTime(TAB_REPORT_THROTTLE_MS); });
    renderWith({ tabs: [tab({ id: 'a', readOnly: true })], activeTabId: 'a' });
    expect(reportTabs).toHaveBeenCalledTimes(2);
  });

  it('共享根按窗口报，且换根立刻报（不受标签节流牵连）', () => {
    renderWith({ windowLabel: 'win-2', rootPath: 'D:\\projects\\notes' });
    expect(setSharedRoot).toHaveBeenCalledWith('win-2', 'D:\\projects\\notes');
    renderWith({ windowLabel: 'win-2', rootPath: 'D:\\other' });
    expect(setSharedRoot).toHaveBeenLastCalledWith('win-2', 'D:\\other');
  });

  it('enabled=false 时一条都不发（手机端与浏览器壳走到这里）', () => {
    renderWith({ enabled: false, tabs: [tab({ id: 'a' })], rootPath: 'D:\\x' });
    expect(reportTabs).not.toHaveBeenCalled();
    expect(setSharedRoot).not.toHaveBeenCalled();
  });
});
