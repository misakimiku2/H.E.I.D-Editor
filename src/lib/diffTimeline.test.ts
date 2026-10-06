import { describe, expect, it } from 'vitest';
import {
  MIN_DIFF_ENTRIES,
  MAX_DIFF_ENTRIES,
  DEFAULT_DIFF_ENTRIES,
  MAX_DIFF_STEPS,
  DEFAULT_DIFF_CONTEXT,
  DEFAULT_COALESCE_WINDOW,
  COALESCE_WINDOW_CHOICES,
  appendEntry,
  appendExternalChange,
  removeEntry,
  revertEntry,
  trimTimeline,
  applyInternalEdit,
  clampDiffEntries,
  normalizeCoalesceWindow,
  detectExternalChange,
  diffStats,
  buildDiffRows,
  buildUnifiedLines,
  foldDiffRows,
  stepCountOf,
  type DiffFold,
  type DiffItem,
  type ExternalDiffEntry,
  type InternalDiffEntry,
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

describe('applyInternalEdit（软件内编辑记录）', () => {
  const T0 = 1_000;
  const MAX = 5;

  it('新步骤：追加条目，before 为变化前内容', () => {
    let timeline = applyInternalEdit([], 'v0', 'v1', true, MAX, T0);
    timeline = applyInternalEdit(timeline, 'v1', 'v2', true, MAX, T0 + 1);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ before: 'v0', after: 'v1', detectedAt: T0 });
    expect(timeline[1]).toMatchObject({ before: 'v1', after: 'v2', detectedAt: T0 + 1 });
  });

  it('连击（非新步骤）：合并进最后一条的 after，before 不变', () => {
    let timeline = applyInternalEdit([], 'v0', 'v1', true, MAX, T0);
    timeline = applyInternalEdit(timeline, 'v1', 'v12', false, MAX, T0 + 1);
    timeline = applyInternalEdit(timeline, 'v12', 'v123', false, MAX, T0 + 2);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ before: 'v0', after: 'v123' });
  });

  it('连击但最后一条 after 与基准衔接不上（外源跳变）→ 退化为追加', () => {
    let timeline = applyInternalEdit([], 'v0', 'v1', true, MAX, T0);
    // 期间内容被外部改写为 X，编辑器从 X 出发连击输入
    timeline = applyInternalEdit(timeline, 'X', 'Xa', false, MAX, T0 + 1);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({ before: 'X', after: 'Xa' });
  });

  it('连击但时间线为空（条目已被接受/撤销）→ 退化为追加，不丢变化', () => {
    const timeline = applyInternalEdit([], 'v0', 'v1', false, MAX, T0);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ before: 'v0', after: 'v1' });
  });

  it('Ctrl+Z 回退后分支重输入：基准对不上，追加新条目保留旧历史', () => {
    let timeline = applyInternalEdit([], 'A', 'B', true, MAX, T0);
    // 回退到 A 后重输入为 C：before 应取实际内容 A，旧条目 A→B 保留
    timeline = applyInternalEdit(timeline, 'A', 'C', false, MAX, T0 + 1);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ before: 'A', after: 'B' });
    expect(timeline[1]).toMatchObject({ before: 'A', after: 'C' });
  });

  it('超出 maxEntries 时同样裁剪最旧', () => {
    let timeline: InternalDiffEntry[] = [];
    for (let i = 0; i < 8; i++) {
      timeline = applyInternalEdit(timeline, `v${i}`, `v${i + 1}`, true, 3, T0 + i);
    }
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({ before: 'v5', after: 'v6' });
    expect(timeline[2]).toMatchObject({ before: 'v7', after: 'v8' });
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

describe('appendExternalChange（外部修改归条：一条 = 一次待审阅的变更）', () => {
  it('连发写入合成一条：before 停在基线、after 跟到最新、每次写入留在 steps', () => {
    let tl = appendExternalChange([], 'v0', 'v1', 1000);
    tl = appendExternalChange(tl, 'v1', 'v2', 1001);
    tl = appendExternalChange(tl, 'v2', 'v3', 1002);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ before: 'v0', after: 'v3', detectedAt: 1002 });
    expect(tl[0].steps?.map(s => s.content)).toEqual(['v1', 'v2', 'v3']);
    expect(tl[0].steps?.map(s => s.detectedAt)).toEqual([1000, 1001, 1002]);
    expect(stepCountOf(tl[0])).toBe(3);
  });

  it('只写过一次时没有 steps：不为单独一件事编造过程', () => {
    const tl = appendExternalChange([], 'v0', 'v1', 1000);
    expect(tl[0].steps).toBeUndefined();
    expect(stepCountOf(tl[0])).toBe(1);
  });

  it('合并沿用同一个 id：它还是同一件待处理的事，选中态与 React key 不跳', () => {
    let tl = appendExternalChange([], 'v0', 'v1', 1000);
    const id = tl[0].id;
    tl = appendExternalChange(tl, 'v1', 'v2', 1001);
    expect(tl[0].id).toBe(id);
  });

  it('链条断裂（before 接不上上一条的 after）→ 另起一条，不把两件事混成一份对比', () => {
    let tl = appendExternalChange([], 'v0', 'v1', 1000);
    tl = appendExternalChange(tl, 'X', 'Y', 1001);
    expect(tl).toHaveLength(2);
    expect(tl[1]).toMatchObject({ before: 'X', after: 'Y' });
    expect(tl[1].steps).toBeUndefined();
  });

  it('分批间隔内合并、超窗另起一条', () => {
    const opts = { windowMinutes: 5 };
    let tl = appendExternalChange([], 'v0', 'v1', 0, opts);
    tl = appendExternalChange(tl, 'v1', 'v2', 4 * 60_000, opts);   // 距上次 4 分钟
    expect(tl).toHaveLength(1);
    tl = appendExternalChange(tl, 'v2', 'v3', 20 * 60_000, opts);  // 距上次 16 分钟
    expect(tl).toHaveLength(2);
    expect(tl[1]).toMatchObject({ before: 'v2', after: 'v3' });
  });

  it('恰好压在窗口边界上仍算同一批', () => {
    const opts = { windowMinutes: 5 };
    let tl = appendExternalChange([], 'v0', 'v1', 0, opts);
    tl = appendExternalChange(tl, 'v1', 'v2', 5 * 60_000, opts);
    expect(tl).toHaveLength(1);
  });

  it('不分批（窗口 0）：隔多久都并成一条', () => {
    let tl = appendExternalChange([], 'v0', 'v1', 0, { windowMinutes: 0 });
    tl = appendExternalChange(tl, 'v1', 'v2', 10 * 24 * 60 * 60_000, { windowMinutes: 0 });
    expect(tl).toHaveLength(1);
    expect(stepCountOf(tl[0])).toBe(2);
  });

  it(`过程步触到上限 ${MAX_DIFF_STEPS}：最旧的边界被并掉，总次数仍然对得上`, () => {
    const total = MAX_DIFF_STEPS + 5;
    let tl = appendExternalChange([], 'v0', 'v1', 0);
    for (let i = 2; i <= total; i++) {
      tl = appendExternalChange(tl, `v${i - 1}`, `v${i}`, i);
    }
    const e = tl[0];
    expect(tl).toHaveLength(1);
    expect(e.steps).toHaveLength(MAX_DIFF_STEPS);
    expect(e.after).toBe(`v${total}`);
    expect(e.mergedSteps).toBe(5);
    expect(stepCountOf(e)).toBe(total);
    /* 留下来的最早一步，基准已退到整条基线——它覆盖的是被并掉的那几次写入 */
    expect(e.steps![0].content).toBe('v6');
    expect(e.before).toBe('v0');
  });

  it('新开条目时仍按 maxEntries 裁剪最旧', () => {
    let tl: ExternalDiffEntry[] = [];
    for (let i = 1; i <= 4; i++) {
      tl = appendExternalChange(tl, `b${i}`, `a${i}`, i, { maxEntries: 2 }); // 每次断链，强制另起
    }
    expect(tl).toHaveLength(2);
    expect(tl.map(e => e.after)).toEqual(['a3', 'a4']);
  });

  it('不修改原数组（纯函数）', () => {
    const tl = appendExternalChange([], 'v0', 'v1', 0);
    const snapshot = [...tl];
    appendExternalChange(tl, 'v1', 'v2', 1);
    expect(tl).toEqual(snapshot);
    expect(tl[0].steps).toBeUndefined();
  });
});

