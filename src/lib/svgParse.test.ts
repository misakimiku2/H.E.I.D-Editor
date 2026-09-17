// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSvg, type SvgElementInfo } from './svgParse';

/** 从解析结果取第 i 个（先序）元素区间切片 */
const slice = (src: string, els: SvgElementInfo[], i: number) => src.slice(els[i].start, els[i].end);

describe('parseSvg 基本解析', () => {
  it('产出先序元素区间：根在前，子按文档序', () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"/><circle r="5"/></svg>';
    const res = parseSvg(src)!;
    expect(res).not.toBeNull();
    expect(res.elements).toHaveLength(3);
    expect(res.elements[0].node.tagName).toBe('svg');
    expect(res.elements[1].node.tagName).toBe('rect');
    expect(res.elements[2].node.tagName).toBe('circle');
    expect(slice(src, res.elements, 1)).toBe('<rect width="10"/>');
    expect(slice(src, res.elements, 2)).toBe('<circle r="5"/>');
    expect(slice(src, res.elements, 0)).toBe(src);
  });

  it('成对闭合标签的区间覆盖到闭合标签结束，含子元素', () => {
    const src = '<svg><g>\n  <rect/>\n</g></svg>';
    const res = parseSvg(src)!;
    expect(slice(src, res.elements, 1)).toBe('<g>\n  <rect/>\n</g>');
  });

  it('区间端点互不交叉且严格嵌套（子区间在父区间内）', () => {
    const src = '<svg><g><g><rect/><rect/></g><text>x</text></g></svg>';
    const res = parseSvg(src)!;
    const els = res.elements;
    for (let i = 1; i < els.length; i++) {
      const parent = els[i].node.parentElement!;
      const p = els[els.findIndex(e => e.node === parent)];
      expect(els[i].start).toBeGreaterThan(p.start);
      expect(els[i].end).toBeLessThan(p.end);
    }
  });
});

describe('parseSvg 词法边界', () => {
  it('属性值内的 > 单引号转义引号与换行不破坏扫描', () => {
    const src = '<svg>\n  <text title="a>b, \'q\', &quot;w&quot;\n  more">hi</text>\n</svg>';
    const res = parseSvg(src)!;
    expect(res.elements).toHaveLength(2);
    /* XML 属性值规范化：换行在属性值中归一为空格（规范行为，非 bug） */
    expect(res.elements[1].node.getAttribute('title')).toBe('a>b, \'q\', "w"   more');
  });

  it('跳过 XML 声明、DOCTYPE、注释、CDATA、处理指令（不算元素）', () => {
    const src = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      '<svg><!-- comment <fake tag> --><style>/*<![CDATA[ a>b ]]>*/</style><?pi data?><rect/></svg>',
    ].join('\n');
    const res = parseSvg(src)!;
    const tags = res.elements.map(e => e.node.tagName);
    expect(tags).toEqual(['svg', 'style', 'rect']);
  });

  it('文本节点不产出区间，svg 内文本内容保留在 DOM', () => {
    const src = '<svg><text>hello <tspan>world</tspan>!</text></svg>';
    const res = parseSvg(src)!;
    expect(res.elements).toHaveLength(3);
    expect(res.elements[1].node.textContent).toBe('hello world!');
  });
});

describe('parseSvg 一致性性质', () => {
  it('全区间切片按序拼接 + 间隙拼回 == 原文逐字节相等（先序嵌套：已被覆盖的子区间跳过）', () => {
    const src = [
      '<?xml version="1.0"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">',
      '  <!-- 背景 -->',
      '  <rect x="1" width="2"><animate attributeName="x"/></rect>',
      '  <path d="M0 0L8 8"/>',
      '</svg>',
    ].join('\n');
    const res = parseSvg(src)!;
    let out = '';
    let cursor = 0;
    for (const e of res.elements) {
      if (e.start < cursor) {
        /* 嵌套子元素：父区间已覆盖；子区间必须完整落在父区间内 */
        expect(e.end).toBeLessThanOrEqual(cursor);
        continue;
      }
      out += src.slice(cursor, e.start);
      out += src.slice(e.start, e.end);
      cursor = e.end;
    }
    expect(out + src.slice(cursor)).toBe(src);
  });

  it('每个元素的区间切片都以自己的标签名开头（扫描器与 DOM 逐位对齐）', () => {
    const src = '<svg><g fill="none"><rect width="4"/><circle r="2"/></g></svg>';
    const res = parseSvg(src)!;
    for (const e of res.elements) {
      const tag = e.node.tagName;
      expect(src.slice(e.start + 1, e.start + 1 + tag.length)).toBe(tag);
    }
  });

  it('元素计数与权威 DOM 元素总数一致（zip 前提）', () => {
    const src = '<svg><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><use href="#g"/><g><rect/><circle/></g></svg>';
    const res = parseSvg(src)!;
    const domCount = res.dom.getElementsByTagName('*').length;
    expect(res.elements).toHaveLength(domCount);
    // 先序与 DOM 文档序逐一对齐
    const all = Array.from(res.dom.getElementsByTagName('*'));
    res.elements.forEach((e, i) => expect(e.node).toBe(all[i]));
  });
});

describe('parseSvg 降级', () => {
  it('畸形 XML 返回 null（编辑降级为纯预览）', () => {
    expect(parseSvg('<svg><rect></svg>')).toBeNull();
    expect(parseSvg('not xml at all')).toBeNull();
    expect(parseSvg('')).toBeNull();
  });

  it('根元素不是 svg 返回 null', () => {
    expect(parseSvg('<html><body></body></html>')).toBeNull();
  });
});
