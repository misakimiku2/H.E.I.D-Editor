/**
 * 预览本地 Markdown 链接解析：相对地址按文档目录补全，支持 %编码、#锚点、../ 与 file:///。
 * 非 Markdown 文件、外链与缺少基准目录的相对地址返回 null（保持原守卫的拦截行为）。
 */
import { describe, expect, it } from 'vitest';
import { resolveMarkdownLinkPath } from './markdownLinks';

describe('resolveMarkdownLinkPath', () => {
  it('Windows 文档目录 + 相对链接', () => {
    expect(resolveMarkdownLinkPath('第01章_坠落.md', 'C:\\Users\\me\\剧情'))
      .toBe('C:\\Users\\me\\剧情\\第01章_坠落.md');
  });

  it('百分号编码、#锚点与 ?查询', () => {
    expect(resolveMarkdownLinkPath('%E7%AC%AC01%E7%AB%A0.md#开头', 'C:\\docs'))
      .toBe('C:\\docs\\第01章.md');
    expect(resolveMarkdownLinkPath('第01章.md?raw=1', 'C:\\docs'))
      .toBe('C:\\docs\\第01章.md');
  });

  it('../ 向上跳目录，. 与重复分隔符折叠', () => {
    expect(resolveMarkdownLinkPath('../目录/第02章.md', 'C:\\a\\b'))
      .toBe('C:\\a\\目录\\第02章.md');
    expect(resolveMarkdownLinkPath('./子目录/./x.md', 'C:\\a\\b'))
      .toBe('C:\\a\\b\\子目录\\x.md');
  });

  it('子文件夹：多级目录、斜杠方向、中文与空格目录都能拼接', () => {
    expect(resolveMarkdownLinkPath('剧情/第一章/第01章.md', 'C:\\docs'))
      .toBe('C:\\docs\\剧情\\第一章\\第01章.md');
    expect(resolveMarkdownLinkPath('%E5%89%A7%E6%83%85/%E7%AC%AC01%E7%AB%A0.md', 'C:\\docs'))
      .toBe('C:\\docs\\剧情\\第01章.md');
    expect(resolveMarkdownLinkPath('剧情\\第 1 章.md', 'C:\\docs'))
      .toBe('C:\\docs\\剧情\\第 1 章.md');
    expect(resolveMarkdownLinkPath('..\\外传/第04章.md', 'C:\\a\\b'))
      .toBe('C:\\a\\外传\\第04章.md');
  });

  it('绝对路径与 file:/// 地址', () => {
    expect(resolveMarkdownLinkPath('D:/docs/x.md', 'C:\\a')).toBe('D:\\docs\\x.md');
    expect(resolveMarkdownLinkPath('file:///C:/docs/x.md', 'C:\\a')).toBe('C:\\docs\\x.md');
  });

  it('Unix 文档目录保持正斜杠', () => {
    expect(resolveMarkdownLinkPath('../b/x.md', '/home/me/a')).toBe('/home/me/b/x.md');
    expect(resolveMarkdownLinkPath('/opt/docs/x.md', '/home/me/a')).toBe('/opt/docs/x.md');
  });

  it('不处理外链、锚点、非 Markdown 文件与缺基准目录的相对地址', () => {
    expect(resolveMarkdownLinkPath('https://example.com/a.md')).toBeNull();
    expect(resolveMarkdownLinkPath('mailto:a@b.c')).toBeNull();
    expect(resolveMarkdownLinkPath('#章节')).toBeNull();
    expect(resolveMarkdownLinkPath('图片.png', 'C:\\docs')).toBeNull();
    expect(resolveMarkdownLinkPath('x.md')).toBeNull();
  });
});
