// @vitest-environment jsdom
/**
 * 桌面推来文件变更时，手机端文件树**只重列受影响的那几层**（v1.5 阶段 4）。
 *
 * 这条测的是"增量"这个词本身：桌面的推送按目录合并（帧里给的是"哪几层的内容变了"），
 * 所以一次 npm install 落在手机上不该变成整棵树的重新列举。
 * 顺带测两个反向判据：与树无关的帧一次请求都不该发；换根要重建而不是就地刷新
 * ——就地刷会让用户以为看的还是原来那棵树。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

const remoteList = vi.fn();
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return { ...real, remoteList: (rel: string) => remoteList(rel) };
});

/** 测试从这里"推一帧"给跑着的应用 */
let emit: ((type: string, data: string) => void) | null = null;
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    subscribeRemoteEvents: (cb: (type: string, data: string) => void) => {
      emit = cb;
      return () => { emit = null; };
    },
  };
});

import { FileTreeSidebar } from './FileTreeSidebar';
import { makeRemotePath } from '../lib/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
/** 共享根在手机上挂成的那棵树（rel 是相对共享根的，帧里的目录与它同一套坐标） */
const ROOT_PATH = makeRemotePath(DEV, 'notes');

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  emit = null;
  remoteList.mockReset();
});

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <FileTreeSidebar
        rootPath={ROOT_PATH}
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
      />,
    );
  });
  return container!;
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const listed = () => remoteList.mock.calls.map(c => c[0] as string);
const rowsIn = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[title]')]
    .map(n => n.getAttribute('title') ?? '')
    .filter(p => p.startsWith('hide-remote://') && p !== ROOT_PATH);
const rowFor = (el: HTMLElement, rel: string) =>
  [...el.querySelectorAll<HTMLElement>('[title]')].find(n => n.getAttribute('title') === makeRemotePath(DEV, rel));

const entries = (...names: [string, boolean][]) => ({
  entries: names.map(([name, isDir]) => ({ name, isDir, size: isDir ? 0 : 3, mtimeMs: 1 })),
  truncated: false,
});

/** 挂上这棵树：根的列表必须在渲染之前就备好 —— 建根节点是渲染时发生的事，mock 晚一步就拿不到 */
async function mountTree(rootEntries = entries(['sub', true], ['plan.md', false])) {
  remoteList.mockResolvedValueOnce(rootEntries);
  const el = render();
  await settle();
  return el;
}

/** 再展开 notes/sub，让树上同时有两层"已加载目录"；退出前清空 mock 以便数请求 */
async function withExpandedSub(el: HTMLElement) {
  remoteList.mockResolvedValueOnce(entries(['deep.txt', false]));
  act(() => { rowFor(el, 'notes/sub')!.click(); });
  await settle();
  remoteList.mockReset();
}

async function push(dirs: string[] | null) {
  act(() => { emit!('fs', dirs ? JSON.stringify({ dirs }) : ''); });
  await settle();
}

describe('远程根的文件树跟着桌面的变更刷新', () => {
  it('帧里只有 sub 时，重列 sub 而不动根', async () => {
    const el = await mountTree();
    await withExpandedSub(el);
    await push(['notes/sub']);
    expect(listed()).toEqual(['notes/sub']);
  });

  it('与这棵树无关的帧一次请求都不发', async () => {
    const el = await mountTree();
    await withExpandedSub(el);
    await push(['notes/../elsewhere', 'vendor']);
    expect(listed()).toEqual([]);
  });

  it('同帧里的两层各自只列一次', async () => {
    const el = await mountTree();
    await withExpandedSub(el);
    await push(['notes', 'notes/sub']);
    expect(listed().sort()).toEqual(['notes', 'notes/sub']);
  });

  it('退化帧（桌面那一帧装不下）按整棵重列处理', async () => {
    const el = await mountTree();
    await withExpandedSub(el);
    await push(null);
    expect(listed().sort()).toEqual(['notes', 'notes/sub']);
  });

  it('共享根那一层变了要带上挂在它下面的这棵树', async () => {
    const el = await mountTree();
    await withExpandedSub(el);
    // 桌面在共享根里动了名字（比如把 notes 整个改名/删掉）：帧里给的是父目录 `""`
    await push(['']);
    expect(listed()).toContain('notes');
  });

  it('换根重建：展开态丢掉，只留新一棵树的根', async () => {
    const el = await mountTree();
    await withExpandedSub(el);
    expect(rowsIn(el)).toContain(makeRemotePath(DEV, 'notes/sub/deep.txt'));
    remoteList.mockResolvedValueOnce(entries(['fresh.md', false]));
    act(() => { emit!('rootChanged', ''); });
    await settle();
    expect(listed()).toEqual(['notes']);
    expect(rowsIn(el)).toEqual([makeRemotePath(DEV, 'notes/fresh.md')]);
  });

  it('抽屉没打开时不订这条推送', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <FileTreeSidebar
          rootPath={ROOT_PATH}
          open={false}
          isDarkMode={false}
          activeTabId='t1'
          tabs={[]}
          onOpenFile={() => {}}
          onRootChange={() => {}}
          onClose={() => {}}
          canManage
          askDangerConfirm={() => Promise.resolve(false)}
          onTabsRenamed={() => {}}
          onFileDeleted={() => {}}
        />,
      );
    });
    await settle();
    expect(emit, '抽屉没开就不该订阅（订了也没人在看）').toBeNull();
    expect(remoteList).not.toHaveBeenCalled();
  });
});
