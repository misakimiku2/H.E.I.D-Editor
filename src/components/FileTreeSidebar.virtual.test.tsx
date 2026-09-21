// @vitest-environment jsdom
/**
 * 树行虚拟化：
 * ① flattenTreeRows 纯逻辑：行序与旧 renderNode 一致（命名行置顶/目录行后随子行、
 *    错误/加载行占位、折叠不下钻）；
 * ② 窗口化渲染：mock plugin-fs 列出 2000 项大目录 + 视口高度桩，验证只渲染
 *    视口窗口切片、总高撑开、滚动后窗口平移。
 * 模块顶层按 __TAURI_INTERNALS__ 选定桌面 lister，本文件先置标志再动态 import。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  watch: vi.fn(async () => () => {}),
}));

import { readDir } from '@tauri-apps/plugin-fs';
import type { TreeNode } from '../lib/fileTree';

const mockReadDir = vi.mocked(readDir);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mod: typeof import('./FileTreeSidebar');
let root: Root | null = null;
let container: HTMLElement | null = null;

const VIEWPORT = 500;
let origClientHeight: PropertyDescriptor | undefined;

beforeAll(async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  mod = await import('./FileTreeSidebar');
  origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEWPORT });
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterAll(() => {
  delete (globalThis as any).ResizeObserver;
  if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight);
});

function flush() {
  return act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

function node(partial: Partial<TreeNode> & { path: string }): TreeNode {
  return {
    name: partial.path.split('/').pop() ?? partial.path,
    isDir: false, expanded: false, children: null, error: null, ...partial,
  };
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <mod.FileTreeSidebar
        rootPath="C:/big" open isDarkMode={false} activeTabId="t1"
        tabs={[]} onOpenFile={() => {}} onRootChange={() => {}} onClose={() => {}}
        canManage={false} askDangerConfirm={() => Promise.resolve(false)}
        onTabsRenamed={() => {}} onFileDeleted={() => {}}
      />,
    );
  });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  mockReadDir.mockReset();
});

describe('flattenTreeRows 扁平行序', () => {
  const tree: TreeNode = {
    ...node({ path: 'C:/proj' }),
    isDir: true,
    expanded: true,
    children: [
      node({ path: 'C:/proj/a.txt' }),
      { ...node({ path: 'C:/proj/sub' }), isDir: true, expanded: true, children: [node({ path: 'C:/proj/sub/b.md' })] },
      { ...node({ path: 'C:/proj/err' }), isDir: true, expanded: true, error: 'denied' },
      { ...node({ path: 'C:/proj/load' }), isDir: true, expanded: true },
    ],
  };

  it('目录行后跟子行，错误/加载行占位', () => {
    const rows = mod.flattenTreeRows(tree, null);
    expect(rows.map(r => r.key)).toEqual([
      'C:/proj', 'C:/proj/a.txt', 'C:/proj/sub', 'C:/proj/sub/b.md',
      'C:/proj/err', 'error:C:/proj/err', 'C:/proj/load', 'loading:C:/proj/load',
    ]);
  });

  it('根目录内新建命名行置顶；目录内命名行在目录行后', () => {
    const atRoot = mod.flattenTreeRows(tree, { parentPath: 'C:/proj', isDir: false });
    expect(atRoot[0].kind).toBe('create');
    expect(atRoot[1].key).toBe('C:/proj');

    const inDir = mod.flattenTreeRows(tree, { parentPath: 'C:/proj/sub', isDir: true });
    const i = inDir.findIndex(r => r.key === 'C:/proj/sub');
    expect(inDir[i + 1].kind).toBe('create');
  });

  it('折叠目录不下钻子行', () => {
    const collapsed: TreeNode = {
      ...tree,
      children: tree.children!.map(c => (c.name === 'sub' ? { ...c, expanded: false } : c)),
    };
    const rows = mod.flattenTreeRows(collapsed, null);
    expect(rows.map(r => r.key)).not.toContain('C:/proj/sub/b.md');
  });
});

describe('FileTreeSidebar 大目录窗口化渲染', () => {
  it('只渲染视口切片，总高撑开，滚动后窗口平移', async () => {
    const TOTAL = 2000;
    mockReadDir.mockImplementation(async (dir: string | URL) => {
      if (String(dir) === 'C:/big') return [{ name: 'big', isDirectory: true } as never];
      return Array.from(
        { length: TOTAL },
        (_, i) => ({ name: `f${String(i).padStart(4, '0')}.txt`, isDirectory: false }) as never,
      );
    });
    mount();
    await flush();

    /* 展开含 2000 个文件的大目录 */
    const bigRow = container!.querySelector('button[title="C:/big/big"]') as HTMLButtonElement;
    expect(bigRow).toBeTruthy();
    act(() => { bigRow.click(); });
    await flush();

    /* 总高 = 全部行 × 行高；首屏渲染 = 视口行数(18) + 下 overscan(12)（first 被 0 截断） */
    const spacer = container!.querySelector('div.heid-tree-spacer') as HTMLElement;
    expect(spacer.style.height).toBe(`${(2 + TOTAL) * 28}px`);
    expect(container!.querySelectorAll('.heid-tree-row').length).toBe(Math.ceil(VIEWPORT / 28) + 12);

    /* 滚到第 1000 行：first = 1000-12，last = ceil(28500/28)+12 = 1030 → 42 行 */
    const scroller = container!.querySelector('div.heid-scroll') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 1000 * 28, configurable: true });
    act(() => { scroller.dispatchEvent(new Event('scroll')); });

    const wrappers = Array.from(spacer.querySelectorAll('div.absolute')) as HTMLElement[];
    expect(wrappers.length).toBe(Math.ceil((1000 * 28 + VIEWPORT) / 28) + 12 - (1000 - 12));
    expect(wrappers[0].style.top).toBe(`${(1000 - 12) * 28}px`);
    expect(container!.querySelectorAll('.heid-tree-row').length).toBe(wrappers.length);
  });

  it('视口未知（clientHeight=0）时回退全量渲染', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 0 });
    const TOTAL = 400;
    mockReadDir.mockImplementation(async (dir: string | URL) => {
      if (String(dir) === 'C:/big') return [{ name: 'big', isDirectory: true } as never];
      return Array.from({ length: TOTAL }, (_, i) => ({ name: `g${i}.txt`, isDirectory: false }) as never);
    });
    mount();
    await flush();
    const bigRow = container!.querySelector('button[title="C:/big/big"]') as HTMLButtonElement;
    act(() => { bigRow.click(); });
    await flush();

    expect(container!.querySelectorAll('.heid-tree-row').length).toBe(2 + TOTAL);
  });
});
