// @vitest-environment jsdom
/**
 * SVG 工作台预览面板的触屏分支：单指平移、双指捏合缩放、浏览器手势关闭，
 * 以及浮在画布上的切换按钮不被手势吞掉。
 * 桌面分支（中键平移 + 滚轮缩放）由 SvgWorkbench.test.tsx 覆盖，本文件把
 * IS_TOUCH_PRIMARY mock 为 true 只看触屏路径。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* platform 在模块加载期读取，vi.mock 须提升到 import 之前 */
vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: true,
  IS_ANDROID_APP: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { SvgWorkbench } from './SvgWorkbench';

const SRC = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
  '  <rect width="40" height="40"/>',
  '</svg>',
].join('\n');

beforeAll(() => {
  /* jsdom 不实现 blob URL，预览的 <img> 就挂不上——桩一个地址即可，
     图片不会真加载，fitScale 保持初值 1，断言只看 transform 里的位移与比例 */
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
});

type PType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

const fire = (el: Element, type: PType, pointerId: number, x: number, y: number, pointerType = 'touch') => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId, pointerType, clientX: x, clientY: y, button: 0, isPrimary: pointerId === 1 });
  act(() => { el.dispatchEvent(e); });
};

let host: HTMLDivElement;
let root: Root;

function mountTouch() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <SvgWorkbench content={SRC} isDarkMode={false} onToggleEdit={() => {}} onContentChange={() => {}}>
        {null}
      </SvgWorkbench>,
    );
  });
  return host;
}

const img = () => host.querySelector('[data-svg-preview] img') as HTMLImageElement;

afterEach(() => {
  /* 每个用例重挂，避免手势状态串味 */
  act(() => { root.unmount(); });
  host.remove();
});

describe('SvgWorkbench 预览面板触屏手势', () => {
  it('单指按下并拖动 = 平移画布（桌面需中键，触屏无中键）', () => {
    mountTouch();
    const pane = host.querySelector('[data-svg-preview]') as HTMLElement;
    expect(img()).not.toBeNull();
    fire(pane, 'pointerdown', 1, 100, 100);
    fire(pane, 'pointermove', 1, 140, 120);
    expect(img().style.transform).toContain('translate(40px, 20px)');
    fire(pane, 'pointerup', 1, 140, 120);
  });

  it('双指张开 = 以两指中点为锚放大', () => {
    mountTouch();
    const pane = host.querySelector('[data-svg-preview]') as HTMLElement;
    fire(pane, 'pointerdown', 1, 100, 100);
    fire(pane, 'pointerdown', 2, 200, 100);
    fire(pane, 'pointermove', 2, 300, 100);
    /* 两指距离 100 → 200，比例 2 落在 scale 上（fitScale 初值 1） */
    expect(img().style.transform).toContain('scale(2)');
  });

  it('松开一指后剩余指继续单指平移，不残留捏合', () => {
    mountTouch();
    const pane = host.querySelector('[data-svg-preview]') as HTMLElement;
    fire(pane, 'pointerdown', 1, 100, 100);
    fire(pane, 'pointerdown', 2, 200, 100);
    fire(pane, 'pointermove', 2, 260, 100);
    fire(pane, 'pointerup', 2, 260, 100);
    const before = img().style.transform;
    fire(pane, 'pointermove', 1, 120, 130);
    expect(img().style.transform).not.toBe(before);
    expect(img().style.transform).toContain('translate(');
  });

  it('鼠标指针不参与触屏手势（桌面中键/滚轮路径不变）', () => {
    mountTouch();
    const pane = host.querySelector('[data-svg-preview]') as HTMLElement;
    fire(pane, 'pointerdown', 1, 100, 100, 'mouse');
    fire(pane, 'pointermove', 1, 180, 180, 'mouse');
    expect(img().style.transform).toContain('translate(0px, 0px)');
  });

  it('触屏下画布关闭浏览器默认手势，单指拖动不被页面滚动吃掉', () => {
    mountTouch();
    const pane = host.querySelector('[data-svg-preview]') as HTMLElement;
    expect(pane.className).toContain('touch-none');
  });

  it('编辑/预览切换按钮在画布内仍有效：按下它不会起手势', () => {
    const onToggleEdit = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <SvgWorkbench content={SRC} isDarkMode={false} onToggleEdit={onToggleEdit} onContentChange={() => {}}>
          {null}
        </SvgWorkbench>,
      );
    });
    const btn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('svg.editMode'))!;
    expect(btn).toBeDefined();
    fire(btn, 'pointerdown', 1, 50, 50);
    const pane = host.querySelector('[data-svg-preview]') as HTMLElement;
    fire(pane, 'pointermove', 1, 200, 200);
    expect(img().style.transform).toContain('translate(0px, 0px)');
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onToggleEdit).toHaveBeenCalledTimes(1);
  });
});
