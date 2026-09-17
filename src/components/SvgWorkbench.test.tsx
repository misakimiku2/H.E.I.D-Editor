// @vitest-environment jsdom
/**
 * SVG 工作台组件冒烟：
 * ① 编辑模式挂载——sanitize 副本带 data-hed-idx 内联渲染；
 * ② 命中选中与拖拽提交——pointer 事件链走通、松手才提交一次补丁；
 * ③ 面板联动——图层树列出元素、调色板收集颜色并触发全局换色、fill 输入直改属性。
 * （视觉细节不在 jsdom 断言范围：getBoundingClientRect 恒为 0，覆盖层不参与断言）
 */
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('畸形 XML：画布显示无效占位，面板可切换但不崩', () => {
    const h = mount({ content: '<svg><rect></svg>' });
    expect(h.textContent).toContain('svg.invalid');
  });
});
