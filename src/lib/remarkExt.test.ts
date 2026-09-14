/**
 * markdown 扩展语法（预览渲染用）：
 *   ==高亮== / ^上标^ / ~下标~ 在 mdast 文本节点上拆分，代码/公式不参与；
 *   组装版 GFM 关掉单波浪线删除线，把 ~ 让给下标（~~保留删除线）。
 */
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { remarkGfmStrict, remarkInlineExt } from './remarkExt';

const proc = (plugins: unknown[]) => unified().use(remarkParse).use(plugins as never);

const run = async (md: string, plugins: unknown[] = [remarkInlineExt]) => {
  const p = proc(plugins) as any;
  return p.run(p.parse(md));
};

const findType = (node: any, type: string): any => {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const hit = findType(child, type);
    if (hit) return hit;
  }
  return null;
};

describe('remarkInlineExt', () => {
  it('==高亮== 拆分为 mark（hName: mark）', async () => {
    const tree = await run('前缀 ==高亮== 后缀');
    const mark = findType(tree, 'mark');
    expect(mark).not.toBeNull();
    expect(mark.data.hName).toBe('mark');
    expect(mark.children[0].value).toBe('高亮');
  });

  it('^上标^ 与 ~下标~ 分别映射 sup/sub', async () => {
    const tree = await run('x^2^ 与 H~2~O');
    expect(findType(tree, 'superscript')?.data.hName).toBe('sup');
    expect(findType(tree, 'subscript')?.data.hName).toBe('sub');
  });

  it('内侧空白不成对（a == b 不高亮），无配对的 ^ 保持字面量', async () => {
    const tree = await run('a == b 与 x^2');
    expect(findType(tree, 'mark')).toBeNull();
    expect(findType(tree, 'superscript')).toBeNull();
  });

  it('代码与行内代码里的标记不参与', async () => {
    const tree = await run('`==x==` 与\n\n```\n==y==\n```');
    expect(findType(tree, 'mark')).toBeNull();
  });

  it('组装版 GFM：~~双波浪~~仍是删除线，单波浪线成为下标', async () => {
    const tree = await run('~~删除~~ 与 ~下标~', [remarkGfmStrict, remarkInlineExt]);
    expect(findType(tree, 'delete')).not.toBeNull();
    expect(findType(tree, 'subscript')).not.toBeNull();
  });

  it('==red:文字== 携带色板类名，未知前缀按普通文本默认高亮', async () => {
    const tree = await run('==red:重点== 与 ==foo:怪==');
    const marks: any[] = [];
    (function collect(n: any) {
      if (n.type === 'mark') marks.push(n);
      n.children?.forEach(collect);
    })(tree);
    expect(marks).toHaveLength(2);
    expect(marks[0].data.hProperties.className).toEqual(['md-mark-red']);
    expect(marks[0].children[0].value).toBe('重点');
    expect(marks[1].data.hProperties).toBeUndefined();
    expect(marks[1].children[0].value).toBe('foo:怪');
  });

  it('经 remark-rehype 转换后输出带类名的 <mark> 元素', async () => {
    const { default: remarkRehype } = await import('remark-rehype');
    const p = proc([remarkInlineExt, remarkRehype]) as any;
    const hast = await p.run(p.parse('==red:x=='));
    let mark: any = null;
    (function find(n: any) {
      if (mark) return;
      if (n.type === 'element' && n.tagName === 'mark') { mark = n; return; }
      n.children?.forEach(find);
    })(hast);
    expect(mark).not.toBeNull();
    expect(mark.properties.className).toEqual(['md-mark-red']);
  });
});
