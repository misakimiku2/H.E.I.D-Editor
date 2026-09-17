// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSvg } from './svgParse';
import { createRenderCopy } from './svgSanitize';

const parse = (src: string) => parseSvg(src)!;

describe('createRenderCopy 剥离清单', () => {
  it('移除 <script> 及其内容', () => {
    const res = parse('<svg><script>alert(1)</script><rect/></svg>');
    const root = createRenderCopy(res);
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('rect')).not.toBeNull();
  });

  it('移除所有 on* 事件属性', () => {
    const res = parse('<svg><rect onclick="evil()" onload="evil()" width="4"/></svg>');
    const rect = createRenderCopy(res).querySelector('rect')!;
    expect(rect.hasAttribute('onclick')).toBe(false);
    expect(rect.hasAttribute('onload')).toBe(false);
    expect(rect.getAttribute('width')).toBe('4');
  });

  it('移除 javascript: 的 href 与 xlink:href', () => {
    const res = parse('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a href="javascript:evil()"><rect xlink:href="javascript:evil()"/></a></svg>');
    const root = createRenderCopy(res);
    expect(root.querySelector('a')!.getAttribute('href')).toBeNull();
    expect(root.querySelector('rect')!.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
  });

  it('data: 与同文档 #id 引用保留', () => {
    const res = parse('<svg><image href="data:image/png;base64,AAA"/><use href="#shape"/></svg>');
    const root = createRenderCopy(res);
    expect(root.querySelector('image')!.getAttribute('href')).toBe('data:image/png;base64,AAA');
    expect(root.querySelector('use')!.getAttribute('href')).toBe('#shape');
  });

  it('外链 <image> / <use> 整个元素移除（不发网络请求）', () => {
    const res = parse('<svg><image href="http://evil.example/x.png"/><use href="https://evil.example/x.svg#g"/><rect/></svg>');
    const root = createRenderCopy(res);
    expect(root.querySelector('image')).toBeNull();
    expect(root.querySelector('use')).toBeNull();
    expect(root.querySelector('rect')).not.toBeNull();
  });

  it('移除 <foreignObject> 整棵子树', () => {
    const res = parse('<svg><foreignObject><body><p>x</p></body></foreignObject><circle/></svg>');
    const root = createRenderCopy(res);
    expect(root.querySelector('foreignObject')).toBeNull();
    expect(root.querySelector('circle')).not.toBeNull();
  });
});

describe('createRenderCopy 选中索引盖章', () => {
  it('存活元素的 data-hed-idx == 权威树先序下标', () => {
    const res = parse('<svg><g><rect/><circle/></g><text>t</text></svg>');
    const root = createRenderCopy(res);
    const stamped = [root, ...Array.from(root.querySelectorAll('[data-hed-idx]'))];
    expect(stamped.map(el => el.getAttribute('data-hed-idx'))).toEqual(['0', '1', '2', '3', '4']);
    /* 凭 idx 能回到权威元素 */
    const rectIdx = root.querySelector('rect')!.getAttribute('data-hed-idx')!;
    expect(res.elements[Number(rectIdx)].node.tagName).toBe('rect');
  });
});

describe('createRenderCopy 不误伤', () => {
  it('合法内容原样保留：fill/viewBox/gradient stop', () => {
    const src = '<svg viewBox="0 0 8 8"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect fill="url(#g)" width="8"/></svg>';
    const root = createRenderCopy(parse(src));
    expect(root.getAttribute('viewBox')).toBe('0 0 8 8');
    expect(root.querySelector('stop')!.getAttribute('stop-color')).toBe('#f00');
    expect(root.querySelector('rect')!.getAttribute('fill')).toBe('url(#g)');
  });
});
