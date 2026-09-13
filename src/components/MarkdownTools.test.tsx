// @vitest-environment jsdom
/**
 * markdown 快捷格式化的页签操作：预览/源码编辑器右键菜单共用的
 * tabGroup / tabStart / tabEnd / tabClear 转换（提取失败后的人工修复入口）。
 */
import { describe, expect, it } from 'vitest';
import { transformSlice } from './MarkdownTools';

describe('transformSlice：页签操作', () => {
  it('tabGroup：首个短文本行作标签并从内容移除，末段补结束标记', () => {
    const slice = '常态攻击\n进行最多3段的连续攻击。';
    const out = transformSlice(
      { kind: 'tabGroup' }, slice, '', undefined, { index: 0, total: 2 },
    );
    expect(out).toBe('<!-- tab:常态攻击 -->\n\n进行最多3段的连续攻击。');
  });

  it('tabGroup：图片块无文本行，用序号兜底；最后一段补 <!-- /tab -->', () => {
    const slice = '![](https://x/a.png)';
    const out = transformSlice(
      { kind: 'tabGroup' }, slice, '', undefined, { index: 2, total: 3 },
    );
    expect(out).toBe('<!-- tab:页签3 -->\n\n![](https://x/a.png)\n\n<!-- /tab -->');
  });

  it('tabGroup：非末段不带结束标记；单行块标签复用后内容保留', () => {
    const out = transformSlice(
      { kind: 'tabGroup' }, '第一段内容', '', undefined, { index: 0, total: 2 },
    );
    expect(out).toBe('<!-- tab:第一段内容 -->\n\n第一段内容');
  });

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