describe('normalizeCoalesceWindow（分批间隔档位）', () => {
  it('合法档位原值返回，字符串数字也认', () => {
    for (const w of COALESCE_WINDOW_CHOICES) expect(normalizeCoalesceWindow(w)).toBe(w);
    expect(normalizeCoalesceWindow('15')).toBe(15);
  });

  it('认不出的回默认（不分批）', () => {
    expect(DEFAULT_COALESCE_WINDOW).toBe(0);
    expect(normalizeCoalesceWindow(7)).toBe(DEFAULT_COALESCE_WINDOW);
    expect(normalizeCoalesceWindow('abc')).toBe(DEFAULT_COALESCE_WINDOW);
    expect(normalizeCoalesceWindow(NaN)).toBe(DEFAULT_COALESCE_WINDOW);
  });
});

describe('foldDiffRows（hunk 折叠：只留变更块 ± 上下文）', () => {
  /** n 行文件，内容 L1..Ln */
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  /** 把第 idx 行（0-based）换成 X{idx} */
  const changeAt = (text: string, ...idx: number[]) =>
    text.split('\n').map((l, i) => (idx.includes(i) ? `X${i}` : l)).join('\n');

  const visible = (items: DiffItem[]) => {
    const out: (string | null)[] = [];
    for (const it of items) if (it.kind === 'row') out.push(it.row.left?.text ?? null);
    return out;
  };
  const foldsOf = (items: DiffItem[]): DiffFold[] => {
    const out: DiffFold[] = [];
    for (const it of items) if (it.kind === 'fold') out.push(it);
    return out;
  };

  /* 20 行文件里改掉第 10 行 */
  const before = lines(20);
  const after = changeAt(before, 9);

  it('默认上下文 3 行，与 git 一致', () => {
    expect(DEFAULT_DIFF_CONTEXT).toBe(3);
    const a = foldDiffRows(buildDiffRows(before, after));
    const b = foldDiffRows(buildDiffRows(before, after), 3);
    expect(a.items).toEqual(b.items);
    expect(a.hunkAnchors).toEqual(b.hunkAnchors);
  });

  it('只留变更行 ± 3 行，首尾各折成一段', () => {
    const rows = buildDiffRows(before, after);
    expect(rows).toHaveLength(20);
    const { items, hunkAnchors } = foldDiffRows(rows, 3);
    expect(items).toHaveLength(9);                       // 折叠 + 7 行 + 折叠
    expect(visible(items)).toEqual(['L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']);
    expect(hunkAnchors).toEqual([4]);                    // 锚点落在变更行本身，不含上下文
    expect(items[4]).toMatchObject({ kind: 'row' });
    const folds = foldsOf(items);
    expect(folds).toHaveLength(2);
    expect(folds[0]).toMatchObject({ hidden: 6, from: 0, to: 5, leftFrom: 1, leftTo: 6, rightFrom: 1, rightTo: 6 });
    expect(folds[1]).toMatchObject({ hidden: 7, from: 13, to: 19, leftFrom: 14, leftTo: 20 });
  });

  it('两处变更相隔不超过 2×上下文时并成一处（中间不夹一两行的折叠条）', () => {
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows(before, changeAt(before, 4, 9)), 3);
    expect(hunkAnchors).toHaveLength(1);
    expect(foldsOf(items)).toHaveLength(2);              // 只剩首尾
    expect(visible(items)).toEqual(['L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']);
  });

  it('两处变更相隔超过 2×上下文时各自成块，中间留一段折叠', () => {
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows(before, changeAt(before, 1, 17)), 3);
    expect(hunkAnchors).toHaveLength(2);
    const folds = foldsOf(items);
    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({ hidden: 9, from: 5, to: 13, leftFrom: 6, leftTo: 14 });
    /* 两个锚点都指向变更行 */
    expect(items[hunkAnchors[0]]).toMatchObject({ kind: 'row' });
    expect(items[hunkAnchors[1]]).toMatchObject({ kind: 'row' });
    expect((items[hunkAnchors[0]] as { row: { left: { text: string } } }).row.left.text).toBe('L2');
    expect((items[hunkAnchors[1]] as { row: { left: { text: string } } }).row.left.text).toBe('L18');
  });

  it('内容完全相同：整份折成一段，没有可跳转的变更位置', () => {
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows(lines(5), lines(5)), 3);
    expect(hunkAnchors).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'fold', hidden: 5, from: 0, to: 4 });
  });

  it('空文件对空文件：不产出任何条目', () => {
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows('', ''), 3);
    expect(items).toEqual([]);
    expect(hunkAnchors).toEqual([]);
  });

  it('变更在文件开头：不产出前置折叠段', () => {
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows(before, changeAt(before, 0)), 3);
    expect(items[0]).toMatchObject({ kind: 'row' });
    expect(hunkAnchors).toEqual([0]);
    expect(foldsOf(items)).toHaveLength(1);              // 只剩尾部
  });

  it('变更在文件末尾：不产出尾部折叠段', () => {
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows(before, changeAt(before, 19)), 3);
    expect(items[items.length - 1]).toMatchObject({ kind: 'row' });
    expect(hunkAnchors).toHaveLength(1);
    expect(foldsOf(items)).toHaveLength(1);              // 只剩头部
  });

  it('上下文 0：只留变更行本身', () => {
    const { items } = foldDiffRows(buildDiffRows(before, after), 0);
    expect(visible(items)).toEqual(['L10']);
    expect(foldsOf(items)).toHaveLength(2);
  });

  it('文件比上下文还短：不折叠，全量可见', () => {
    const b = lines(4);
    const { items, hunkAnchors } = foldDiffRows(buildDiffRows(b, changeAt(b, 1)), 3);
    expect(foldsOf(items)).toHaveLength(0);
    expect(visible(items)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(hunkAnchors).toEqual([1]);
  });

  it('折叠段的 from/to 能原样取回被折掉的行', () => {
    const rows = buildDiffRows(before, after);
    const f = foldsOf(foldDiffRows(rows, 3).items)[1];
    expect(rows.slice(f.from, f.to + 1).map(r => r.left?.text))
      .toEqual(['L14', 'L15', 'L16', 'L17', 'L18', 'L19', 'L20']);
  });
});

