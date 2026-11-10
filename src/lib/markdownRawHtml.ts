/**
 * 预览中的原始 HTML：rehype-raw 解析 + rehype-sanitize 清洗。
 * 网址导入的正文常夹带裸 <br>/<u>/<details> 等标签，react-markdown 默认把
 * 原始 HTML 当纯文本显示（预览里直接冒出 "<br>"）。清洗沿用 GFM 白名单，
 * 脚本、事件属性、javascript: 链接、内联样式一律去掉，再补少量无害的排版标签。
 */
import { defaultSchema } from 'rehype-sanitize';

/** 是否含原始 HTML 标签（注释不算——它们由 remarkStripHtmlComments 提前移除）。
    没有原始标签的文档可以跳过 rehype-raw，大文件解析开销大幅下降；清洗仍保留 */
const RAW_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;

export function hasRawHtml(md: string): boolean {
  return RAW_TAG_RE.test(md);
}

/** GFM 白名单之外的常见排版标签（均无脚本能力） */
const EXTRA_TAGS = [
  'u', 'mark', 'small', 'big', 'cite', 'dfn', 'abbr', 'time',
  'figure', 'figcaption', 'address', 'article', 'aside', 'header',
  'footer', 'main', 'nav', 'center', 'font',
];

export const rawHtmlSanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  /* remark-rehype 已给脚注 id 加过 user-content- 前缀；sanitize 再前缀一次
     会让脚注正文的锚点与跳转链接对不上，这里保留原有单次前缀 */
  clobberPrefix: '',
  tagNames: [...(defaultSchema.tagNames ?? []), ...EXTRA_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    /* ==red:高亮== 等扩展依赖 mark 上的 md-mark-* 类名着色 */
    mark: [['className', /^md-mark-/]],
  },
  /* style 标签不在白名单，若按普通元素拆掉，CSS 文本会漏成可见正文 */
  strip: [...(defaultSchema.strip ?? []), 'style'],
  protocols: {
    ...defaultSchema.protocols,
    /* 本地图片 file:///、内嵌图片 data: 与应用自有协议照常放行 */
    src: ['http', 'https', 'file', 'data', 'blob', 'content'],
  },
};
