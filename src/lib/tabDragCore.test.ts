import { describe, expect, it } from 'vitest';
import {
  insertionIndex, applyMove, gapIndexFromRects, DRAG_THRESHOLD_PX,
  isPrematureDragEnd, DRAGEND_MIN_MS, ownShiftFor, ownDropIndexOf, ownSlideOffsetX,
} from './tabDragCore';

/* 标签条矩形桩:等宽 100px,从 0 起 */
const rects = (n: number) => Array.from({ length: n }, (_, i) => ({ left: i * 100, right: i * 100 + 100 }));

describe('insertionIndex', () => {
  it('空列表恒为 0', () => {
    expect(insertionIndex([], 500)).toBe(0);
  });

  it('以标签中点为界:左半落前、右半落后', () => {
    const r = rects(3); // [0,100) [100,200) [200,300)
    expect(insertionIndex(r, 40)).toBe(0);   // 第 1 个左半 → 最前
    expect(insertionIndex(r, 60)).toBe(1);   // 第 1 个右半 → 1 前
    expect(insertionIndex(r, 160)).toBe(2);  // 第 2 个右半 → 2 前
    expect(insertionIndex(r, 260)).toBe(3);  // 第 3 个右半 → 末尾
    expect(insertionIndex(r, 999)).toBe(3);  // 越出最右 → 末尾
    expect(insertionIndex(r, -50)).toBe(0);  // 越出最左 → 最前
  });
});

