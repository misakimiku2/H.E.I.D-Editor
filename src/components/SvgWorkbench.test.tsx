// @vitest-environment jsdom
/**
 * SVG 工作台组件冒烟：
 * ① 编辑模式挂载——sanitize 副本带 data-hed-idx 内联渲染；
 * ② 命中选中与拖拽提交——pointer 事件链走通、松手才提交一次补丁；
 * ③ 面板联动——图层树列出元素、调色板收集颜色并触发全局换色、fill 输入直改属性；
 * ④ 属性页的位移 X/Y——读前导 translate 播种、± 步进与绝对输入各自怎么写回源码。
 * （视觉细节不在 jsdom 断言范围：getBoundingClientRect 恒为 0，覆盖层不参与断言）
 */
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
/* jsdom 不实现 scrollIntoView：图层页签里「选中行滚进视野」的副作用会抛 */
Element.prototype.scrollIntoView = () => {};

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { SvgWorkbench } from './SvgWorkbench';

const SRC = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
  '  <!-- 主题色块 -->',
  '  <rect fill="#ff0000" width="40" height="40"/>',
  '  <circle stroke="#00ff00" fill="none" r="10"/>',
  '</svg>',
].join('\n');

const fire = (el: Element, type: string, init: Partial<MouseEventInit> = {}) => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
};

