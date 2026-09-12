import { describe, expect, it } from 'vitest';
import {
  MIN_DIFF_ENTRIES,
  MAX_DIFF_ENTRIES,
  DEFAULT_DIFF_ENTRIES,
  appendEntry,
  removeEntry,
  revertEntry,
  trimTimeline,
  clampDiffEntries,
  detectExternalChange,
  diffStats,
  buildDiffRows,
  type ExternalDiffEntry,
} from './diffTimeline';

/**
 * 模拟磁盘连续变化：contents[0] 为建立监听时的基准内容，
 * 之后 contents[i-1] → contents[i] 依次外部修改（before 恒取最后已知内容，与 hook 用法一致）。
 * maxEntries 不传时走 appendEntry 默认值。
 */
function simulateChanges(contents: string[], t0 = 1_000, maxEntries?: number): ExternalDiffEntry[] {
  let timeline: ExternalDiffEntry[] = [];
  for (let i = 1; i < contents.length; i++) {
    timeline = appendEntry(timeline, contents[i - 1], contents[i], t0 + i, maxEntries);
  }
  return timeline;
}

describe('appendEntry / 时间线', () => {
  it('首条 entry 的 before 为建立监听时读到的磁盘内容', () => {
    const timeline = appendEntry([], 'v0', 'v1', 111);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].before).toBe('v0');
    expect(timeline[0].after).toBe('v1');
    expect(timeline[0].detectedAt).toBe(111);
    expect(timeline[0].id).toBeTruthy();
  });

  it('链式结构：第 N 条的 before 等于第 N-1 条的 after', () => {
    const timeline = simulateChanges(['v0', 'v1', 'v2', 'v3']);
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({ before: 'v0', after: 'v1' });
    expect(timeline[1]).toMatchObject({ before: 'v1', after: 'v2' });
    expect(timeline[2]).toMatchObject({ before: 'v2', after: 'v3' });
  });

  it('追加时保持时间倒序无关的原始顺序（按检测时间递增排列）', () => {
    const timeline = simulateChanges(['v0', 'v1', 'v2']);
    expect(timeline.map(e => e.detectedAt)).toEqual([1001, 1002]);
  });

  it('上限裁剪：显式 maxEntries，超出丢弃最旧', () => {
    // v0 → ... → v5 共 6 个版本、5 次变化，上限 3 条
    const versions = Array.from({ length: 6 }, (_, i) => `v${i}`);
    const timeline = simulateChanges(versions, 1_000, 3);
    expect(timeline).toHaveLength(3);
    // 最旧两条（v0→v1、v1→v2）被丢弃，现存最早的是 v2→v3
    expect(timeline[0]).toMatchObject({ before: 'v2', after: 'v3' });
    expect(timeline[timeline.length - 1]).toMatchObject({ before: 'v4', after: 'v5' });
  });

  it(`上限裁剪：不传 maxEntries 时默认保留 ${DEFAULT_DIFF_ENTRIES} 条`, () => {
    const versions = Array.from({ length: DEFAULT_DIFF_ENTRIES + 2 }, (_, i) => `v${i}`);
    const timeline = simulateChanges(versions);
    expect(timeline).toHaveLength(DEFAULT_DIFF_ENTRIES);
    // 最旧一条（v0→v1）被丢弃，现存最早的是 v1→v2
    expect(timeline[0]).toMatchObject({ before: 'v1', after: 'v2' });
    expect(timeline[timeline.length - 1]).toMatchObject({
      before: `v${DEFAULT_DIFF_ENTRIES}`,
      after: `v${DEFAULT_DIFF_ENTRIES + 1}`,
    });
  });

  it('取值范围常量：5 ~ 50，默认 30', () => {
    expect(MIN_DIFF_ENTRIES).toBe(5);
    expect(MAX_DIFF_ENTRIES).toBe(50);
    expect(DEFAULT_DIFF_ENTRIES).toBe(30);
  });

  it('不修改原数组（纯函数）', () => {
    const original = appendEntry([], 'a', 'b');
    const snapshot = [...original];
    appendEntry(original, 'b', 'c');
    expect(original).toEqual(snapshot);
  });
});

