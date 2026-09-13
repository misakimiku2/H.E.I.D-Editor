/**
 * 网址导入 Markdown：defuddle 提取正文 + turndown(GFM) 转 Markdown。
 * 提取前先做 DOM 结构化重写与表格规整（lib/domStructure）；defuddle 返回空内容时
 * 走正文容器兜底梯子。转换库全部动态 import（懒加载 chunk）。
 * 纯函数（地址补全 / 文件名 / 头部元信息块 / 标题消毒）可单测；importFrom*
 * 依赖 DOMParser，仅在浏览器运行时调用。
 */
import { rt } from './i18nContext';
import { structuralizeDoc, normalizeTables, extractMainContent, collectTabGroups, type TabGroupEntry } from './domStructure';

/** 平台渲染兜底的结果结构（lib/renderFetch） */
interface RenderedPage {
  html: string;
  finalUrl: string;
  /** 渲染页面时用户实际可见的文本（body.innerText），用于核算提取覆盖率 */
  visibleText?: string;
}

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
  /** 页面标题（defuddle 提取 + 消毒） */
  title: string;
  /** 站名 / 域名 */
  site: string;
  /** 头部元信息块 + 正文 Markdown */
  markdown: string;
  /** 正文 Markdown（不含头部元信息块），供静态/渲染结果择优 */
  bodyMd: string;
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

