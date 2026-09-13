import { describe, expect, it } from 'vitest';
import { makeHeaderBlock, markdownFilename, resolveImageUrl, sanitizeTitle } from './urlImport';

describe('resolveImageUrl', () => {
  it('相对地址按页面 URL 补全为绝对地址', () => {
    expect(resolveImageUrl('img/a.png', 'https://example.com/post/1')).toBe('https://example.com/post/img/a.png');
    expect(resolveImageUrl('/img/a.png', 'https://example.com/post/1')).toBe('https://example.com/img/a.png');
  });

  it('已是绝对 http(s) 或 data: 地址时原样返回', () => {
    expect(resolveImageUrl('https://cdn.example.com/a.png', 'https://example.com/x')).toBe('https://cdn.example.com/a.png');
    expect(resolveImageUrl('data:image/png;base64,AAAA', 'https://example.com/x')).toBe('data:image/png;base64,AAAA');
  });

  it('非法相对串按相对路径解析，函数不抛错', () => {
    // WHATWG URL 规范：非绝对串均按相对路径处理
    expect(resolveImageUrl('::bad::', 'https://example.com/x')).toBe('https://example.com/::bad::');
    expect(() => resolveImageUrl('%zz', 'https://example.com/x')).not.toThrow();
  });
});

describe('markdownFilename', () => {
  it('优先使用标题，补 .md 扩展名', () => {
    expect(markdownFilename('Hello World', 'example.com')).toBe('Hello World.md');
  });

  it('标题为空时回退站名', () => {
    expect(markdownFilename('  ', 'example.com')).toBe('example.com.md');
  });

  it('过滤文件名非法字符', () => {
    expect(markdownFilename('a/b\\c:d*e?f"g<h>i|j', 'example.com')).toBe('a b c d e f g h i j.md');
  });

  it('超长标题截断到 80 字符', () => {
    const long = 'x'.repeat(200);
    const name = markdownFilename(long, 'example.com');
    expect(name.length).toBeLessThanOrEqual(83); // 80 + ".md"
    expect(name.endsWith('.md')).toBe(true);
  });
});

describe('makeHeaderBlock', () => {
  it('包含标题 / 来源 / ISO 抓取时间三行引用', () => {
    const time = new Date('2026-09-13T08:00:00Z');
    const block = makeHeaderBlock('My Post', 'https://example.com/post', time);
    expect(block).toContain('My Post');
    expect(block).toContain('https://example.com/post');
    expect(block).toContain('2026-09-13');
    expect(block.startsWith('> ')).toBe(true);
    expect(block.endsWith('\n\n')).toBe(true);
  });
});

describe('sanitizeTitle', () => {
  it('剥离标题中的 HTML 标签', () => {
    expect(sanitizeTitle('<span class="mw-page-title-main">主人公(女神异闻录3)</span>')).toBe('主人公(女神异闻录3)');
  });

  it('折叠多余空白并去除首尾空格', () => {
    expect(sanitizeTitle('  一   二  ')).toBe('一 二');
  });

  it('空标题保持为空', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('<b></b>')).toBe('');
  });
});
