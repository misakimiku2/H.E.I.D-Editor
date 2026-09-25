// @vitest-environment jsdom
/**
 * 文件树上的同步状态（v1.5 阶段 5 的五态标记与树顶横幅）。
 *
 * 盯四件事：
 * 1. 三种落到文件上的状态各有各的形状，且**不与脏点叠成两颗**（同一行两颗琥珀点没人读得懂）；
 * 2. 「已同步」按设计就是没有标记 —— 不该出现一个绿色的"一切正常"点；
 * 3. 横幅分开说「要你确认」与「等链路」，两件事合成一句就会让人分不清现在欠谁；
 * 4. 本地根与桌面上一块都不渲染：那些计数说的是另一台设备的事。
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
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key,
}));

const remoteList = vi.fn();
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return { ...real, remoteList: (rel: string) => remoteList(rel) };
});

import { FileTreeSidebar, type OfflineBarInfo, type TreeSyncMark } from './FileTreeSidebar';
import { makeRemotePath } from '../lib/remote';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
const ROOT_PATH = makeRemotePath(DEV, 'notes');
const md = (name: string) => makeRemotePath(DEV, `notes/${name}`);

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  remoteList.mockReset();
});

async function render(opts: {
  markers?: Map<string, TreeSyncMark>;
  bar?: OfflineBarInfo;
  dirty?: boolean;
} = {}) {
  // list 的真实形状是 {entries, truncated}（remote.ts 的 RemoteListResult），不是裸数组
  remoteList.mockResolvedValue({
    entries: [
      { name: 'a.md', isDir: false, size: 3, mtimeMs: 1 },
      { name: 'b.md', isDir: false, size: 3, mtimeMs: 1 },
    ],
    truncated: false,
  });
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
        tabs={[{ id: 't1', path: md('a.md'), isDirty: opts.dirty ?? false }]}
        onOpenFile={() => {}}
        onRootChange={() => {}}
        onClose={() => {}}
        canManage
        askDangerConfirm={async () => true}
        onTabsRenamed={() => {}}
        onFileDeleted={() => {}}
        remoteMarkers={opts.markers}
        offlineBar={opts.bar}
        onSyncOne={() => {}}
        onDropOne={() => {}}
        onOpenDiff={() => {}}
      />,
    );
  });
  // 树体是异步列出来的：不等一下这里只有头部，标记与横幅都还没挂上
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

const bar = (over: Partial<OfflineBarInfo> = {}): OfflineBarInfo => ({
  offline: true, pending: 2, conflicts: 0, progress: null,
  onSync: () => {}, onCancel: () => {}, onReconnect: () => {}, ...over,
});

const text = () => container!.textContent ?? '';
const mark = (label: string) => container!.querySelector(`[aria-label="${label}"]`);

describe('文件树的同步标记', async () => {
  it('待同步：琥珀点配一支上行箭头，且不与脏点叠成两颗', async () => {
    await render({ markers: new Map([[md('a.md'), 'queued']]), dirty: true });
    const el = mark('offline.stateQueued');
    expect(el).not.toBeNull();
    expect(el!.querySelector('svg')).not.toBeNull();
    expect(el!.querySelector('.bg-amber-500')).not.toBeNull();
    /* 同一行上那颗独立的脏点（没有 aria-label 的裸点）不该还在 */
    expect(container!.querySelectorAll('.bg-amber-500').length).toBe(1);
  });

  it('需要确认是红点、桌面已更新是蓝点，都不带箭头', async () => {
    await render({ markers: new Map([[md('a.md'), 'conflict'], [md('b.md'), 'updated']]) });
    const c = mark('offline.stateConflict');
    const u = mark('offline.stateUpdated');
    expect(c!.querySelector('.bg-red-500')).not.toBeNull();
    expect(u!.querySelector('.bg-sky-500')).not.toBeNull();
    expect(c!.querySelector('svg')).toBeNull();
    expect(u!.querySelector('svg')).toBeNull();
  });

  it('已同步 = 没有标记（设计稿 §9.2 那一行）', async () => {
    await render({ markers: new Map([[md('a.md'), 'queued']]) });
    // b.md 没进表 → 那一行什么都不标（整棵树只有一颗同步标记）
    expect(container!.querySelectorAll('[aria-label^="offline.state"]').length).toBe(1);
  });

  it('没传标记时不渲染任何同步形状：本地 SAF 树与桌面保持原样', async () => {
    await render({ dirty: true });
    expect(container!.querySelectorAll('[aria-label^="offline."]').length).toBe(0);
    expect(container!.querySelectorAll('.bg-red-500').length).toBe(0);
  });
});

describe('树顶的离线横幅', async () => {
  it('断开时说清有几项待同步，并给一个去连接的入口', async () => {
    await render({ bar: bar({ offline: true, pending: 3, conflicts: 0 }) });
    expect(text()).toContain('offline.banner:3');
    expect(text()).toContain('offline.gotoConnect');
    expect(text()).not.toContain('offline.syncNow');
  });

  it('连着但还有欠账：给「立即同步」而不是「去连接」', async () => {
    await render({ bar: bar({ offline: false, pending: 1, conflicts: 0 }) });
    expect(text()).toContain('offline.syncNow');
    expect(text()).not.toContain('offline.gotoConnect');
  });

  it('「要你确认」与「等链路」分两行说，不揉成一句「同步失败」', async () => {
    await render({ bar: bar({ offline: true, pending: 2, conflicts: 1 }) });
    expect(text()).toContain('offline.bannerConfirm:1');
    expect(text()).toContain('offline.banner:2');
    expect(text()).not.toMatch(/失败/);
  });

  it('回放进行中只留进度那一条，并给一个能取消的按钮', async () => {
    const onCancel = vi.fn();
    await render({ bar: bar({ offline: true, pending: 2, conflicts: 2, progress: { done: 1, total: 2 }, onCancel }) });
    expect(text()).toContain('offline.bannerSyncing:1,2');
    expect(text()).not.toContain('offline.bannerConfirm');
    const btn = [...container!.querySelectorAll('button')].find(b => b.textContent === 'common.cancel');
    expect(btn).toBeTruthy();
    act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('队列是空的就一块都不出现：正常在线浏览时不该有条常驻横幅', async () => {
    await render({ bar: bar({ offline: false, pending: 0, conflicts: 0, progress: null }) });
    expect(text()).not.toContain('offline.banner');
    expect(container!.querySelector('[role="status"]')).toBeNull();
  });
});
