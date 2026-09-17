// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSvg } from './svgParse';
import { applyPatches, deletePatch, elementPatch, type SourcePatch } from './svgWrite';

describe('applyPatches', () => {
  it('单个补丁精确替换区间，其余逐字节不动', () => {
    const src = 'AAA<rect/>BBB';
    expect(applyPatches(src, [{ start: 3, end: 10, text: '<circle/>' }])).toBe('AAA<circle/>BBB');
  });

  it('多个补丁乱序传入：从后往前套用，偏移互不失效', () => {
    const src = 'aaaa[B1]bbbb[B2]cc';
    const patches: SourcePatch[] = [
      { start: 4, end: 8, text: 'one' },
      { start: 12, end: 16, text: 'two' },
    ];
    expect(applyPatches(src, patches.reverse())).toBe('aaaaonebbbbtwocc');
  });

  it('空文本补丁即删除', () => {
    expect(applyPatches('x<rect/>y', [{ start: 1, end: 8, text: '' }])).toBe('xy');
  });
});

describe('elementPatch', () => {
  const SRC = [
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '  <!-- 背景色块 -->',
    '  <rect x="1" width="8"/>',
    '</svg>',
  ].join('\n');

  it('权威树改属性后，补丁只替换该元素，注释与缩进原样保留', () => {
    const res = parseSvg(SRC)!;
    const rect = res.elements[1];
    rect.node.setAttribute('fill', '#ff0000');
    const next = applyPatches(SRC, [elementPatch(SRC, rect)]);
    expect(next).toContain('<!-- 背景色块 -->');
    expect(next).toContain('<rect x="1" width="8" fill="#ff0000"/>');
    /* 未触碰的兄弟区域逐字节不变 */
    expect(next).toBe(SRC.replace('<rect x="1" width="8"/>', '<rect x="1" width="8" fill="#ff0000"/>'));
  });

  it('非根元素的序列化不注入冗余 xmlns 声明', () => {
    const res = parseSvg(SRC)!;
    const rect = res.elements[1];
    rect.node.setAttribute('stroke', 'blue');
    const patch = elementPatch(SRC, rect);
    expect(patch.text).not.toContain('xmlns');
  });

  it('根元素序列化保留 xmlns 声明', () => {
    const res = parseSvg(SRC)!;
    const svg = res.elements[0];
    svg.node.setAttribute('width', '16');
    const patch = elementPatch(SRC, svg);
    expect(patch.text).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('写回后重解析仍对齐（幂等链路）', () => {
    const res = parseSvg(SRC)!;
    const rect = res.elements[1];
    rect.node.setAttribute('fill', 'green');
    const next = applyPatches(SRC, [elementPatch(SRC, rect)]);
    const res2 = parseSvg(next)!;
    expect(res2).not.toBeNull();
    expect(res2.elements).toHaveLength(2);
    expect(res2.elements[1].node.getAttribute('fill')).toBe('green');
  });
});

describe('deletePatch', () => {
  it('元素独占一行：整行吞掉（含缩进与换行），不留空白行', () => {
    const src = '<svg>\n  <rect/>\n  <circle/>\n</svg>';
    const res = parseSvg(src)!;
    const patch = deletePatch(src, res.elements[1]);
    expect(applyPatches(src, [patch])).toBe('<svg>\n  <circle/>\n</svg>');
  });

  it('行内还有其他内容：只删元素自身区间', () => {
    const src = '<svg><rect/><circle/></svg>';
    const res = parseSvg(src)!;
    const patch = deletePatch(src, res.elements[1]);
    expect(applyPatches(src, [patch])).toBe('<svg><circle/></svg>');
  });

  it('删除最后一行元素：连前导换行一起收掉，不留尾空白行', () => {
    const src = '<svg>\n  <rect/>\n  <circle/>\n</svg>';
    const res = parseSvg(src)!;
    const patch = deletePatch(src, res.elements[2]);
    expect(applyPatches(src, [patch])).toBe('<svg>\n  <rect/>\n</svg>');
  });

  it('根元素不可删（返回 null）', () => {
    const res = parseSvg('<svg><rect/></svg>')!;
    expect(deletePatch('<svg><rect/></svg>', res.elements[0])).toBeNull();
  });

  it('批量删除多个元素（从后往前套用）', () => {
    const src = '<svg>\n  <rect/>\n  <circle/>\n  <path/>\n</svg>';
    const res = parseSvg(src)!;
    const patches = [deletePatch(src, res.elements[1])!, deletePatch(src, res.elements[2])!, deletePatch(src, res.elements[3])!];
    expect(applyPatches(src, patches)).toBe('<svg>\n</svg>');
  });
});