describe('trimTimeline（设置调低时即时裁剪）', () => {
  it('超限裁剪保留最新', () => {
    const timeline = simulateChanges(['v0', 'v1', 'v2', 'v3']);
    const trimmed = trimTimeline(timeline, 2);
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0]).toMatchObject({ before: 'v1', after: 'v2' });
    expect(trimmed[1]).toMatchObject({ before: 'v2', after: 'v3' });
  });

  it('未超限返回原数组引用', () => {
    const timeline = simulateChanges(['v0', 'v1']);
    expect(trimTimeline(timeline, 10)).toBe(timeline);
  });
});

describe('clampDiffEntries（设置取值钳制）', () => {
  it('低于下限钳到最小值', () => {
    expect(clampDiffEntries(0)).toBe(MIN_DIFF_ENTRIES);
    expect(clampDiffEntries(-3)).toBe(MIN_DIFF_ENTRIES);
  });

  it('高于上限钳到最大值', () => {
    expect(clampDiffEntries(999)).toBe(MAX_DIFF_ENTRIES);
  });

  it('范围内整数原值返回，小数四舍五入', () => {
    expect(clampDiffEntries(30)).toBe(30);
    expect(clampDiffEntries(7.6)).toBe(8);
  });

  it('无法解析为数字时回退默认值', () => {
    expect(clampDiffEntries('abc')).toBe(DEFAULT_DIFF_ENTRIES);
    expect(clampDiffEntries(NaN)).toBe(DEFAULT_DIFF_ENTRIES);
  });
});

describe('removeEntry（接受）', () => {
  it('仅移除指定条目，其余保留', () => {
    let timeline = simulateChanges(['v0', 'v1', 'v2', 'v3']);
    const target = timeline[1]; // v1→v2
    timeline = removeEntry(timeline, target.id);
    expect(timeline).toHaveLength(2);
    expect(timeline.map(e => e.id)).not.toContain(target.id);
    expect(timeline[0]).toMatchObject({ before: 'v0', after: 'v1' });
    expect(timeline[1]).toMatchObject({ before: 'v2', after: 'v3' });
  });

  it('id 不存在时原样返回', () => {
    const timeline = simulateChanges(['v0', 'v1']);
    expect(removeEntry(timeline, 'nope')).toEqual(timeline);
  });
});

describe('revertEntry（撤销级联移除）', () => {
  it('撤销中间条目：该条及其后所有条目移除，之前的保留', () => {
    let timeline = simulateChanges(['v0', 'v1', 'v2', 'v3', 'v4']); // 4 条
    const target = timeline[1]; // v1→v2
    timeline = revertEntry(timeline, target.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ before: 'v0', after: 'v1' });
  });

  it('撤销首条：时间线清空', () => {
    let timeline = simulateChanges(['v0', 'v1', 'v2']);
    timeline = revertEntry(timeline, timeline[0].id);
    expect(timeline).toHaveLength(0);
  });

  it('撤销末条：仅移除末条', () => {
    let timeline = simulateChanges(['v0', 'v1', 'v2']);
    const lastId = timeline[timeline.length - 1].id;
    timeline = revertEntry(timeline, lastId);
    expect(timeline).toHaveLength(1);
  });

  it('id 不存在时原样返回', () => {
    const timeline = simulateChanges(['v0', 'v1']);
    expect(revertEntry(timeline, 'nope')).toEqual(timeline);
  });
});

