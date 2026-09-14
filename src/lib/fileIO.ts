/**
 * 文件读写平台适配层（Tauri 桌面 / 安卓 SAF / 浏览器 File System Access / input 降级）：
 * 打开（选择器 + 拖拽路径 + argv 路径）、保存（原编码 / 换行符写回）、SAF 桥接
 * 全部收敛在此，上层（hooks / 组件）只面对 OpenedFile / SaveResult 两个结果类型。
 */
import { IS_ANDROID_APP, displayNameFromPath } from './platform';
import { detectLanguageFromPath } from './codemirror';
import {
  applyLineEnding, detectLineEnding, normalizeToLf,
  type LineEnding,
} from './lineEndings';
import { decodeAs, detectEncoding } from './encoding';
import { rt } from './i18nContext';
import type { FileTab } from './tabModel';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function supportsFsAccess(): boolean {
  return typeof (window as any).showOpenFilePicker === 'function';
}

export const READ_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs', '.rb', '.php',
  '.html', '.htm', '.css', '.scss', '.less', '.json', '.yaml', '.yml',
  '.xml', '.svg', '.md', '.sh', '.bash', '.sql', '.toml', '.ini', '.txt',
  '.swift', '.kt', '.kts', '.scala', '.vue', '.svelte',
];

export interface OpenedFile {
  content: string;
  name: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
  encoding: string;
  bom: boolean;
  eol: LineEnding;
  binary?: boolean;
}

/** 从解码结果构造 OpenedFile：文本统一 LF 归一，原始换行符记入 eol */
export function openedFromDecoded(
  decoded: { text: string; encoding: string; bom: boolean; binary?: boolean },
  meta: { name: string; path: string | null; handle: FileSystemFileHandle | null },
): OpenedFile {
  const detection = detectLineEnding(decoded.text);
  return {
    content: normalizeToLf(decoded.text),
    name: meta.name,
    path: meta.path,
    handle: meta.handle,
    encoding: decoded.encoding,
    bom: decoded.bom,
    eol: detection.eol,
    binary: decoded.binary,
  };
}

/** 字节 → OpenedFile（安卓 SAF 与浏览器路径：JS 侧启发式检测） */
export function openedFromBytes(
  bytes: Uint8Array,
  meta: { name: string; path: string | null; handle: FileSystemFileHandle | null },
  forceEncoding?: string,
): OpenedFile {
  const decoded = forceEncoding
    ? { ...decodeAs(bytes, forceEncoding), encoding: forceEncoding }
    : detectEncoding(bytes);
  return openedFromDecoded(decoded, meta);
}

/* ---- Android SAF 桥（MainActivity 提供）：系统文档选择器 + content URI 写回 ----
   fs 插件对 picker 返回的 content URI 只有读授权（写报 Permission Denial），
   因此安卓端打开/另存/写盘统一走原生 SAF 流程，读写授权经 takePersistableUriPermission 持久化。 */

interface AndroidSafFile {
  uri: string;
  name: string;
}

export function androidPickFiles(): Promise<AndroidSafFile[] | null> {
  return new Promise((resolve) => {
    const handler = (e: Event) => {
      window.removeEventListener('heid-saf', handler);
      const d = (e as CustomEvent<{ kind: string; canceled?: boolean; files?: AndroidSafFile[] }>).detail;
      if (d?.kind !== 'open' || d.canceled || !d.files?.length) return resolve(null);
      resolve(d.files);
    };
    window.addEventListener('heid-saf', handler);
    (window as any).HeidBridge?.openDocs?.('[]');
  });
}

export function androidCreateDoc(name: string, mime: string): Promise<AndroidSafFile | null> {
  return new Promise((resolve) => {
    const handler = (e: Event) => {
      window.removeEventListener('heid-saf', handler);
      const d = (e as CustomEvent<{ kind: string; canceled?: boolean; file?: AndroidSafFile | null }>).detail;
      if (d?.kind !== 'create' || d.canceled || !d.file) return resolve(null);
      resolve(d.file);
    };
    window.addEventListener('heid-saf', handler);
    (window as any).HeidBridge?.createDoc?.(name, mime);
  });
}

export async function androidWriteUri(uri: string, content: string, encoding: string, bom: boolean): Promise<boolean> {
  const bridge = (window as any).HeidBridge;
  /* writeUri 在原生侧按指定编码编码字节（JS 的 TextEncoder 只支持 UTF-8）；
     桥不可用时回退 UTF-8 直接写 */
  if (!bridge?.writeUri) {
    if (!bridge?.writeBase64) return false;
    const bytes = new TextEncoder().encode(content);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return bridge.writeBase64(uri, btoa(binary)) === true;
  }
  return bridge.writeUri(uri, content, encoding, bom) === true;
}

