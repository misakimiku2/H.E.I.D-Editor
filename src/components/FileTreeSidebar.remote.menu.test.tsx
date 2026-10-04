// @vitest-environment jsdom
/**
 * 手机上那台电脑的树里的**管理入口**该出现哪几条（v1.5：手机上写好的东西能存进这棵树）。
 *
 * 这一份单独成文件而不是塞进 `FileTreeSidebar.remote.test.tsx`，是因为触发方式：那边按真机
 * 形状跑（`IS_TOUCH_PRIMARY` 为真，长按才开菜单，而 `useLongPress` 在触屏上会把原生
 * contextmenu 吞掉），这里要的是**能同步点开菜单**的那条口 —— 右键与长按进的是同一个
 * `openMenuAt`，判据与平台无关，所以从右键这一侧验完全算数。
 *
 * 盯两件事：
 * ① 远程行上那几个协议里根本没有的命令（重命名 / 删除 / 复制 / 在文件管理器中显示）**不摆**。
 *    以前是摆着并误走 SAF 桥，报一句「SAF create rejected」（2026-10-04 手机上实拍），
 *    那句话既不是原因也不是用户能做的事；
 * ② 新建文件 / 新建文件夹这两条现在真的走链路上的 `create` / `mkdir`。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: false,   // 见文件头：这一份走右键那一侧，长按由 .remote.test.tsx 覆盖
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const alerts: string[] = [];
vi.mock('../lib/appAlert', () => ({
  appAlert: (m: string) => { alerts.push(m); },
  registerAppAlert: () => {},
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}=${Object.values(vars).join(',')}` : key,
}));

const remoteList = vi.fn();
const remoteCreate = vi.fn();
const remoteMkdir = vi.fn();
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return {
    ...real,
    remoteList: (rel: string) => remoteList(rel),
    remoteCreate: (a: unknown) => remoteCreate(a),
    remoteMkdir: (rel: string) => remoteMkdir(rel),
  };
});
vi.mock('../lib/link', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  subscribeLinkStatus: () => () => {},
}));

import { FileTreeSidebar } from './FileTreeSidebar';
import { RemoteError, makeRemotePath } from '../lib/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
const ROOT_PATH = makeRemotePath(DEV, 'notes');

let root: Root | null = null;
let container: HTMLElement | null = null;
const opened: string[] = [];

function render(rootPath = ROOT_PATH) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <FileTreeSidebar
        rootPath={rootPath}
        open
        isDarkMode={false}
        activeTabId='t1'
        tabs={[{ id: 't1', path: null, isDirty: false }]}
        onOpenFile={(p: string) => opened.push(p)}
        onRootChange={() => {}}
        onClose={() => {}}
        canManage
        askDangerConfirm={() => Promise.resolve(false)}
        onTabsRenamed={() => {}}
        onFileDeleted={() => {}}
      />,
    );
  });
  return container!;
}

const settle = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

const rowFor = (el: HTMLElement, rel: string) =>
  [...el.querySelectorAll<HTMLElement>('[title]')]
    .find(n => (n.getAttribute('title') ?? '') === makeRemotePath(DEV, rel));

/** 右键那一侧的开菜单（与长按进的是同一个 openMenuAt） */
function openMenu(el: HTMLElement, rel: string | null) {
  const target = rel ? rowFor(el, rel) : el.querySelector<HTMLElement>('.heid-tree-row');
  expect(target, `没有可右键的那一行（${rel ?? '根'}）`).toBeTruthy();
  act(() => {
    target!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }));
  });
  return document.body.textContent ?? '';
}

function clickMenuItem(key: string) {
  const btn = [...document.body.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(key));
  if (!btn) throw new Error(`菜单里没有「${key}」，当前：${document.body.textContent}`);
  act(() => { btn.click(); });
}

/** 新建那行的原位输入框（树顶的搜索框不在这个 DOM 里，取最后一个 input 就是它） */
function typeName(v: string) {
  const input = [...container!.querySelectorAll('input')].pop() as HTMLInputElement;
  act(() => {
    input.value = v;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

const CREATED = { conflict: false, hash: 'h', size: 0, mtimeMs: 1, serverBom: false, serverBinary: false };

beforeEach(() => {
  remoteList.mockResolvedValue({
    entries: [{ name: 'sub', isDir: true, size: 0, mtimeMs: 1 }, { name: 'plan.md', isDir: false, size: 12, mtimeMs: 2 }],
    truncated: false,
  });
  remoteCreate.mockResolvedValue(CREATED);
  remoteMkdir.mockResolvedValue(CREATED);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  opened.length = 0;
  alerts.length = 0;
  vi.clearAllMocks();
});

describe('远程行的菜单', () => {
  it('只有新建两条与刷新，没有重命名/删除/剪切复制/在文件管理器中显示', async () => {
    const el = render();
    await settle();
    const menu = openMenu(el, 'notes/sub');
    expect(menu).toContain('menu.newFile');
    expect(menu).toContain('tree.newFolder');
    expect(menu).toContain('tree.refresh');
    for (const absent of ['tree.rename', 'tree.delete', 'ctx.cut', 'ctx.copy', 'ctx.paste', 'tree.reveal']) {
      expect(menu, `远程行不该出现「${absent}」`).not.toContain(absent);
    }
    // 「复制路径」两条也不给：那串身份键对人没有意义，而它看着像路径，抄出去只会更糊涂
    expect(menu).not.toContain('tree.copyPath');
    expect(menu).not.toContain('tree.copyRelPath');
  });

  it('本机 SAF 那棵树照旧齐全（别把改动变成第二次「远程好、本地少了一截」）', async () => {
    remoteList.mockResolvedValue({ entries: [], truncated: false });
    const el = render('content://com.android.externalstorage.documents/tree/primary%3ADownload\u0000Notes');
    await settle();
    const menu = openMenu(el, null);
    expect(menu).toContain('tree.rename');
    expect(menu).toContain('tree.delete');
    expect(menu).toContain('tree.copyPath');
  });
});

describe('远程树里的新建', () => {
  it('新建文件走 create，名字拼在被新建的那一层下面，建完就打开它', async () => {
    const el = render();
    await settle();
    openMenu(el, 'notes/sub');
    clickMenuItem('menu.newFile');
    typeName('新笔记.md');
    await settle();
    expect(remoteCreate).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'notes/sub/新笔记.md', text: '' }));
    expect(opened).toEqual([makeRemotePath(DEV, 'notes/sub/新笔记.md')]);
  });

  it('新建文件夹走 mkdir，只建被选中的那一层下面那一段', async () => {
    const el = render();
    await settle();
    openMenu(el, null);
    clickMenuItem('tree.newFolder');
    typeName('来自手机');
    await settle();
    expect(remoteMkdir).toHaveBeenCalledWith('notes/来自手机');
    expect(remoteCreate, '建文件夹不该顺手建出一份同名文件').not.toHaveBeenCalled();
  });

  it('桌面说那个位置被占着：把那句原话报出来，且不把别人那份当新建成功打开', async () => {
    remoteCreate.mockRejectedValue(new RemoteError('exists', '电脑上已经有同名的文件，换个名字再建'));
    const el = render();
    await settle();
    openMenu(el, null);
    clickMenuItem('menu.newFile');
    typeName('plan.md');
    await settle();
    expect(opened, '占位时不该打开别人那一份').toEqual([]);
    // 告警里要带得出桌面上那句话：只说「操作失败」会让人以为是自己手抖
    expect(alerts.join('')).toContain('电脑上已经有同名的文件');
  });
});
