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

/** 文档目录 → assets 子目录（'/' 拼接，读取端对反斜杠同样接受） */
export function assetsDirOf(docDir: string): string {
  return `${docDir.replace(/[\\/]+$/, '')}/assets`;
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
  /* 同秒连贴多图：候选名 paste-x → paste-x-2 → paste-x-3…（createNew 保证不覆盖既有文件） */
  const candidates = [stem, ...Array.from({ length: 30 }, (_, i) => `${stem}-${i + 2}`)];
  for (const name of candidates) {
    try {
      await writeFile(`${dir}/${name}.${ext}`, bytes, { createNew: true });
      return `assets/${name}.${ext}`;
    } catch {
      /* 已存在则试下一个序号 */
    }
  }
  /* 32 个候选全撞（异常场景）：放弃防覆盖，直接写入首个候选名 */
  await writeFile(`${dir}/${stem}.${ext}`, bytes);
  return `assets/${stem}.${ext}`;
}
