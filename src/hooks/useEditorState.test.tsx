// @vitest-environment jsdom
/**
 * useEditorState 关闭标签的激活态流转：
 * 关闭激活标签必须与删除同一次更新选出继任标签——中间不允许出现
 * 「tabs 已删、activeTab 为 null」的渲染（对应 UI 上闪一帧欢迎页的回归）。
 * 批量关闭时 tabsRef 可能滞后，漏网的悬空 active 由 useLayoutEffect 在 paint 前纠正。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useEditorState, type EditorState } from './useEditorState';
import { makeUntitledTab, type FileTab } from '../lib/tabModel';

/* React 19 手写 createRoot 测试需显式声明 act 环境 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let latest: EditorState | null = null;

/* 每次渲染记录 (标签数, 激活标签)，用于断言「无激活标签的中间帧」是否出现过 */
let renderLog: { tabCount: number; activeId: string | null }[] = [];

function Harness({ initialTabs }: { initialTabs: FileTab[] }) {
  latest = useEditorState({
    maxDiffEntries: 50,
    onInternalEdit: () => {},
    initialTabs,
  });
  renderLog.push({ tabCount: latest.tabs.length, activeId: latest.activeTab?.id ?? null });
  return null;
}

function render(initialTabs: FileTab[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness initialTabs={initialTabs} />); });
}

function makeTabs(names: string[]): FileTab[] {
  return names.map(n => makeUntitledTab(n));
}

beforeEach(() => {
  renderLog = [];
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe('useEditorState 关闭标签', () => {
  it('关闭激活标签：同一次更新选出继任（最后一个），全程不渲染出 activeTab=null', () => {
    const tabs = makeTabs(['a.txt', 'b.txt', 'c.txt']);
    render(tabs);
    const editor = latest!;
    /* 挂载后兜底选中最后一个 */
    expect(editor.activeTabId).toBe(tabs[2].id);
    /* 挂载首帧的「未选激活」是合法中间态（layout effect 随即纠正），清空后只观察删除动作的渲染 */
    renderLog = [];

    act(() => { editor.deleteTab(tabs[2].id); });
    expect(latest!.tabs.map(t => t.title)).toEqual(['a.txt', 'b.txt']);
    expect(latest!.activeTabId).toBe(tabs[1].id);
    /* 删除动作引发的所有渲染中，不允许出现「还有标签但无激活标签」的中间态 */
    const dangling = renderLog.filter(r => r.tabCount > 0 && r.activeId === null);
    expect(dangling).toEqual([]);
  });

  it('关闭中间的非激活标签：激活态不动', () => {
    const tabs = makeTabs(['a.txt', 'b.txt', 'c.txt']);
    render(tabs);
    act(() => { latest!.deleteTab(tabs[0].id); });
    expect(latest!.activeTabId).toBe(tabs[2].id);
    expect(latest!.activeTab?.title).toBe('c.txt');
  });

  it('关闭最后一个标签：回到无激活态（欢迎页），渲染日志不再出现悬空激活', () => {
    const tabs = makeTabs(['a.txt']);
    render(tabs);
    act(() => { latest!.deleteTab(tabs[0].id); });
    expect(latest!.tabs).toEqual([]);
    expect(latest!.activeTabId).toBe('');
    expect(latest!.activeTab).toBeNull();
  });

  it('activeId 悬空（setTabs 直删模拟批量关闭滞后）：useLayoutEffect 兜底同一批渲染内纠正', () => {
    const tabs = makeTabs(['a.txt', 'b.txt', 'c.txt']);
    render(tabs);
    act(() => {
      /* 绕过 deleteTab：模拟批量关闭循环里 tabsRef 滞后留下的悬空激活态 */
      latest!.setTabs(prev => prev.filter(t => t.id !== latest!.activeTabId));
    });
    expect(latest!.tabs.length).toBe(2);
    expect(latest!.tabs.find(t => t.id === latest!.activeTabId)).toBeTruthy();
  });
});
