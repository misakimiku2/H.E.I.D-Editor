import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from './markdownHtml';

/* 预热：Prism 高亮是 renderMarkdownToHtml 内部的动态 import（刻意不进主包），冷启动时
   首次加载 + vite 转译要好几秒。全量跑 71 个测试文件各起一个 worker 抢 CPU 时，
   第一个用例就会撞上 5s 默认超时（v1.4.1 触屏批次实测复现过一次，单跑永远绿）。
   先在这里把这条 import 链跑一遍，测的是同一份产物、只是不赶时间 */
await renderMarkdownToHtml('```js\n0\n```', { title: 'warmup', dark: false });

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
