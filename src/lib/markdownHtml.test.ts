import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './markdownHtml';

describe('renderMarkdownToHtml', () => {
  it('产出单文件 HTML：doctype / charset / title / 标题与行内格式', async () => {
    const html = await renderMarkdownToHtml('# 标题\n\n**bold** text', { title: 'T1', dark: false });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html.toLowerCase()).toContain('charset="utf-8"');
    expect(html).toContain('<title>T1</title>');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('GFM 表格转换为 <table>', async () => {
    const html = await renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |', { title: 'T', dark: false });
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('围栏代码块转换为 <pre><code>', async () => {
    const html = await renderMarkdownToHtml('```js\nconst x = 1;\n```', { title: 'T', dark: false });
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    /* 着色后内容被 span 拆分，按片段断言 */
    expect(html).toContain('language-js');
    expect(html).toContain('const');
  });

  it('带语言标注的代码块输出语法着色（内联 style 的 token span）', async () => {
    const html = await renderMarkdownToHtml('```ts\nconst x: number = 1;\n```', { title: 'T', dark: false });
    expect(html).toContain('class="code-block"');
    /* ghcolors 主题的 token 色以内联 style 出现 */
    expect(html).toMatch(/class="token" style="color:#/);
  });

  it('无语言代码块不着色（普通 pre，不做行内误判）', async () => {
    const html = await renderMarkdownToHtml('```\nplain code\n```', { title: 'T', dark: false });
    expect(html).toContain('plain code');
    expect(html).not.toContain('class="code-block"');
  });

  it('行内代码维持 <code> 不走代码块样式', async () => {
    const html = await renderMarkdownToHtml('文字 `inline()` 结尾', { title: 'T', dark: false });
    expect(html).toContain('<code>inline()</code>');
    expect(html).not.toContain('class="code-block"');
  });

  it('title 中的 HTML 字符被转义', async () => {
    const html = await renderMarkdownToHtml('x', { title: '<b>&', dark: false });
    expect(html).toContain('<title>&lt;b&gt;&amp;</title>');
  });

  it('深浅色主题产出不同背景色', async () => {
    const light = await renderMarkdownToHtml('x', { title: 'T', dark: false });
    const dark = await renderMarkdownToHtml('x', { title: 'T', dark: true });
    expect(light).toContain('#ffffff');
    expect(dark).not.toContain('#ffffff');
  });
});
