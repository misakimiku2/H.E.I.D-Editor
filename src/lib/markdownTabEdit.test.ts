/**
 * 预览页签条的结构化编辑：新增（末尾/指定位置）、改名改内容、删除；
 * 删除最后一个页签时解散组并保留正文。
 */
import { describe, expect, it } from 'vitest';
import { parseLangBlocks, type LangBlock } from './markdownLangs';
import {
  deleteTabSection, insertTabSection, makeTabGroup, sanitizeTabLabel, updateTabSection,
} from './markdownTabEdit';

const groupOf = (md: string) => {
  const block = parseLangBlocks(md)!.find((b): b is Extract<LangBlock, { type: 'tabs' }> => b.type === 'tabs')!;
  return block;
};

const doc = [
  '前言',
  '',
  '<!-- tab:甲 -->',
  '',
  '甲内容',
  '',
  '<!-- tab:乙 -->',
  '',
  '乙内容',
  '',
  '<!-- /tab -->',
  '',
  '结尾',
].join('\n');

describe('页签组源码编辑', () => {
  it('末尾追加：插在组尾标记之前，不产生第二个组尾', () => {
    const md = doc;
    const out = insertTabSection(md, groupOf(md), '丙', '丙内容');
    expect(out).toBe([
      '前言',
      '',
      '<!-- tab:甲 -->',
      '',
      '甲内容',
      '',
      '<!-- tab:乙 -->',
      '',
      '乙内容',
      '',
      '<!-- tab:丙 -->',
      '',
      '丙内容',
      '',
      '<!-- /tab -->',
      '',
      '结尾',
    ].join('\n'));
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('插到指定页签之前', () => {
    const md = doc;
    const out = insertTabSection(md, groupOf(md), '前', '前内容', 0);
    expect(out.indexOf('<!-- tab:前 -->')).toBeLessThan(out.indexOf('<!-- tab:甲 -->'));
    expect(out).toContain('前内容');
  });

  it('未闭合组追加时补上组尾标记', () => {
    const md = '<!-- tab:甲 -->\n\n甲内容';
    const out = insertTabSection(md, groupOf(md), '乙', '乙内容');
    expect(out).toBe('<!-- tab:甲 -->\n\n甲内容\n\n<!-- tab:乙 -->\n\n乙内容\n\n<!-- /tab -->');
  });

  it('改写标签与内容，其它页签原样保留', () => {
    const md = doc;
    const out = updateTabSection(md, groupOf(md).sections[1], '新乙', '新的正文\n第二行');
    expect(out).toBe([
      '前言',
      '',
      '<!-- tab:甲 -->',
      '',
      '甲内容',
      '',
      '<!-- tab:新乙 -->',
      '',
      '新的正文',
      '第二行',
      '',
      '<!-- /tab -->',
      '',
      '结尾',
    ].join('\n'));
  });

  it('删除非最后一个页签：连同内容删除，组尾保留', () => {
    const md = doc;
    const out = deleteTabSection(md, groupOf(md), 0);
    expect(out).not.toContain('甲内容');
    expect(out).toContain('乙内容');
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('删除最后一个页签：解散组并保留正文', () => {
    const md = '前言\n\n<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n结尾';
    expect(deleteTabSection(md, groupOf(md), 0)).toBe('前言\n\n甲内容\n\n结尾');
  });

  it('新建页签组与标签清洗', () => {
    expect(makeTabGroup('页签1', '内容')).toBe('<!-- tab:页签1 -->\n\n内容\n\n<!-- /tab -->');
    expect(sanitizeTabLabel('  a-->b\nc  ', '兜底')).toBe('ab c');
    expect(sanitizeTabLabel('   ', '兜底')).toBe('兜底');
  });
});
