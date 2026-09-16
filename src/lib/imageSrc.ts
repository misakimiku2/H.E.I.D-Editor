/**
 * 图片地址解析（Markdown 预览与独立图片查看器共用）：
 * 本地绝对/相对路径经 plugin-fs 读取为 blob URL（模块级缓存，同一文件不重复读盘），
 * 读取失败回退 asset 协议 convertFileSrc；http(s)/data/blob/content 协议直接返回。
 * 浏览器（无 Tauri）模式下本地路径会抛错，远程图片不受影响。
 */

const imageCache = new Map<string, string>();

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon',
};

/** plugin-fs 明确拒绝（权限不足），与普通读取失败区分提示 */
export class ImageForbiddenError extends Error {}

/** 图片 URL 协议前缀（这些不参与本地路径拼接） */
const REMOTE_RE = /^(https?:|data:|blob:|content:)/i;
/** Windows 盘符 / UNC / Unix 绝对路径 */
const ABSOLUTE_PATH_RE = /^([a-zA-Z]:[\\/]|\\\\|\/)/;

/**
 * 归一 markdown 图片 src 为可读取的本地路径或原样 URL：
 * - http(s)/data/blob/content 原样返回（直接给 <img>）；
 * - `file:///` 前缀剥离并百分号解码（插入弹窗写入的是 encodeURI 后的 URL）；
 * - 其余（`C:\...` 绝对 / `assets/...` 相对）原样返回，交给 joinRelativeSrc 拼基准目录。
 * 旧文档的 `|||LOCAL-FILE:` alt 标记在 MarkdownImage 里优先于此函数。
 */
export function normalizeLocalSrc(src: string): string {
  if (!src) return '';
  if (REMOTE_RE.test(src)) return src;
  let p = src.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/+/i, '');
    try { p = decodeURIComponent(p); } catch { /* 含孤立 % 时保留原样 */ }
  } else if (/%[0-9a-f]{2}/i.test(p) && !/\\/.test(p)) {
    /* 插入弹窗 encodeURI 过的路径（含 %20 等且不是 Windows 反斜杠原路径）：解码还原 */
    try { p = decodeURIComponent(p); } catch { /* 保留原样 */ }
  }
  /* Windows 盘符路径统一反斜杠（fs 插件对混合分隔符的读取会失败） */
  if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\');
  return p;
}

/**
 * Markdown 相对图片地址（`assets/x.png`）与文档目录拼接为可读的绝对路径。
 * 协议地址与绝对路径原样返回；无 baseDir（未保存文档）返回原值（后续按现状报错）。
 * 分隔符跟随 baseDir（Windows 目录拼 `\`，Unix 拼 `/`）——fs 插件对混合分隔符
 * 路径的读取会失败，必须产出与文件选择器一致的原生路径。
 */
export function joinRelativeSrc(src: string, baseDir?: string): string {
  const raw = normalizeLocalSrc(src);
  if (!raw || REMOTE_RE.test(raw) || ABSOLUTE_PATH_RE.test(raw)) return raw;
  if (!baseDir) return raw;
  const dir = baseDir.replace(/[\\/]+$/, '');
  if (!dir) return raw;
  const sep = dir.includes('\\') ? '\\' : '/';
  const rel = raw.replace(/^(?:\.{1,2}[\\/])+/, '').replace(/\//g, sep);
  return `${dir}${sep}${rel}`;
}

/** 解析为可直接给 <img> 使用的 URL；失败抛错（权限不足抛 ImageForbiddenError） */
export async function resolveImageSrc(src: string): Promise<string> {  if (!src || /^(https?:|data:|blob:|content:)/.test(src)) return src;
  const cached = imageCache.get(src);
  if (cached) return cached;
  const { readFile } = await import('@tauri-apps/plugin-fs');
  try {
    const data = await readFile(src);
    const ext = src.split('.').pop()?.toLowerCase() || 'png';
    const blob = new Blob([new Uint8Array(data)], { type: MIME_MAP[ext] || 'image/png' });
    const url = URL.createObjectURL(blob);
    imageCache.set(src, url);
    return url;
  } catch (err: any) {
    if (String(err?.message || err).includes('forbidden')) throw new ImageForbiddenError();
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const p = /^[A-Za-z]:/.test(src) ? '/' + src.replace(/\\/g, '/') : src;
      const result = convertFileSrc(p);
      if (result && result.length > 0) {
        imageCache.set(src, result);
        return result;
      }
    } catch { /* 回退也失败 */ }
    throw new Error('image load failed');
  }
}
