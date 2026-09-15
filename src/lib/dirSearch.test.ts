/**
 * 跨文件搜索纯函数：分组与片段内高亮区间。
 * invoke 封装（searchInDir）与 fileOps 同策略不测——命令契约由 Rust 测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { groupByFile, hitRangeInSnippet, type FileHit } from './dirSearch';

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
