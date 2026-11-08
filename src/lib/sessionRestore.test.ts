// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';

/* 读盘与尺寸分层打桩：恢复例程只关心「磁盘上那份是什么」。
   路径没在 DISK 里 = 文件已经不在了（readLocalPath 抛错），与真实行为同一口径 */
const DISK: Record<string, string> = {};
let SIZE: number | null = null;
let CLS: 'full' | 'preview' | 'reject' = 'full';
vi.mock('./fileIO', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readLocalPath: (path: string) => {
    if (!(path in DISK)) return Promise.reject(new Error(`gone: ${path}`));
    return Promise.resolve({
      name: path.split('/').pop() ?? path,
      content: DISK[path],
      encoding: 'UTF-8', bom: false, eol: 'LF', binary: null,
    });
  },
}));
vi.mock('./largeFile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fileSize: () => Promise.resolve(SIZE),
  classifyBySize: () => CLS,
}));

import { pickActiveTab, restoreSessionTabs } from './sessionRestore';
import { makeUntitledTab } from './tabModel';
import type { SessionState } from './session';

function tab(title: string, path: string | null) {
  const t = makeUntitledTab(title);
  t.path = path;
  return t;
}

const base: SessionState = { tabs: [], activePath: null };

describe('pickActiveTab', () => {
  const restored = [
    tab('welcome.ts', null),
    tab('a.md', null),               /* 导入产生的无路径 md */
    tab('b.md', 'C:/notes/b.md'),
  ];

  it('file 激活:按路径精确匹配', () => {
    expect(pickActiveTab(restored, { ...base, activePath: 'C:/notes/b.md' })?.path).toBe('C:/notes/b.md');
  });

  it('无路径激活:按 activeVirtualTitle 精确匹配,不误落 welcome', () => {
    expect(pickActiveTab(restored, { ...base, activePath: null, activeVirtualTitle: 'a.md' })?.title).toBe('a.md');
  });

  it('无路径激活但标题失配:退回第一个无路径标签', () => {
    expect(pickActiveTab(restored, { ...base, activePath: null, activeVirtualTitle: 'gone.txt' })?.title).toBe('welcome.ts');
  });

  it('路径与标题都失配:兜底最后一个标签', () => {
    expect(pickActiveTab(restored, { ...base, activePath: 'C:/x/gone.txt' })?.title).toBe('b.md');
  });

  it('空恢复结果返回 null(不抛错)', () => {
    expect(pickActiveTab([], base)).toBeNull();
  });
});

/** 草稿回报：恢复通知的文案全靠这一份（数量 / 文件名 / 草稿时刻） */
describe('restoreSessionTabs 草稿回报', () => {
  const AT = 1_700_000_000_000;
  const seed = (key: string, content: string) => {
    localStorage.setItem('heid-drafts', JSON.stringify({ [key]: { content, at: AT } }));
  };

  beforeEach(() => {
    localStorage.clear();
    for (const k of Object.keys(DISK)) delete DISK[k];
    SIZE = null;
    CLS = 'full';
  });

  it('磁盘与草稿不同：端出草稿、标脏、回报标题与时刻', async () => {
    DISK['C:/notes/a.md'] = 'disk version';
    seed('file:C:/notes/a.md', 'unsaved version');
    const r = await restoreSessionTabs({
      tabs: [{ kind: 'file', path: 'C:/notes/a.md', mdView: 'edit' }], activePath: 'C:/notes/a.md',
    });
    expect(r?.tabs[0].content).toBe('unsaved version');
    expect(r?.tabs[0].originalContent).toBe('disk version');
    expect(r?.tabs[0].isDirty).toBe(true);
    expect(r?.drafted).toEqual([{ title: 'a.md', at: AT }]);
  });

  it('草稿与磁盘一致：不算恢复出未保存内容', async () => {
    DISK['C:/notes/a.md'] = 'same';
    seed('file:C:/notes/a.md', 'same');
    const r = await restoreSessionTabs({
      tabs: [{ kind: 'file', path: 'C:/notes/a.md', mdView: 'edit' }], activePath: 'C:/notes/a.md',
    });
    expect(r?.tabs[0].isDirty).toBe(false);
    expect(r?.drafted).toEqual([]);
  });

  it('无路径脏标签：从 untitled 键取回并回报', async () => {
    seed('untitled:草稿.txt', 'hello');
    const r = await restoreSessionTabs({
      tabs: [{ kind: 'virtual', title: '草稿.txt', draft: true }], activePath: null,
    });
    expect(r?.tabs[0].content).toBe('hello');
    expect(r?.tabs[0].isDirty).toBe(true);
    expect(r?.drafted).toEqual([{ title: '草稿.txt', at: AT }]);
  });

  it('草稿丢失（超限/被清）的无路径标签退化为空标签，不回报', async () => {
    const r = await restoreSessionTabs({
      tabs: [{ kind: 'virtual', title: '草稿.txt', draft: true }], activePath: null,
    });
    expect(r?.tabs[0].isDirty).toBe(false);
    expect(r?.drafted).toEqual([]);
  });

  it('文件已从磁盘上消失：整条跳过，那份草稿也不端出来', async () => {
    seed('file:C:/notes/gone.md', 'unsaved');
    expect(await restoreSessionTabs({
      tabs: [{ kind: 'file', path: 'C:/notes/gone.md', mdView: 'edit' }], activePath: 'C:/notes/gone.md',
    })).toBeNull();
  });

  it('回报按快照原顺序，不受读盘快慢影响', async () => {
    DISK['C:/notes/a.md'] = 'A';
    DISK['C:/notes/b.md'] = 'B';
    localStorage.setItem('heid-drafts', JSON.stringify({
      'file:C:/notes/a.md': { content: 'A-draft', at: AT },
      'file:C:/notes/b.md': { content: 'B-draft', at: AT + 1 },
    }));
    const r = await restoreSessionTabs({
      tabs: [
        { kind: 'file', path: 'C:/notes/a.md', mdView: 'edit' },
        { kind: 'file', path: 'C:/notes/b.md', mdView: 'edit' },
      ],
      activePath: 'C:/notes/b.md',
    });
    expect(r?.drafted).toEqual([{ title: 'a.md', at: AT }, { title: 'b.md', at: AT + 1 }]);
  });

  it('大文件恢复为只读分块预览：没有草稿可回报', async () => {
    SIZE = 64 * 1024 * 1024;
    CLS = 'preview';
    const r = await restoreSessionTabs({
      tabs: [{ kind: 'file', path: 'C:/notes/huge.log', mdView: 'edit' }], activePath: 'C:/notes/huge.log',
    });
    expect(r?.tabs[0].largePreview).toBe(true);
    expect(r?.drafted).toEqual([]);
  });

  it('超过上限的条目整条跳过：不恢复也不回报', async () => {
    SIZE = 600 * 1024 * 1024;
    CLS = 'reject';
    expect(await restoreSessionTabs({
      tabs: [{ kind: 'file', path: 'C:/notes/huge.log', mdView: 'edit' }], activePath: 'C:/notes/huge.log',
    })).toBeNull();
  });
});
