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
    overlay: false,
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
          truncated: false, skippedLarge: 0, skippedBinary: 1, skippedDirs: 2, filesCapped: false,
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
          truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false,
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
});
