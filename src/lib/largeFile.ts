/**
 * 大文件分层路由（第二层 32~512MB 只读分块预览）：
 * 尺寸分类与 Rust 侧 large_file 模块的 invoke 封装收敛在此。
 * 阈值与 src-tauri/src/large_file.rs 的 LARGE_FILE_MAX_BYTES 保持一致。
 */
import { isTauri } from './fileIO';

/** 第一层上限：≤ 该字节数正常打开可编辑 */
export const LARGE_FILE_EDIT_MAX_BYTES = 32 * 1024 * 1024;
/** 第三层上限：> 该字节数拒绝打开 */
export const LARGE_FILE_MAX_BYTES = 512 * 1024 * 1024;

export type FileSizeClass = 'edit' | 'preview' | 'reject';

/** 按字节数分三层：edit 正常编辑 / preview 只读分块预览 / reject 拒绝 */
export function classifyBySize(sizeBytes: number): FileSizeClass {
  if (sizeBytes <= LARGE_FILE_EDIT_MAX_BYTES) return 'edit';
  if (sizeBytes <= LARGE_FILE_MAX_BYTES) return 'preview';
  return 'reject';
}

/** Rust 错误串 FILE_TOO_LARGE:{size} → 字节数（第三层拒绝时弹窗显示实际尺寸） */
export function parseFileTooLarge(err: string): number | null {
  const m = /^FILE_TOO_LARGE:(\d+)$/.exec(err);
  return m ? Number(m[1]) : null;
}

/** 字节数人性化显示（probe 信息栏） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 滚动条代理映射：scrollTop → 首个可视条目下标（行号或字节行）。
 * 文档总高不超浏览器布局上限时等价 scrollTop / LINE_H 的连续映射；
 * 超限后滚动条按比例压缩（同类编辑器处理超大文档的通行做法），
 * 滚轮步进会随文档变大而「加速」，换来滚动高度恒有界。
 */
export function firstVisibleIndex(
  scrollTop: number, maxScroll: number, totalItems: number, viewportItems: number,
): number {
  if (maxScroll <= 0 || totalItems <= viewportItems) return 0;
  const frac = Math.min(1, Math.max(0, scrollTop / maxScroll));
  return Math.min(totalItems - 1, Math.round(frac * (totalItems - viewportItems)));
}

export interface LargeFileInfo {
  sizeBytes: number;
  totalLines: number;
  encoding: string;
  bom: boolean;
  binary: boolean;
}

export interface LineWindow {
  startLine: number;
  lines: string[];
  /** 与 lines 等长：该行超过字节截断阈值被截断 */
  truncated: boolean[];
  endOffset: number;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 查文件字节数（打开前的分层路由判定；非 Tauri 桌面环境返回 null） */
export async function fileSize(path: string): Promise<number | null> {
  if (!isTauri) return null;
  try {
    return await invoke<number>('file_size', { path });
  } catch {
    return null;
  }
}

/** 探测大文件：行数 / 编码 / 二进制判定；错误串原样抛出供 parseFileTooLarge 判定 */
export async function probeLargeFile(path: string, force?: string): Promise<LargeFileInfo> {
  return invoke<LargeFileInfo>('probe_large_file', { path, force: force ?? null });
}

/** 按行窗口读取（行边界对齐，内存中只有可视窗口） */
export async function readLineWindow(path: string, startLine: number, maxLines: number): Promise<LineWindow> {
  return invoke<LineWindow>('read_line_window', { path, startLine, maxLines });
}

/** 按字节区间读取（十六进制视图） */
export async function readByteWindow(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
  return invoke<number[]>('read_byte_window', { path, offset, maxBytes }).then(b => new Uint8Array(b));
}
