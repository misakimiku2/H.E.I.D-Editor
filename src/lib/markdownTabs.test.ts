/**
 * 页签内容变换：整段选区→一个页签；紧邻已关闭的页签组时并排追加为同组新页签；
 * 图片右键「设为页签」按同一逻辑逐张并排成组
 * （回归用例对应真实事故：并组时旧结束标记只被削掉 `<!`，
 *   在预览里留下可见的 `-- /tab -->` 文本）。
 */
import { describe, expect, it } from 'vitest';
import { applyImageTab, applySelectionTab, spliceSelectionTab } from './markdownTabs';

const IMG1 = '![](https://x/1.png)';
const IMG2 = '![](https://x/2.png)';
const IMG3 = '![](https://x/3.png)';

describe('applySelectionTab：文字选区转页签', () => {
  it('整段选区包成一个页签：首行短文本作标签并从内容移除，前后紧贴时补空行', () => {
    const content = '成熟稳重的精英人形……\n\n职业：防卫\n\n稀有度：标准人形\n\n异位属性：物理';
    const start = content.indexOf('职业');
    const end = content.indexOf('物理') + '物理'.length;
    expect(applySelectionTab(content, start, end)).toBe(
      '成熟稳重的精英人形……\n\n<!-- tab:职业：防卫 -->\n\n稀有度：标准人形\n\n异位属性：物理\n\n<!-- /tab -->',
    );
  });

  it('紧邻上一个已关闭的页签组：并排追加为同组新页签，旧结束标记保留作组尾', () => {
    const content = [
      '成熟稳重的精英人形……',
      '',
      '<!-- tab:职业：防卫 -->',
      '',
      '稀有度：标准人形',
      '',
      '<!-- /tab -->',
      '',
      '武器类型：突击步枪',
      '',
      '小队归属：闪电小队',
    ].join('\n');
    const start = content.indexOf('武器类型');
    const end = content.indexOf('闪电小队') + '闪电小队'.length;
    const out = applySelectionTab(content, start, end);
    expect(out).toBe(
      [
        '成熟稳重的精英人形……',
        '',
        '<!-- tab:职业：防卫 -->',
        '',
        '稀有度：标准人形',
        '',
        '<!-- tab:武器类型：突击步枪 -->',
        '',
        '小队归属：闪电小队',
        '',
        '<!-- /tab -->',
      ].join('\n'),
    );
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('隔正文的选区另起新组（不并入前面的组）', () => {
    const content = '<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n说明文字\n\n乙内容一\n\n乙内容二';
    const start = content.indexOf('乙内容一');
    const end = content.length;
    expect(applySelectionTab(content, start, end)).toBe(
      '<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n说明文字\n\n<!-- tab:乙内容一 -->\n\n乙内容二\n\n<!-- /tab -->',
    );
  });

  it('文档末尾的选区（无尾随换行）也能成组；标签回退全局编号', () => {
    const content = '<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n![](a.png)';
    expect(applySelectionTab(content, content.indexOf('![]'), content.length)).toBe(
      '<!-- tab:甲 -->\n\n甲内容\n\n<!-- tab:页签2 -->\n\n![](a.png)\n\n<!-- /tab -->',
    );
  });

  it('空白选区原样返回', () => {
    expect(spliceSelectionTab('head\n\n', '  \n\n', 'tail')).toEqual({ head: 'head\n\n', slice: '  \n\n', tail: 'tail' });
  });
});

describe('applyImageTab：图片设为页签', () => {
  it('首图：包成独立页签组，前后紧贴上文时补空行', () => {
    const content = `基础资料\n\n${IMG1}\n\n${IMG2}`;
    const out = applyImageTab(content, content.indexOf(IMG1), content.indexOf(IMG1) + IMG1.length);
    expect(out).toBe(`基础资料\n\n<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n${IMG2}`);
  });

  it('相邻图并排追加为同组新页签：旧结束标记完整保留，不残留碎片', () => {
    const content = `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n${IMG2}\n\n${IMG3}`;
    const out = applyImageTab(content, content.indexOf(IMG2), content.indexOf(IMG2) + IMG2.length);
    expect(out).toBe(`<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- tab:页签2 -->\n\n${IMG2}\n\n<!-- /tab -->\n\n${IMG3}`);
    /* 不残留断裂的标记行（-- /tab --> 之类） */
    expect(out).not.toMatch(/^--\s*\/\s*tab/m);
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('隔正文的图另起新组（不并入前面的组）', () => {
    const content = `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n说明文字\n\n${IMG2}`;
    const out = applyImageTab(content, content.indexOf(IMG2), content.indexOf(IMG2) + IMG2.length);
    expect(out).toBe(
      `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n说明文字\n\n<!-- tab:页签2 -->\n\n${IMG2}\n\n<!-- /tab -->`,
    );
  });

  it('文档末尾的图（无尾随换行）也能成组', () => {
    const content = `前言\n\n${IMG1}`;
    const out = applyImageTab(content, content.indexOf(IMG1), content.indexOf(IMG1) + IMG1.length);
    expect(out).toBe(`前言\n\n<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->`);
  });

  it('连续三张图逐张并排进同一组，标签顺延', () => {
    let content = `${IMG1}\n\n${IMG2}\n\n${IMG3}`;
    const pos = (img: string) => ({ start: content.indexOf(img), end: content.indexOf(img) + img.length });
    const p1 = pos(IMG1);
    content = applyImageTab(content, p1.start, p1.end);
    const p2 = pos(IMG2);
    content = applyImageTab(content, p2.start, p2.end);
    const p3 = pos(IMG3);
    content = applyImageTab(content, p3.start, p3.end);
    expect(content).toBe(
      `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- tab:页签2 -->\n\n${IMG2}\n\n<!-- tab:页签3 -->\n\n${IMG3}\n\n<!-- /tab -->`,
    );
    expect((content.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });
});