/* 桌面（Tauri Windows/桌面平台）读取：Rust 侧 encoding_rs 检测编码；force 指定编码重新解码 */
export async function readLocalPath(path: string, forceEncoding?: string): Promise<OpenedFile> {
  let name = displayNameFromPath(path);
  /* 数字型 content URI（如 content://media/.../file/1000000018）解析不出可读名，走原生桥查 DISPLAY_NAME */
  if (path.startsWith('content://')) {
    const bridge = (window as any).HeidBridge;
    if (bridge?.displayName) {
      try {
        const resolved = bridge.displayName(path);
        if (resolved) name = resolved;
      } catch { /* 桥不可用时沿用解析结果 */ }
    }
  }
  if (isTauri && !IS_ANDROID_APP) {
    const { invoke } = await import('@tauri-apps/api/core');
    const r = await invoke<{ text: string; encoding: string; bom: boolean; lossy: boolean; binary: boolean }>(
      'read_text_file', { path, force: forceEncoding ?? null },
    );
    return openedFromDecoded(r, { name, path, handle: null });
  }  /* 安卓 / 纯 Tauri 移动端：SAF 字节流 → JS 启发式检测 */
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  return openedFromBytes(bytes, { name, path, handle: null }, forceEncoding);
}

export async function pickAndReadFile(): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: rt('file.filterName'), extensions: READ_EXTENSIONS.map(e => e.slice(1)) }],
    });
    if (typeof selected !== 'string') return null;
    return await readLocalPath(selected);
  }
  if (supportsFsAccess()) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        multiple: false,
        types: [{
          description: 'Text files',
          accept: {
            'text/*': READ_EXTENSIONS.filter(e => e !== '.svg'),
            'image/svg+xml': ['.svg'],
          },
        }],
      });
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      return openedFromBytes(bytes, { name: file.name, path: file.name, handle });
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      // fall through to input fallback
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = READ_EXTENSIONS.join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve(openedFromBytes(bytes, { name: file.name, path: file.name, handle: null }));
    };
    input.click();
  });
}

export interface SaveResult {
  ok: boolean;
  savedPath: string | null;
}

/* 桌面：Tauri 命令按编码写盘；其余场景 UTF-8 由调用方处理 */
export async function writeLocalPath(path: string, content: string, encoding = 'utf-8', bom = false): Promise<void> {
  if (isTauri && !IS_ANDROID_APP) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_text_file', { path, content, encoding, bom });
    return;
  }
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, new TextEncoder().encode(content));
}

/* saveAs = true 时忽略已有路径，总是弹出保存对话框另选位置；
   silent = true 时不弹错误提示（自动保存用，失败只返回 false） */
export async function saveFileToDisk(tab: FileTab, contentLf: string, saveAs = false, silent = false): Promise<SaveResult> {
  /* 编辑器内是 LF，落盘前按标签页的目标换行符还原 */
  const content = applyLineEnding(contentLf, tab.eol);
  /* 安卓：写盘走 SAF 桥（按编码编码字节）；另存为/无路径时先经系统新建文档取得可写 URI */
  if (IS_ANDROID_APP) {
    let target = tab.path;
    if (saveAs || !target) {
      const created = await androidCreateDoc(tab.title, 'text/plain');
      if (!created) return { ok: false, savedPath: null };
      target = created.uri;
    }
    const ok = await androidWriteUri(target, content, tab.encoding, tab.bom);
    if (!ok) {
      if (!silent) alert(rt('save.errAndroidWrite'));
      return { ok: false, savedPath: null };
    }
    return { ok: true, savedPath: target };
  }
  const encoder = new TextEncoder();
  if (!saveAs && tab.path && isTauri) {
      try {
        await writeLocalPath(tab.path, content, tab.encoding, tab.bom);
        return { ok: true, savedPath: tab.path };
      } catch (e) {
        console.error('Save failed:', e);
        if (!silent) alert(rt('save.errGeneric', { msg: String(e) }));
        return { ok: false, savedPath: null };
      }
    }
    if (isTauri) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const target = await save({ defaultPath: tab.title });
      if (!target) return { ok: false, savedPath: null };
      try {
        await writeLocalPath(target, content, tab.encoding, tab.bom);
        return { ok: true, savedPath: target };
      } catch (e) {
        console.error('Save failed:', e);
        if (!silent) alert(rt('save.errGeneric', { msg: String(e) }));
        return { ok: false, savedPath: null };
      }
    }
  if (!saveAs && tab.handle) {
    try {
      const writable = await (tab.handle as any).createWritable();
      await writable.write(encoder.encode(content));
      await writable.close();
      return { ok: true, savedPath: tab.path };
    } catch (e) {
      console.error('Save failed:', e);
      return { ok: false, savedPath: null };
    }
  }
  if (supportsFsAccess()) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: tab.title,
      });
      const writable = await handle.createWritable();
      await writable.write(encoder.encode(content));
      await writable.close();
      // remember handle so subsequent saves go straight to the file
      tab.handle = handle;
      tab.path = handle.name;
      return { ok: true, savedPath: handle.name };
    } catch (e: any) {
      if (e?.name === 'AbortError') return { ok: false, savedPath: null };
    }
  }
  // fallback: download（浏览器模式仅支持 UTF-8）
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = tab.title;
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, savedPath: tab.path };
}

export function formatFileSize(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* detectLanguageFromPath 仅由上层（打开文件入标签）使用；此处 re-export 便于
   调用方从单一模块取齐「文件 → 标签」相关工具 */
export { detectLanguageFromPath };
