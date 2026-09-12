/**
 * 网址导入 Markdown：defuddle 提取正文 + turndown(GFM) 转 Markdown。
 * 纯函数（地址补全 / 文件名 / 头部元信息块）可单测；importFromHtml 依赖
 * DOMParser，仅在浏览器运行时调用。转换库全部动态 import（懒加载 chunk）。
 */
import { rt } from './i18nContext';

/** http_get 命令的返回结构（Rust HttpGetResult） */
export interface UrlFetchResult {
  status: number;
  final_url: string;
  content_type: string;
  text: string;
  encoding: string;
  bom: boolean;
  lossy: boolean;
}

export interface UrlImportResult {
  /** 页面标题（defuddle 提取） */
  title: string;
  /** 站名 / 域名 */
  site: string;
  /** 头部元信息块 + 正文 Markdown */
  markdown: string;
  /** 建议的新标签页文件名 */
  filename: string;
}

/** 相对图片地址按最终页面 URL 补全；绝对 / data: 地址原样返回，无法解析也原样返回 */
export function resolveImageUrl(src: string, baseUrl: string): string {
  if (!src) return src;
  if (/^(https?:|data:)/i.test(src)) return src;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

/** 新标签页文件名：标题优先、站名回退；过滤文件名非法字符并限长 */
export function markdownFilename(title: string, domain: string): string {
  const raw = (title.trim() || domain.trim() || 'import').replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = (raw.length > 80 ? raw.slice(0, 80).trimEnd() : raw) || 'import';
  return `${base}.md`;
}

/** 头部元信息块：> 标题 / 来源 / 抓取时间，末尾空行与正文分隔 */
export function makeHeaderBlock(title: string, url: string, fetchedAt: Date): string {
  const iso = fetchedAt.toISOString().slice(0, 19).replace('T', ' ');
  return [
    `> **${rt('import.headerTitle')}**：${title || '—'}`,
    `> **${rt('import.headerSource')}**：${url}`,
    `> **${rt('import.headerTime')}**：${iso}`,
    '',
    '',
  ].join('\n');
}

/** 提取正文并转换为 Markdown（浏览器运行时；依赖 DOMParser） */
export async function importFromHtml(html: string, pageUrl: string): Promise<UrlImportResult> {
  const [{ default: Defuddle }, { default: TurndownService }, gfmPlugin] = await Promise.all([
    import('defuddle'),
    import('turndown'),
    import('turndown-plugin-gfm'),
  ]);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  /* 相对图片地址先补全为绝对地址（在提取/转换前改 DOM） */
  doc.querySelectorAll('img[src]').forEach(img => {
    const raw = img.getAttribute('src') ?? '';
    img.setAttribute('src', resolveImageUrl(raw, pageUrl));
  });

  const parsed = new Defuddle(doc, { url: pageUrl }).parse();
  const title = (parsed.title ?? '').trim();
  const site = (parsed.site ?? parsed.domain ?? '').trim();
  const contentHtml = parsed.content ?? '';
  if (!contentHtml.trim()) {
    throw new Error(rt('import.errNoContent'));
  }

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  gfmPlugin.gfm(turndown);
  const bodyMd = turndown.turndown(contentHtml).trim();

  return {
    title,
    site,
    markdown: makeHeaderBlock(title, pageUrl, new Date()) + bodyMd,
    filename: markdownFilename(title, site),
  };
}
