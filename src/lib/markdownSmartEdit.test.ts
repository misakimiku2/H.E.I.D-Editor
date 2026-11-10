import { describe, it, expect } from 'vitest';
import { linkPasteInsert, toggleTaskAtOffset } from './markdownSmartEdit';

describe('linkPasteInsert 选中粘贴 URL', () => {
  it('http(s) URL 包裹选区', () => {
    expect(linkPasteInsert('https://example.com', 'text')).toBe('[text](https://example.com)');
    expect(linkPasteInsert('http://a.b/c?d=1', 'nikke')).toBe('[nikke](http://a.b/c?d=1)');
  });

  it('www 开头补 https://', () => {
    expect(linkPasteInsert('www.example.com', 'text')).toBe('[text](https://www.example.com)');
  });

  it('mailto/xmpp 保持内置原有支持', () => {
    expect(linkPasteInsert('mailto:a@b.c', 'text')).toBe('[text](mailto:a@b.c)');
    expect(linkPasteInsert('xmpp:a@b.c', 'text')).toBe('[text](xmpp:a@b.c)');
  });

  it('首尾空白先 trim', () => {
    expect(linkPasteInsert('  https://a.b \n', 'text')).toBe('[text](https://a.b)');
  });

  it('非 URL 不包裹', () => {
    expect(linkPasteInsert('ftp://a.b', 'text')).toBeNull();
    expect(linkPasteInsert('hello world', 'text')).toBeNull();
    expect(linkPasteInsert('https://a.b\nc', 'text')).toBeNull();
    expect(linkPasteInsert('', 'text')).toBeNull();
  });

  it('选区为空/多行/含方括号不包裹', () => {
    expect(linkPasteInsert('https://a.b', '')).toBeNull();
    expect(linkPasteInsert('https://a.b', 'a\nb')).toBeNull();
    expect(linkPasteInsert('https://a.b', 'a]b')).toBeNull();
    expect(linkPasteInsert('https://a.b', '[a')).toBeNull();
  });
});

describe('toggleTaskAtOffset 预览 checkbox 回写', () => {
  it('未勾变勾', () => {
    expect(toggleTaskAtOffset('- [ ] a', 0)).toBe('- [x] a');
  });

  it('已勾变未勾（含大写 X）', () => {
    expect(toggleTaskAtOffset('- [x] a', 0)).toBe('- [ ] a');
    expect(toggleTaskAtOffset('- [X] a', 0)).toBe('- [ ] a');
  });

  it('嵌套与有序任务列表', () => {
    expect(toggleTaskAtOffset('  - [ ] a', 0)).toBe('  - [x] a');
    expect(toggleTaskAtOffset('1. [ ] a', 0)).toBe('1. [x] a');
  });

  it('偏移落在行内任意位置都定位到该行', () => {
    expect(toggleTaskAtOffset('- [ ] abc', 6)).toBe('- [x] abc');
  });

  it('多行文档只改目标行', () => {
    const src = '# t\n\n- [ ] a\n- [x] b\n';
    expect(toggleTaskAtOffset(src, src.indexOf('- [x]'))).toBe('# t\n\n- [ ] a\n- [ ] b\n');
  });

  it('非任务行/过期偏移返回 null', () => {
    expect(toggleTaskAtOffset('- plain', 0)).toBeNull();
    expect(toggleTaskAtOffset('# heading', 0)).toBeNull();
    expect(toggleTaskAtOffset('text\n- [ ] a', 0)).toBeNull();
  });
});