describe('applyMove', () => {
  const arr = ['A', 'B', 'C', 'D'];

  it('向右移动:插入点按「含被拖标签」的坐标换算(to-1)', () => {
    expect(applyMove(arr, 0, 3)).toEqual(['B', 'C', 'A', 'D']);
    expect(applyMove(arr, 0, 4)).toEqual(['B', 'C', 'D', 'A']);
    expect(applyMove(arr, 1, 4)).toEqual(['A', 'C', 'D', 'B']);
  });

  it('向左移动:插入点即移除自身后的下标', () => {
    expect(applyMove(arr, 3, 0)).toEqual(['D', 'A', 'B', 'C']);
    expect(applyMove(arr, 3, 2)).toEqual(['A', 'B', 'D', 'C']);
    expect(applyMove(arr, 2, 1)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('位置无变化返回 null(调用方跳过重排,不产生无意义提交)', () => {
    expect(applyMove(arr, 0, 0)).toBeNull();
    expect(applyMove(arr, 0, 1)).toBeNull(); // 插到自身右半 = 不动
    expect(applyMove(arr, 2, 2)).toBeNull();
    expect(applyMove(arr, 2, 3)).toBeNull(); // 插到自身左缘 = 不动
  });

  it('不修改原数组', () => {
    applyMove(arr, 0, 3);
    expect(arr).toEqual(['A', 'B', 'C', 'D']);
  });

  it('越界 from 返回 null', () => {
    expect(applyMove(arr, -1, 0)).toBeNull();
    expect(applyMove(arr, 4, 0)).toBeNull();
  });
});

describe('DRAG_THRESHOLD_PX', () => {
  it('阈值存在且为小正值(防误触,点击不进拖拽)', () => {
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0);
    expect(DRAG_THRESHOLD_PX).toBeLessThanOrEqual(10);
  });
});

describe('gapIndexFromRects(三分位占位判定)', () => {
  const r = rects(3); // [0,100) [100,200) [200,300)

  it('左三分之一 → 插到该标签前', () => {
    expect(gapIndexFromRects(r, 10, 0)).toBe(0);
    expect(gapIndexFromRects(r, 110, 0)).toBe(1);  // 第二个标签左 1/3
  });

  it('右三分之一 → 插到该标签后', () => {
    expect(gapIndexFromRects(r, 90, 0)).toBe(1);
    expect(gapIndexFromRects(r, 190, 0)).toBe(2);
  });

  it('中间三分之一 → 粘滞保持 prev(占位符不闪烁)', () => {
    expect(gapIndexFromRects(r, 150, 1)).toBe(1);  /* 悬在 tab1 中段,prev=1 */
    expect(gapIndexFromRects(r, 150, 2)).toBe(2);  /* prev=2 紧邻,粘滞 */
    expect(gapIndexFromRects(r, 150, 0)).toBe(2);  /* prev 与之无关:就近右半 */
  });

  it('越出最右 → 追加到末尾', () => {
    expect(gapIndexFromRects(r, 500, 0)).toBe(3);
    expect(gapIndexFromRects(r, 290, 0)).toBe(3);  // 最后一个标签右 1/3
  });

  it('空列表返回 prev(负值收敛为 0 由调用方保证)', () => {
    expect(gapIndexFromRects([], 5, 0)).toBe(0);
  });
});

describe('isPrematureDragEnd(dragend 异常早到防护)', () => {
  it('时长达到下限 → 正常 dragend,照常收尾', () => {
    expect(isPrematureDragEnd(1000, 1000 + DRAGEND_MIN_MS)).toBe(false);
    expect(isPrematureDragEnd(1000, 1000 + 5000)).toBe(false);
  });

  it('时长低于下限 → 异常:Chromium 中止拖拽在按钮未松时触发,按取消处理', () => {
    expect(isPrematureDragEnd(1000, 1000 + DRAGEND_MIN_MS - 1)).toBe(true);
    expect(isPrematureDragEnd(1000, 1000)).toBe(true);
  });
});

describe('ownShiftFor(其余标签让位位移)', () => {
  it('dropIndex 回到原位 → 不让位', () => {
    expect(ownShiftFor(0, 1, 1, 80)).toBe(0);
    expect(ownShiftFor(2, 1, 1, 80)).toBe(0);
  });

  it('dropIndex 离开原位 → 序号 >= dropIndex 的非拖标签右移一个占位宽', () => {
    /* p=2(追加到末尾):无标签让位,空隙在最右 */
    expect(ownShiftFor(0, 2, 0, 80)).toBe(0);
    expect(ownShiftFor(1, 2, 0, 80)).toBe(0);
    expect(ownShiftFor(2, 2, 0, 80)).toBe(80);
    /* p=1(B/C 之间):C 让位,B 不动 */
    expect(ownShiftFor(0, 1, 0, 80)).toBe(0);
    expect(ownShiftFor(1, 1, 0, 80)).toBe(80);
  });
});

describe('ownSlideOffsetX(被拖标签滑动位移,Chrome 式重排)', () => {
  const w3 = [100, 100, 100];
  const GAP = 2;

  it('落点在原位 → 位移 0(不滑动)', () => {
    expect(ownSlideOffsetX(w3, 0, 0, GAP)).toBe(0);
    expect(ownSlideOffsetX(w3, 1, 1, GAP)).toBe(0);
  });

  it('右移:滑到目标槽位(正位移)', () => {
    expect(ownSlideOffsetX(w3, 0, 1, GAP)).toBe(102);  // A 滑到 B 之前
    expect(ownSlideOffsetX(w3, 0, 2, GAP)).toBe(204);  // A 滑到末尾
    expect(ownSlideOffsetX(w3, 1, 2, GAP)).toBe(102);  // B 滑到末尾
  });

  it('左移:滑到目标槽位(负位移)', () => {
    expect(ownSlideOffsetX(w3, 2, 1, GAP)).toBe(-102); // C 滑到 B 之前
    expect(ownSlideOffsetX(w3, 2, 0, GAP)).toBe(-204); // C 滑到最前
    expect(ownSlideOffsetX(w3, 1, 0, GAP)).toBe(-102); // B 滑到最前
  });
});

describe('ownDropIndexOf(非拖坐标 → applyMove 含拖坐标)', () => {
  it('右移插入点 +1,左移/原位不变(修复右移落点少一位)', () => {
    expect(ownDropIndexOf(2, 0)).toBe(3);   // A 拖过 C 右缘 → 追加到末尾
    expect(ownDropIndexOf(1, 0)).toBe(2);   // A 拖到 B/C 之间 → [B,A,C]
    expect(ownDropIndexOf(0, 2)).toBe(0);   // C 拖到最前
    expect(ownDropIndexOf(1, 1)).toBe(1);   // 原位
  });

  it('与 applyMove 配合:落点与占位符视觉一致', () => {
    const tabs = ['A', 'B', 'C'];
    expect(applyMove(tabs, 0, ownDropIndexOf(1, 0))).toEqual(['B', 'A', 'C']);
    expect(applyMove(tabs, 0, ownDropIndexOf(2, 0))).toEqual(['B', 'C', 'A']);
    expect(applyMove(tabs, 2, ownDropIndexOf(0, 2))).toEqual(['C', 'A', 'B']);
  });
});
