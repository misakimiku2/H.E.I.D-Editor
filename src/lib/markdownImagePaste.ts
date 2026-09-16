/**
 * Markdown 粘贴图片落盘（桌面）/ data URI 回退（浏览器）：
 * 剪贴板里的 image/* 文件写入 <文档目录>/assets/paste-时间戳.扩展名，
 * 返回相对路径（'/' 分隔）供编辑器插入 `![](相对路径)`；
 * 预览侧经 MarkdownPreview 的 baseDir 拼回绝对路径读取。
 * 命名 / 扩展名推断为纯函数可单测；落盘依赖 Tauri 命令与 plugin-fs。
 */

/** MIME → 扩展名（常见图片类型；未知类型回退 png） */
export function extFromMime(mime: string, fallback = 'png'): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.includes('svg')) return 'svg';
  if (m.includes('bmp')) return 'bmp';
  if (m.includes('x-icon')) return 'ico';
  if (m.includes('avif')) return 'avif';
  return fallback;
}

/** 落盘文件名主体：paste-YYYYMMDD-HHmmss（本地时间，秒级冲突由调用方 -n 消解） */
export function pasteImageStem(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `paste-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 文档目录 → assets 子目录：分隔符跟随 docDir（Windows 拼反斜杠，fs 插件读写才认原生路径） */
export function assetsDirOf(docDir: string): string {
  const dir = docDir.replace(/[\\/]+$/, '');
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}assets`;
}

/** 浏览器模式回退：Blob → data: URI（超 2MB 拒绝，防止文档被巨型 base64 撑爆） */
export const DATA_URI_MAX_BYTES = 2 * 1024 * 1024;

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read blob failed'));
    fr.readAsDataURL(blob);
  });
}

/** 剪贴板事件里的首个图片文件（无则 null） */
export function imageFileFromClipboard(items: DataTransferItemList | null | undefined): File | null {
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      return item.getAsFile();
    }
  }
  return null;
}

/**
 * 桌面落盘：写 <docDir>/assets/paste-时间戳(-n).扩展名，返回相对路径 assets/…。
 * 文件名秒级冲突时追加 -2、-3…（同秒连贴多图）。
 */
export async function savePastedImage(blob: Blob, mime: string, docDir: string, now = new Date()): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const dir = assetsDirOf(docDir);
  await invoke('fs_mkdir', { path: dir });
  const ext = extFromMime(mime);
  const stem = pasteImageStem(now);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  /* 同秒连贴多图：候选名 paste-x → paste-x-2 → paste-x-3…（createNew 保证不覆盖既有文件）。
     写盘路径用原生分隔符（dir 已按 docDir 风格拼好）；插入 markdown 的相对路径恒为 assets/…（/ 分隔） */
  const sep = dir.includes('\\') ? '\\' : '/';
  const candidates = [stem, ...Array.from({ length: 30 }, (_, i) => `${stem}-${i + 2}`)];
  for (const name of candidates) {
    try {
      await writeFile(`${dir}${sep}${name}.${ext}`, bytes, { createNew: true });
      return `assets/${name}.${ext}`;
    } catch {
      /* 已存在则试下一个序号 */
    }
  }
  /* 32 个候选全撞（异常场景）：放弃防覆盖，直接写入首个候选名 */
  await writeFile(`${dir}${sep}${stem}.${ext}`, bytes);
  return `assets/${stem}.${ext}`;
}

/** 剪贴板 RGBA 像素 → PNG Blob（Tauri readImage 只给原始像素，经 canvas 编码） */
export async function rgbaToPngBlob(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob | null> {
  if (!rgba || width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

/**
 * 受管理的本地图片：只有本应用生成进 assets/ 的文件名（paste-时间戳 / remote-urlhash）
 * 才允许「从文档删除后自动清理」，用户手工引用的其他图片一律不动。
 */
const MANAGED_ASSET_RE = /^assets\/(?:paste-\d{8}-\d{6}(?:-\d+)?|remote-[0-9a-f]{8})\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** 收集 markdown 里引用的受管理图片（相对路径口径） */
export function collectManagedImages(md: string): Set<string> {
  const out = new Set<string>();
  const re = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of md.matchAll(re)) {
    if (MANAGED_ASSET_RE.test(m[1])) out.add(m[1]);
  }
  return out;
}

/** 编辑后消失的受管理图片（旧引用 − 新引用；撤销写回则不算消失） */
export function removedManagedImages(oldMd: string, newMd: string): string[] {
  const before = collectManagedImages(oldMd);
  if (before.size === 0) return [];
  const after = collectManagedImages(newMd);
  return Array.from(before).filter(u => !after.has(u));
}

/**
 * 剪贴板当前是否为图片（右键菜单据此在「粘贴 / 粘贴 图片」间切换标签）。
 * 桌面：先读文本（有文字即非图片，Windows 剪贴板单一内容），再试读图（无图抛错）；
 * 浏览器：navigator.clipboard.read 看类型。任何失败按非图片处理。
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      const text = await readText();
      if (text && text.length > 0) return false;
      const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
      await readImage();
      return true;
    }
    if (!navigator.clipboard?.read) return false;
    const items = await navigator.clipboard.read();
    return items.some(i => i.types.some(t => t.startsWith('image/')));
  } catch {
    return false;
  }
}
