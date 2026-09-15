import { describe, it, expect } from 'vitest';
import {
  ensureHistory, recordStep, undoStep, redoStep,
  canUndoHistory, canRedoHistory, MAX_HISTORY, HISTORY_COALESCE_MS,
  LARGE_HISTORY_CHARS, historyLimitFor,
  type TabHistory,
} from './tabHistory';

/* 初始历史的 lastAt=0，首个时间戳必须大于合并窗口才会独立成条（与真实 Date.now() 一致） */
const T0 = HISTORY_COALESCE_MS + 1;

function setup(initial = 'a'): { map: Map<string, TabHistory>; h: TabHistory } {
  const map = new Map<string, TabHistory>();
  const h = ensureHistory(map, 't1', initial);
  return { map, h };
}

describe('ensureHistory', () => {
  it('懒初始化：stack[0] 为初始内容，index 指向初始态', () => {
    const { map, h } = setup('hello');
    expect(h.stack).toEqual(['hello']);
    expect(h.index).toBe(0);
    expect(h.lastAt).toBe(0);
    expect(map.get('t1')).toBe(h);
  });

  it('重复调用返回同一实例，不重置内容', () => {
    const { map, h } = setup();
    recordStep(h, 'a', 'ab', false, T0);
    expect(ensureHistory(map, 't1', 'a')).toBe(h);
    expect(h.stack).toEqual(['a', 'ab']);
  });
});

describe('recordStep', () => {
  it('内容未变化时不记录', () => {
    const { h } = setup('a');
    expect(recordStep(h, 'a', 'a', false, T0).recorded).toBe(false);
    expect(h.stack).toEqual(['a']);
  });

  it('与当前栈顶相同的内容不重复记录', () => {
    const { h } = setup('a');
    recordStep(h, 'a', 'b', false, T0);
    expect(recordStep(h, 'b', 'b', false, T0 + 1).recorded).toBe(false);
    expect(h.stack).toEqual(['a', 'b']);
  });

  it('超过合并窗口的修改独立成条', () => {
    const { h } = setup('a');
    recordStep(h, 'a', 'ab', false, T0);
    recordStep(h, 'ab', 'abc', false, T0 + HISTORY_COALESCE_MS + 1);
    expect(h.stack).toEqual(['a', 'ab', 'abc']);
    expect(h.index).toBe(2);
  });

  it('合并窗口内的连续输入覆盖当前条目，不新增', () => {
    const { h } = setup('a');
    recordStep(h, 'a', 'ab', false, T0);
    recordStep(h, 'ab', 'abc', false, T0 + HISTORY_COALESCE_MS - 1);
    expect(h.stack).toEqual(['a', 'abc']);
    expect(h.index).toBe(1);
  });

  it('major 修改强制独立成条（即使间隔很小）', () => {
    const { h } = setup('a');
    recordStep(h, 'a', 'ab', false, T0);
    recordStep(h, 'ab', 'xyz', true, T0 + 1);
    expect(h.stack).toEqual(['a', 'ab', 'xyz']);
  });

  it('撤销后再次修改会截断重做分支', () => {
    const { h } = setup('a');
    recordStep(h, 'a', 'b', false, T0);
    recordStep(h, 'b', 'c', false, T0 + HISTORY_COALESCE_MS + 1);
    undoStep(h, 0);
    recordStep(h, 'b', 'd', false, T0 + HISTORY_COALESCE_MS + 2);
    expect(h.stack).toEqual(['a', 'b', 'd']);
    expect(h.index).toBe(2);
  });

  it(`历史超过 ${MAX_HISTORY} 条时丢弃最旧`, () => {
    const { h } = setup('v0');
    for (let i = 1; i <= MAX_HISTORY + 5; i++) {
      recordStep(h, `v${i - 1}`, `v${i}`, true, T0 + i * (HISTORY_COALESCE_MS + 1));
    }
    expect(h.stack.length).toBe(MAX_HISTORY);
    expect(h.stack[0]).toBe(`v${6}`);
    expect(h.index).toBe(MAX_HISTORY - 1);
  });
});

describe('undo / redo', () => {
  it('undo 逐步回退，redo 恢复，边界返回 null', () => {
    const { h } = setup('a');
    recordStep(h, 'a', 'b', true, T0);
    recordStep(h, 'b', 'c', true, T0 + HISTORY_COALESCE_MS + 1);

    expect(undoStep(h, 0)).toBe('b');
    expect(canUndoHistory(h)).toBe(true);
    expect(undoStep(h, 0)).toBe('a');
    expect(canUndoHistory(h)).toBe(false);
    expect(undoStep(h, 0)).toBe(null);

    expect(redoStep(h, 0)).toBe('b');
    expect(redoStep(h, 0)).toBe('c');
    expect(canRedoHistory(h)).toBe(false);
    expect(redoStep(h, 0)).toBe(null);
  });

  it('未初始化历史的标签页安全返回 null/false', () => {
    expect(undoStep(undefined, 0)).toBe(null);
    expect(redoStep(undefined, 0)).toBe(null);
    expect(canUndoHistory(undefined)).toBe(false);
    expect(canRedoHistory(undefined)).toBe(false);
  });
});

describe('大文件历史降档', () => {
  it('historyLimitFor：常规内容取满额，超大内容降到 5 条', () => {
    expect(historyLimitFor(1000)).toBe(MAX_HISTORY);
    expect(historyLimitFor(LARGE_HISTORY_CHARS)).toBe(MAX_HISTORY);
    expect(historyLimitFor(LARGE_HISTORY_CHARS + 1)).toBe(5);
  });

  it('超大内容连续成条时栈压到 5 条', () => {
    const { h } = setup('a');
    const big = 'x'.repeat(LARGE_HISTORY_CHARS + 1);
    for (let i = 0; i < 12; i++) {
      recordStep(h, i === 0 ? 'a' : big + (i - 1), big + i, true, T0 + i * (HISTORY_COALESCE_MS + 1));
    }
    expect(h.stack.length).toBe(5);
    expect(h.index).toBe(4);
    expect(h.stack[h.index]).toBe(big + 11);
  });

  it('合并路径的内容暴涨同样触发压缩（内存防护）', () => {
    const { h } = setup('v0');
    for (let i = 1; i <= MAX_HISTORY; i++) {
      recordStep(h, `v${i - 1}`, `v${i}`, true, T0 + i * (HISTORY_COALESCE_MS + 1));
    }
    expect(h.stack.length).toBe(MAX_HISTORY);
    const big = 'y'.repeat(LARGE_HISTORY_CHARS + 2);
    const lastAt = T0 + MAX_HISTORY * (HISTORY_COALESCE_MS + 1);
    recordStep(h, `v${MAX_HISTORY}`, big, false, lastAt + 1);
    expect(h.stack.length).toBe(5);
    expect(h.stack[h.index]).toBe(big);
  });

  it('内容回落后上限恢复满额', () => {
    const { h } = setup('a');
    const big = 'z'.repeat(LARGE_HISTORY_CHARS + 1);
    recordStep(h, 'a', big, true, T0);
    recordStep(h, big, 'small', true, T0 + HISTORY_COALESCE_MS + 1);
    for (let i = 0; i < 8; i++) {
      recordStep(h, `s${i}`, `s${i + 1}`, true, T0 + (i + 2) * (HISTORY_COALESCE_MS + 1));
    }
    /* a + big + small + 8 次追加 = 11 条，未再触发压缩 */
    expect(h.stack.length).toBe(11);
  });
});
