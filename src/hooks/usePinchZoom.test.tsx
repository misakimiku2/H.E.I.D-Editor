// @vitest-environment jsdom
/**
 * usePinchZoom 增量手势语义：
 * - 单指移动 → onPan 增量（相对上次事件），无位移不回调；
 * - 双指按下 → 进入捏合，onPinch 给出距离比与中点；比例不变不回调；
 * - 任一指抬起回到单指 → 重新以剩余指为平移起点；
 * - mouse 指针完全不参与（桌面路径不变）。
 * IS_TOUCH_PRIMARY 在本文件 mock 为 true，专注触屏分支。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { usePinchZoom } from './usePinchZoom';

vi.mock('../lib/platform', () => ({ IS_TOUCH_PRIMARY: true }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;
let target: HTMLElement | null = null;

const onPan = vi.fn();
const onPinch = vi.fn();
const onMoved = vi.fn();

function Probe() {
  const { bind } = usePinchZoom();
  return <div data-testid="target" {...bind({ onPan, onPinch, onMoved })} />;
}

function firePointer(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', pointerId: number, x: number, y: number, pointerType = 'touch') {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId, pointerType, clientX: x, clientY: y, button: 0, isPrimary: pointerId === 1 });
  act(() => { target!.dispatchEvent(e); });
}

beforeEach(() => {
  onPan.mockClear(); onPinch.mockClear(); onMoved.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Probe />); });
  target = container.querySelector('[data-testid="target"]');
});

afterEach(() => {
  act(() => { root!.unmount(); });
  container?.remove();
  container = root = target = null;
});

describe('usePinchZoom', () => {
  it('单指平移给出增量位移', () => {
    firePointer('pointerdown', 1, 100, 100);
    firePointer('pointermove', 1, 110, 120);
    firePointer('pointermove', 1, 115, 118);
    expect(onPan).toHaveBeenNthCalledWith(1, 10, 20);
    expect(onPan).toHaveBeenNthCalledWith(2, 5, -2);
    expect(onMoved).toHaveBeenCalled();
  });

  it('双指捏合给出距离比、中点与中点位移', () => {
    firePointer('pointerdown', 1, 100, 100);
    firePointer('pointerdown', 2, 200, 100); /* 距离 100，中点 (150,100) */
    firePointer('pointermove', 2, 250, 100); /* 距离 150 → ratio 1.5，中点 (175,100)，位移 (25,0) */
    expect(onPinch).toHaveBeenCalledTimes(1);
    expect(onPinch).toHaveBeenCalledWith(1.5, 175, 100, 25, 0);
  });

  it('双指整体平移（比例不变）仍报中点位移', () => {
    firePointer('pointerdown', 1, 100, 100);
    firePointer('pointerdown', 2, 200, 100);
    firePointer('pointermove', 1, 120, 100); /* 中间事件：仅一指动，距离变 80 */
    firePointer('pointermove', 2, 220, 100); /* 距离回到 100，中点 (170,100)，位移 (10,0) */
    expect(onPinch).toHaveBeenLastCalledWith(1.25, 170, 100, 10, 0);
    expect(onMoved).toHaveBeenCalled(); /* 有移动 */
  });

  it('抬指回到单指后重新以剩余指为平移起点', () => {
    firePointer('pointerdown', 1, 100, 100);
    firePointer('pointerdown', 2, 200, 100);
    firePointer('pointerup', 2, 200, 100);
    firePointer('pointermove', 1, 140, 130);
    expect(onPan).toHaveBeenCalledWith(40, 30);
  });

  it('pointercancel 全部清理，之后单指可重新起手', () => {
    firePointer('pointerdown', 1, 100, 100);
    firePointer('pointercancel', 1, 100, 100);
    firePointer('pointerdown', 1, 200, 200);
    firePointer('pointermove', 1, 210, 210);
    expect(onPan).toHaveBeenLastCalledWith(10, 10);
  });

  it('mouse 指针不参与', () => {
    firePointer('pointerdown', 1, 100, 100, 'mouse');
    firePointer('pointermove', 1, 150, 150, 'mouse');
    expect(onPan).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
  });
});
