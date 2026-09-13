/**
 * markdown 多语言/页签切换：`<!-- lang:标签名 -->`（或 `<!-- tab:标签名 -->`）
 * 开启可切换区块，`<!-- /tab -->` 收组，一篇文档允许任意多个页签组，
 * 每组在文档原位渲染切换标签、独立切换。抓取端（lib/domStructure R8/R9 +
 * urlImport.insertTabMarkers）会把「标签组 + 等量内容面板」重写为标记组。
 * 区块的 start 偏移必须指向原文中 md 的真实位置（预览右键选区映射回源码）。
 */
import { describe, expect, it } from 'vitest';
import { parseLangBlocks } from './markdownLangs';

/** 区块结构（不含 start）；start 用「按 start 回切原文必须还原出 md」单独校验 */
const plain = (blocks: ReturnType<typeof parseLangBlocks>) =>
  blocks!.map(b => b.type === 'md'
    ? { type: b.type, md: b.md }
    : { type: b.type, sections: b.sections.map(({ label, md }) => ({ label, md })) });

/** 所有区块的 start 回切原文都应得到自身 md */
const startsRoundTrip = (content: string, blocks: NonNullable<ReturnType<typeof parseLangBlocks>>) =>
  blocks.every(b => b.type === 'md'
    ? content.slice(b.start, b.start + b.md.length) === b.md
    : b.sections.every(s => content.slice(s.start, s.start + s.md.length) === s.md));

describe('parseLangBlocks', () => {
  it('两个及以上 lang 标记切分为一个页签组，组外内容为普通块', () => {
    const md = '前言部分\n\n<!-- lang:中文 -->\n\n中文正文\n\n<!-- lang:English -->\n\nEnglish body';
    const blocks = parseLangBlocks(md)!;
    expect(plain(blocks)).toEqual([
      { type: 'md', md: '前言部分' },
      {
        type: 'tabs',
        sections: [
          { label: '中文', md: '中文正文' },
          { label: 'English', md: 'English body' },
        ],
      },
    ]);
    expect(startsRoundTrip(md, blocks)).toBe(true);
  });

  it('tab: 前缀同样识别（抓取端页签标记）', () => {
    const md = '<!-- tab:基础信息 -->\n![](a.png)\n<!-- tab:编队立绘 -->\n![](b.png)';
    const blocks = parseLangBlocks(md)!;
    expect(plain(blocks)).toEqual([
      {
        type: 'tabs',
        sections: [
          { label: '基础信息', md: '![](a.png)' },
          { label: '编队立绘', md: '![](b.png)' },
        ],
      },
    ]);
    expect(startsRoundTrip(md, blocks)).toBe(true);
  });

  it('结束标记收组，其后内容为普通块；多个组各自独立', () => {
    const md = [
      '页头',
      '<!-- tab:基础信息 -->',
      '![](a.png)',
      '<!-- tab:编队立绘 -->',
      '![](b.png)',
      '<!-- /tab -->',
      '',
      '中间正文',
      '<!-- tab:常态攻击 -->',
      '技能一',
      '<!-- tab:共鸣技能 -->',
      '技能二',
      '<!-- /tab -->',
      '',
      '页尾',
    ].join('\n');
    const blocks = parseLangBlocks(md)!;
    expect(plain(blocks)).toEqual([
      { type: 'md', md: '页头' },
      {
        type: 'tabs',
        sections: [
          { label: '基础信息', md: '![](a.png)' },
          { label: '编队立绘', md: '![](b.png)' },
        ],
      },
      { type: 'md', md: '中间正文' },
      {
        type: 'tabs',
        sections: [
          { label: '常态攻击', md: '技能一' },
          { label: '共鸣技能', md: '技能二' },
        ],
      },
      { type: 'md', md: '页尾' },
    ]);
    expect(startsRoundTrip(md, blocks)).toBe(true);
  });

  it('无结束标记时文档剩余部分都算组内容（lang 多语言用法）', () => {
    const md = '共享开头\n<!-- lang:A -->\nA 内容\n<!-- lang:B -->\nB 内容\n结尾也算 B';
    const blocks = parseLangBlocks(md)!;
    expect(plain(blocks)).toEqual([
      { type: 'md', md: '共享开头' },
      {
        type: 'tabs',
        sections: [
          { label: 'A', md: 'A 内容' },
          { label: 'B', md: 'B 内容\n结尾也算 B' },
        ],
      },
    ]);
    expect(startsRoundTrip(md, blocks)).toBe(true);
  });

  it('标记写法容忍空白差异', () => {
    const md = '<!--lang:日本語-->\n日本語の本文\n<!-- lang: English -->\nEnglish';
    const blocks = parseLangBlocks(md)!;
    expect(plain(blocks)).toEqual([
      {
        type: 'tabs',
        sections: [
          { label: '日本語', md: '日本語の本文' },
          { label: 'English', md: 'English' },
        ],
      },
    ]);
    expect(startsRoundTrip(md, blocks)).toBe(true);
  });

  it('无标记返回 null；单区块组降级为普通块', () => {
    expect(parseLangBlocks('普通文档')).toBeNull();
    expect(parseLangBlocks('只有结束标记 <!-- /tab -->')).toBeNull();
    expect(parseLangBlocks('<!-- lang:中文 -->\n只有一个标记')).toEqual([
      { type: 'md', md: '只有一个标记', start: '<!-- lang:中文 -->\n'.length },
    ]);
  });
});
