/**
 * 文件树管理操作与剪贴板的平台封装（动态 import，不进主包）：
 * - 文件管理（新建/重命名/删除/复制/资源管理器中显示）：桌面走自定义 Tauri 命令；
 *   安卓走 HeidBridge 的 SAF 树内桥（createInTree/renameEntry/deleteEntry，
 *   v1.4 补齐新建/重命名/删除；剪切移动与复制暂不提供，UI 侧置灰）；
 *   **连着的那台电脑**那棵树走链路（`create` / `mkdir` 两条远程命令），
 *   重命名/删除/复制那几条协议里没有，在这里拦下来（见 [`remoteUnsupported`]）；
 * - 剪贴板读写：Tauri 内走 plugin-clipboard-manager（WebView 自带
 *   navigator.clipboard.readText 在 WebView2 默认拒绝权限），浏览器走原生 API。
 */
import { IS_ANDROID_APP } from './platform';
import {
  RemoteError, isRemotePath, makeRemotePath, parseRemotePath, remoteCreate, remoteMkdir,
} from './remote';

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

/**
 * 远程路径 → `{deviceId, rel}`（`hide-remote://<设备>/<相对共享根的路径>`）。
 * 不是远程路径返回 null；带远程前缀却解析不出来（编码坏掉）时报错，
 * 因为那意味着树上这一行的身份键本身坏了 —— 静默当本地路径处理会往手机上写东西。
 */
function remoteRefOf(path: string): { deviceId: string; rel: string } | null {
  if (!isRemotePath(path)) return null;
  const ref = parseRemotePath(path);
  if (!ref) throw new RemoteError('badpath', '电脑上那个条目的路径读不出来，先刷新一次树');
  return ref;
}

/**
 * 协议里没有的那几条（重命名 / 删除 / 复制 / 在资源管理器中显示）。
 *
 * 必须在前端就拦下来：让它们落到 SAF 桥那一支，桥会把 `hide-remote://…` 当树内路径去拆
 * `treeUri\0相对路径`，拆不出分隔符就当整串是 treeUri，最后报一句「SAF rename rejected」——
 * 那句话既不是原因也不是用户能做的事（2026-10-04 在手机上点开电脑那棵树新建就撞过这一刀）。
 * `unsupported` 是**永久**码：它不在 `LINK_DOWN_CODES` 里，绝不能被离线队列当成"等重连再试"。
 */
function remoteUnsupported(what: string): RemoteError {
  return new RemoteError('unsupported', `电脑上的文件还不支持${what}，请在电脑上操作`);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function fsMkdir(path: string): Promise<void> {
  /* 远程分支判在 SAF 桥**之前**：安卓上桥一直存在（它是设备能力，与这条路径属于谁无关），
     先问桥就等于把电脑那棵树里的路径交给 DocumentsContract 去拆 */
  const remote = remoteRefOf(path);
  if (remote) {
    await remoteMkdir(remote.rel);
    return;
  }
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
  const remote = remoteRefOf(path);
  if (remote) {
    const r = await remoteCreate({ relPath: remote.rel, text: '', encoding: 'utf-8', bom: false });
    /* 桌面说这个位置被占着（一个字都没写）。树上这条是「新建」，占位就是没建出来 ——
       报错让树里那句「操作失败」把桌面的原话说出来，别返回一个指向别人文件的路径 */
    if (r.exists) throw new RemoteError('exists', '电脑上已经有同名的文件，换个名字再建');
    /* 身份键的 device 段沿用传进来的那一份（树上那一行本来就是从它拼出来的）：
       换一次连接就换一串的 keyId 只会在下一次 read 时变成「找不到这台设备」 */
    return makeRemotePath(remote.deviceId, remote.rel);
  }
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
  if (isRemotePath(from) || isRemotePath(to)) throw remoteUnsupported('重命名');
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
  if (isRemotePath(from) || isRemotePath(to)) throw remoteUnsupported('复制');
  if (IS_ANDROID_APP) throw new Error('SAF copy unsupported'); /* UI 侧置灰，不应到达 */
  return invoke('fs_copy', { from, to });
}

export async function fsDelete(path: string, _isDir: boolean): Promise<void> {
  if (remoteRefOf(path)) throw remoteUnsupported('删除');
  const bridge = safBridge();
  if (bridge) {
    if (!bridge.deleteEntry(path)) throw new Error('SAF delete rejected');
    return;
  }
  return invoke('fs_delete', { path, isDir: _isDir });
}

export function fsReveal(path: string): Promise<void> {
  if (remoteRefOf(path)) return Promise.reject(remoteUnsupported('在文件管理器中显示'));
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
