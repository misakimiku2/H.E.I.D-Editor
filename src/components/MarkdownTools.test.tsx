// @vitest-environment jsdom
/**
 * markdown 快捷格式化的页签操作：预览/源码编辑器右键菜单共用的
 * tabStart / tabEnd / tabClear 转换（选区→页签的变换见 lib/markdownTabs）。
 */
import { describe, expect, it } from 'vitest';
import { transformSlice, footnoteEdit } from './MarkdownTools';

describe('transformSlice：扩展行内包裹', () => {
  it('mark / sup / sub / math 走 INLINE_WRAPS 包裹', () => {
    expect(transformSlice({ kind: 'mark' }, '重点', '重点')).toBe('==重点==');
    expect(transformSlice({ kind: 'mark', color: 'blue' }, '重点', '重点')).toBe('==blue:重点==');
    expect(transformSlice({ kind: 'sup' }, 'x2', '2')).toBe('x^2^');
    expect(transformSlice({ kind: 'sub' }, 'H2O', '2')).toBe('H~2~O');
    expect(transformSlice({ kind: 'math' }, 'E=mc^2', 'E=mc^2')).toBe('$E=mc^2$');
  });

  it('mark：选区内已带高亮时换色/取消，而不是嵌套', () => {
    const marked = '==red:重点==';
    expect(transformSlice({ kind: 'mark', color: 'blue' }, marked, '重点')).toBe('==blue:重点==');
    expect(transformSlice({ kind: 'mark', color: 'red' }, marked, '重点')).toBe('重点');
    expect(transformSlice({ kind: 'mark' }, marked, '重点')).toBe('==重点==');
    expect(transformSlice({ kind: 'mark' }, '==重点==', '重点')).toBe('重点');
  });

  it('footnoteEdit：标记插在选中文本后，文末追加定义行', () => {
    const content = '正文文字\n\n结尾';
    const fe = footnoteEdit(content, { start: 0, end: 4 }, '文字');
    expect(fe.marker).toBe('[^1]');
    expect(fe.markerAt).toBe(4);
    expect(fe.def).toBe('\n\n[^1]: ');
    expect(fe.defAt).toBe(content.length);
    const next = content.slice(0, fe.markerAt) + fe.marker
      + content.slice(fe.markerAt, fe.defAt) + fe.def + content.slice(fe.defAt);
    expect(next).toBe('正文文字[^1]\n\n结尾\n\n[^1]: ');
  });

  it('footnoteEdit：已有脚注时编号顺延', () => {
    const content = '前[^1]\n\n[^1]: 旧定义\n\n后一段落';
    const fe = footnoteEdit(content, { start: content.indexOf('后'), end: content.length }, '后一段落');
    expect(fe.marker).toBe('[^2]');
    expect(fe.def).toBe('\n\n[^2]: ');
  });
});

describe('transformSlice：页签操作', () => {
  it('tabStart / tabEnd：插入页签头尾标记', () => {
    expect(transformSlice({ kind: 'tabStart' }, '![](a.png)', ''))
      .toBe('<!-- tab:标签 -->\n\n![](a.png)');
    expect(transformSlice({ kind: 'tabEnd' }, '![](a.png)\n', ''))
      .toBe('![](a.png)\n\n<!-- /tab -->');
  });

  it('tabClear：移除选区内的页签/语言标记行并收敛空行', () => {
    const slice = '前言\n\n<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n<!-- lang:乙 -->\n乙内容';
    const out = transformSlice({ kind: 'tabClear' }, slice, '');
    expect(out).not.toContain('<!--');
    expect(out).toContain('前言');
    expect(out).toContain('甲内容');
    expect(out).toContain('乙内容');
    expect(out).not.toMatch(/\n{3,}/);
  });
});
