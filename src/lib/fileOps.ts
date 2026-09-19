/**
 * 文件树管理操作与剪贴板的平台封装（动态 import，不进主包）：
 * - 文件管理（新建/重命名/删除/复制/资源管理器中显示）：桌面走自定义 Tauri 命令；
 *   安卓走 HeidBridge 的 SAF 树内桥（createInTree/renameEntry/deleteEntry，
 *   v1.4 补齐新建/重命名/删除；剪切移动与复制暂不提供，UI 侧置灰）；
 * - 剪贴板读写：Tauri 内走 plugin-clipboard-manager（WebView 自带
 *   navigator.clipboard.readText 在 WebView2 默认拒绝权限），浏览器走原生 API。
 */
import { IS_ANDROID_APP } from './platform';

export const isTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 文件树管理操作当前环境是否可用（桌面 Tauri / 安卓 SAF 桥；纯浏览器不可用） */
export const treeManageAvailable = isTauriRuntime;

/** SAF 树内路径分隔符（与 fileTree.ts 的 SAF_SEP 同源约定）：
    目录路径 = treeUri\0相对路径，文件路径 = 完整 document URI（content://…） */
const SAF_SEP = '\u0000';

function safBridge(): any | null {
  if (!IS_ANDROID_APP) return null;
  const bridge = (window as any).HeidBridge;
  return bridge?.createInTree ? bridge : null;
}

/** 取路径末段作为条目名（SAF 目录路径以 '/' 分层；桌面路径由调用方自行 join） */
function lastSegmentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut >= 0 ? path.slice(cut + 1) : path;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function fsMkdir(path: string): Promise<void> {
  const bridge = safBridge();
  if (bridge) {
    const name = lastSegmentOf(path);
    const parentDir = path.slice(0, path.length - name.length - 1);
    const uri = bridge.createInTree(parentDir, name, true);
    if (!uri) throw new Error('SAF create rejected');
    return;
  }
  return invoke('fs_mkdir', { path });
}

/** 新建空文件并返回实际可用的路径：安卓为新建文档的 content URI（桌面=传入路径） */
export async function fsCreateEmptyFile(path: string): Promise<string> {
  const bridge = safBridge();
  if (bridge) {
    const name = lastSegmentOf(path);
    const parentDir = path.slice(0, path.length - name.length - 1);
    const uri = bridge.createInTree(parentDir, name, false);
    if (!uri) throw new Error('SAF create rejected');
    return uri;
  }
  const { writeLocalPath } = await import('./fileIO');
  await writeLocalPath(path, '', 'utf-8', false);
  return path;
}

/** 重命名（桌面/安卓目录=改名不移动），返回生效后的新路径：
    安卓文件为提供器确认后的新 content URI（旧 URI 随改名失效，标签页需跟进）。 */
export async function fsRename(from: string, to: string): Promise<string> {
  const bridge = safBridge();
  if (bridge) {
    const newName = IS_ANDROID_APP && !from.startsWith('content://')
      ? lastSegmentOf(to)
      : to; /* 安卓文件的 to 由前端 joinPath(parent, name) 得出，parentPathOf(content://) 为空 → to 即新名 */
    const newUri = bridge.renameEntry(from, newName);
    if (!newUri) throw new Error('SAF rename rejected');
    return from.startsWith('content://') ? newUri : to;
  }
  await invoke('fs_rename', { from, to });
  return to;
}

export async function fsCopy(from: string, to: string): Promise<void> {
  if (IS_ANDROID_APP) throw new Error('SAF copy unsupported'); /* UI 侧置灰，不应到达 */
  return invoke('fs_copy', { from, to });
}

export async function fsDelete(path: string, _isDir: boolean): Promise<void> {
  const bridge = safBridge();
  if (bridge) {
    if (!bridge.deleteEntry(path)) throw new Error('SAF delete rejected');
    return;
  }
  return invoke('fs_delete', { path, isDir: _isDir });
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

/**
 * 浏览器剪贴板读取权限的只读查询（不触发授权弹窗）。
 * navigator.clipboard.readText 在权限为 prompt 时必然弹「查看剪贴板」授权框，
 * 探测/降级判断一律走本查询；Firefox 等不支持该查询名时返回 'unknown'。
 */
export async function clipboardReadPermissionState(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
  try {
    const st = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
    return (st?.state as 'granted' | 'prompt' | 'denied') ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