describe('SvgWorkbench 编辑模式', () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = (props: Partial<React.ComponentProps<typeof SvgWorkbench>> = {}) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <SvgWorkbench
          content={SRC}
          isDarkMode={false}
          svgEdit
          onToggleEdit={() => {}}
          onContentChange={() => {}}
          exportBase="sample.svg"
          {...props}
        >
          {null}
        </SvgWorkbench>,
      );
    });
    return host;
  };

  it('sanitize 副本带索引章内联挂载；源码注释不被渲染为元素', () => {
    const h = mount();
    const svg = h.querySelector('[data-svg-canvas] svg[data-hed-idx="0"]');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('rect[data-hed-idx="1"]')).not.toBeNull();
    /* svg 根 + rect + circle 共 3 个元素；querySelectorAll 只数后代 = 2（注释不算） */
    expect(svg!.querySelectorAll('*').length).toBe(2);
  });

  it('画布点选元素：属性面板同步显示该元素（选中为内部状态）', () => {
    const h = mount();
    const rect = h.querySelector('rect[data-hed-idx="1"]')!;
    act(() => { fire(rect, 'pointerdown'); });
    const tagLabel = Array.from(h.querySelectorAll('span')).find(s => s.textContent === '<rect>');
    expect(tagLabel).toBeDefined();
  });

  it('拖拽松手才提交一次移动补丁（增量并入 transform）', () => {
    const onContentChange = vi.fn();
    const h = mount({ onContentChange });
    const rect = h.querySelector('rect[data-hed-idx="1"]') as SVGElement;
    act(() => {
      fire(rect, 'pointerdown');
      fire(rect, 'pointermove', { clientX: 40, clientY: 0 });
      fire(rect, 'pointerup', { clientX: 40, clientY: 0 });
    });
    expect(onContentChange).toHaveBeenCalledTimes(1);
    const next = onContentChange.mock.calls[0][0] as string;
    expect(next).toContain('transform="translate(');
    expect(next).toContain('<rect fill="#ff0000"');
    /* 未触碰部分逐字保留 */
    expect(next).toContain('<!-- 主题色块 -->');
    expect(next).toContain('<circle stroke="#00ff00"');
  });

  it('未过位移阈值的按下-抬起不提交（纯点选）', () => {
    const onContentChange = vi.fn();
    const h = mount({ onContentChange });
    const rect = h.querySelector('rect[data-hed-idx="1"]') as SVGElement;
    act(() => {
      fire(rect, 'pointerdown');
      fire(rect, 'pointerup');
    });
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('图层树列出全部元素；调色板全局换色走手术式写回', () => {
    const onContentChange = vi.fn();
    const h = mount({ onContentChange });
    /* 图层 tab */
    const tabs = Array.from(h.querySelectorAll('button')).filter(b => b.textContent === 'svg.tabLayers');
    act(() => { tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const rows = Array.from(h.querySelectorAll('[data-outline]')).map(b => b.textContent);
    expect(rows.some(r => r!.startsWith('svg'))).toBe(true);
    expect(rows.some(r => r!.startsWith('rect'))).toBe(true);
    /* 颜色 tab → 选中红色 → 应用替换 */
    const colorTab = Array.from(h.querySelectorAll('button')).filter(b => b.textContent === 'svg.tabColors');
    act(() => { colorTab[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const redRow = Array.from(h.querySelectorAll('button')).find(b => b.textContent?.includes('#ff0000'));
    expect(redRow).toBeDefined();
    act(() => { redRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const apply = Array.from(h.querySelectorAll('button')).find(b => b.textContent === 'svg.applyReplace')!;
    act(() => { apply.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onContentChange).toHaveBeenCalledTimes(1);
    const next = onContentChange.mock.calls[0][0] as string;
    expect(next).toContain('fill="#38bdf8"');
    expect(next).toContain('<!-- 主题色块 -->');
    expect(next).toContain('<circle stroke="#00ff00"');
  });

  it('预览模式：不渲染内联画布（保持 <img> 隔离）', () => {
    const h = mount({ svgEdit: false });
    expect(h.querySelector('[data-svg-canvas]')).toBeNull();
  });

  it('编辑模式带拖宽手柄；预览模式平移改中键触发', () => {
    const h = mount({ svgEdit: false });
    /* 拖宽手柄（分隔条）两模式共用，始终存在 */
    expect(h.querySelector('[role="separator"]')).not.toBeNull();
    /* 预览面板：左键不再平移，中键按下进入平移态（grabbing 光标） */
    const preview = h.querySelector('[data-svg-preview]') as HTMLElement;
    expect(preview).not.toBeNull();
    act(() => { fire(preview, 'mousedown', { button: 0 }); });
    expect(preview.style.cursor).not.toContain('grabbing');
    act(() => { fire(preview, 'mousedown', { button: 1 }); });
    expect(preview.style.cursor).toContain('grabbing');
  });

  it('画布中键=平移、左键空白=取消选中', () => {
    const h = mount();
    const pane = h.querySelector('[data-svg-canvas]') as HTMLElement;
    const rect = h.querySelector('rect[data-hed-idx="1"]')!;
    /* 左键选中后再左键空白 → 回到未选中（属性面板显示空态文案） */
    act(() => { fire(rect, 'pointerdown'); });
    expect(Array.from(h.querySelectorAll('span')).some(s => s.textContent === '<rect>')).toBe(true);
    act(() => { fire(pane, 'pointerdown', { button: 0 }); });
    expect(Array.from(h.querySelectorAll('span')).some(s => s.textContent === '<rect>')).toBe(false);
    /* 中键在元素上按下 = 平移（grabbing 光标），不改变选中 */
    act(() => { fire(rect, 'pointerdown', { button: 1 }); });
    expect(pane.style.cursor).toContain('grabbing');
  });

  it('畸形 XML：画布显示无效占位，面板可切换但不崩', () => {
    const h = mount({ content: '<svg><rect></svg>' });
    expect(h.textContent).toContain('svg.invalid');
  });

  /* ---- 位移 X/Y：触屏没有方向键，微调要靠输入框 + ± 步进（v1.4.1） ---- */
  const POS_SRC = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '  <rect fill="#ff0000" width="40" height="40" transform="translate(4 2)"/>',
    '</svg>',
  ].join('\n');

  const selectRect = (h: HTMLElement) => {
    act(() => { fire(h.querySelector('rect[data-hed-idx="1"]')!, 'pointerdown'); });
  };
  const axisInput = (h: HTMLElement, axis: 'x' | 'y') =>
    h.querySelector(`[data-axis="${axis}"] input`) as HTMLInputElement;
  const stepBtn = (h: HTMLElement, axis: 'x' | 'y', sign: -1 | 1) =>
    Array.from(h.querySelectorAll<HTMLElement>(`[data-axis="${axis}"] button`))
      .find(b => b.textContent === (sign < 0 ? '−' : '+'))!;
  /** 走原生 value setter：直接赋 .value 会被 React 判为「值没变」而跳过 onChange */
  const typeInto = (input: HTMLInputElement, v: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const blur = (input: HTMLInputElement) => {
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };

  it('选中元素后播种出位移 X/Y（读前导 translate 的两个数）', () => {
    const h = mount({ content: POS_SRC });
    expect(h.querySelector('[data-axis="x"]')).toBeNull();
    selectRect(h);
    expect(axisInput(h, 'x').value).toBe('4');
    expect(axisInput(h, 'y').value).toBe('2');
  });

  it('± 一步 = 1 个 SVG 用户单位（与画布方向键同档），另一轴不动', () => {
    const onContentChange = vi.fn();
    const h = mount({ content: POS_SRC, onContentChange });
    selectRect(h);
    act(() => { stepBtn(h, 'x', 1).click(); });
    expect(onContentChange.mock.calls[0][0]).toContain('transform="translate(5 2)"');
    act(() => { stepBtn(h, 'y', -1).click(); });
    expect(onContentChange.mock.calls[1][0]).toContain('transform="translate(4 1)"');
  });

  it('输入框失焦提交绝对值，Enter 同样提交', () => {
    const onContentChange = vi.fn();
    const h = mount({ content: POS_SRC, onContentChange });
    selectRect(h);
    typeInto(axisInput(h, 'x'), '30');
    blur(axisInput(h, 'x'));
    expect(onContentChange.mock.calls[0][0]).toContain('transform="translate(30 2)"');
    axisInput(h, 'y').focus();
    typeInto(axisInput(h, 'y'), '-6');
    act(() => { axisInput(h, 'y').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onContentChange.mock.calls[1][0]).toContain('transform="translate(4 -6)"');
  });

  it('空输入不写源码，草稿收回节点现值', () => {
    const onContentChange = vi.fn();
    const h = mount({ content: POS_SRC, onContentChange });
    selectRect(h);
    typeInto(axisInput(h, 'x'), '');
    blur(axisInput(h, 'x'));
    expect(onContentChange).not.toHaveBeenCalled();
    expect(axisInput(h, 'x').value).toBe('4');
  });

  it('两轴归零时删掉 transform 属性，源码里不留 translate(0 0)', () => {
    const onContentChange = vi.fn();
    const h = mount({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000" transform="translate(4 0)"/></svg>',
      onContentChange,
    });
    selectRect(h);
    typeInto(axisInput(h, 'x'), '0');
    blur(axisInput(h, 'x'));
    expect(onContentChange.mock.calls[0][0]).not.toContain('transform=');
  });

  it('触屏档 ± 按钮撑到 44×44（桌面保持紧凑）', () => {
    const h = mount({ content: POS_SRC });
    selectRect(h);
    const btn = stepBtn(h, 'x', 1);
    expect(btn.className).toContain('pointer-coarse:h-11');
    expect(btn.className).toContain('pointer-coarse:w-11');
    expect(btn.className).toContain('h-6');
  });

  it('根元素没有位移行（与画布一致：0 号不可挪）', () => {
    const h = mount({ content: POS_SRC });
    const tabs = Array.from(h.querySelectorAll('button')).filter(b => b.textContent === 'svg.tabLayers');
    act(() => { tabs[0].click(); });
    act(() => { (h.querySelector('[data-outline="0"]') as HTMLElement).click(); });
    expect(h.querySelector('[data-axis="x"]')).toBeNull();
  });
});
