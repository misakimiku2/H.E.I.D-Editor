/**
 * markdown 多语言/页签切换：`<!-- lang:标签 -->` 或 `<!-- tab:标签 -->` 注释把
 * 文档切分为多个可切换区块，预览顶部出现切换标签。GitHub 式的 HTML/CSS 切换
 * 在我们预览中不可用（原始 HTML 被安全剥离），因此采用标记约定 + 预览原生渲染；
 * 抓取端（lib/domStructure R8）会把「标签组 + 等量图片面板」重写为 tab: 标记。
 */
import { describe, expect, it } from 'vitest';
import { splitLangSections } from './markdownLangs';

describe('splitLangSections', () => {
  it('两个及以上 lang 标记切分为多个区块', () => {
    const md = '前言部分\n\n<!-- lang:中文 -->\n\n中文正文\n\n<!-- lang:English -->\n\nEnglish body';
    expect(splitLangSections(md)).toEqual([
      { label: '中文', md: '前言部分\n\n中文正文' },
      { label: 'English', md: 'English body' },
    ]);
  });

  it('tab: 前缀同样识别（抓取端页签标记）', () => {
    const md = '<!-- tab:基础信息 -->\n![](a.png)\n<!-- tab:编队立绘 -->\n![](b.png)';
    expect(splitLangSections(md)).toEqual([
      { label: '基础信息', md: '![](a.png)' },
      { label: '编队立绘', md: '![](b.png)' },
    ]);
  });

  it('标记写法容忍空白差异', () => {
    const md = '<!--lang:日本語-->\n日本語の本文\n<!-- lang: English -->\nEnglish';
    expect(splitLangSections(md)).toEqual([
      { label: '日本語', md: '日本語の本文' },
      { label: 'English', md: 'English' },
    ]);
  });

  it('少于两个标记返回 null（不进入切换模式）', () => {
    expect(splitLangSections('普通文档')).toBeNull();
    expect(splitLangSections('只有 <!-- lang:中文 --> 一个标记')).toBeNull();
  });

  it('标记前的引导内容并入第一个区块', () => {
    const md = '共享开头\n<!-- lang:A -->\nA 内容\n<!-- lang:B -->\nB 内容';
    const sections = splitLangSections(md)!;
    expect(sections[0].md).toContain('共享开头');
    expect(sections[0].md).toContain('A 内容');
    expect(sections[1].md).toBe('B 内容');
  });
});
