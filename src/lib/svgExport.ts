/**
 * SVG → PNG 导出：sanitize 后的序列化文本 → blob URL → Image → 离屏 canvas 按倍率绘制。
 * Tauri 下经原生 save 对话框落盘（二进制写入），浏览器走 <a download>；
 * 复制走异步剪贴板（image/png）。canvas / 剪贴板为浏览器运行时能力，jsdom 不可测，保持薄胶水。
 */

/** 导出文件名：去扩展名追加 @Nx.png（1 倍不标注） */
export function pngFileName(title: string, scale: number): string {
  const base = title.replace(/\.[^./\\]+$/, '');
  const mark = scale === 1 ? '' : `@${scale}x`;
  return `${base}${mark}.png`;
}

/** 序列化 SVG 文本渲染为 PNG blob（透明背景；scale ≤ 0 视为 1） */
export async function renderSvgPng(svgText: string, scale: number): Promise<Blob | null> {
  const k = Math.max(1, scale || 1);
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    return await new Promise<Blob | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width || 300) * k));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height || 150) * k));
          const ctx = canvas.getContext('2d')!;
          ctx.scale(k, k);
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(b => resolve(b), 'image/png');
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 落盘：Tauri 原生 save 对话框（二进制），否则浏览器下载。返回是否成功/已完成 */
export async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
  const data = new Uint8Array(await blob.arrayBuffer());
  try {
    const { isTauri } = await import('./fileIO');
    if (isTauri) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const target = await save({ defaultPath: filename });
      if (!target) return false;
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      await writeFile(target, data);
      return true;
    }
  } catch { /* 非 Tauri 或插件缺失 → 走下载 */ }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/** 复制 PNG 到剪贴板（需要异步剪贴板支持） */
export async function copyBlobPng(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
