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
    expect(html).toContain('const x = 1;');
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
