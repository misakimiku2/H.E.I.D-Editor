// @vitest-environment jsdom
/**
 * 草稿捕获的节流语义（崩溃保护的地基）：首笔编辑当场落盘，连续打字期间最多 3 秒写一次，
 * 窗口里攒下的多次改动到点写的是最新那一份 —— 崩溃最坏只丢这 3 秒，
 * 而不是「整段没停手的编辑」（尾沿防抖的老行为：一直打字就一次都不落盘）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { useFileActions } from './useFileActions';
import type { EditorState } from './useEditorState';
import { draftKeyForTab, loadDrafts, MAX_DRAFT_CHARS } from '../lib/drafts';
import { listNotifications, resetNotificationsForTest } from '../lib/notifications';
import { makeUntitledTab, type FileTab } from '../lib/tabModel';

const PATH = 'C:/docs/notes.md';
const KEY = `file:${PATH}`;

/** 只认 heid-drafts 这一份的当前内容 */
const draftOf = (key: string): string | null => loadDrafts(localStorage)[key]?.content ?? null;
/** 现在浮在界面上的通知卡片 */
const cards = () => listNotifications();

function fileTab(content: string, extra: Partial<FileTab> = {}): FileTab {
  return {
    ...makeUntitledTab('notes.md', content),
    path: PATH,
    isDirty: true,
    readOnly: false,
    ...extra,
  };
}

/** 只喂标签集合，其余入参给不会动的占位：这里要盯的是草稿那一条 effect */
function Harness({ tabs }: { tabs: FileTab[] }) {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useFileActions({
    editor: {
      tabs, tabsRef,
      setTabs: vi.fn(),
      activeTab: tabs[0] ?? null,
      activeTabId: tabs[0]?.id ?? '',
      setActiveTabId: vi.fn(),
      setActiveTabIdRef: { current: vi.fn() },
      activeTabIdRef: { current: tabs[0]?.id ?? '' },
      recordContentChange: vi.fn(),
      updateTabContent: vi.fn(),
      deleteTab: vi.fn(),
    } as unknown as EditorState,
    askDiscardConfirm: async () => 'discard',
    pendingDiscardRef: { current: null },
    exitingRef: { current: false },
    updateKnownDiskContent: vi.fn(),
    onRemoteConflict: vi.fn(),
    autosaveEnabled: false,
    autosaveIntervalSec: 30,
    t: (key: string) => key,
  });
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
/** heid-drafts 这一份的 setItem 次数（其余键的写入不计，避免被最近文件/快照干扰） */
let draftWrites = 0;

function mount(tabs: FileTab[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness tabs={tabs} />); });
}

function rerender(tabs: FileTab[]) {
  act(() => { root!.render(<Harness tabs={tabs} />); });
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetNotificationsForTest();
  draftWrites = 0;
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    if (k === 'heid-drafts') draftWrites++;
    original.call(this, k, v);
  });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('草稿节流', () => {
  it('首笔编辑当场落盘，不等 3 秒', () => {
    mount([fileTab('v1')]);
    expect(draftOf(KEY)).toBe('v1');
    expect(draftWrites).toBe(1);
  });

  it('连续打字：窗口内一次都不重复写，到点写最新那一份', () => {
    mount([fileTab('v1')]);
    rerender([fileTab('v12')]);
    rerender([fileTab('v123')]);
    rerender([fileTab('v1234')]);
    /* 全在同一个 3 秒窗口里：草稿仍是首笔那份，只排了一次尾随落盘 */
    expect(draftOf(KEY)).toBe('v1');
    expect(draftWrites).toBe(1);
    advance(3000);
    expect(draftOf(KEY)).toBe('v1234');
    expect(draftWrites).toBe(2);
  });

  it('过了窗口再改，又是一次当场落盘', () => {
    mount([fileTab('v1')]);
    advance(3000);
    rerender([fileTab('v2')]);
    expect(draftOf(KEY)).toBe('v2');
  });

  it('保存后（不再脏）同批清除草稿', () => {
    mount([fileTab('v1')]);
    rerender([fileTab('v1', { isDirty: false })]);
    advance(3000);
    expect(draftOf(KEY)).toBeNull();
  });

  it('只读标签不进草稿', () => {
    mount([fileTab('v1', { readOnly: true })]);
    expect(draftOf(draftKeyForTab({ path: PATH, title: 'notes.md' }))).toBeNull();
    expect(draftWrites).toBe(0);
  });
});

describe('没有草稿保护时说出来', () => {
  const BIG = 'x'.repeat(MAX_DRAFT_CHARS + 1);

  it('超过草稿上限的脏标签：报超限，而不是静默放弃保护', () => {
    mount([fileTab(BIG)]);
    const cap = cards().find(n => n.id === 'heid-draft-cap');
    expect(cap?.title).toBe('draft.capTitle');
    expect(cap?.kind).toBe('error');
    /* 保存一次就重新有副本，所以这条必须带得动那个动作 */
    expect(cap?.actions?.map(a => a.label)).toEqual(['draft.capSaveNow']);
  });

  it('同一情况一个窗口只说一次，不每 3 秒刷屏', () => {
    mount([fileTab(BIG)]);
    rerender([fileTab(`${BIG}y`)]);
    advance(3000);
    rerender([fileTab(`${BIG}yz`)]);
    advance(3000);
    expect(cards().filter(n => n.id === 'heid-draft-cap')).toHaveLength(1);
    expect(cards()).toHaveLength(1);
  });

  it('正常大小的脏标签不打扰', () => {
    mount([fileTab('v1')]);
    advance(3000);
    expect(cards()).toEqual([]);
  });

  it('本地存储写不进去：报的是存储那条', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    mount([fileTab('v1')]);
    expect(cards().some(n => n.id === 'heid-draft-storage')).toBe(true);
    expect(cards().some(n => n.id === 'heid-draft-cap')).toBe(false);
  });

  it('超限那一份保存掉之后收掉卡片，不留一条已经不对的提示', () => {
    mount([fileTab(BIG)]);
    expect(cards().some(n => n.id === 'heid-draft-cap')).toBe(true);
    rerender([fileTab(BIG, { isDirty: false })]);
    /* 收卡片跟着对齐的节奏走（下一次 flush 才知道保护回来了），不是当场 */
    advance(3000);
    expect(cards().some(n => n.id === 'heid-draft-cap')).toBe(false);
  });
});
