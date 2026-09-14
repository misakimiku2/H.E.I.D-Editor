/**
 * markdown 扩展语法（预览渲染用，react-markdown 的 remarkPlugins 调用）：
 *   ==高亮==  → <mark>
 *   ^上标^    → <sup>
 *   ~下标~    → <sub>
 * 表格/任务列表/删除线(~~)/自动链接/脚注由组装版 GFM 提供——这里刻意关掉
 * 单波浪线删除线（remark-gfm 默认开启），把 ~ 让给下标。
 * 拆分发生在 mdast 文本节点上（解析之后），代码块/行内代码/公式不参与；
 * 自定义节点通过 data.hName 映射为标准 HTML 元素，react-markdown 直接渲染。
 */
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

/* 高亮支持的色板：==文字== 默认黄，==red:文字== 等带颜色前缀（冒号分隔，
 * 不用 | 以免和表格单元格冲突）。md-mark-<色> 类名由预览样式着色 */
export const MARK_COLORS = ['yellow', 'red', 'orange', 'green', 'blue', 'purple'] as const;

interface InlineRule {
  type: string;
  tag: string;
  re: RegExp;
}

/* 内容首尾不允许空白、不允许出现定界符本身（==…== 中间不能有 =） */
const INLINE_RULES: InlineRule[] = [
  { type: 'mark', tag: 'mark', re: /==([^=\s](?:[^=]*[^=\s])?)==/g },
  { type: 'superscript', tag: 'sup', re: /\^([^\^\s](?:[^\^]*[^\^\s])?)\^/g },
  { type: 'subscript', tag: 'sub', re: /~([^~\s](?:[^~]*[^~\s])?)~/g },
];

/* mark 内容的 "颜色:" 前缀；未知颜色视作普通文本（整段按默认色高亮） */
function markColorOf(content: string): { color: string; text: string } {
  const m = /^([a-z]+):(.+)$/.exec(content);
  if (m && (MARK_COLORS as readonly string[]).includes(m[1])) {
    return { color: m[1], text: m[2] };
  }
  return { color: '', text: content };
}

/* 组装版 GFM：与 remark-gfm 等价，但单波浪线不再是删除线 */
export function remarkGfmStrict(this: any): undefined {
  const data = this.data();
  /* micromark 阶段（singleTilde:false）与 mdast 阶段各注入一次 */
  data.micromarkExtensions = (data.micromarkExtensions || []).concat(gfm({ singleTilde: false }));
  data.fromMarkdownExtensions = (data.fromMarkdownExtensions || []).concat(gfmFromMarkdown());
  return undefined;
}

/* 在一段文本里找最早命中的扩展语法；无命中返回 null */
function earliestHit(value: string): { start: number; end: number; content: string; rule: InlineRule } | null {
  let best: { start: number; end: number; content: string; rule: InlineRule } | null = null;
  for (const rule of INLINE_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(value))) {
      if (!best || m.index < best.start) {
        best = { start: m.index, end: m.index + m[0].length, content: m[1], rule };
      }
      if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
  }
  return best;
}

/* 递归拆分文本节点，命中处替换为 hName 映射的元素节点 */
function splitInline(value: string): unknown[] {
  const hit = earliestHit(value);
  if (!hit) return [{ type: 'text', value }];
  let node: Record<string, unknown>;
  if (hit.rule.type === 'mark') {
    const { color, text } = markColorOf(hit.content);
    node = {
      type: 'mark',
      data: {
        hName: 'mark',
        ...(color ? { hProperties: { className: [`md-mark-${color}`] } } : {}),
      },
      children: [{ type: 'text', value: text }],
    };
  } else {
    node = {
      type: hit.rule.type,
      data: { hName: hit.rule.tag },
      children: [{ type: 'text', value: hit.content }],
    };
  }
  const rest = value.slice(hit.end);
  const head = value.slice(0, hit.start);
  return [
    ...(head ? [{ type: 'text', value: head }] : []),
    node,
    ...(rest ? splitInline(rest) : []),
  ];
}

/* 不参与行内扩展的子树：代码与公式按字面量处理 */
const LITERAL_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath']);

function transformInlineExt(node: any): void {
  if (!Array.isArray(node.children)) return;
  const next: unknown[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...splitInline(child.value));
    } else if (!LITERAL_TYPES.has(child.type)) {
      transformInlineExt(child);
      next.push(child);
    } else {
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkInlineExt(this: any) {
  return (tree: unknown) => transformInlineExt(tree);
}
