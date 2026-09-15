/**
 * Markdown 图片本地化：收集 `![…](http…)` 远程图源，逐张经 Rust `http_get_binary`
 * 下载并写入 <文档目录>/assets/remote-<hash>.<ext>，全文替换为相对路径。
 * 结果走 updateTabContent（可撤销）。收集 / 命名 / 替换为纯函数可单测；
 * 网络与落盘经注入的 io 接口隔离，编排层错误逐张跳过并计数。
 */

/** 单文档处理上限：防御整页图床（sprite 之类的极端场景）拖垮会话 */
export const LOCALIZE_MAX_IMAGES = 50;

export interface RemoteImage {
  url: string;
  /** 出现次数（含同一 URL 多处引用） */
  count: number;
}

/** 收集 markdown 里的远程图片地址（唯一化，保留出现顺序） */
export function collectRemoteImages(md: string): RemoteImage[] {
  const re = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  const counts = new Map<string, number>();
  for (const m of md.matchAll(re)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([url, count]) => ({ url, count }));
}

/** URL → 8 位无符号 hash（FNV-1a）：稳定命名，同一 URL 重复本地化覆盖为同一名 */
export function hashUrl8(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 下载内容 → 落盘扩展名：content-type 优先，回退 URL 路径段，最后 png */
export function extOfDownload(contentType: string, url: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('bmp')) return 'bmp';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('x-icon')) return 'ico';
  const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  const m = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.exec(seg);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
}

/** 全文替换：url → 相对路径（仅替换图片语法里的精确地址） */
export function replaceImageUrl(md: string, url: string, rel: string): string {
  const esc = url.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(!\\[[^\\]]*\\]\\(\\s*)${esc}((?:\\s+"[^"]*")?\\s*\\))`, 'g');
  return md.replace(re, (_all, head, tail) => `${head}${rel}${tail}`);
}

/** 单张下载结果（io 返回） */
export interface DownloadIoResult {
  base64: string;
  contentType: string;
}

/** 编排层的 io 接口：测试注入桩，运行时实现为 Tauri invoke + plugin-fs 写盘 */
export interface LocalizeIo {
  download(url: string): Promise<DownloadIoResult>;
  save(relPath: string, bytes: Uint8Array): Promise<void>;
}

export interface LocalizeOutcome {
  /** 替换后的全文（零成功时与原文相同） */
  md: string;
  ok: string[];
  failed: { url: string; reason: string }[];
  /** 达到上限被跳过的张数 */
  skipped: number;
}

/**
 * 逐张本地化：每张独立 try（失败跳过计数），全部结果汇总返回。
 * saveDirIo 决定落盘位置——调用方传「目录」由 io 拼绝对路径（assets/ 前缀已含在 relPath）。
 */
export async function localizeRemoteImages(md: string, io: LocalizeIo): Promise<LocalizeOutcome> {
  const all = collectRemoteImages(md);
  const targets = all.slice(0, LOCALIZE_MAX_IMAGES);
  const skipped = all.length - targets.length;
  let out = md;
  const ok: string[] = [];
  const failed: { url: string; reason: string }[] = [];
  for (const { url } of targets) {
    try {
      const dl = await io.download(url);
      const bin = atob(dl.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const rel = `assets/remote-${hashUrl8(url)}.${extOfDownload(dl.contentType, url)}`;
      await io.save(rel, bytes);
      out = replaceImageUrl(out, url, rel);
      ok.push(url);
    } catch (e: any) {
      failed.push({ url, reason: String(e?.message ?? e) });
    }
  }
  return { md: out, ok, failed, skipped };
}
