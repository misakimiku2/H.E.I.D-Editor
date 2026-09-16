import { describe, expect, it } from 'vitest';
import { activeHeadingOffset, extractHeadings } from './markdownOutline';

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

describe('activeHeadingOffset（滚动跟随）', () => {
  /* 按 top 升序的标题位置表（offset 沿用 extractHeadings 的全文偏移语义） */
  const els = [
    { offset: 0, top: 0 },
    { offset: 120, top: 400 },
    { offset: 300, top: 900 },
  ];

  it('无标题返回 null，未越过阈值时高亮第一个', () => {
    expect(activeHeadingOffset([], 0)).toBeNull();
    expect(activeHeadingOffset(els, 0)).toBe(0);
  });

  it('视口顶部 96px 阈值上方最近的标题胜出', () => {
    /* top=400 在 scrollTop=304 时恰好触及阈值（400 = 304 + 96） */
    expect(activeHeadingOffset(els, 303)).toBe(0);
    expect(activeHeadingOffset(els, 304)).toBe(120);
    expect(activeHeadingOffset(els, 803)).toBe(120);
    expect(activeHeadingOffset(els, 804)).toBe(300);
  });

  it('滚过最后标题后保持最后一个', () => {
    expect(activeHeadingOffset(els, 5000)).toBe(300);
  });
});
