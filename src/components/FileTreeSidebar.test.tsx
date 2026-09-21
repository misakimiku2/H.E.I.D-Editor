// @vitest-environment jsdom
/**
 * FileTreeSidebar 搜索态冒烟：mock Tauri invoke 后验证
 * ① 搜索按钮进入搜索态、Enter 触发 search_in_dir；
 * ② 结果按文件分组渲染（相对路径 + 命中行 + 高亮片段）；
 * ③ 点击命中行 onOpenFile 携带行列定位参数。
 * 分组/高亮区间纯逻辑在 lib/dirSearch.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

import { invoke } from '@tauri-apps/api/core';
import { FileTreeSidebar } from './FileTreeSidebar';

const mockInvoke = vi.mocked(invoke);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
const onOpenFile = vi.fn();

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

function props() {
  return {
    rootPath: 'C:/proj',
    open: true,
    isDarkMode: false,
    activeTabId: 't1',
    tabs: [{ id: 't1', path: null, isDirty: false }],
    onOpenFile,
    onRootChange: () => {},
    onClose: () => {},
    canManage: true,
    askDangerConfirm: () => Promise.resolve(false),
    onTabsRenamed: () => {},
    onFileDeleted: () => {},
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset();
  onOpenFile.mockReset();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

describe('FileTreeSidebar 跨文件搜索', () => {
  it('Enter 触发搜索、分组渲染、点击命中带行列定位', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'search_in_dir') {
        return Promise.resolve({
          matches: [
            { path: 'C:/proj/src/a.ts', line: 3, col: 5, len: 6, text: 'const needle = 1;', offset: 0 },
            { path: 'C:/proj/src/a.ts', line: 8, col: 1, len: 6, text: 'needle here', offset: 0 },
            { path: 'C:/proj/docs/b.md', line: 1, col: 2, len: 6, text: '# needle doc', offset: 0 },
          ],
          filesScanned: 12, filesMatched: 2, matchTotal: 3,
          truncated: false, skippedLarge: 0, skippedBinary: 1, skippedDirs: 2, filesCapped: false, cancelled: false,
          error: null,
        });
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<FileTreeSidebar {...props()} />);
    /* 进入搜索态 */
    const searchBtn = container!.querySelector('button[title="tree.searchInFiles"]') as HTMLButtonElement;
    act(() => { searchBtn.click(); });
    const input = container!.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => { setInputValue(input, 'needle'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    /* invoke 参数与分组渲染 */
    expect(mockInvoke).toHaveBeenCalledWith('search_in_dir', {
      root: 'C:/proj', query: 'needle', caseSensitive: false, regexp: false, wholeWord: false,
      searchId: expect.any(Number),
    });
    const text = container!.textContent ?? '';
    expect(text).toContain('src/a.ts');
    expect(text).toContain('docs/b.md');
    expect(text).toContain('needle here');

    /* 点击第二个命中：行列随路径传给 onOpenFile */
    const hitBtns = Array.from(container!.querySelectorAll('button'))
      .filter(b => b.textContent?.includes('needle')) as HTMLButtonElement[];
    act(() => { hitBtns[1].click(); });
    expect(onOpenFile).toHaveBeenCalledWith('C:/proj/src/a.ts', { line: 8, col: 1 });
  });

  it('空查询 Enter 不发请求；正则编译错误经 error 字段展示', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'search_in_dir') {
        return Promise.resolve({
          matches: [], filesScanned: 0, filesMatched: 0, matchTotal: 0,
          truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, cancelled: false,
          error: 'regex parse error: unclosed group',
        });
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<FileTreeSidebar {...props()} />);
    act(() => { (container!.querySelector('button[title="tree.searchInFiles"]') as HTMLButtonElement).click(); });
    const input = container!.querySelector('input') as HTMLInputElement;

    /* 空查询：不发 invoke */
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(mockInvoke).not.toHaveBeenCalled();

    /* 非空查询：error 渲染为红字 */
    act(() => { setInputValue(input, '(unclosed'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(container!.textContent).toContain('regex parse error');
  });

  it('搜索中显示取消按钮：取消调用 cancel 命令并退出忙碌态，迟到结果被丢弃', async () => {
    let resolveSearch: (v: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'search_in_dir') {
        return new Promise((resolve) => { resolveSearch = resolve; });
      }
      if (cmd === 'search_in_dir_cancel') return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<FileTreeSidebar {...props()} />);
    act(() => { (container!.querySelector('button[title="tree.searchInFiles"]') as HTMLButtonElement).click(); });
    const input = container!.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(input, 'needle'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect((container!.textContent ?? '').includes('tree.searchScanning')).toBe(true);

    /* 取消：调用 cancel 命令，退出忙碌态 */
    const cancelBtn = Array.from(container!.querySelectorAll('button'))
      .find(b => b.textContent?.includes('common.cancel')) as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    act(() => { cancelBtn.click(); });
    /* cancelInDirSearch 经动态 import 后才发 invoke：先刷微任务再断言 */
    await act(async () => { await Promise.resolve(); });
    expect(mockInvoke).toHaveBeenCalledWith('search_in_dir_cancel', { searchId: expect.any(Number) });
    expect((container!.textContent ?? '').includes('tree.searchScanning')).toBe(false);

    /* 迟到的搜索结果被 seq 守卫丢弃：不渲染结果也不报错 */
    await act(async () => {
      resolveSearch({
        matches: [{ path: 'C:/proj/src/a.ts', line: 3, col: 5, len: 6, text: 'const needle = 1;', offset: 0 }],
        filesScanned: 12, filesMatched: 1, matchTotal: 1,
        truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, cancelled: true,
        error: null,
      });
      await new Promise(r => setTimeout(r, 20));
    });
    expect((container!.textContent ?? '').includes('src/a.ts')).toBe(false);
  });
});

