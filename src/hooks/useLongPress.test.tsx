// @vitest-environment jsdom
/**
 * useLongPress 长按手势语义：
 * - 触屏指针按住 500ms 触发一次（带坐标与触觉反馈），桌面右键路径不受影响；
 * - 提前抬起 / 位移超阈值 / 第二指按下均取消；
 * - 触屏上原生 contextmenu 被吞（防长按与 WebView 原生长按双开菜单）。
 * IS_TOUCH_PRIMARY 在本文件 mock 为 true，专注触屏分支。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useLongPress, LONG_PRESS_MS } from './useLongPress';

vi.mock('../lib/platform', () => ({ IS_TOUCH_PRIMARY: true }));

/* React 19 手写 createRoot 测试需显式声明 act 环境 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;
let target: HTMLElement | null = null;

const onLongPress = vi.fn();
const onContextMenuMouse = vi.fn();
const onClickMouse = vi.fn();
const onMouseDownMouse = vi.fn();

function Probe() {
  const { bind } = useLongPress();
  return <div data-testid="target" {...bind({ onLongPress, onContextMenu: onContextMenuMouse, onClick: onClickMouse, onMouseDown: onMouseDownMouse })} />;
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Probe />); });
  target = container.querySelector('[data-testid="target"]');
}

type PointerType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

/** jsdom 无 PointerEvent：以可冒泡 Event 加指针属性模拟 React 可识别的指针事件 */
function fire(type: PointerType, opts: { pointerId?: number; pointerType?: string; clientX?: number; clientY?: number } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 60, button: 0, ...opts });
  act(() => { target!.dispatchEvent(e); });
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  (navigator as any).vibrate = vi.fn();
  onLongPress.mockClear();
  onContextMenuMouse.mockClear();
  onClickMouse.mockClear();
  onMouseDownMouse.mockClear();
  mount();
});

afterEach(() => {
  act(() => { root!.unmount(); });
  container?.remove();
  container = root = target = null;
  vi.useRealTimers();
});

describe('useLongPress', () => {
  it('按住 500ms 触发一次，坐标为按下点，并带触觉反馈', () => {
    fire('pointerdown', { clientX: 40, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ x: 40, y: 60 });
    expect(navigator.vibrate).toHaveBeenCalledWith(10);
  });

  it('提前抬起不触发，且抬起后再等也不触发', () => {
    fire('pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 100); });
    fire('pointerup');
    act(() => { vi.advanceTimersByTime(500); });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('位移超过阈值取消（滚动/拖拽优先），小位移不取消', () => {
    fire('pointerdown');
    fire('pointermove', { clientX: 40 + 12, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
    expect(onLongPress).not.toHaveBeenCalled();

    fire('pointerdown', { pointerId: 2 });
    fire('pointermove', { pointerId: 2, clientX: 40 + 6, clientY: 60 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('pointercancel 取消（浏览器接管滚动的场景）', () => {
    fire('pointerdown');
    fire('pointercancel');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('第二指按下取消第一指（捏合缩放优先）', () => {
    fire('pointerdown', { pointerId: 1 });
    fire('pointerdown', { pointerId: 2, clientX: 90, clientY: 90 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('mouse 指针完全不参与（桌面走原生右键）', () => {
    fire('pointerdown', { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('触发后再次长按可重新计一次（菜单关闭后可再次长按）', () => {
    fire('pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fire('pointerup');
    fire('pointerdown', { pointerId: 3 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(onLongPress).toHaveBeenCalledTimes(2);
  });

  it('触屏上原生 contextmenu 被吞（preventDefault+stopPropagation，不透传桌面回调）', () => {
    const e = new Event('contextmenu', { bubbles: true, cancelable: true });
    const pd = vi.spyOn(e, 'preventDefault');
    const sp = vi.spyOn(e, 'stopPropagation');
    act(() => { target!.dispatchEvent(e); });
    expect(pd).toHaveBeenCalled();
    expect(sp).toHaveBeenCalled();
    expect(onContextMenuMouse).not.toHaveBeenCalled();
  });

  it('长按触发后紧随的 click 被吞（防弹菜单时误触发选中/打开）', () => {
    fire('pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fire('pointerup');
    const click = new Event('click', { bubbles: true, cancelable: true });
    const pd = vi.spyOn(click, 'preventDefault');
    act(() => { target!.dispatchEvent(click); });
    expect(pd).toHaveBeenCalled();
    expect(onClickMouse).not.toHaveBeenCalled();
  });

  it('长按触发后合成的 mousedown 被拦（防「点击外部关闭」逻辑立刻关掉菜单）', () => {
    fire('pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fire('pointerup');
    const md = new Event('mousedown', { bubbles: true, cancelable: true });
    const pd = vi.spyOn(md, 'preventDefault');
    const sp = vi.spyOn(md, 'stopPropagation');
    act(() => { target!.dispatchEvent(md); });
    expect(pd).toHaveBeenCalled();
    expect(sp).toHaveBeenCalled();
  });

  it('未长按的普通点按不拦 mousedown', () => {
    fire('pointerdown');
    fire('pointerup');
    const md = new Event('mousedown', { bubbles: true, cancelable: true });
    act(() => { target!.dispatchEvent(md); });
    expect(md.defaultPrevented).toBe(false);
  });

  it('onMouseDown 透传：普通点按时收到回调，长按抑制窗口内不收到', () => {
    /* 普通点按：透传给元素自身的 mousedown 逻辑 */
    fire('pointerdown');
    fire('pointerup');
    act(() => { target!.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true })); });
    expect(onMouseDownMouse).toHaveBeenCalledTimes(1);
    /* 长按触发后的合成 mousedown：仍被吞掉，透传回调不触发 */
    fire('pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    fire('pointerup');
    act(() => { target!.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true })); });
    expect(onMouseDownMouse).toHaveBeenCalledTimes(1);
  });

  it('普通点按的 click 正常透传', () => {
    fire('pointerdown');
    fire('pointerup');
    const click = new Event('click', { bubbles: true, cancelable: true });
    act(() => { target!.dispatchEvent(click); });
    expect(onClickMouse).toHaveBeenCalledTimes(1);
  });

  it('指针事件 stopPropagation（嵌套 bind 时只触发最内层）', () => {
    const sp = vi.spyOn(Event.prototype, 'stopPropagation');
    fire('pointerdown');
    expect(sp).toHaveBeenCalled();
    sp.mockRestore();
  });
});
