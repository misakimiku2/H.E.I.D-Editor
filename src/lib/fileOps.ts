/**
 * 文件树管理操作与剪贴板的平台封装（动态 import，不进主包）：
 * - 文件管理（新建目录/重命名/复制/删除/资源管理器中显示）走自定义 Tauri 命令，
 *   仅桌面可用 —— 安卓 SAF 桥没有对应能力，前端据此隐藏入口；
 * - 剪贴板读写：Tauri 内走 plugin-clipboard-manager（WebView 自带
 *   navigator.clipboard.readText 在 WebView2 默认拒绝权限），浏览器走原生 API。
 */
import { IS_ANDROID_APP } from './platform';

export const isTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 文件树管理操作当前环境是否可用（桌面 Tauri；安卓 SAF / 纯浏览器不可用） */
export const treeManageAvailable = isTauriRuntime && !IS_ANDROID_APP;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function fsMkdir(path: string): Promise<void> {
  return invoke('fs_mkdir', { path });
}

export function fsRename(from: string, to: string): Promise<void> {
  return invoke('fs_rename', { from, to });
}

export function fsCopy(from: string, to: string): Promise<void> {
  return invoke('fs_copy', { from, to });
}

export function fsDelete(path: string, isDir: boolean): Promise<void> {
  return invoke('fs_delete', { path, isDir });
}

export function fsReveal(path: string): Promise<void> {
  return invoke('fs_reveal', { path });
}

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriRuntime) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime) {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    return await readText();
  }
  return navigator.clipboard.readText();
}
