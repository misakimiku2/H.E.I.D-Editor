import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText, X, Plus, FolderOpen, Save, SaveAll, RotateCcw,
  Sun, Moon, SunMoon, Menu, Info, Eye, Pencil, Undo2, Redo2,
  GitCompare, Columns2, History, ChevronRight, Trash2, Settings, Keyboard, FileDown, Link2, PanelLeft, FolderX,
} from 'lucide-react';
import heidIconLight from './assets/heid-icon-light.svg';
import heidIconDark from './assets/heid-icon-dark.svg';
import { cn } from './lib/utils';
import { CodeEditor } from './components/CodeEditor';
import { MarkdownPreview, type MarkdownPreviewHandle } from './components/MarkdownPreview';
import { WindowControls } from './components/WindowControls';
import { DiffModal } from './components/DiffModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import {
  appendEntry, removeEntry, revertEntry, trimTimeline, clampDiffEntries,
  applyInternalEdit, DEFAULT_DIFF_ENTRIES,
  type ExternalDiffEntry, type InternalDiffEntry,
} from './lib/diffTimeline';
import { useExternalFileWatcher } from './hooks/useExternalFileWatcher';
import { loadSessionState, saveSessionState, type SessionMdView, type SessionTab } from './lib/session';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY, NARROW_QUERY, displayNameFromPath } from './lib/platform';
import { detectLanguageFromPath, LANGUAGE_LABELS } from './lib/codemirror';
import {
  applyLineEnding, detectLineEnding, normalizeToLf,
  EOL_LABELS, type LineEnding,
} from './lib/lineEndings';
import {
  decodeAs, detectEncoding, encodingLabel, ENCODING_OPTIONS,
} from './lib/encoding';
import {
  addRecentFile, clearRecentFiles, listRecentFiles, type RecentFile,
} from './lib/recentFiles';
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS, type EditorSettings,
} from './lib/settings';
import { deleteDraft, draftKeyForTab, getDraft, saveDraft } from './lib/drafts';
import { countWords } from './lib/wordCount';
import { translate, resolveSystemLang, type Lang, type MessageKey } from './lib/i18n';
import { I18nProvider, rt, setRuntimeLang } from './lib/i18nContext';
import { SettingsDialog } from './components/SettingsDialog';
import { UrlImportModal } from './components/UrlImportModal';
import { FileTreeSidebar } from './components/FileTreeSidebar';
import { getDirLister } from './lib/fileTree';
import type { UrlImportResult } from './lib/urlImport';
import { openExternal } from './lib/openExternal';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useLastPointer } from './hooks/useLastPointer';
import { TopAppBar } from './components/mobile/TopAppBar';
import { BottomToolbar } from './components/mobile/BottomToolbar';
import { TabSheet } from './components/mobile/TabSheet';

/* ---------- types ---------- */

/* markdown 标签页的视图模式：编辑 / 分屏（左预览右源码）/ 预览（持久化词汇表定义于 lib/session） */
type MdViewMode = SessionMdView;

interface FileTab {
  id: string;
  title: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
  content: string;
  originalContent: string;
  language: string;
  isDirty: boolean;
  readOnly: boolean;
  mdView: MdViewMode;
  /** 文件编码（WHATWG label；浏览器保存始终 UTF-8） */
  encoding: string;
  /** 文件是否带 BOM（UTF-8 / UTF-16 写回时保持） */
  bom: boolean;
  /** 当前目标换行符（编辑器内统一 LF，保存时转换） */
  eol: LineEnding;
  /** 磁盘上的原换行符（eol 与其不同即视为有未保存修改） */
  originalEol: LineEnding;
  /** 疑似二进制文件（检测含 NUL），只读预览 */
  binary?: boolean;
  /** 大文件（超降级阈值）：关闭语法高亮/小地图等保证流畅 */
  large?: boolean;
}

/** 大文件降级阈值（字符数）：超过即关闭语法高亮、小地图、补全等重计算特性 */
const LARGE_FILE_CHARS = 2_000_000;

/* ---------- file system helpers (Tauri desktop / web File System Access API) ---------- */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function supportsFsAccess(): boolean {
  return typeof (window as any).showOpenFilePicker === 'function';
}

const READ_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs', '.rb', '.php',
  '.html', '.htm', '.css', '.scss', '.less', '.json', '.yaml', '.yml',
  '.xml', '.svg', '.md', '.sh', '.bash', '.sql', '.toml', '.ini', '.txt',
  '.swift', '.kt', '.kts', '.scala', '.vue', '.svelte',
];

