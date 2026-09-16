import { describe, expect, it } from 'vitest';
import { pickActiveTab } from './sessionRestore';
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
