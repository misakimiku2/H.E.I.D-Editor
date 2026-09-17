// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSvg } from './svgParse';
import { collectPalette, replaceColor } from './svgPalette';

const parse = (src: string) => parseSvg(src)!;

describe('collectPalette', () => {
  it('收集 fill/stroke/stop-color 并按颜色聚合计数', () => {
    const src = '<svg><rect fill="#FF0000" stroke="#Ff0000"/><circle stroke="#ff0000"/><path fill="blue"/><stop stop-color="#ff0000"/></svg>';
    const entries = collectPalette(parse(src));
    const red = entries.find(e => e.color === '#ff0000')!;
    expect(red).toBeDefined();
    expect(red.count).toBe(4);
    const blue = entries.find(e => e.color === 'blue')!;
    expect(blue.count).toBe(1);
  });

  it('跳过 none / url() / currentColor / inherit', () => {
    const src = '<svg><rect fill="none" stroke="url(#g)" fill-opacity="currentColor" style="fill: inherit"/></svg>';
    expect(collectPalette(parse(src))).toEqual([]);
  });

  it('内联 style 声明也收集（标记 inStyle）', () => {
    const src = '<svg><rect style="fill:#0f0; stroke-width: 2"/><path style="stroke: #0F0"/></svg>';
    const entries = collectPalette(parse(src));
    expect(entries).toHaveLength(1);
    expect(entries[0].color).toBe('#0f0');
    expect(entries[0].count).toBe(2);
    expect(entries[0].uses.every(u => u.inStyle)).toBe(true);
  });
});

describe('replaceColor', () => {
  it('属性颜色替换：只改涉及的元素，其余逐字节保留', () => {
    const src = [
      '<svg>',
      '  <!-- 主题红 -->',
      '  <rect fill="#FF0000" width="4"/>',
      '  <circle fill="blue"/>',
      '</svg>',
    ].join('\n');
    const res = parse(src);
    const next = replaceColor(src, res, '#ff0000', '#3366ff');
    expect(next).toContain('<rect fill="#3366ff" width="4"/>');
    expect(next).toContain('<!-- 主题红 -->');
    expect(next).toContain('<circle fill="blue"/>');
    /* 重解析后属性确实变了 */
    const res2 = parse(next)!;
    expect(res2.elements[1].node.getAttribute('fill')).toBe('#3366ff');
  });

  it('style 声明替换：只动对应声明，其余声明保留', () => {
    const src = '<svg><rect style="fill:#0f0; stroke-width: 2"/></svg>';
    const res = parse(src);
    const next = replaceColor(src, res, '#0f0', 'rebeccapurple');
    expect(next).toBe('<svg><rect style="fill:rebeccapurple; stroke-width: 2"/></svg>');
  });

  it('跨多元素全局替换一次成型', () => {
    const src = '<svg><rect fill="#ff0000"/><circle stroke="#FF0000"/><path fill="#abc"/></svg>';
    const res = parse(src);
    const next = replaceColor(src, res, '#ff0000', 'navy');
    expect(next).toBe('<svg><rect fill="navy"/><circle stroke="navy"/><path fill="#abc"/></svg>');
  });

  it('目标色不存在时源码原样返回', () => {
    const src = '<svg><rect fill="blue"/></svg>';
    const res = parse(src);
    expect(replaceColor(src, res, '#ff0000', 'navy')).toBe(src);
  });
});