describe('FileTreeSidebar 侧栏宽度拖拽', () => {
  /* jsdom 无 PointerEvent：用 MouseEvent 顶替并补 isPrimary/pointerId */
  const pev = (type: string, x: number) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
    Object.defineProperty(ev, 'isPrimary', { value: true });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    return ev;
  };
  const panel = () => container!.firstElementChild as HTMLElement;
  const handle = () => container!.querySelector('[role="separator"]') as HTMLElement;

  it('拖拽改变宽度、上下限收敛、释放时持久化', () => {
    localStorage.clear();
    render(<FileTreeSidebar {...props()} />);
    expect(panel().style.width).toBe('256px');

    act(() => { handle().dispatchEvent(pev('pointerdown', 0)); });
    act(() => { handle().dispatchEvent(pev('pointermove', 64)); });
    expect(panel().style.width).toBe('320px');
    act(() => { handle().dispatchEvent(pev('pointermove', 500)); });
    expect(panel().style.width).toBe('400px');
    act(() => { handle().dispatchEvent(pev('pointermove', -100)); });
    expect(panel().style.width).toBe('256px');

    act(() => { handle().dispatchEvent(pev('pointermove', 104)); });
    act(() => { handle().dispatchEvent(pev('pointerup', 104)); });
    expect(panel().style.width).toBe('360px');
    expect(localStorage.getItem('heid-tree-sidebar-width')).toBe('360');
  });

  it('重启恢复：挂载时读取持久化宽度', () => {
    localStorage.setItem('heid-tree-sidebar-width', '380');
    render(<FileTreeSidebar {...props()} />);
    expect(panel().style.width).toBe('380px');
  });
});

describe('FileTreeSidebar 长行命中可见性', () => {
  it('命中靠后时显示窗口左移（… 前缀），高亮落在片段内', async () => {
    localStorage.clear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'search_in_dir') {
        const text = 'x'.repeat(150) + 'needle' + 'y'.repeat(44);
        return Promise.resolve({
          matches: [{ path: 'C:/proj/src/long.ts', line: 12, col: 151, len: 6, text, offset: 0 }],
          filesScanned: 1, filesMatched: 1, matchTotal: 1,
          truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, cancelled: false,
          error: null,
        });
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<FileTreeSidebar {...props()} />);
    act(() => { (container!.querySelector('button[title="tree.searchInFiles"]') as HTMLButtonElement).click(); });
    const input = container!.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(input, 'needle'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    const mark = container!.querySelector('mark');
    expect(mark?.textContent).toBe('needle');
    const rowText = mark!.closest('button')!.querySelector('.heid-name-text')!.textContent ?? '';
    expect(rowText.startsWith('…')).toBe(true);
    /* 高亮之前最多保留 lead 个前文字符，保证窄栏下高亮可见 */
    expect(rowText.indexOf('needle')).toBeLessThanOrEqual(1 + 24);
  });
});

describe('FileTreeSidebar 结果分页', () => {
  const pev = (type: string, x: number) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
    Object.defineProperty(ev, 'isPrimary', { value: true });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    return ev;
  };

  it('超过每页上限出翻页条：翻页切换内容、越端禁用、新搜索重置页码', async () => {
    localStorage.clear();
    const total = 250;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'search_in_dir') {
        return Promise.resolve({
          matches: Array.from({ length: total }, (_, i) => ({
            path: 'C:/proj/src/big.ts', line: i + 1, col: 1, len: 6, text: 'needle', offset: 0,
          })),
          filesScanned: 1, filesMatched: 1, matchTotal: total,
          truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, cancelled: false,
          error: null,
        });
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<FileTreeSidebar {...props()} />);
    act(() => { (container!.querySelector('button[title="tree.searchInFiles"]') as HTMLButtonElement).click(); });
    const input = container!.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(input, 'needle'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    const has = (sub: string) => (container!.textContent ?? '').includes(sub);
    /* 第 1 页：行 1-100，上一页禁用 */
    expect(has('tree.searchPage1,3')).toBe(true);
    expect((container!.querySelector('button[title="tree.searchPrevPage"]') as HTMLButtonElement).disabled).toBe(true);
    expect(has('needle')).toBe(true);

    /* 下一页 → 行 101-200 */
    act(() => { (container!.querySelector('button[title="tree.searchNextPage"]') as HTMLButtonElement).click(); });
    expect(has('tree.searchPage2,3')).toBe(true);

    /* 下一页到末页 → 下一页禁用，行 201-250 */
    act(() => { (container!.querySelector('button[title="tree.searchNextPage"]') as HTMLButtonElement).click(); });
    expect(has('tree.searchPage3,3')).toBe(true);
    expect((container!.querySelector('button[title="tree.searchNextPage"]') as HTMLButtonElement).disabled).toBe(true);

    /* 再次搜索 → 回到第 1 页 */
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(has('tree.searchPage1,3')).toBe(true);
  });

  it('单页结果不出翻页条', async () => {
    localStorage.clear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'search_in_dir') {
        return Promise.resolve({
          matches: [{ path: 'C:/proj/a.ts', line: 1, col: 1, len: 6, text: 'needle', offset: 0 }],
          filesScanned: 1, filesMatched: 1, matchTotal: 1,
          truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, cancelled: false,
          error: null,
        });
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<FileTreeSidebar {...props()} />);
    act(() => { (container!.querySelector('button[title="tree.searchInFiles"]') as HTMLButtonElement).click(); });
    const input = container!.querySelector('input') as HTMLInputElement;
    act(() => { setInputValue(input, 'needle'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(container!.querySelector('button[title="tree.searchNextPage"]')).toBeNull();
  });
});