describe('detectExternalChange（变更判定）', () => {
  it('与已知内容相同 → 忽略（自身写入或无实质变化触碰）', () => {
    expect(detectExternalChange('same', 'same')).toBeNull();
  });

  it('与已知内容不同 → 产出条目载荷', () => {
    expect(detectExternalChange('old', 'new')).toEqual({ before: 'old', after: 'new' });
  });

  it('无基准（undefined）→ 忽略，由调用方落基准', () => {
    expect(detectExternalChange(undefined, 'whatever')).toBeNull();
  });

  it('空字符串与 undefined 严格区分（不能把空文件当无基准）', () => {
    expect(detectExternalChange('', 'x')).toEqual({ before: '', after: 'x' });
  });
});

describe('diffStats（增删统计）', () => {
  it('纯新增', () => {
    expect(diffStats('a\n', 'a\nb\nc\n')).toEqual({ added: 2, removed: 0 });
  });

  it('纯删除', () => {
    expect(diffStats('a\nb\nc\n', 'a\n')).toEqual({ added: 0, removed: 2 });
  });

  it('修改（一行删一行增）', () => {
    expect(diffStats('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1 });
  });

  it('内容相同为零差异', () => {
    expect(diffStats('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
  });
});

describe('buildDiffRows（双栏对比行模型）', () => {
  it('修改行：左右对齐，空位以 null 填充，行号各自连续', () => {
    // line2 被修改：左列 line2(del) 对齐右列 line2'(add)
    const rows = buildDiffRows('line1\nline2\nline3\n', 'line1\nline2 changed\nline3\n');
    expect(rows.map(r => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['line1', 'line1'],
      ['line2', 'line2 changed'],
      ['line3', 'line3'],
    ]);
    const changed = rows[1];
    expect(changed.left?.type).toBe('del');
    expect(changed.right?.type).toBe('add');
    expect(changed.left?.lineNo).toBe(2);
    expect(changed.right?.lineNo).toBe(2);
    expect(rows[0].left?.type).toBe('same');
  });

  it('删除行：只占左列（红），右列 null 填充，右侧行号不推进', () => {
    const rows = buildDiffRows('a\nb\nc\n', 'a\nc\n');
    expect(rows.map(r => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', null],
      ['c', 'c'],
    ]);
    expect(rows[1].left?.type).toBe('del');
    expect(rows[1].left?.lineNo).toBe(2);
    expect(rows[2].right?.lineNo).toBe(2); // 右列 b 行不存在，c 仍是第 2 行
  });

  it('新增行：只占右列（绿），左列 null 填充，左侧行号不推进', () => {
    const rows = buildDiffRows('a\nc\n', 'a\nb\nc\n');
    expect(rows.map(r => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      [null, 'b'],
      ['c', 'c'],
    ]);
    expect(rows[1].right?.type).toBe('add');
    expect(rows[1].right?.lineNo).toBe(2);
    expect(rows[2].left?.lineNo).toBe(2);
  });

  it('替换块行数不等：短侧用 null 补齐对齐', () => {
    // 1 行删替换 2 行增
    const rows = buildDiffRows('x\nold\ny\n', 'x\nnew1\nnew2\ny\n');
    const block = rows.slice(1, 3);
    expect(block[0]).toMatchObject({
      left: { type: 'del', text: 'old', lineNo: 2 },
      right: { type: 'add', text: 'new1', lineNo: 2 },
    });
    expect(block[1].left).toBeNull();
    expect(block[1].right).toMatchObject({ type: 'add', text: 'new2', lineNo: 3 });
  });

  it('相同内容：全部 same 行，两侧行号一致', () => {
    const rows = buildDiffRows('a\nb\n', 'a\nb\n');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.left?.type).toBe('same');
      expect(row.right?.type).toBe('same');
      expect(row.left?.lineNo).toBe(row.right?.lineNo);
    }
  });

  it('末行无换行符的文件也能正确对比', () => {
    const rows = buildDiffRows('a\nb', 'a\nB');
    expect(rows[1].left).toMatchObject({ type: 'del', text: 'b' });
    expect(rows[1].right).toMatchObject({ type: 'add', text: 'B' });
  });
});
