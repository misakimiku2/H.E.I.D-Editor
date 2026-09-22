// @vitest-environment jsdom
/**
 * 安卓端文件树工具栏：跨文件搜索走 Rust `search_in_dir` 递归读真实路径，
 * SAF 的树内路径（treeUri\0相对路径）喂不进去、什么都搜不到，
 * 所以安卓不放这个入口；同一条工具栏上的刷新等按钮照常保留。
 * 桌面侧的搜索入口由 FileTreeSidebar.test.tsx 覆盖。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* platform 在模块加载期读取，须用 vi.mock 提升到 import 之前 */
vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

import { FileTreeSidebar } from './FileTreeSidebar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <FileTreeSidebar
        rootPath='content://com.android.externalstorage.documents/tree/primary%3ADownload'
        open
        isDarkMode={false}
        activeTabId='t1'
        tabs={[{ id: 't1', path: null, isDirty: false }]}
        onOpenFile={() => {}}
        onRootChange={() => {}}
        onClose={() => {}}
        canManage
        askDangerConfirm={() => Promise.resolve(false)}
        onTabsRenamed={() => {}}
        onFileDeleted={() => {}}
      />
    );
  });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

describe('安卓文件树工具栏', () => {
  it('不放跨文件搜索入口（SAF 路径搜不到东西）', () => {
    render();
    expect(container!.querySelector('[aria-label="tree.searchInFiles"]')).toBeNull();
  });

  it('刷新入口仍在（工具栏未被一并关掉）', () => {
    render();
    expect(container!.querySelector('[aria-label="tree.refresh"]')).not.toBeNull();
  });
});