/** 标题消毒：提取器可能把 HTML 标签带进标题（如 MediaWiki 的 mw-page-title-main），剥掉并折叠空白 */
export function sanitizeTitle(raw: string): string {
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 共享的 turndown 实例构造：GFM 规则 */
function makeTurndown(TurndownService: any, gfmPlugin: any) {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  gfmPlugin.gfm(turndown);
  return turndown;
}

interface ConvertedDoc {
  title: string;
  site: string;
  bodyMd: string;
}

/** 提取正文并转换为 Markdown（浏览器运行时；依赖 DOMParser） */
async function convertHtml(html: string, pageUrl: string): Promise<ConvertedDoc> {
  const [{ default: Defuddle }, { default: TurndownService }, gfmPlugin] = await Promise.all([
    import('defuddle'),
    import('turndown'),
    import('turndown-plugin-gfm'),
  ]);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  /* 结构化重写 + 表格规整先于提取：div 伪表格 / colgroup 表格修复成语义结构 */
  structuralizeDoc(doc);
  normalizeTables(doc);

  /* 相对图片地址先补全为绝对地址（在提取/转换前改 DOM） */
  doc.querySelectorAll('img[src]').forEach(img => {
    const raw = img.getAttribute('src') ?? '';
    img.setAttribute('src', resolveImageUrl(raw, pageUrl));
  });

  /* 页签图组配对（在图片地址补全后收集，src 与最终 markdown 一致） */
  const tabGroups = collectTabGroups(doc);

  const parsed = new Defuddle(doc, { url: pageUrl }).parse();
  const site = (parsed.site ?? parsed.domain ?? '').trim();
  const turndown = makeTurndown(TurndownService, gfmPlugin);

  const contentHtml = parsed.content ?? '';
  let bodyMd = contentHtml.trim() ? turndown.turndown(contentHtml).trim() : '';

  /* defuddle 空手而归（如 MediaWiki 移动版皮肤）：正文容器兜底梯子 */
  if (!bodyMd) {
    const fallbackHtml = extractMainContent(doc);
    if (fallbackHtml.trim()) {
      try {
        bodyMd = turndown.turndown(fallbackHtml).trim();
      } catch {
        bodyMd = '';
      }
    }
  }
  if (!bodyMd) {
    throw new Error(rt('import.errNoContent'));
  }
  bodyMd = insertTabMarkers(bodyMd, tabGroups);

  let title = sanitizeTitle(parsed.title ?? '');
  if (!title) title = sanitizeTitle(doc.title ?? '');
  if (!title) {
    const h1 = doc.querySelector('h1');
    if (h1) title = sanitizeTitle(h1.textContent ?? '');
  }
  return { title, site, bodyMd };
}

/**
 * 把 tab 配对按图片 src 回插为 markdown 注释标记（defuddle 会剥掉 DOM 里的
 * 注释与自定义属性，故在 markdown 层回插）。图片定位失败（被提取丢弃）时跳过。
 */
export function insertTabMarkers(bodyMd: string, groups: TabGroupEntry[][]): string {
  let md = bodyMd;
  let cursor = 0;
  for (const group of groups) {
    for (const entry of group) {
      if (!entry.imgSrc) continue;
      const i = md.indexOf(entry.imgSrc, cursor);
      if (i < 0) continue;
      const imgStart = md.lastIndexOf('![', i);
      if (imgStart < 0) continue;
      const lineStart = md.lastIndexOf('\n', imgStart) + 1;
      const marker = `<!-- tab:${entry.label} -->\n\n`;
      md = md.slice(0, lineStart) + marker + md.slice(lineStart);
      cursor = lineStart + marker.length;
    }
  }
  return md;
}

/** 提取正文并转换为带元信息头的完整 Markdown */
export async function importFromHtml(html: string, pageUrl: string): Promise<UrlImportResult> {
  const { title, site, bodyMd } = await convertHtml(html, pageUrl);
  return {
    title,
    site,
    markdown: makeHeaderBlock(title, pageUrl, new Date()) + bodyMd,
    bodyMd,
    filename: markdownFilename(title, site),
  };
}

/** 全文兜底转换：跳过 defuddle 的选根，直接用剔除噪音容器后的全部内容 */
async function convertLadder(html: string, pageUrl: string): Promise<ConvertedDoc> {
  const [{ default: TurndownService }, gfmPlugin] = await Promise.all([
    import('turndown'),
    import('turndown-plugin-gfm'),
  ]);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  structuralizeDoc(doc);
  normalizeTables(doc);
  doc.querySelectorAll('img[src]').forEach(img => {
    const raw = img.getAttribute('src') ?? '';
    img.setAttribute('src', resolveImageUrl(raw, pageUrl));
  });
  const tabGroups = collectTabGroups(doc);
  const contentHtml = extractMainContent(doc);
  if (!contentHtml.trim()) {
    throw new Error(rt('import.errNoContent'));
  }
  const turndown = makeTurndown(TurndownService, gfmPlugin);
  const bodyMd = insertTabMarkers(turndown.turndown(contentHtml).trim(), tabGroups);
  if (!bodyMd) {
    throw new Error(rt('import.errNoContent'));
  }
  let title = sanitizeTitle(doc.title ?? '');
  if (!title) {
    const h1 = doc.querySelector('h1');
    if (h1) title = sanitizeTitle(h1.textContent ?? '');
  }
  return { title, site: '', bodyMd };
}

/** 全文兜底转换的完整导出（含元信息头） */
export async function importFromHtmlDeep(html: string, pageUrl: string): Promise<UrlImportResult> {
  const { title, site, bodyMd } = await convertLadder(html, pageUrl);
  return {
    title,
    site,
    markdown: makeHeaderBlock(title, pageUrl, new Date()) + bodyMd,
    bodyMd,
    filename: markdownFilename(title, site),
  };
}

/** 提取结果对渲染页面可见文本的覆盖率：按非空行采样，markdown 链接语法还原为文本后匹配 */
export function markdownCoverage(visibleText: string, md: string): number {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const mdNorm = norm(
    md.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'),
  );
  const lines = [...new Set(visibleText.split('\n').map(l => norm(l)).filter(l => l.length >= 10))];
  if (lines.length === 0) return 1;
  const sample = lines.length > 300 ? lines.filter((_, i) => i % Math.ceil(lines.length / 300) === 0) : lines;
  const hit = sample.filter(l => mdNorm.includes(l.slice(0, 20))).length;
  return hit / sample.length;
}

/** 正文达到该长度即认为静态结果足够好，不再触发渲染兜底 */
const GOOD_ENOUGH_BODY = 500;

/** 覆盖率低于该值视为 defuddle 丢失了可见内容，改用全文兜底提取 */
const MIN_COVERAGE = 0.5;

/** 转换器注入点：测试用桩替换 defuddle/全文兜底，不依赖其内部实现 */
export interface ImportConverters {
  convert?: (html: string, pageUrl: string) => Promise<UrlImportResult>;
  convertDeep?: (html: string, pageUrl: string) => Promise<UrlImportResult>;
}

/**
 * 静态抓取结果的导入编排：转换静态 HTML；正文过短或转换失败时触发渲染兜底；
 * 渲染结果按可见文本覆盖率核算，defuddle 丢内容时改用全文兜底并择优；
 * 渲染失败静默回退静态结果；两者皆空抛 errNoContent。
 */
export async function importFromFetched(
  staticHtml: string,
  pageUrl: string,
  render: () => Promise<RenderedPage | null>,
  onPhase?: (phase: 'static' | 'rendering') => void,
  converters?: ImportConverters,
): Promise<UrlImportResult> {
  const convert = converters?.convert ?? importFromHtml;
  const convertDeep = converters?.convertDeep ?? importFromHtmlDeep;
  onPhase?.('static');
  let best: UrlImportResult | null = null;
  try {
    best = await convert(staticHtml, pageUrl);
    if (best.bodyMd.length >= GOOD_ENOUGH_BODY) return best;
  } catch {
    best = null;
  }
  onPhase?.('rendering');
  let renderNote = '';
  try {
    const rendered = await render();
    if (rendered?.html) {
      try {
        let alt = await convert(rendered.html, rendered.finalUrl);
        /* 覆盖率核算：defuddle 有时会选择性丢掉页面可见的大块内容（如 SPA 的
           语音/标签页面板）。可见文本覆盖率过低时改用全文兜底提取并择优。 */
        if (rendered.visibleText) {
          const cov = markdownCoverage(rendered.visibleText, alt.bodyMd);
          if (cov < MIN_COVERAGE) {
            try {
              const deep = await convertDeep(rendered.html, rendered.finalUrl);
              if (markdownCoverage(rendered.visibleText, deep.bodyMd) > cov) alt = deep;
            } catch {
              /* 全文兜底失败：保留 defuddle 结果 */
            }
          }
        }
        if (!best || alt.bodyMd.length > best.bodyMd.length) best = alt;
      } catch {
        /* 渲染结果转换失败：保留静态结果 */
      }
    }
  } catch (e) {
    renderNote = String((e as Error)?.message ?? e);
    /* 渲染兜底失败：回退静态结果 */
  }
  if (!best) {
    throw new Error(renderNote ? `${rt('import.errNoContent')}（渲染兜底未成功：${renderNote}）` : rt('import.errNoContent'));
  }
  return best;
}
