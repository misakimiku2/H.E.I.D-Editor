import { describe, expect, it } from 'vitest';
import { extractHeadings } from './markdownOutline';

describe('extractHeadings', () => {
  it('ATX 标题：层级、文本、行号与偏移', () => {
    const md = 'intro\n# Title\nsome text\n## Sub §\ntail';
    const hs = extractHeadings(md);
    expect(hs).toHaveLength(2);
    expect(hs[0]).toEqual({ level: 1, text: 'Title', line: 1, offset: 6 });
    expect(hs[1]).toEqual({ level: 2, text: 'Sub §', line: 3, offset: 24 });
  });

  it('跳过围栏代码块内的 # 行（``` 与 ~~~，嵌套长度规则）', () => {
    const md = [
      '# real',
      '```',
      '# fake1',
      '```',
      '~~~js',
      '# fake2',
      '~~~',
      '## real2',
    ].join('\n');
    const hs = extractHeadings(md);
    expect(hs.map(h => h.text)).toEqual(['real', 'real2']);
  });

  it('围栏标记更长时才闭合（CommonMark 规则）', () => {
    const md = '````\n# fake\n```\nstill fake\n````\n# real';
    expect(extractHeadings(md).map(h => h.text)).toEqual(['real']);
  });

  it('尾部 # 装饰与无文本标题', () => {
    expect(extractHeadings('# head #')[0].text).toBe('head');
    expect(extractHeadings('#')[0]).toMatchObject({ level: 1, text: '' });
  });

  it('四空格以内的缩进仍算标题，更深缩进不算', () => {
    expect(extractHeadings('   # a')[0].text).toBe('a');
    // 正则不匹配 4+ 空格缩进（代码块）
    expect(extractHeadings('    # a')).toHaveLength(0);
  });

  it('# 后必须有空白或行尾（#tag 不是标题）', () => {
    expect(extractHeadings('#tag')).toHaveLength(0);
  });

  it('空文档与纯文本返回空', () => {
    expect(extractHeadings('')).toHaveLength(0);
    expect(extractHeadings('just\ntext\n')).toHaveLength(0);
  });
});
