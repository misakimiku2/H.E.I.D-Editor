/**
 * 跨文件搜索纯函数：分组与片段内高亮区间、命中行显示窗口、分页。
 * invoke 封装（searchInDir）与 fileOps 同策略不测——命令契约由 Rust 测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  groupByFile, hitDisplay, hitRangeInSnippet, pageGroups, HITS_PER_PAGE,
  type FileHit,
} from './dirSearch';

const hit = (path: string, line: number, col: number, len: number, text: string, offset: number): FileHit =>
  ({ path, line, col, len, text, offset });

describe('groupByFile：按文件分组保持顺序', () => {
  it('同文件命中归并、跨文件顺序保持', () => {
    const groups = groupByFile([
      hit('a.txt', 1, 1, 2, 'ab', 0),
      hit('a.txt', 3, 5, 2, 'xxab', 2),
      hit('b.ts', 2, 1, 2, 'ab', 0),
      hit('a.txt', 9, 1, 2, 'ab', 0),
    ]);
    expect(groups.map(g => g.path)).toEqual(['a.txt', 'b.ts']);
    expect(groups[0].hits.map(h => h.line)).toEqual([1, 3, 9]);
    expect(groups[1].hits).toHaveLength(1);
  });

  it('空结果返回空数组', () => {
    expect(groupByFile([])).toEqual([]);
  });
});

describe('hitRangeInSnippet：片段内高亮区间', () => {
  it('命中在片段开头', () => {
    expect(hitRangeInSnippet(hit('a', 1, 1, 5, 'hello world', 0))).toEqual({ from: 0, to: 5 });
  });

  it('片段带偏移（长行窗口）', () => {
    /* 命中 col 301（原行 0-based 300），片段起点 260 → 片段内 40 */
    expect(hitRangeInSnippet(hit('a', 1, 301, 3, 'xxx'.repeat(70), 260)))
      .toEqual({ from: 40, to: 43 });
  });

  it('匹配长于片段时截至片段末尾', () => {
    expect(hitRangeInSnippet(hit('a', 1, 198, 10, 'x'.repeat(200), 0)))
      .toEqual({ from: 197, to: 200 });
  });
});

describe('hitDisplay：命中行显示窗口（按显示宽度，CJK 记 2）', () => {
  it('命中靠前：原文透传，片段无偏移时无前缀', () => {
    expect(hitDisplay(hit('a', 1, 7, 5, 'hello world', 0)))
      .toEqual({ prefix: '', text: 'hello world', from: 6, to: 11 });
  });

  it('命中靠前但片段带偏移：补 … 前缀', () => {
    expect(hitDisplay(hit('a', 1, 11, 3, '0123456789abc', 10)))
      .toEqual({ prefix: '…', text: '0123456789abc', from: 0, to: 3 });
  });

  it('命中靠后：窗口左移，命中前保留 lead 个宽度单位', () => {
    /* 50 个前导 ASCII（50 单位 > 18）：窗口起点 50-18=32 */
    const text = 'x'.repeat(50) + 'needle' + 'y'.repeat(30);
    const d = hitDisplay(hit('a', 1, 51, 6, text, 0));
    expect(d.prefix).toBe('…');
    expect(d.text).toBe(text.slice(32));
    expect(d.from).toBe(18);
    expect(d.to).toBe(24);
    expect(d.text.slice(d.from, d.to)).toBe('needle');
  });

  it('中文前缀占 2 单位：实际保留字符数减半，高亮不被推宽', () => {
    const text = '中'.repeat(30) + 'needle';
    const d = hitDisplay(hit('a', 1, 31, 6, text, 0));
    expect(d.prefix).toBe('…');
    expect(d.text).toBe('中'.repeat(9) + 'needle');
    expect(d.from).toBe(9);
    expect(d.to).toBe(15);
    /* 显示宽度：…(1) + 9×2 = 19 单位，不超出 lead+1 */
    expect(d.text.slice(d.from, d.to)).toBe('needle');
  });

  it('恰好等于 lead 不窗口化', () => {
    const text = 'a'.repeat(18) + 'needle';
    expect(hitDisplay(hit('a', 1, 19, 6, text, 0)))
      .toEqual({ prefix: '', text, from: 18, to: 24 });
  });

  it('自定义 lead：窗口随之移动且区间不错位', () => {
    const text = 'a'.repeat(40) + 'NEEDLE';
    const d = hitDisplay(hit('a', 1, 41, 6, text, 0), 10);
    expect(d.text).toBe(text.slice(30));
    expect(d.text.slice(d.from, d.to)).toBe('NEEDLE');
  });
});

describe('pageGroups：命中分页', () => {
  const seq = (n: number, path: string): FileHit[] =>
    Array.from({ length: n }, (_, i) => hit(path, i + 1, 1, 2, 'ab', 0));

  it('单文件按页切片，页数向上取整', () => {
    const matches = seq(HITS_PER_PAGE + 50, 'a.ts');
    expect(pageGroups(matches, 0).groups[0].hits).toHaveLength(HITS_PER_PAGE);
    const last = pageGroups(matches, 1);
    expect(last.groups[0].hits).toHaveLength(50);
    expect(last.pageTotal).toBe(2);
  });

  it('跨文件续页：文件被页边界切开', () => {
    const matches = [...seq(60, 'a.ts'), ...seq(60, 'b.ts')];
    const p0 = pageGroups(matches, 0);
    expect(p0.groups.map(g => g.path)).toEqual(['a.ts', 'b.ts']);
    expect(p0.groups[0].hits).toHaveLength(60);
    expect(p0.groups[1].hits).toHaveLength(40);
    const p1 = pageGroups(matches, 1);
    expect(p1.groups.map(g => g.path)).toEqual(['b.ts']);
    expect(p1.groups[0].hits).toHaveLength(20);
  });

  it('页码越界钳制到最后一页', () => {
    const matches = seq(120, 'a.ts');
    const p = pageGroups(matches, 99);
    expect(p.groups[0].hits).toHaveLength(20);
  });

  it('自定义页大小', () => {
    const matches = [...seq(3, 'a.ts'), ...seq(3, 'b.ts')];
    const p = pageGroups(matches, 1, 4);
    expect(p.pageTotal).toBe(2);
    expect(p.groups.map(g => g.path)).toEqual(['b.ts']);
    expect(p.groups[0].hits).toHaveLength(2);
  });
});