interface OpenedFile {
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
function openedFromDecoded(
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
function openedFromBytes(
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

function androidPickFiles(): Promise<AndroidSafFile[] | null> {
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

function androidCreateDoc(name: string, mime: string): Promise<AndroidSafFile | null> {
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

async function androidWriteUri(uri: string, content: string, encoding: string, bom: boolean): Promise<boolean> {
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
async function readLocalPath(path: string, forceEncoding?: string): Promise<OpenedFile> {
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

async function pickAndReadFile(): Promise<OpenedFile | null> {
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

interface SaveResult {
  ok: boolean;
  savedPath: string | null;
}

/* 桌面：Tauri 命令按编码写盘；其余场景 UTF-8 由调用方处理 */
async function writeLocalPath(path: string, content: string, encoding = 'utf-8', bom = false): Promise<void> {
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
async function saveFileToDisk(tab: FileTab, contentLf: string, saveAs = false, silent = false): Promise<SaveResult> {
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

function formatFileSize(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SAMPLE_CODE = `// 欢迎使用 H.E.I.D
// Highlighting Intelligent Document Editor
// 特性：语法高亮 / 迷你地图 / 粘性滚动 / 行号拖选 / 代码折叠

import { EditorView } from '@codemirror/view';

interface EditorOptions {
  theme: 'dark' | 'light';
  lineNumbers: boolean;
  minimap: boolean;
}

function createEditor(target: HTMLElement, options: EditorOptions): EditorView {
  const view = new EditorView({
    parent: target,
    doc: rt('editor.placeholder'),
    extensions: [
      options.lineNumbers ? lineNumbers() : [],
      EditorView.theme({ '&': { backgroundColor: options.theme === 'dark' ? '#1e1e1e' : '#ffffff' } }),
    ],
  });
  return view;
}

# Python 也支持
def greet(name: str) -> str:
    """简单的问候函数"""
    return f"Hello, {name}!"

`;

/* ---------- App ---------- */

/* 每个标签页的内容历史（撤销/重做）：stack 存内容快照，index 指向当前态 */
interface TabHistory {
  stack: string[];
  index: number;
  lastAt: number;
}

/* 文件树侧栏：记住最后一次打开的文件夹（抽屉本身每次启动保持关闭） */
const TREE_ROOT_KEY = 'heid-tree-root';
function loadTreeRoot(): string | null {
  try { return localStorage.getItem(TREE_ROOT_KEY); } catch { return null; }
}
function saveTreeRoot(path: string | null): void {
  try {
    if (path) localStorage.setItem(TREE_ROOT_KEY, path);
    else localStorage.removeItem(TREE_ROOT_KEY);
  } catch { /* 忽略持久化失败 */ }
}

const MAX_HISTORY = 200;
/* 间隔小于该值的连续修改（连续输入）合并为同一条历史 */
const HISTORY_COALESCE_MS = 800;

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now()}-${tabCounter}`;
}

/* 初始 welcome 标签使用固定 id：会话恢复时需要精确识别并让位给快照内容 */
const INITIAL_WELCOME_ID = 'tab-welcome-initial';

function makeWelcomeTab(id: string = nextTabId()): FileTab {
  return {
    id,
    title: 'welcome.ts',
    path: null,
    handle: null,
    content: SAMPLE_CODE,
    originalContent: SAMPLE_CODE,
    language: 'typescript',
    isDirty: false,
    readOnly: false,
    mdView: 'edit',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    originalEol: 'lf',
  };
}

function makeUntitledTab(title: string): FileTab {
  return {
    id: nextTabId(),
    title,
    path: null,
    handle: null,
    content: '',
    originalContent: '',
    language: 'plaintext',
    isDirty: false,
    readOnly: false,
    mdView: 'edit',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    originalEol: 'lf',
  };
}

/* H.E.I.D 品牌 >_< 标识（简化自应用图标，随主题变色） */
function HeidMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="108 228 294 104"
      fill="none"
      stroke="currentColor"
      strokeWidth={24}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M120 240 L190 280 L120 320" />
      <line x1="230" y1="310" x2="290" y2="310" />
      <path d="M390 240 L320 280 L390 320" />
    </svg>
  );
}

type ThemeMode = 'light' | 'dark' | 'system';

/* ---- 丢弃确认（应用内自绘弹窗，替代原生 ask / window.confirm）----
   退出应用与关闭脏标签共用同一套 ConfirmDialog；resolve 经 state 回调完成 Promise。
   saveText 存在时弹窗显示「退出并保存」按钮，resolve 返回对应决策。 */
interface PendingDiscardConfirm {
  message: string;
  confirmText: string;
  saveText: string | null;
  resolve: (decision: 'cancel' | 'discard' | 'save') => void;
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (IS_ANDROID_APP) return 'system'; /* 安卓无应用内主题：始终跟随系统（键盘等系统界面不可控） */
    const saved = localStorage.getItem('heid-theme-mode');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  /* 安卓 WebView 的 prefers-color-scheme 不随运行时系统主题更新，
     初值与变化改走 HeidBridge（isSystemDark / heid-sysdark 事件） */
  const [systemDark, setSystemDark] = useState(
    () => IS_ANDROID_APP
      ? !!(window as any).HeidBridge?.isSystemDark?.()
      : window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  /* 系统主题变化监听（跟随系统模式使用） */
  useEffect(() => {
    if (IS_ANDROID_APP) {
      const onSysDark = (e: Event) => {
        const d = (e as CustomEvent<{ dark: boolean }>).detail;
        if (d && typeof d.dark === 'boolean') setSystemDark(d.dark);
      };
      window.addEventListener('heid-sysdark', onSysDark);
      return () => window.removeEventListener('heid-sysdark', onSysDark);
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem('heid-theme-mode', themeMode);
  }, [themeMode]);

  const isDarkMode = themeMode === 'dark' || (themeMode === 'system' && systemDark);

  /* 安卓：系统状态栏/导航栏图标外观跟随应用主题（浅色主题=深色图标，反之亦然） */
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    try { (window as any).HeidBridge?.setDarkTheme?.(isDarkMode); } catch { /* 桥不可用时忽略 */ }
  }, [isDarkMode]);

  /* 原生滚动条与表单控件跟随主题：Chromium 依据根元素的 color-scheme 渲染深色滚动条 */
  useEffect(() => {
    document.documentElement.style.colorScheme = isDarkMode ? 'dark' : 'light';
  }, [isDarkMode]);

  /* 移动端形态：安卓且窄屏（手机）采用专属布局；安卓宽屏（平板）沿用桌面布局 */
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isPhone = IS_ANDROID_APP && isNarrow;

  const [tabs, setTabs] = useState<FileTab[]>(() => [makeWelcomeTab(INITIAL_WELCOME_ID)]);
  const [activeTabId, setActiveTabId] = useState<string>(() => '');
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /* 标签栏右键菜单（tabId 为 null 表示右键在标签条空白处，无「关闭其他」锚点） */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string | null } | null>(null);
  /* 主菜单「最近打开」二级子菜单开合（菜单整体关闭时一并复位）。
     关闭走短延迟：鼠标从触发项移向子菜单（经过桥接区）时不中断 */
  const [recentSubOpen, setRecentSubOpen] = useState(false);
  const recentSubTimerRef = useRef<number | null>(null);
  const recentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const recentSubRef = useRef<HTMLDivElement | null>(null);
  const [recentSubPos, setRecentSubPos] = useState<{ left: number; top: number } | null>(null);
  const openRecentSub = useCallback(() => {
    if (recentSubTimerRef.current !== null) {
      clearTimeout(recentSubTimerRef.current);
      recentSubTimerRef.current = null;
    }
    setRecentSubOpen(true);
    /* portal 到 body 后需自行定位：贴触发项右侧展开（触发项距主菜单右缘内缩 6px，
       偏移取 14px 即子菜单与主菜单面板之间留约 8px 间隙），越界收进视口 */
    const el = recentTriggerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRecentSubPos({
        left: Math.max(4, Math.min(r.right + 10, window.innerWidth - 268)),
        top: Math.max(4, Math.min(r.top - 4, window.innerHeight - 360)),
      });
    }
  }, []);
  const scheduleCloseRecentSub = useCallback(() => {
    if (recentSubTimerRef.current !== null) clearTimeout(recentSubTimerRef.current);
    recentSubTimerRef.current = window.setTimeout(() => {
      recentSubTimerRef.current = null;
      setRecentSubOpen(false);
    }, 180);
  }, []);
  const cancelRecentSubTimer = useCallback(() => {
    if (recentSubTimerRef.current !== null) {
      clearTimeout(recentSubTimerRef.current);
      recentSubTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelRecentSubTimer, [cancelRecentSubTimer]);
  const [aboutOpen, setAboutOpen] = useState(false);
  /* 移动端：标签页抽屉开合 */
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  /* 丢弃确认弹窗（退出应用 / 关闭脏标签共用），null 表示无待确认项 */
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardConfirm | null>(null);
  /* ---- Diff 时间线：外部修改（监听磁盘）与软件内编辑（记录编辑爆发）两套相互独立 ---- */
  const [diffTimelines, setDiffTimelines] = useState<Record<string, ExternalDiffEntry[]>>({});
  const [internalDiffTimelines, setInternalDiffTimelines] = useState<Record<string, InternalDiffEntry[]>>({});
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  /* 时间线每文件保留条数（5~50，默认 30；localStorage 持久化，仅影响后续追加与即时裁剪） */
  const [maxDiffEntries, setMaxDiffEntries] = useState<number>(() => {
    const raw = localStorage.getItem('heid-diff-max-entries');
    return raw === null ? DEFAULT_DIFF_ENTRIES : clampDiffEntries(raw);
  });
  /* 最近打开文件（菜单数据源；addRecentFile 后同步刷新） */
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => listRecentFiles());
  const menuRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<MarkdownPreviewHandle | null>(null);
  const historiesRef = useRef<Map<string, TabHistory>>(new Map());
  /* 保存进行中标记（含等待原生对话框期间），防止重复触发导致连续弹出对话框 */
  const savingRef = useRef(false);

  /* 懒初始化标签页历史（stack[0] 为初始内容） */
  const ensureHistory = useCallback((tabId: string, initialContent: string): TabHistory => {
    let h = historiesRef.current.get(tabId);
    if (!h) {
      h = { stack: [initialContent], index: 0, lastAt: 0 };
      historiesRef.current.set(tabId, h);
    }
    return h;
  }, []);

  /** 内容变化来源：edit=软件内编辑（同步记内部 diff 时间线）；external=磁盘外部修改；revert=时间线撤销回写 */
  type ContentChangeSource = 'edit' | 'external' | 'revert';

  /* 记录一次内容变化；major（如右键格式化）强制独立成条，否则按时间间隔合并连击。
     source 为 edit 且标签页有路径时，按同样的合并判定把变化推进内部 diff 时间线
     （未命名标签无路径不记录；外部修改/时间线撤销不属于自己的时间线，跳过） */
  const recordContentChange = useCallback((tabId: string, prevContent: string, nextContent: string, major?: boolean, source: ContentChangeSource = 'external') => {
    if (prevContent === nextContent) return;
    const h = ensureHistory(tabId, prevContent);
    if (nextContent === h.stack[h.index]) return;
    const now = Date.now();
    const newStep = major || now - h.lastAt > HISTORY_COALESCE_MS;
    if (newStep) {
      h.stack = h.stack.slice(0, h.index + 1);
      h.stack.push(nextContent);
      if (h.stack.length > MAX_HISTORY) h.stack.shift();
      h.index = h.stack.length - 1;
    } else {
      h.stack[h.index] = nextContent;
    }
    h.lastAt = now;
    if (source === 'edit') {
      const path = tabsRef.current.find(tb => tb.id === tabId)?.path;
      if (path) {
        setInternalDiffTimelines(prev => ({
          ...prev,
          [path]: applyInternalEdit(prev[path] ?? [], prevContent, nextContent, newStep, maxDiffEntries, now),
        }));
      }
    }
  }, [ensureHistory, maxDiffEntries]);

  /* 关于弹窗：Esc 关闭 */
  useEffect(() => {
    if (!aboutOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAboutOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [aboutOpen]);

  /* 菜单：点击外部或 Esc 关闭 */
  useEffect(() => {
    if (!menuOpen) {
      cancelRecentSubTimer();
      setRecentSubOpen(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (recentSubRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /* 标签右键菜单：点击外部或 Esc 关闭 */
  const tabMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!tabMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!tabMenuRef.current?.contains(e.target as Node)) setTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [tabMenu]);

  useEffect(() => {
    if (!tabs.find(t => t.id === activeTabId)) {
      setActiveTabId(tabs.length > 0 ? tabs[tabs.length - 1].id : '');
    }
  }, [tabs, activeTabId]);

  const activeTab = useMemo(
    () => tabs.find(t => t.id === activeTabId) || null,
    [tabs, activeTabId]
  );

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const setActiveTabIdRef = useRef(setActiveTabId);
  setActiveTabIdRef.current = setActiveTabId;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  /* ---- 外部 Diff：监听管理 + 变更应用 ---- */

  /* 当前被标签页引用的真实文件路径（去重）——两条时间线的存活域（关最后一个标签页即丢弃）；
     浏览器模式与安卓（fs watch 不支持且 SAF 无真实路径）不监听外部，但内部时间线照常记录 */
  const referencedPaths = useMemo(
    () => Array.from(new Set(tabs.flatMap(t => (t.path ? [t.path] : [])))),
    [tabs]
  );
  const watchedPaths = useMemo(
    () => (isTauri && !IS_ANDROID_APP ? referencedPaths : []),
    [referencedPaths]
  );

  /* 检测到真实外部修改：追加时间线条目（按用户设置的保留条数裁剪），并按标签页脏状态分流处理 */
  const handleExternalChange = useCallback((path: string, before: string, after: string) => {
    setDiffTimelines(prev => ({ ...prev, [path]: appendEntry(prev[path] ?? [], before, after, Date.now(), maxDiffEntries) }));
    // 先为干净标签页以 major 方式记撤销历史（Ctrl+Z 可回退这次外部替换），再统一更新状态
    for (const t of tabsRef.current) {
      if (t.path === path && !t.isDirty) recordContentChange(t.id, t.content, after, true, 'external');
    }
    setTabs(prev => prev.map(t => {
      if (t.path !== path) return t;
      if (!t.isDirty) {
        // 干净：内容与 originalContent 同步为新磁盘内容，不产生脏状态
        return { ...t, content: after, originalContent: after, isDirty: false };
      }
      // 脏：编辑器内容不动，originalContent 跟踪磁盘最后已知状态，保留冲突标记
      return { ...t, originalContent: after, isDirty: t.content !== after || t.eol !== t.originalEol };
    }));
  }, [recordContentChange, maxDiffEntries]);

  const { updateKnownDiskContent } = useExternalFileWatcher({
    paths: watchedPaths,
    enabled: isTauri && !IS_ANDROID_APP,
    onExternalChange: handleExternalChange,
  });

  const diffTimelinesRef = useRef(diffTimelines);
  diffTimelinesRef.current = diffTimelines;
  const internalDiffTimelinesRef = useRef(internalDiffTimelines);
  internalDiffTimelinesRef.current = internalDiffTimelines;

  /* 提醒与当前标签页联动：只统计激活文件自己的未处理条数（每标签独立，切换标签页即切换提醒） */
  const activePendingDiffs = activeTab?.path ? (diffTimelines[activeTab.path]?.length ?? 0) : 0;

  /* 路径不再被任何标签页引用：丢弃其两条时间线（外部监听由 hook 自行拆除清理） */
  useEffect(() => {
    const live = new Set(referencedPaths);
    const dropStale = <T,>(prev: Record<string, T[]>): Record<string, T[]> => {
      const stale = Object.keys(prev).filter(p => !live.has(p));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      stale.forEach(p => delete next[p]);
      return next;
    };
    setDiffTimelines(dropStale);
    setInternalDiffTimelines(dropStale);
  }, [referencedPaths]);

  /* 保留条数设置持久化 */
  useEffect(() => {
    localStorage.setItem('heid-diff-max-entries', String(maxDiffEntries));
  }, [maxDiffEntries]);

  /* 调低保留条数时立即裁剪所有时间线（丢弃最旧） */
  useEffect(() => {
    setDiffTimelines(prev => {
      let changed = false;
      const next: Record<string, ExternalDiffEntry[]> = {};
      for (const [p, entries] of Object.entries(prev)) {
        const trimmed = trimTimeline(entries, maxDiffEntries);
        if (trimmed !== entries) changed = true;
        next[p] = trimmed;
      }
      return changed ? next : prev;
    });
    setInternalDiffTimelines(prev => {
      let changed = false;
      const next: Record<string, InternalDiffEntry[]> = {};
      for (const [p, entries] of Object.entries(prev)) {
        const trimmed = trimTimeline(entries, maxDiffEntries);
        if (trimmed !== entries) changed = true;
        next[p] = trimmed;
      }
      return changed ? next : prev;
    });
  }, [maxDiffEntries]);

  /* 接受：经确认后仅移除该条目，磁盘与编辑器均不动 */
  const handleAcceptDiff = useCallback((path: string, entryId: string) => {
    setDiffTimelines(prev => {
      const next = { ...prev, [path]: removeEntry(prev[path] ?? [], entryId) };
      if (next[path].length === 0) delete next[path];
      return next;
    });
  }, []);

  /* 撤销修改：经确认后把该条 before 写回磁盘（按该文件标签页的编码/换行符），编辑器同步回退，该条及其后所有条目一并移除 */
  const handleRevertDiff = useCallback(async (path: string, entryId: string) => {
    const entry = (diffTimelinesRef.current[path] ?? []).find(e => e.id === entryId);
    if (!entry) return;
    const refTab = tabsRef.current.find(t => t.path === path);
    const encoding = refTab?.encoding ?? 'utf-8';
    const bom = refTab?.bom ?? false;
    const eol = refTab?.eol ?? 'lf';
    try {
      await writeLocalPath(path, applyLineEnding(entry.before, eol), encoding, bom);
    } catch (e) {
      console.error('撤销外部修改失败（写回磁盘）:', path, e);
      return;
    }
    updateKnownDiskContent(path, entry.before);
    setDiffTimelines(prev => {
      const kept = revertEntry(prev[path] ?? [], entryId);
      const next = { ...prev };
      if (kept.length > 0) next[path] = kept;
      else delete next[path];
      return next;
    });
    // 该路径所有标签页的 originalContent 同步为写回内容（它始终跟踪磁盘最后已知状态）
    for (const t of tabsRef.current) {
      if (t.path === path && !t.isDirty) recordContentChange(t.id, t.content, entry.before, true, 'revert');
    }
    setTabs(prev => prev.map(t => {
      if (t.path !== path) return t;
      if (!t.isDirty) {
        // 干净：编辑器内容同步回退并计入撤销历史
        return { ...t, content: entry.before, originalContent: entry.before, isDirty: false };
      }
      // 脏：本地内容不动，isDirty 依据新的 originalContent 重新成立
      return { ...t, originalContent: entry.before, isDirty: t.content !== entry.before || t.eol !== t.originalEol };
    }));
  }, [recordContentChange, updateKnownDiskContent]);

  /* 接受（内部）：仅移除该条目，编辑器内容不动 */
  const handleAcceptInternalDiff = useCallback((path: string, entryId: string) => {
    setInternalDiffTimelines(prev => {
      const next = { ...prev, [path]: removeEntry(prev[path] ?? [], entryId) };
      if (next[path].length === 0) delete next[path];
      return next;
    });
  }, []);

  /* 撤销（内部）：把编辑器内容恢复到该条 before（磁盘不动），该条及其后所有条目移除。
     回退本身以 major 记入撤销历史（Ctrl+Z 可恢复），source=revert 不再进时间线 */
  const handleRevertInternalDiff = useCallback((path: string, entryId: string) => {
    const entry = (internalDiffTimelinesRef.current[path] ?? []).find(e => e.id === entryId);
    if (!entry) return;
    setInternalDiffTimelines(prev => {
      const kept = revertEntry(prev[path] ?? [], entryId);
      const next = { ...prev };
      if (kept.length > 0) next[path] = kept;
      else delete next[path];
      return next;
    });
    for (const t of tabsRef.current) {
      if (t.path === path) recordContentChange(t.id, t.content, entry.before, true, 'revert');
    }
    setTabs(prev => prev.map(t => {
      if (t.path !== path) return t;
      return { ...t, content: entry.before, isDirty: entry.before !== t.originalContent || t.eol !== t.originalEol };
    }));
  }, [recordContentChange]);


  const openPathIntoTab = useCallback(async (path: string) => {
    try {
      const file = await readLocalPath(path);
      const language = detectLanguageFromPath(file.name);
      const existing = tabsRef.current.find(t => t.path === path);
      if (existing) {
        setTabs(prev => prev.map(t => t.id === existing.id
          ? { ...t, content: file.content, originalContent: file.content, isDirty: false, encoding: file.encoding, bom: file.bom, eol: file.eol, originalEol: file.eol }
          : t
        ));
        setActiveTabIdRef.current(existing.id);
        addRecentFile(path, file.name);
        setRecentFiles(listRecentFiles());
        return;
      }
      const newTab: FileTab = {
        id: nextTabId(),
        title: file.name,
        path,
        handle: null,
        content: file.content,
        originalContent: file.content,
        language,
        isDirty: false,
        readOnly: !!file.binary,
        mdView: language === 'markdown' ? 'preview' : 'edit',
        encoding: file.encoding,
        bom: file.bom,
        eol: file.eol,
        originalEol: file.eol,
        binary: file.binary,
        large: file.content.length > LARGE_FILE_CHARS,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabIdRef.current(newTab.id);
      addRecentFile(path, file.name);
      setRecentFiles(listRecentFiles());
    } catch (e) {
      console.error('Failed to open file:', path, e);
      alert(t('open.errPath', { path }));
    }
  }, []);

  /* ---- Tauri: drag files onto the window to open them ---- */
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
          const paths = event.payload?.paths || [];
          const exts = new Set(READ_EXTENSIONS);
          paths
            .filter(p => exts.has('.' + (p.split('.').pop()?.toLowerCase() || '')))
            .forEach(p => openPathIntoTab(p));
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (e) {
        console.error('drag-drop listener failed:', e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathIntoTab]);

  /* ---- 会话恢复（仅 Tauri）：启动时按快照重建上次会话 ----
     file 条目重读磁盘（文件已删除/移动则跳过）；virtual 条目（未关闭且未编辑的
     welcome / 空 untitled）确定性重建，保证「没关的标签页重启后还在」。 */

  /* 恢复尝试完成前不写入会话快照，避免启动瞬间把上次会话覆盖为空 */
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    const session = loadSessionState();
    if (!session || session.tabs.length === 0) {
      hydratedRef.current = true;
      return;
    }
    let disposed = false;
    (async () => {
      const restored: FileTab[] = [];
      for (const st of session.tabs) {
        if (st.kind === 'virtual') {
          const base = st.title === 'welcome.ts' ? makeWelcomeTab() : makeUntitledTab(st.title);
          if (st.title !== 'welcome.ts') {
            /* 无路径标签的语言按标题扩展名还原（makeUntitledTab 默认 plaintext，
               否则导入的 .md 恢复后丢失 markdown 预览/分屏入口） */
            base.language = detectLanguageFromPath(st.title);
            if (base.language === 'markdown' && st.mdView) base.mdView = st.mdView;
          }
          if (st.draft) {
            /* 脏的无路径标签：内容在草稿里，恢复并标脏（草稿丢失则退化为空标签） */
            const draft = getDraft(draftKeyForTab({ path: null, title: st.title }));
            if (draft !== null) {
              base.content = draft;
              base.isDirty = true;
            }
          }
          restored.push(base);
          continue;
        }
        try {
          const file = await readLocalPath(st.path);
          const language = detectLanguageFromPath(file.name);
          /* 草稿叠加：上次退出时该文件有未保存内容，恢复并标脏 */
          const draft = getDraft(draftKeyForTab({ path: st.path, title: file.name }));
          const hasDraft = draft !== null && draft !== file.content;
          restored.push({
            id: nextTabId(),
            title: file.name,
            path: st.path,
            handle: null,
            content: hasDraft ? draft : file.content,
            originalContent: file.content,
            language,
            isDirty: hasDraft,
            readOnly: !!file.binary,
            mdView: language === 'markdown' ? st.mdView : 'edit',
            encoding: file.encoding,
            bom: file.bom,
            eol: file.eol,
            originalEol: file.eol,
            binary: file.binary,
            large: file.content.length > LARGE_FILE_CHARS,
          });
        } catch {
          // 文件已被删除/移动：跳过该标签
        }
      }
      if (disposed) return;
      hydratedRef.current = true;
      if (restored.length === 0) {
        // 全部失效：清掉快照，保留初始 welcome 标签
        saveSessionState({ tabs: [], activePath: null });
        return;
      }
      setTabs(prev => {
        // 快照完整描述上次会话：移除未被编辑过的初始 welcome 标签（若快照含 welcome 会随之重建）；
        // 恢复期间用户新建/编辑过的标签保留
        const kept = prev.filter(t => !(t.id === INITIAL_WELCOME_ID && !t.isDirty));
        return [...kept, ...restored];
      });
      /* 激活标签还原：file 按路径；无路径（activePath=null）按 activeVirtualTitle 精确匹配——
         否则「激活的是导入的 md」重启后会错误地落在第一个无路径标签（welcome）上 */
      const active =
        (session.activePath === null
          ? restored.find(t => !t.path && t.title === session.activeVirtualTitle) ?? restored.find(t => !t.path)
          : restored.find(t => t.path === session.activePath))
        ?? restored[restored.length - 1];
      setActiveTabId(active.id);
    })();
    return () => {
      disposed = true;
    };
  }, []);

  /* ---- 会话持久化：快照跟随标签页变化 ----
     file 标签存路径；无路径标签仅在未编辑时存为 virtual（内容可确定性重建）；
     脏的无路径标签不持久化——其存亡由退出确认决定，用户确认放弃后不应「复活」。
     提取为函数：除跟随变化外，「退出并保存」在销毁窗口前也显式写入一次，
     避免状态更新对应的 effect 尚未执行、窗口已被销毁。 */
  const writeSessionSnapshot = useCallback(() => {
    if (!isTauri || !hydratedRef.current) return;
    const active = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    saveSessionState({
      tabs: tabsRef.current.flatMap((t): SessionTab[] => {
        if (t.path) return [{ kind: 'file', path: t.path, mdView: t.mdView }];
        /* 脏的无路径标签：内容在草稿（lib/drafts），快照只记 draft 标志；
           用户确认「不保存」退出时草稿与快照条目一并清除（见 confirmWindowClose / closeTab） */
        return t.isDirty
          ? [{ kind: 'virtual', title: t.title, draft: !t.readOnly, mdView: t.mdView }]
          : [{ kind: 'virtual', title: t.title, mdView: t.mdView }];
      }),
      activePath: active?.path ?? null,
      activeVirtualTitle: active && !active.path ? active.title : null,
    });
  }, []);

  useEffect(() => {
    writeSessionSnapshot();
  }, [tabs, activeTab, writeSessionSnapshot]);

  /* ---- global shortcuts ---- */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      /* 编辑器 keymap 已接管的按键（已 preventDefault，但事件仍会冒泡到 window）不再重复处理，
         否则 Ctrl+S 会触发两次保存、弹出两个保存对话框 */
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault();
        handleSaveAs();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        handleOpenFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleNewFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        if (hasTabRef.current) { e.preventDefault(); openFind(false, false); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        if (hasTabRef.current) { e.preventDefault(); openFind(true, false); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        if (hasTabRef.current) { e.preventDefault(); openFind(false, true); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        /* 浏览器里 Ctrl+W 归浏览器管无法拦截；打包后的应用内生效 */
        e.preventDefault();
        if (activeTabIdRef.current) void closeTab(activeTabIdRef.current);
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const list = tabsRef.current;
        if (list.length < 2) return;
        const idx = list.findIndex(t => t.id === activeTabIdRef.current);
        const delta = e.shiftKey ? -1 : 1;
        setActiveTabIdRef.current(list[(idx + delta + list.length) % list.length].id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  /* ---- 全局链接导航守卫：渲染内容里的 <a>（预览正文、导入的来源链接等）不允许让应用 WebView 真实导航 ----
     http(s) 交给系统浏览器打开，其余非锚点协议（javascript: / 相对路径 / 空链接）直接拦截。
     放行两类：# 开头的文档内锚点跳转、带 download / blob: / data: 的下载链接（导出 HTML 走这里）。
     否则点击链接会把整个应用导航成网页，WebView2 的鼠标侧键（历史前进/后退）随之在应用与网页间切换。 */
  useEffect(() => {
    const anchorOf = (target: EventTarget | null): HTMLAnchorElement | null => {
      let el = target as HTMLElement | null;
      while (el && el.tagName !== 'A') el = el.parentElement;
      return el as HTMLAnchorElement | null;
    };
    const guard = (e: MouseEvent) => {
      const a = anchorOf(e.target);
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;
      if (a.hasAttribute('download') || /^(blob:|data:)/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      if (/^https?:\/\//i.test(href)) void openExternal(href);
    };
    document.addEventListener('click', guard, true);
    document.addEventListener('auxclick', guard, true);
    return () => {
      document.removeEventListener('click', guard, true);
      document.removeEventListener('auxclick', guard, true);
    };
  }, []);

  /* ---- tab operations ---- */

  const updateTabContent = useCallback((tabId: string, content: string, opts?: { major?: boolean }) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab) recordContentChange(tabId, tab.content, content, opts?.major, 'edit');
    setTabs(prev => prev.map(t => {
      if (t.id !== tabId) return t;
      /* eol 与磁盘原值不同同样构成未保存状态（保存时才真正换行符转换） */
      return { ...t, content, isDirty: content !== t.originalContent || t.eol !== t.originalEol };
    }));
  }, [recordContentChange]);

  /* ---- 丢弃确认（应用内自绘弹窗）：WebView 的 window.confirm 不可靠，
     原生系统对话框与应用视觉割裂，三端（桌面/安卓/浏览器）统一走 ConfirmDialog。
     已有待确认项时直接拒绝新请求，避免叠开多个弹窗。 */
  const pendingDiscardRef = useRef<PendingDiscardConfirm | null>(null);
  pendingDiscardRef.current = pendingDiscard;

  const askDiscardConfirm = useCallback((
    message: string,
    confirmText: string,
    saveText?: string,
  ): Promise<'cancel' | 'discard' | 'save'> => {
    if (pendingDiscardRef.current) return Promise.resolve('cancel');
    return new Promise(resolve => {
      setPendingDiscard({
        message,
        confirmText,
        saveText: saveText ?? null,
        resolve: decision => {
          setPendingDiscard(null);
          resolve(decision);
        },
      });
    });
  }, []);

  const handleOpenFile = useCallback(async () => {
    /* 安卓：系统文档选择器（支持多选），逐个复用 openPathIntoTab */
    if (IS_ANDROID_APP) {
      const picked = await androidPickFiles();
      if (!picked) return;
      for (const f of picked) await openPathIntoTab(f.uri);
      return;
    }
    let result: OpenedFile | null = null;
    try {
      result = await pickAndReadFile();
    } catch (e: any) {
      console.error('打开文件失败:', e);
      alert(t('open.errGeneric', { msg: e?.message ?? e }));
      return;
    }
    if (!result) return;
    const { content, name, path, handle, encoding, bom, eol, binary } = result;
    const language = detectLanguageFromPath(name);
    const newTab: FileTab = {
      id: nextTabId(),
      title: name,
      path,
      handle,
      content,
      originalContent: content,
      language,
      isDirty: false,
      readOnly: !!binary,
      mdView: language === 'markdown' ? 'preview' : 'edit',
      encoding,
      bom,
      eol,
      originalEol: eol,
      binary,
      large: content.length > LARGE_FILE_CHARS,
    };
    // if same file is already open, focus it
    const existing = tabs.find(t => t.path === path && !t.isDirty);
    if (existing) {
      setTabs(prev => prev.map(t => t.id === existing.id
        ? { ...t, content, originalContent: content, handle, encoding, bom, eol, originalEol: eol }
        : t
      ));
      setActiveTabId(existing.id);
      return;
    }
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    if (path) {
      addRecentFile(path, name);
      setRecentFiles(listRecentFiles());
    }
  }, [tabs]);

  const handleNewFile = useCallback(() => {
    const newTab = makeUntitledTab(`untitled-${tabCounter + 1}.txt`);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const persistTab = useCallback(async (tab: FileTab, saveAs: boolean, opts?: { silent?: boolean }): Promise<boolean> => {
    if (tab.readOnly || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await saveFileToDisk(tab, tab.content, saveAs, opts?.silent ?? false);
      if (result.ok) {
        const savedPath = result.savedPath ?? tab.path;
        const savedTitle = savedPath ? displayNameFromPath(savedPath) : tab.title;
        /* encoding/bom 从传入的 tab（可能已带新编码）回写，编码转换保存后状态栏即时生效 */
        setTabs(prev => prev.map(t => t.id === tab.id
          ? { ...t, originalContent: t.content, isDirty: false, path: savedPath, title: savedTitle, originalEol: t.eol, encoding: tab.encoding, bom: tab.bom }
          : t
        ));
        // 自写识别：更新已知磁盘内容，后续 watch 事件比对无差异，不产生 diff
        if (savedPath) {
          updateKnownDiskContent(savedPath, tab.content);
          addRecentFile(savedPath, savedTitle);
          setRecentFiles(listRecentFiles());
        }
      }
      return result.ok;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [updateKnownDiskContent]);

  /* 关闭单个标签前的丢弃确认；「关闭并保存」先落盘（无路径走另存为），
     保存被取消/失败则不关闭，与退出确认的「退出并保存」语义一致 */
  const confirmDiscardTab = useCallback(async (tab: FileTab): Promise<boolean> => {
    const decision = await askDiscardConfirm(
      t('confirm.closeDirtyTitle', { name: tab.title }),
      t('confirm.closeNoSave'),
      t('confirm.closeAndSave'),
    );
    if (decision === 'cancel') return false;
    if (decision === 'discard') {
      /* 用户明确放弃：清除该标签的草稿，避免崩溃恢复时"复活" */
      deleteDraft(draftKeyForTab(tab));
      return true;
    }
    return await persistTab(tab, !tab.path);
  }, [askDiscardConfirm, persistTab]);

  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.isDirty && !(await confirmDiscardTab(tab))) return;
    historiesRef.current.delete(tabId);
    setTabs(prev => prev.filter(t => t.id !== tabId));
  }, [confirmDiscardTab]);

  /* ---- 标签栏右键菜单：批量关闭（脏标签逐个走确认弹窗，取消即中断余项） ---- */
  const closeOtherTabs = useCallback(async (keepId: string) => {
    for (const t of [...tabsRef.current]) {
      if (t.id === keepId) continue;
      await closeTab(t.id);
    }
  }, [closeTab]);

  const closeAllTabs = useCallback(async () => {
    for (const t of [...tabsRef.current]) {
      await closeTab(t.id);
    }
  }, [closeTab]);

  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    await persistTab(activeTab, false);
  }, [activeTab, persistTab]);

  /* 另存为：无论是否已有路径，总是弹出保存对话框选择新位置 */
  const handleSaveAs = useCallback(async () => {
    if (!activeTab) return;
    await persistTab(activeTab, true);
  }, [activeTab, persistTab]);

  const handleRevert = useCallback(() => {
    if (!activeTab) return;
    /* major：恢复到磁盘版本是离散动作，独立成撤销步骤与内部 diff 条目 */
    updateTabContent(activeTab.id, activeTab.originalContent, { major: true });
  }, [activeTab, updateTabContent]);

  /* ---- 查找 / 替换 / 跳转到行（编辑器内浮层 + 预览查找，弹出在指针位置）---- */
  const [findState, setFindState] = useState({ open: false, showReplace: false, goto: false });
  const openFind = useCallback((showReplace = false, goto = false) => {
    setFindState({ open: true, showReplace, goto });
  }, []);
  const closeFind = useCallback(() => {
    setFindState(s => ({ ...s, open: false }));
  }, []);
  const getPointer = useLastPointer();

  /* ---- 编辑器设置（弹窗修改即时生效 + 持久化）---- */
  const [settings, setSettings] = useState<EditorSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeRootPath, setTreeRootPath] = useState<string | null>(() => loadTreeRoot());
  useEffect(() => { saveTreeRoot(treeRootPath); }, [treeRootPath]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  /* ---- 界面语言：settings.language 解析为具体语言；rt/setRuntimeLang 供模块级文案使用 ---- */
  const lang: Lang = settings.language === 'system'
    ? resolveSystemLang(typeof navigator !== 'undefined' ? navigator.language : undefined)
    : settings.language;
  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  useEffect(() => { setRuntimeLang(lang); }, [lang]);

  /* ---- 安全区：MainActivity 经 heid-insets 桥推送状态栏/手势条高度（css px），
     写入 :root 的 --heid-safe-top/bottom 供 safe-top/safe-bottom 与标题栏内联样式使用；
     WebView 的 env() 不可靠，必须走此桥 ---- */
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    const root = document.documentElement;
    const apply = (top: number, bottom: number) => {
      root.style.setProperty('--heid-safe-top', `${top}px`);
      root.style.setProperty('--heid-safe-bottom', `${bottom}px`);
    };
    const bridge = (window as any).HeidBridge;
    try { apply(bridge?.top?.() ?? 0, bridge?.bottom?.() ?? 0); } catch { /* 桥不可用时等事件 */ }
    const onInsets = (e: Event) => {
      const d = (e as CustomEvent<{ top: number; bottom: number }>).detail;
      if (d) apply(d.top, d.bottom);
    };
    window.addEventListener('heid-insets', onInsets);
    return () => window.removeEventListener('heid-insets', onInsets);
  }, []);

  /* ---- 文件树侧栏：选择器走平台提供者；记忆根目录，抽屉默认关闭 ---- */
  const chooseTreeFolder = useCallback(async () => {
    const l = getDirLister(isTauri, IS_ANDROID_APP);
    if (!l) return;
    const p = await l.chooseRoot();
    if (p) { setTreeRootPath(p); setTreeOpen(true); }
  }, []);
  const handleToggleTree = useCallback(() => {
    if (treeOpen) { setTreeOpen(false); return; }
    if (!treeRootPath) { void chooseTreeFolder(); return; }
    setTreeOpen(true);
  }, [treeOpen, treeRootPath, chooseTreeFolder]);
  const handleTreeRootChange = useCallback((p: string | null) => {
    setTreeRootPath(p);
    if (!p) setTreeOpen(false);
  }, []);

  /* ---- 网址导入：转换结果以 Markdown 新标签页打开（分屏视图，标脏） ---- */
  const handleUrlImported = useCallback((result: UrlImportResult) => {
    const newTab: FileTab = {
      ...makeUntitledTab(result.filename),
      content: result.markdown,
      language: 'markdown',
      isDirty: true,
      mdView: 'split',
    };
    setUrlImportOpen(false);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  /* ---- Markdown 导出为单文件 HTML（桌面另存对话框 / 安卓 SAF 新建文档 / 浏览器 Blob 下载） ---- */
  const handleExportHtml = useCallback(async () => {
    const tab = activeTab;
    if (!tab || tab.language !== 'markdown' || tab.binary) return;
    try {
      const { renderMarkdownToHtml } = await import('./lib/markdownHtml');
      const baseName = tab.title.replace(/\.md$/i, '') || 'export';
      const html = await renderMarkdownToHtml(tab.content, { title: baseName, dark: isDarkMode });
      if (IS_ANDROID_APP) {
        const created = await androidCreateDoc(baseName, 'text/html');
        if (!created) return;
        const ok = await androidWriteUri(created.uri, html, 'utf-8', false);
        if (!ok) alert(rt('save.errAndroidWrite'));
        return;
      }
      if (isTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const path = await save({
          defaultPath: baseName + '.html',
          filters: [{ name: t('export.htmlFilterName'), extensions: ['html'] }],
        });
        if (!path) return;
        await writeLocalPath(path, html, 'utf-8', false);
        return;
      }
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = baseName + '.html';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(t('export.errGeneric', { msg: e?.message ?? String(e) }));
    }
  }, [activeTab, isDarkMode, t]);

  /* ---- 状态栏弹出菜单（编码 / 换行符）---- */
  type StatusMenu = null | 'encoding-root' | 'encoding-reopen' | 'encoding-save' | 'eol';
  const [statusMenu, setStatusMenu] = useState<StatusMenu>(null);
  const statusItemCls = cn(
    "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors text-left",
    isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
  );

  /* ---- 编码 / 换行符（状态栏入口）---- */

  /** 以指定编码重新打开当前文件（重读磁盘并重新解码；脏标签先确认丢弃） */
  const reopenWithEncoding = useCallback(async (tab: FileTab, encoding: string) => {
    if (!tab.path) {
      // 无路径标签：仅记录偏好，供另存时生效
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, encoding } : t));
      return;
    }
    if (tab.isDirty) {
      const decision = await askDiscardConfirm(
        t('confirm.reopenDirtyTitle', { name: tab.title }),
        t('confirm.reopenNoSave'),
      );
      if (decision !== 'discard') return;
    }
    try {
      const file = await readLocalPath(tab.path, encoding);
      setTabs(prev => prev.map(t => t.id === tab.id
        ? {
          ...t,
          content: file.content,
          originalContent: file.content,
          isDirty: false,
          encoding,
          bom: file.bom,
          eol: file.eol,
          originalEol: file.eol,
        }
        : t
      ));
      if (file.encoding !== encoding) {
        // 引擎不支持该编码时 readLocalPath 可能回退，同步真实值
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, encoding: file.encoding } : t));
      }
    } catch (e) {
      console.error('以指定编码重新打开失败:', e);
      alert(t('open.errReopen', { enc: encodingLabel(encoding) }));
    }
  }, [askDiscardConfirm]);

  /** 转换编码并立即保存（有路径时）；无路径仅记录，另存时生效 */
  const convertEncoding = useCallback(async (tab: FileTab, encoding: string) => {
    if (!tab.path || tab.readOnly) {
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, encoding } : t));
      return;
    }
    const ok = await persistTab({ ...tab, encoding }, false);
    if (!ok) alert(t('save.errConvert'));
  }, [persistTab]);

  /** 切换换行符（保存时生效；与磁盘原值不同即标记未保存） */
  const setTabEol = useCallback((tab: FileTab, eol: LineEnding) => {
    setTabs(prev => prev.map(t => t.id === tab.id
      ? { ...t, eol, isDirty: t.content !== t.originalContent || eol !== t.originalEol }
      : t
    ));
  }, []);

  /* ---- 自动保存：按设置间隔把「有路径且脏」的文件静默落盘（无路径标签由草稿兜底） ---- */
  useEffect(() => {
    if (!settings.autosaveEnabled) return;
    const ms = Math.max(5, settings.autosaveIntervalSec) * 1000;
    const id = setInterval(() => {
      /* 确认弹窗 / 退出流程 / 保存进行中：不自动保存，避免和用户「不保存」的决策打架 */
      if (pendingDiscardRef.current || exitingRef.current || savingRef.current) return;
      const targets = tabsRef.current.filter(t => t.isDirty && t.path && !t.readOnly);
      if (targets.length === 0) return;
      void (async () => {
        for (const tab of targets) {
          if (!tabsRef.current.includes(tab)) continue; /* 期间被关闭 */
          await persistTab(tab, false, { silent: true });
        }
      })();
    }, ms);
    return () => clearInterval(id);
  }, [settings.autosaveEnabled, settings.autosaveIntervalSec, persistTab]);

  /* ---- 草稿捕获（崩溃保护，始终开启）：脏标签内容防抖 3s 写入本地草稿；
     干净标签的既有草稿即时清除。保存成功后 isDirty 变 false，同机制自动清草稿 ---- */
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const tab of tabsRef.current) {
        const key = draftKeyForTab(tab);
        if (tab.isDirty && !tab.readOnly) {
          saveDraft(key, tab.content);
        } else if (getDraft(key) !== null) {
          deleteDraft(key);
        }
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [tabs]);


  /* ---- 撤销 / 重做（作用于当前标签页内容历史） ---- */

  const canUndo = !!activeTab && (historiesRef.current.get(activeTab.id)?.index ?? 0) > 0;
  const canRedo = !!activeTab && (() => {
    const h = historiesRef.current.get(activeTab.id);
    return !!h && h.index < h.stack.length - 1;
  })();

  const handleUndo = useCallback(() => {
    if (!activeTab) return;
    const h = historiesRef.current.get(activeTab.id);
    if (!h || h.index <= 0) return;
    const content = h.stack[h.index - 1];
    h.index -= 1;
    h.lastAt = Date.now();
    setTabs(prev => prev.map(t => t.id === activeTab.id
      ? { ...t, content, isDirty: content !== t.originalContent || t.eol !== t.originalEol }
      : t
    ));
  }, [activeTab]);

  const handleRedo = useCallback(() => {
    if (!activeTab) return;
    const h = historiesRef.current.get(activeTab.id);
    if (!h || h.index >= h.stack.length - 1) return;
    const content = h.stack[h.index + 1];
    h.index += 1;
    h.lastAt = Date.now();
    setTabs(prev => prev.map(t => t.id === activeTab.id
      ? { ...t, content, isDirty: content !== t.originalContent || t.eol !== t.originalEol }
      : t
    ));
  }, [activeTab]);

  /* 关闭确认：有未保存标签时弹应用内确认弹窗，返回是否允许关闭 */
  const exitingRef = useRef(false); // 保存并退出进行中，忽略期间的重复关闭请求

  const confirmWindowClose = useCallback(async (): Promise<boolean> => {
    if (exitingRef.current) return false;
    const dirtyCount = tabsRef.current.filter(t => t.isDirty).length;
    if (dirtyCount === 0) return true;
    const decision = await askDiscardConfirm(
      t('confirm.exitDirtyTitle', { n: dirtyCount }),
      t('confirm.exitNoSave'),
      t('confirm.exitAndSave'),
    );
    if (decision === 'cancel') return false;
    if (decision === 'discard') {
      /* 用户明确放弃：清除脏标签草稿并刷新快照，标签不应在崩溃恢复中"复活" */
      for (const t of tabsRef.current) {
        if (t.isDirty) deleteDraft(draftKeyForTab(t));
      }
      writeSessionSnapshot();
      return true;
    }
    /* 退出并保存：逐个落盘（有路径静默写盘，无路径走另存为对话框），
       任一保存被取消/失败则中止退出留在应用，避免静默丢数据 */
    exitingRef.current = true;
    try {
      const dirty = tabsRef.current.filter(t => t.isDirty && !t.readOnly);
      for (const tab of dirty) {
        const ok = await persistTab(tab, !tab.path);
        if (!ok) return false;
      }
      writeSessionSnapshot();
      return true;
    } finally {
      exitingRef.current = false;
    }
  }, [askDiscardConfirm, persistTab, writeSessionSnapshot]);

  /* ---- 窗口关闭统一拦截（仅 Tauri）：自定义按钮 / Alt+F4 / 任务栏关闭都走未保存确认 ----
     Tauri 在存在 close-requested 监听时自动拦截系统关闭并转发事件；
     一律 preventDefault 后自行决定是否 destroy，避免事件处理器未阻止时被立即关闭。 */
  const confirmWindowCloseRef = useRef(confirmWindowClose);
  confirmWindowCloseRef.current = confirmWindowClose;

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const appWindow = getCurrentWindow();
        const fn = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            const confirmed = await confirmWindowCloseRef.current();
            if (confirmed) await appWindow.destroy();
          } catch (e) {
            // 确认流程出错：宁可关不掉也不静默丢数据
            console.error('窗口关闭确认失败:', e);
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (e) {
        console.error('注册窗口关闭拦截失败:', e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /* ---- 安卓系统返回键：逐层关闭弹层，最后走与桌面一致的未保存退出确认 ---- */
  const overlayStateRef = useRef({ tabSheetOpen, menuOpen, aboutOpen, pendingDiscard, findOpen: findState.open, settingsOpen, shortcutsOpen, tabMenuOpen: !!tabMenu });
  overlayStateRef.current = { tabSheetOpen, menuOpen, aboutOpen, pendingDiscard, findOpen: findState.open, settingsOpen, shortcutsOpen, tabMenuOpen: !!tabMenu };
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    const onBack = () => {
      const o = overlayStateRef.current;
      if (o.pendingDiscard) { o.pendingDiscard.resolve('cancel'); return; }
      if (o.findOpen) { closeFind(); return; }
      if (o.settingsOpen) { setSettingsOpen(false); return; }
      if (o.shortcutsOpen) { setShortcutsOpen(false); return; }
      if (o.tabMenuOpen) { setTabMenu(null); return; }
      if (o.tabSheetOpen) { setTabSheetOpen(false); return; }
      if (o.menuOpen) { setMenuOpen(false); return; }
      if (o.aboutOpen) { setAboutOpen(false); return; }
      void (async () => {
        if (await confirmWindowCloseRef.current()) {
          /* window.destroy 在 Android 上不可用，走原生桥退出 */
          if (IS_ANDROID_APP) {
            (window as any).HeidBridge?.exitApp?.();
          } else {
            try { await getCurrentWindow().destroy(); } catch (e) { console.error('退出失败:', e); }
          }
        }
      })();
    };
    window.addEventListener('heid-back', onBack);
    return () => window.removeEventListener('heid-back', onBack);
  }, []);

  /* 浏览器模式兜底：有未保存修改时拦截刷新/关闭（浏览器原生离开确认） */
  useEffect(() => {
    if (isTauri) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (tabsRef.current.some(t => t.isDirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  /* 切换当前 markdown 标签页的视图模式 */
  const setMdView = useCallback((mode: MdViewMode) => {
    if (!activeTab) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, mdView: mode } : t));
  }, [activeTab]);

  /* ---- 分屏同步滚动：按滚动比例映射到另一侧，带短时锁防止回环 ---- */

  const editorScrollerRef = useRef<HTMLElement | null>(null);
  const previewScrollerRef = useRef<HTMLElement | null>(null);
  const scrollLockRef = useRef<{ owner: 'editor' | 'preview'; until: number } | null>(null);

  const syncScrollFrom = useCallback((owner: 'editor' | 'preview') => {
    const el = owner === 'editor' ? editorScrollerRef.current : previewScrollerRef.current;
    const other = owner === 'editor' ? previewScrollerRef.current : editorScrollerRef.current;
    if (!el || !other) return;
    const now = performance.now();
    const lock = scrollLockRef.current;
    if (lock && lock.owner !== owner && now < lock.until) return;
    scrollLockRef.current = { owner, until: now + 80 };
    const max = el.scrollHeight - el.clientHeight;
    const otherMax = other.scrollHeight - other.clientHeight;
    if (max <= 0 || otherMax <= 0) return;
    other.scrollTop = (el.scrollTop / max) * otherMax;
  }, []);

  const handleEditorScroll = useCallback(() => syncScrollFrom('editor'), [syncScrollFrom]);
  const handlePreviewScroll = useCallback(() => syncScrollFrom('preview'), [syncScrollFrom]);

  const attachEditorScroller = useCallback((el: HTMLElement | null) => {
    const prev = editorScrollerRef.current;
    if (prev && prev !== el) prev.removeEventListener('scroll', handleEditorScroll);
    editorScrollerRef.current = el;
    if (el) el.addEventListener('scroll', handleEditorScroll, { passive: true });
  }, [handleEditorScroll]);

  const attachPreviewScroller = useCallback((el: HTMLElement | null) => {
    const prev = previewScrollerRef.current;
    if (prev && prev !== el) prev.removeEventListener('scroll', handlePreviewScroll);
    previewScrollerRef.current = el;
    if (el) el.addEventListener('scroll', handlePreviewScroll, { passive: true });
  }, [handlePreviewScroll]);

  /* ---- render ---- */

  const isMarkdown = activeTab?.language === 'markdown';

  /* 手机端无分屏：split 折叠为预览，由底部工具栏在编辑/预览间切换 */
  const effectiveView: MdViewMode = activeTab
    ? (isPhone && activeTab.mdView === 'split' ? 'preview' : activeTab.mdView)
    : 'edit';
  const toggleMdView = () => {
    if (!activeTab) return;
    setMdView(effectiveView === 'preview' ? 'edit' : 'preview');
  };

  /* 编辑器面板当前是否渲染（分屏/编辑态 Ctrl+F 搜索源码）；同步进 ref 供 window 快捷键读取 */
  const editorVisible = !!activeTab && !(isMarkdown && effectiveView === 'preview');
  const editorVisibleRef = useRef(editorVisible);
  editorVisibleRef.current = editorVisible;
  /* 有标签页即允许查找（纯预览态 Ctrl+F 走 PreviewFindBar） */
  const hasTabRef = useRef(!!activeTab);
  hasTabRef.current = !!activeTab;

  /* 状态栏光标信息（行/列/选中字符数） */
  const [cursorInfo, setCursorInfo] = useState({ line: 1, col: 1, selChars: 0 });
  /* 字数统计：Markdown 按 CJK 感知计数，其余按空白分词（200 万字符单次线性扫描，毫秒级） */
  const activeContent = activeTab?.content ?? '';
  const activeLanguage = activeTab?.language ?? '';
  const wordCountInfo = useMemo(
    () => countWords(activeContent, activeLanguage === 'markdown'),
    [activeContent, activeLanguage],
  );
  useEffect(() => {
    setCursorInfo({ line: 1, col: 1, selChars: 0 });
  }, [activeTabId]);

  const renderMdPreview = () => {
    if (!activeTab) return null;
    /* 预览查找仅在纯预览形态启用（分屏时 Ctrl+F 搜索编辑器源码） */
    const previewOnly = isMarkdown && effectiveView === 'preview';
    return (
      <MarkdownPreview
        ref={previewRef}
        content={activeTab.content}
        isDarkMode={isDarkMode}
        onChange={activeTab.readOnly ? undefined : (v) => updateTabContent(activeTab.id, v, { major: true })}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onScroller={attachPreviewScroller}
        findOpen={previewOnly && findState.open ? true : undefined}
        onFindClose={closeFind}
        getPointer={getPointer}
      />
    );
  };

  const renderEditor = () => {
    if (!activeTab) return null;
    return (
      <CodeEditor
        key={activeTab.id}
        value={activeTab.content}
        language={activeTab.language}
        isDarkMode={isDarkMode}
        editable={!activeTab.readOnly}
        editorSettings={settings}
        lowPerf={!!activeTab.large}
        onChange={(v, meta) => updateTabContent(activeTab.id, v, meta)}
        onSave={handleSave}
        onScroller={attachEditorScroller}
        onCursor={setCursorInfo}
        find={findState.open ? findState : undefined}
        onFindClose={closeFind}
        getPointer={getPointer}
        markdownMenu={isMarkdown && !activeTab.readOnly
          ? { canUndo, canRedo, onUndo: handleUndo, onRedo: handleRedo }
          : undefined}
      />
    );
  };

  return (
    <I18nProvider lang={lang}>
    <div className={cn(
      "h-dvh flex flex-col overflow-hidden relative",
      isDarkMode ? "bg-zinc-900 text-zinc-200" : "bg-zinc-50 text-zinc-800"
    )}>
      {/* 标题栏：手机端用 TopAppBar 取代自绘标题栏 + 菜单栏；桌面与安卓平板保留原布局 */}
      {isPhone ? (
        <TopAppBar
          isDarkMode={isDarkMode}
          title={activeTab?.title ?? 'H.E.I.D'}
          isDirty={!!activeTab?.isDirty}
          isMarkdown={!!isMarkdown}
          saving={saving}
          tabCount={tabs.length}
          onOpenTabs={() => setTabSheetOpen(true)}
          onNew={handleNewFile}
          onOpen={handleOpenFile}
          onSave={handleSave}
          onSaveAs={handleSaveAs}
          onImportUrl={isTauri ? () => setUrlImportOpen(true) : undefined}
          onOpenDiff={() => setDiffModalOpen(true)}
          onInsertTable={() => previewRef.current?.insertTable()}
          onInsertImage={() => previewRef.current?.openImageModal()}
          onCloseTab={() => activeTab && void closeTab(activeTab.id)}
          onSettings={() => setSettingsOpen(true)}
          onShortcuts={() => setShortcutsOpen(true)}
          onAbout={() => setAboutOpen(true)}
        />
      ) : (
      <div
        data-tauri-drag-region={!IS_ANDROID_APP}
        className={cn(
          "h-10 border-b flex items-center pl-3 gap-1.5 shrink-0 select-none",
          isDarkMode ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-white"
        )}
        /* 安卓边到边：标题栏向下让出系统状态栏高度（var 仅安卓注入，桌面回退 0） */
        style={{
          height: 'calc(2.5rem + var(--heid-safe-top, 0px))',
          paddingTop: 'var(--heid-safe-top, 0px)',
        }}
      >
        <div className="flex items-center gap-2 shrink-0" data-tauri-drag-region={!IS_ANDROID_APP}>
          <HeidMark className="w-10 h-3.5 shrink-0" />
          <span className="text-sm font-semibold tracking-tight" data-tauri-drag-region={!IS_ANDROID_APP}>H.E.I.D</span>
        </div>

        <button
          onClick={handleToggleTree}
          title={t('tree.toggle')}
          className={cn(
            "w-7 h-6 rounded-md flex items-center justify-center transition-colors shrink-0",
            treeOpen
              ? (isDarkMode ? "bg-zinc-700 text-zinc-200" : "bg-zinc-200 text-zinc-700")
              : (isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500")
          )}
        >
          <PanelLeft size={14} />
        </button>

        {/* 标签页 */}
        <div
          data-tauri-drag-region={!IS_ANDROID_APP}
          className="min-w-0 flex items-center gap-0.5 overflow-x-auto"
          onWheel={(e) => {
            /* 桌面滚轮→横滚（滚动条已隐藏）；触摸端走原生滑动 */
            const el = e.currentTarget;
            if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
              el.scrollLeft += e.deltaY;
            }
          }}
          onContextMenu={(e) => {
            /* 空白处右键：无锚点标签，只提供新建与全部关闭 */
            e.preventDefault();
            setTabMenu({ x: e.clientX, y: e.clientY, tabId: null });
          }}
        >
          {tabs.map((tab) => {
            /* 脏且存在未处理外部 diff：橙色提示点（外圈样式区别于琥珀色脏状态点） */
            const conflicted = tab.isDirty && !!tab.path && (diffTimelines[tab.path]?.length ?? 0) > 0;
            return (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] shrink-0",
              activeTabId === tab.id
                ? (isDarkMode ? "bg-zinc-700 text-zinc-100" : "bg-zinc-200 text-zinc-800")
                : (isDarkMode ? "text-zinc-500 hover:bg-zinc-700/50" : "text-zinc-500 hover:bg-zinc-100")
              )}
            >
              <span
                title={conflicted ? t('tab.conflictedTitle') : undefined}
                className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                conflicted
                  ? "bg-orange-500 ring-2 ring-orange-400/40"
                  : tab.isDirty ? "bg-amber-500" : (activeTabId === tab.id ? "bg-emerald-500" : (isDarkMode ? "bg-zinc-600" : "bg-zinc-300"))
              )} />
              <FileText size={12} className="shrink-0 opacity-60" />
              <span className="truncate">{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
                className={cn(
                  "p-0.5 rounded-sm hover:bg-zinc-500/20 transition-all shrink-0",
                  IS_TOUCH_PRIMARY ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                <X size={10} />
              </button>
            </div>
            );
          })}
        </div>

        <button
          onClick={handleNewFile}
          className={cn(
            "p-1.5 rounded-md transition-colors shrink-0",
            isDarkMode ? "hover:bg-zinc-600/70 text-zinc-300" : "hover:bg-zinc-200/70 text-zinc-600"
          )}
          title={`${t('menu.newFile')} (Ctrl+N)`}
        >
          <Plus size={15} />
        </button>

        <div className="flex-1 h-full" data-tauri-drag-region={!IS_ANDROID_APP} />

        {!IS_ANDROID_APP && <WindowControls isDarkMode={isDarkMode} />}
      </div>
      )}

      {/* 菜单栏（手机端由顶栏取代） */}
      {!isPhone && (
      <div
        ref={menuRef}
        className={cn(
          "h-9 border-b flex items-center px-2 shrink-0 relative select-none",
          isDarkMode ? "border-zinc-700 bg-zinc-800/60" : "border-zinc-200 bg-zinc-100/60"
        )}
      >
        <button
          onClick={() => setMenuOpen(v => !v)}
          className={cn(
            "p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs",
            menuOpen
              ? (isDarkMode ? "bg-zinc-700 text-zinc-200" : "bg-zinc-200 text-zinc-700")
              : (isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500")
          )}
          title={t('menu.menuLabel')}
        >
          <Menu size={15} />
        </button>

        <div className="flex-1" />

        {/* Diff 时间线入口（外部修改 + 软件内编辑）：按钮常驻；
            角标只统计外部修改——激活文件自己的未处理条数，切换标签页即切换提醒，
            其他文件的冲突仍以标签页橙点提示。软件内记录不提醒，按需打开查看 */}
        <button
          onClick={() => setDiffModalOpen(true)}
          className={cn(
            "relative mr-2 p-1.5 rounded-md transition-colors shrink-0",
            isDarkMode ? "hover:bg-zinc-600/70 text-zinc-300" : "hover:bg-zinc-200/70 text-zinc-600"
          )}
          title={activeTab ? t('diff.entryTitle', { name: activeTab.title }) : t('diff.menuTitle')}
        >
          <GitCompare size={15} />
          {activePendingDiffs > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-orange-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
              {activePendingDiffs > 99 ? '99+' : activePendingDiffs}
            </span>
          )}
        </button>

        {/* Markdown 视图三档切换：编辑 | 分屏 | 预览（仅 markdown 文件显示） */}
        {isMarkdown && activeTab && (
          <div
            role="group"
            aria-label={t('view.mdViewAria')}
            className={cn(
              "flex items-center rounded-full p-0.5 mr-2 shrink-0",
              isDarkMode ? "bg-zinc-700/60" : "bg-zinc-200/80"
            )}
          >
            {([
              { mode: 'edit', icon: Pencil, title: t('common.edit') },
              { mode: 'split', icon: Columns2, title: t('view.split') },
              { mode: 'preview', icon: Eye, title: t('common.preview') },
            ] as const).map(({ mode: m, icon: Icon, title }) => {
              const active = activeTab.mdView === m;
              return (
                <button
                  key={m}
                  onClick={() => setMdView(m)}
                  title={title}
                  className={cn(
                    "w-7 h-6 rounded-full flex items-center justify-center transition-all",
                    active
                      ? cn("shadow-sm", isDarkMode ? "bg-zinc-600 text-zinc-100" : "bg-white text-zinc-700")
                      : (isDarkMode ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")
                  )}
                >
                  <Icon size={13} />
                </button>
              );
            })}
          </div>
        )}

        {/* 主题三档切换：浅色 | 跟随系统 | 深色（安卓始终跟随系统，无此入口） */}
        {!IS_ANDROID_APP && (
        <div
          role="group"
          aria-label={t('theme.modeAria')}
          className={cn(
            "flex items-center rounded-full p-0.5 shrink-0",
            isDarkMode ? "bg-zinc-700/60" : "bg-zinc-200/80"
          )}
        >
          {([
            { mode: 'light', icon: Sun, title: t('theme.tipLight'), activeColor: 'text-amber-500' },
            { mode: 'system', icon: SunMoon, title: t('theme.tipSystem'), activeColor: isDarkMode ? 'text-zinc-100' : 'text-zinc-700' },
            { mode: 'dark', icon: Moon, title: t('theme.tipDark'), activeColor: 'text-indigo-400' },
          ] as const).map(({ mode: m, icon: Icon, title, activeColor }) => {
            const active = themeMode === m;
            return (
              <button
                key={m}
                onClick={() => setThemeMode(m)}
                title={title}
                className={cn(
                  "w-7 h-6 rounded-full flex items-center justify-center transition-all",
                  active
                    ? cn("shadow-sm", isDarkMode ? "bg-zinc-600" : "bg-white", activeColor)
                    : (isDarkMode ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")
                )}
              >
                <Icon size={13} />
              </button>
            );
          })}
        </div>
        )}

        {menuOpen && (
          <div className={cn(
            "absolute left-2 top-full -mt-px z-50 w-52 rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col",
            isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
          )}>
            <button
              onClick={() => { setMenuOpen(false); handleOpenFile(); }}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <FolderOpen size={14} />
              {t('menu.openFile')}
              <span className="ml-auto text-[10px] opacity-50">Ctrl+O</span>
            </button>
            {isTauri && (
              <button
                onClick={() => { setMenuOpen(false); void chooseTreeFolder(); }}
                className={cn(
                  "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                )}
              >
                <FolderOpen size={14} />
                {t('tree.openFolder')}
              </button>
            )}
            {isTauri && treeRootPath && (
              <button
                onClick={() => { setMenuOpen(false); handleTreeRootChange(null); }}
                className={cn(
                  "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                )}
              >
                <FolderX size={14} />
                {t('tree.closeFolder')}
              </button>
            )}
            {/* 最近打开（二级菜单，悬停/点击展开；portal 渲染到 body——
                嵌套在主菜单面板内时子元素的 backdrop-filter 采不到面板外的内容，毛玻璃会失效） */}
            <div
              onMouseEnter={openRecentSub}
              onMouseLeave={scheduleCloseRecentSub}
            >
              <button
                ref={recentTriggerRef}
                onClick={() => setRecentSubOpen(v => !v)}
                disabled={recentFiles.length === 0}
                className={cn(
                  "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none",
                  isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                )}
              >
                <History size={14} />
                {t('menu.recent')}
                <ChevronRight size={12} className="ml-auto opacity-50" />
              </button>
              {recentSubOpen && recentFiles.length > 0 && recentSubPos && createPortal(
                <div
                  ref={recentSubRef}
                  onMouseEnter={openRecentSub}
                  onMouseLeave={scheduleCloseRecentSub}
                  className={cn(
                    "fixed z-[70] w-64 rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col",
                    isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
                  )}
                  style={recentSubPos}
                >
                    {recentFiles.slice(0, 10).map(f => (
                      <button
                        key={f.path}
                        onClick={() => { setMenuOpen(false); void openPathIntoTab(f.path); }}
                        className={cn(
                          "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs flex items-center gap-2 transition-colors",
                          isDarkMode ? "hover:bg-zinc-600/70 text-zinc-300" : "hover:bg-zinc-200/70 text-zinc-600"
                        )}
                        title={f.path}
                      >
                        <FileText size={13} className="shrink-0 opacity-60" />
                        <span className="truncate">{f.name}</span>
                      </button>
                    ))}
                    <div className={cn("h-px mx-2 my-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
                    <button
                      onClick={() => { setRecentFiles(clearRecentFiles()); }}
                      className={cn(
                        "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                        isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                      )}
                    >
                      <Trash2 size={13} />
                      {t('menu.clearRecent')}
                    </button>
                </div>,
                document.body
              )}
            </div>
            <div className={cn("h-px mx-2 my-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
            <button
              onClick={() => { setMenuOpen(false); handleSave(); }}
              disabled={!activeTab || activeTab.readOnly || saving}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <Save size={14} />
              {t('menu.save')}
              <span className="ml-auto text-[10px] opacity-50">Ctrl+S</span>
            </button>
            <button
              onClick={() => { setMenuOpen(false); handleSaveAs(); }}
              disabled={!activeTab || activeTab.readOnly || saving}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <SaveAll size={14} />
              {t('menu.saveAs')}
              <span className="ml-auto text-[10px] opacity-50">Ctrl+Shift+S</span>
            </button>
            <button
              onClick={() => { setMenuOpen(false); void handleExportHtml(); }}
              disabled={!isMarkdown || !!activeTab?.binary}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <FileDown size={14} />
              {t('export.htmlMenu')}
            </button>
            {isTauri && (
              <button
                onClick={() => { setMenuOpen(false); setUrlImportOpen(true); }}
                className={cn(
                  "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                )}
              >
                <Link2 size={14} />
                {t('import.menu')}
              </button>
            )}
            <div className={cn("h-px mx-2 my-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
            <button
              onClick={() => { setMenuOpen(false); handleUndo(); }}
              disabled={!canUndo}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <Undo2 size={14} />
              {t('menu.undo')}
              <span className="ml-auto text-[10px] opacity-50">Ctrl+Z</span>
            </button>
            <button
              onClick={() => { setMenuOpen(false); handleRedo(); }}
              disabled={!canRedo}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <Redo2 size={14} />
              {t('menu.redo')}
              <span className="ml-auto text-[10px] opacity-50">Ctrl+Y</span>
            </button>
            <div className={cn("h-px mx-2 my-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
            <button
              onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <Settings size={14} />
              {t('menu.settings')}
            </button>
            <button
              onClick={() => { setMenuOpen(false); setShortcutsOpen(true); }}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <Keyboard size={14} />
              {t('menu.shortcuts')}
            </button>
            <button
              onClick={() => { setMenuOpen(false); setAboutOpen(true); }}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              <Info size={14} />
              {t('menu.about')}
            </button>
          </div>
        )}
      </div>
      )}

      {/* editor area（桌面/平板：文件树侧栏开启时编辑区让位；手机无侧栏） */}
      <div className="flex flex-1 overflow-hidden">
        {treeOpen && !isPhone && isTauri && treeRootPath && (
          <FileTreeSidebar
            rootPath={treeRootPath}
            open={treeOpen}
            overlay={IS_ANDROID_APP}
            isDarkMode={isDarkMode}
            activeTabId={activeTabId}
            tabs={tabs}
            onOpenFile={(p) => void openPathIntoTab(p)}
            onRootChange={handleTreeRootChange}
            onClose={() => setTreeOpen(false)}
          />
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
        {activeTab ? (
          <>
            {/* markdown 分屏（左预览右源码）/ 预览 / 编辑器 */}
            {isMarkdown && effectiveView === 'split' ? (
              <div className="flex flex-1 overflow-hidden">
                <div className="flex-1 min-w-0 overflow-hidden">
                  {renderMdPreview()}
                </div>
                <div className={cn("w-px shrink-0", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
                <div className="flex-1 min-w-0 overflow-hidden">
                  {renderEditor()}
                </div>
              </div>
            ) : isMarkdown && effectiveView === 'preview' ? (
              <div className="flex-1 overflow-hidden">
                {renderMdPreview()}
              </div>
            ) : (
              <div className="flex-1 overflow-hidden">
                {renderEditor()}
              </div>
            )}

            {/* bottom status bar（手机端隐藏）：文件信息 + 光标位置 + 编码/换行符 + 还原 */}
            {!isPhone && (<div className={cn(
              "border-t flex items-center px-4 gap-2 text-[11px] shrink-0 relative",
              isDarkMode ? "border-zinc-700 bg-zinc-800 text-zinc-500" : "border-zinc-200 bg-zinc-100 text-zinc-500"
            )}
            style={{
              height: 'calc(1.5rem + var(--heid-safe-bottom, 0px))',
              paddingBottom: 'var(--heid-safe-bottom, 0px)',
            }}>
              <span className="truncate" title={activeTab.path || t('status.unsavedPath')}>{activeTab.path || t('status.unsavedPath')}</span>
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0">{LANGUAGE_LABELS[activeTab.language] || activeTab.language}</span>
              {activeTab.binary && (
                <span className="shrink-0 text-orange-400 font-medium" title={t('status.binaryTip')}>{t('status.binary')}</span>
              )}
              {!activeTab.binary && activeTab.large && (
                <span className="shrink-0" title={t('status.largeTip')}>{t('status.large')}</span>
              )}
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0">{formatFileSize(activeTab.content)}</span>
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0">{t('status.lines', { n: activeTab.content.split('\n').length })}</span>
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0 tabular-nums">
                {t('status.charCount', { n: wordCountInfo.chars })} · {t('status.wordCount', { n: wordCountInfo.words })}
              </span>
              {/* 行列位置：仅编辑器可见时显示（预览态无光标概念） */}
              {editorVisible && (
                <>
                  <span className="shrink-0 opacity-50">|</span>
                  <span className="shrink-0 tabular-nums" title={t('status.cursorTip')}>
                    {t('status.cursor', { line: cursorInfo.line, col: cursorInfo.col })}
                    {cursorInfo.selChars > 0 && t('status.selected', { n: cursorInfo.selChars })}
                  </span>
                </>
              )}
              {activeTab.isDirty && <span className="shrink-0 text-amber-500 font-medium">{t('status.unsavedPath')}</span>}
              <div className="flex-1" />

              {/* 换行符菜单 */}
              <button
                onClick={() => setStatusMenu(m => m === 'eol' ? null : 'eol')}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 shrink-0",
                  isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-200 text-zinc-600"
                )}
                title={t('status.eol')}
              >
                {EOL_LABELS[activeTab.eol]}
              </button>
              {/* 编码菜单 */}
              <button
                onClick={() => setStatusMenu(m => m === 'encoding-root' ? null : 'encoding-root')}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 shrink-0",
                  isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-200 text-zinc-600"
                )}
                title={t('status.encoding')}
              >
                {encodingLabel(activeTab.encoding)}
                {activeTab.bom && ' BOM'}
              </button>
              {!activeTab.readOnly && (
                <button
                  onClick={handleRevert}
                  disabled={!activeTab.isDirty}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 disabled:opacity-40 shrink-0",
                    isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                  )}
                  title={t('status.revertTip')}
                >
                  <RotateCcw size={10} /> {t('status.revert')}
                </button>
              )}

              {/* 状态栏弹出菜单（点击遮罩关闭） */}
              {statusMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setStatusMenu(null)} />
                  <div className={cn(
                    "absolute bottom-full mb-1 right-2 z-50 w-56 rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col",
                    isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
                  )}>
                    {statusMenu === 'encoding-root' && (<>
                      <div className={cn("px-3 py-1 text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>{t('status.encoding')}</div>
                      <button
                        onClick={() => setStatusMenu('encoding-reopen')}
                        className={statusItemCls}
                      >
                        <RotateCcw size={12} className="shrink-0" />
                        {t('status.reopenAsMenu')}
                      </button>
                      <button
                        onClick={() => setStatusMenu('encoding-save')}
                        disabled={!activeTab.path || activeTab.readOnly}
                        className={cn(statusItemCls, "disabled:opacity-40")}
                      >
                        <Save size={12} className="shrink-0" />
                        {t('status.convertSaveMenu')}
                      </button>
                      {!activeTab.path && (
                        <div className={cn("px-3 py-1 text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                          {t('status.noPathEncoding')}
                        </div>
                      )}
                    </>)}
                    {(statusMenu === 'encoding-reopen' || statusMenu === 'encoding-save') && (
                      <>
                        <div className={cn("px-3 py-1 text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                          {statusMenu === 'encoding-reopen' ? t('status.reopenAsTitle') : t('status.convertSaveTitle')}
                        </div>
                        {ENCODING_OPTIONS.map(opt => (
                          <button
                            key={opt.id}
                            onClick={() => {
                              setStatusMenu(null);
                              if (statusMenu === 'encoding-reopen') void reopenWithEncoding(activeTab, opt.id);
                              else void convertEncoding(activeTab, opt.id);
                            }}
                            className={cn(statusItemCls, "justify-between")}
                          >
                            <span className="flex items-center gap-2">
                              {opt.id === 'utf-8' && activeTab.bom ? 'UTF-8 BOM' : opt.label}
                            </span>
                            {opt.id === activeTab.encoding && <span className="text-emerald-500">✓</span>}
                          </button>
                        ))}
                      </>
                    )}
                    {statusMenu === 'eol' && (<>
                      <div className={cn("px-3 py-1 text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>{t('status.eol')}</div>
                      {(['lf', 'crlf', 'cr'] as LineEnding[]).map(e => (
                        <button
                          key={e}
                          onClick={() => { setStatusMenu(null); setTabEol(activeTab, e); }}
                          className={cn(statusItemCls, "justify-between")}
                        >
                          <span>{EOL_LABELS[e]}{e === 'lf' ? t('status.eolLfNote') : e === 'crlf' ? t('status.eolCrLfNote') : t('status.eolCrNote')}</span>
                          {activeTab.eol === e && <span className="text-emerald-500">✓</span>}
                        </button>
                      ))}
                    </>)}
                  </div>
                </>
              )}
            </div>)}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6">
            <img
              src={isDarkMode ? heidIconLight : heidIconDark} /* 资源名按图标自身配色命名：dark=深色底图标（适合浅色界面），故深色主题用 light */
              alt="H.E.I.D"
              className="w-20 h-20 drop-shadow-md mb-4"
            />
            <h3 className="text-lg font-medium mb-1">H.E.I.D</h3>
            <p className="text-sm text-zinc-500 max-w-sm text-center mb-4">
              {t('empty.hint')}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleOpenFile}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200" : "bg-zinc-200 hover:bg-zinc-300 text-zinc-700"
                )}
              >
                <FolderOpen size={16} /> {t('menu.openFile')}
              </button>
              <button
                onClick={handleNewFile}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300" : "bg-white hover:bg-zinc-50 text-zinc-600 border border-zinc-200"
                )}
              >
                <Plus size={16} /> {t('menu.newFile')}
              </button>
            </div>

            {/* 最近打开（最多 5 条，悬浮显示完整路径） */}
            {recentFiles.length > 0 && (
              <div className="mt-7 w-full max-w-md flex flex-col items-center">
                <span className={cn(
                  "text-[10px] font-semibold tracking-wider uppercase mb-2",
                  isDarkMode ? "text-zinc-500" : "text-zinc-400"
                )}>
                  {t('menu.recent')}
                </span>
                <div className="w-full flex flex-col gap-0.5">
                  {recentFiles.slice(0, 5).map(f => (
                    <button
                      key={f.path}
                      onClick={() => void openPathIntoTab(f.path)}
                      className={cn(
                        "w-full px-3 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors min-w-0",
                        isDarkMode ? "hover:bg-zinc-800 text-zinc-400" : "hover:bg-zinc-200/70 text-zinc-500"
                      )}
                      title={f.path}
                    >
                      <FileText size={13} className="shrink-0 opacity-60" />
                      <span className="truncate">{f.name}</span>
                      <span className={cn(
                        "ml-auto shrink-0 max-w-[45%] truncate text-[10px] hidden sm:inline",
                        isDarkMode ? "text-zinc-600" : "text-zinc-400"
                      )}>
                        {f.path}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Diff 时间线弹窗（外部修改 / 软件内编辑） */}
        {diffModalOpen && (
          <DiffModal
            externalTimelines={diffTimelines}
            internalTimelines={internalDiffTimelines}
            isDarkMode={isDarkMode}
            focusPath={activeTab?.path ?? null}
            maxEntries={maxDiffEntries}
            onChangeMaxEntries={(n) => setMaxDiffEntries(clampDiffEntries(n))}
            onClose={() => setDiffModalOpen(false)}
            onAccept={(kind, path, id) => (kind === 'external' ? handleAcceptDiff(path, id) : handleAcceptInternalDiff(path, id))}
            onRevert={(kind, path, id) => (kind === 'external' ? void handleRevertDiff(path, id) : handleRevertInternalDiff(path, id))}
          />
        )}

        {/* 设置弹窗 */}
        {settingsOpen && (
          <SettingsDialog
            isDarkMode={isDarkMode}
            settings={settings}
            onChange={setSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {/* 快捷键帮助弹窗 */}
        {shortcutsOpen && (
          <ShortcutHelpDialog
            isDarkMode={isDarkMode}
            onClose={() => setShortcutsOpen(false)}
          />
        )}

        {/* 关于弹窗（背景毛玻璃） */}
        {aboutOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md"
              onClick={() => setAboutOpen(false)}
            />
            <div className={cn(
              "relative w-80 rounded-2xl border shadow-2xl p-6 flex flex-col items-center text-center",
              isDarkMode ? "border-zinc-700 bg-zinc-800/95 text-zinc-100" : "border-zinc-200 bg-white/95 text-zinc-800"
            )}>
              <button
                onClick={() => setAboutOpen(false)}
                className={cn(
                  "absolute top-3 right-3 p-1 rounded-md transition-colors",
                  isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
                )}
                title={t('common.close')}
              >
                <X size={14} />
              </button>
              <img
                src={isDarkMode ? heidIconLight : heidIconDark} /* 资源名按图标自身配色命名：dark=深色底图标（适合浅色界面），故深色主题用 light */
                alt="H.E.I.D"
                className="w-20 h-20 drop-shadow-md"
              />
              <h2 className="mt-4 text-lg font-bold tracking-widest">H.E.I.D</h2>
              <p className="mt-1 text-[11px] text-zinc-500 tracking-wide">
                Highlighting Intelligent Document Editor
              </p>
              <div className={cn(
                "mt-3 px-2.5 py-0.5 rounded-full text-[10px] font-medium border",
                isDarkMode ? "border-zinc-600 text-zinc-400" : "border-zinc-300 text-zinc-500"
              )}>
                {t('about.version', { v: '0.5.0' })}
              </div>
              <p className={cn(
                "mt-4 text-xs leading-relaxed",
                isDarkMode ? "text-zinc-400" : "text-zinc-500"
              )}>
                {t('about.desc')}
              </p>
              <div className={cn(
                "mt-4 pt-3 w-full text-[10px] border-t",
                isDarkMode ? "border-zinc-700 text-zinc-500" : "border-zinc-200 text-zinc-400"
              )}>
                © 2026 H.E.I.D
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* 网址导入弹窗 */}
      {urlImportOpen && (
        <UrlImportModal
          isDarkMode={isDarkMode}
          onImported={handleUrlImported}
          onClose={() => setUrlImportOpen(false)}
        />
      )}

      {/* 标签栏右键菜单 */}
      {tabMenu && (
        <div
          ref={tabMenuRef}
          className={cn(
            "fixed z-[95] w-44 rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col",
            isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
          )}
          style={{
            left: Math.max(4, Math.min(tabMenu.x, window.innerWidth - 190)),
            top: Math.max(4, Math.min(tabMenu.y, window.innerHeight - 130)),
          }}
        >
          {([
            { icon: <Plus size={13} />, label: t('tabs.new'), action: () => handleNewFile(), disabled: false },
            { icon: <X size={13} />, label: t('tabs.closeOthers'), action: () => void closeOtherTabs(tabMenu.tabId!), disabled: !tabMenu.tabId || tabs.length <= 1 },
            { icon: <Trash2 size={13} />, label: t('tabs.closeAll'), action: () => void closeAllTabs(), disabled: tabs.length === 0 },
          ] as const).map(({ icon, label, action, disabled }) => (
            <button
              key={label}
              onClick={() => { setTabMenu(null); action(); }}
              disabled={disabled}
              className={cn(
                "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none",
                isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      )}

      {/* 手机端底部工具栏（拇指区，取代键盘快捷键） */}
      {isPhone && activeTab && (
        <BottomToolbar
          isDarkMode={isDarkMode}
          isDirty={activeTab.isDirty}
          canUndo={canUndo}
          canRedo={canRedo}
          saving={saving}
          isMarkdown={!!isMarkdown}
          view={effectiveView === 'preview' ? 'preview' : 'edit'}
          onOpen={handleOpenFile}
          onSave={handleSave}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onToggleView={toggleMdView}
          onFind={() => openFind(false, false)}
        />
      )}

      {/* 移动端标签页抽屉 */}
      <TabSheet
        open={tabSheetOpen}
        isDarkMode={isDarkMode}
        onClose={() => setTabSheetOpen(false)}
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onCloseTab={(id) => { void closeTab(id); }}
        onNew={handleNewFile}
      />

      {/* 丢弃确认弹窗（退出应用 / 关闭脏标签共用，自绘以统一三端视觉） */}
      {pendingDiscard && (
        <ConfirmDialog
          title={t('confirm.unsavedTitle')}
          message={pendingDiscard.message}
          isDarkMode={isDarkMode}
          confirmText={pendingDiscard.confirmText}
          danger
          extraAction={pendingDiscard.saveText
            ? { text: pendingDiscard.saveText, onAction: () => pendingDiscard.resolve('save') }
            : undefined}
          onConfirm={() => pendingDiscard.resolve('discard')}
          onCancel={() => pendingDiscard.resolve('cancel')}
        />
      )}
    </div>
    </I18nProvider>
  );
}