describe('buildUnifiedLines（窄壳单栏行模型）', () => {
  it('相同行摊成一行', () => {
    expect(buildUnifiedLines(buildDiffRows('a\nb\n', 'a\nb\n'))).toEqual([
      { type: 'same', text: 'a', lineNo: 1 },
      { type: 'same', text: 'b', lineNo: 2 },
    ]);
  });

  it('修改处先 − 旧行再 + 新行，行号各取自己那一侧', () => {
    expect(buildUnifiedLines(buildDiffRows('a\nold\n', 'a\nnew\n'))).toEqual([
      { type: 'same', text: 'a', lineNo: 1 },
      { type: 'del', text: 'old', lineNo: 2 },
      { type: 'add', text: 'new', lineNo: 2 },
    ]);
  });

  it('纯删除只有 − 行，纯新增只有 + 行', () => {
    expect(buildUnifiedLines(buildDiffRows('a\nb\n', 'a\n'))).toEqual([
      { type: 'same', text: 'a', lineNo: 1 },
      { type: 'del', text: 'b', lineNo: 2 },
    ]);
    expect(buildUnifiedLines(buildDiffRows('a\n', 'a\nb\n'))).toEqual([
      { type: 'same', text: 'a', lineNo: 1 },
      { type: 'add', text: 'b', lineNo: 2 },
    ]);
  });

  it('替换块行数不等时按删完再增的顺序摊开', () => {
    expect(buildUnifiedLines(buildDiffRows('x\nold\ny\n', 'x\nn1\nn2\ny\n'))).toEqual([
      { type: 'same', text: 'x', lineNo: 1 },
      { type: 'del', text: 'old', lineNo: 2 },
      { type: 'add', text: 'n1', lineNo: 2 },
      { type: 'add', text: 'n2', lineNo: 3 },
      { type: 'same', text: 'y', lineNo: 3 },
    ]);
  });
});
