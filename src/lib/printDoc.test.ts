// @vitest-environment jsdom
/** 打印文档构建纯函数：行号文本 / CSV 表格 / 标题转义。iframe 打印链路手工验收。 */
import { describe, expect, it } from 'vitest';
import { buildCsvPrintHtml, buildPlainPrintHtml } from './printDoc';

describe('buildPlainPrintHtml', () => {
  it('行号与转义、外框含标题与 @page', () => {
    const html = buildPlainPrintHtml('a<b>', 'let x = 1;\nconst s = "<i>";');
    expect(html).toContain('<title>a&lt;b&gt;</title>');
    expect(html).toContain('@page');
    expect(html).toContain('<span class="ln">1</span>');
    expect(html).toContain('let x = 1;');
    expect(html).toContain('&lt;i&gt;');
    expect(html).not.toContain('<i>');
  });

  it('空行保留占位（flex 行不塌陷）', () => {
    const html = buildPlainPrintHtml('t', 'a\n\nb');
    expect((html.match(/class="line"/g) ?? []).length).toBe(3);
  });
});

describe('buildCsvPrintHtml', () => {
  it('首行表头 th、其余 td，单元格内换线转 <br>', () => {
    const html = buildCsvPrintHtml('t', [['h1', 'h2'], ['a', 'b\nc']], { headerOn: true });
    expect(html).toContain('<th>h1</th>');
    expect(html).toContain('<td>b<br>c</td>');
  });

  it('headerOn=false 全部 td', () => {
    const html = buildCsvPrintHtml('t', [['a', 'b']], { headerOn: false });
    expect(html).toContain('<td>a</td>');
    expect(html).not.toContain('<th>');
  });
});
