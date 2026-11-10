/**
 * 大文档预览分块：标题处切段、围栏代码与页签组不切、超长章节按空行切；
 * 每块的 start 必须能在原文中回切出自身 md（data-md 偏移基准）。
 */
import { describe, expect, it } from 'vitest';
import { buildLargePreviewBlocks, splitMarkdownChunks } from './markdownChunks';
import { parseLangBlocks } from './markdownLangs';

const roundTrip = (content: string, chunks: ReturnType<typeof splitMarkdownChunks>) =>
  chunks.every(c => content.slice(c.start, c.start + c.md.length) === c.md);

describe('splitMarkdownChunks', () => {
  it('按标题切段，offset 可回切原文', () => {
    const md = '# 第一章\n\n正文一\n\n## 小节\n\n正文二\n\n# 第二章\n\n正文三';
    const chunks = splitMarkdownChunks(md);
    expect(chunks.map(c => c.md.split('\n')[0])).toEqual(['# 第一章', '## 小节', '# 第二章']);
    expect(roundTrip(md, chunks)).toBe(true);
  });

  it('围栏代码里的伪标题不切', () => {
    const md = '# 一\n\n```md\n# 不是标题\n## 也不是\n```\n\n正文\n\n# 二\n\n结尾';
    const chunks = splitMarkdownChunks(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0].md).toContain('# 不是标题');
    expect(roundTrip(md, chunks)).toBe(true);
  });

  it('页签组内部不切', () => {
    const md = '# 一\n\n<!-- tab:甲 -->\n\n# 组内标题\n\n内容\n\n<!-- /tab -->\n\n# 二\n\n结尾';
    const chunks = splitMarkdownChunks(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0].md).toContain('<!-- /tab -->');
  });

  it('超长无标题章节按空行切到上限附近', () => {
    const para = 'x'.repeat(400);
    const md = Array.from({ length: 20 }, () => para).join('\n\n');
    const chunks = splitMarkdownChunks(md, 2000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(c => c.md.length <= 2400)).toBe(true);
    expect(roundTrip(md, chunks)).toBe(true);
  });

  it('小文档保持单块', () => {
    const md = '# 标题\n\n一小段';
    expect(splitMarkdownChunks(md)).toEqual([{ start: 0, md }]);
    expect(splitMarkdownChunks('   \n\n')).toEqual([]);
  });
});

describe('buildLargePreviewBlocks', () => {
  it('块偏移抬到全文坐标，页签区间同步平移', () => {
    const md = '# 一\n\n前言[^1]\n\n<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n# 二\n\n结尾';
    const blocks = buildLargePreviewBlocks(md);
    const tab = blocks.find(b => b.type === 'tabs')!;
    if (tab.type !== 'tabs') throw new Error('expected tabs');
    expect(md.slice(tab.sections[0].markerStart, tab.sections[0].markerEnd)).toBe('<!-- tab:甲 -->');
    expect(md.slice(tab.closeStart, tab.closeEnd)).toBe('<!-- /tab -->');
    const mdBlock = blocks.find(b => b.type === 'md' && b.md.includes('# 二'))!;
    if (mdBlock.type !== 'md') throw new Error('expected md');
    expect(md.slice(mdBlock.start, mdBlock.start + mdBlock.md.length)).toBe(mdBlock.md);
  });

  it('无页签时逐标题成块，每块可回切原文', () => {
    const md = '# 一\n\n甲\n\n# 二\n\n乙';
    expect(parseLangBlocks(md)).toBeNull();
    const chunks = buildLargePreviewBlocks(md);
    expect(chunks.length).toBe(2);
    expect(chunks.every(b => b.type === 'md' ? b.md === md.slice(b.start, b.start + b.md.length) : false)).toBe(true);
  });
});
