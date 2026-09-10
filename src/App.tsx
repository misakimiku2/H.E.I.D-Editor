import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText, Code2, X, Plus, FolderOpen, Save, RotateCcw,
  Sun, Moon, SunMoon, Menu, Info,
} from 'lucide-react';
import heidIconLight from './assets/heid-icon-light.svg';
import heidIconDark from './assets/heid-icon-dark.svg';
import { cn } from './lib/utils';
import { CodeEditor } from './components/CodeEditor';
import { WindowControls } from './components/WindowControls';
import { detectLanguageFromPath, LANGUAGE_LABELS } from './lib/codemirror';

/* ---------- types ---------- */

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
}

/* ---------- file system helpers (Tauri desktop / web File System Access API) ---------- */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function supportsFsAccess(): boolean {
  return typeof (window as any).showOpenFilePicker === 'function';
}

const READ_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs', '.rb', '.php',
  '.html', '.htm', '.css', '.scss', '.less', '.json', '.yaml', '.yml',
  '.xml', '.md', '.sh', '.bash', '.sql', '.toml', '.ini', '.txt',
  '.swift', '.kt', '.kts', '.scala', '.vue', '.svelte',
];

interface OpenedFile {
  content: string;
  name: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
}

async function readLocalPath(path: string): Promise<OpenedFile> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  const content = new TextDecoder().decode(bytes);
  const name = path.split(/[\\/]/).pop() || path;
  return { content, name, path, handle: null };
}

async function pickAndReadFile(): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: '文本文件', extensions: READ_EXTENSIONS.map(e => e.slice(1)) }],
    });
    if (typeof selected !== 'string') return null;
    return await readLocalPath(selected);
  }
  if (supportsFsAccess()) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Text files', accept: { 'text/*': READ_EXTENSIONS } }],
      });
      const file = await handle.getFile();
      const content = await file.text();
      return { content, name: file.name, path: file.name, handle };
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
      const content = await file.text();
      resolve({ content, name: file.name, path: file.name, handle: null });
    };
    input.click();
  });
}

interface SaveResult {
  ok: boolean;
  savedPath: string | null;
}

async function writeLocalPath(path: string, content: string): Promise<void> {
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, new TextEncoder().encode(content));
}

async function saveFileToDisk(tab: FileTab, content: string): Promise<SaveResult> {
  const encoder = new TextEncoder();
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const target = tab.path ?? await save({ defaultPath: tab.title });
    if (!target) return { ok: false, savedPath: null };
    try {
      await writeLocalPath(target, content);
      return { ok: true, savedPath: target };
    } catch (e) {
      console.error('Save failed:', e);
      return { ok: false, savedPath: null };
    }
  }
  if (tab.handle) {
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
  // fallback: download
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
    doc: '// 在这里开始输入...',
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

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now()}-${tabCounter}`;
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

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('heid-theme-mode');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  /* 系统主题变化监听（跟随系统模式使用） */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem('heid-theme-mode', themeMode);
  }, [themeMode]);

  const isDarkMode = themeMode === 'dark' || (themeMode === 'system' && systemDark);

  const [tabs, setTabs] = useState<FileTab[]>(() => [
    {
      id: nextTabId(),
      title: 'welcome.ts',
      path: null,
      handle: null,
      content: SAMPLE_CODE,
      originalContent: SAMPLE_CODE,
      language: 'typescript',
      isDirty: false,
      readOnly: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(() => '');
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
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

  const openPathIntoTab = useCallback(async (path: string) => {
    try {
      const { content, name } = await readLocalPath(path);
      const language = detectLanguageFromPath(name);
      const existing = tabsRef.current.find(t => t.path === path);
      if (existing) {
        setTabs(prev => prev.map(t => t.id === existing.id
          ? { ...t, content, originalContent: content, isDirty: false }
          : t
        ));
        setActiveTabIdRef.current(existing.id);
        return;
      }
      const newTab: FileTab = {
        id: nextTabId(),
        title: name,
        path,
        handle: null,
        content,
        originalContent: content,
        language,
        isDirty: false,
        readOnly: false,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabIdRef.current(newTab.id);
    } catch (e) {
      console.error('Failed to open file:', path, e);
      alert(`无法打开文件：${path}`);
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

  /* ---- global shortcuts ---- */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        handleOpenFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleNewFile();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  /* ---- tab operations ---- */

  const updateTabContent = useCallback((tabId: string, content: string) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== tabId) return t;
      return { ...t, content, isDirty: content !== t.originalContent };
    }));
  }, []);

  const closeTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.isDirty) {
      if (!window.confirm(`"${tab.title}" 有未保存的更改，确定关闭吗？`)) return;
    }
    setTabs(prev => prev.filter(t => t.id !== tabId));
  }, [tabs]);

  const handleOpenFile = useCallback(async () => {
    const result = await pickAndReadFile();
    if (!result) return;
    const { content, name, path, handle } = result;
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
      readOnly: false,
    };
    // if same file is already open, focus it
    const existing = tabs.find(t => t.path === path && !t.isDirty);
    if (existing) {
      setTabs(prev => prev.map(t => t.id === existing.id
        ? { ...t, content, originalContent: content, handle }
        : t
      ));
      setActiveTabId(existing.id);
      return;
    }
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs]);

  const handleNewFile = useCallback(() => {
    const newTab: FileTab = {
      id: nextTabId(),
      title: `untitled-${tabCounter + 1}.txt`,
      path: null,
      handle: null,
      content: '',
      originalContent: '',
      language: 'plaintext',
      isDirty: false,
      readOnly: false,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeTab || activeTab.readOnly) return;
    setSaving(true);
    try {
      const result = await saveFileToDisk(activeTab, activeTab.content);
      if (result.ok) {
        const savedPath = result.savedPath ?? activeTab.path;
        const savedTitle = savedPath ? savedPath.split(/[\\/]/).pop() || activeTab.title : activeTab.title;
        setTabs(prev => prev.map(t => t.id === activeTab.id
          ? { ...t, originalContent: t.content, isDirty: false, path: savedPath, title: savedTitle }
          : t
        ));
      }
    } finally {
      setSaving(false);
    }
  }, [activeTab]);

  const handleRevert = useCallback(() => {
    if (!activeTab) return;
    updateTabContent(activeTab.id, activeTab.originalContent);
  }, [activeTab, updateTabContent]);

  const handleWindowClose = useCallback(async (): Promise<boolean> => {
    const dirtyCount = tabsRef.current.filter(t => t.isDirty).length;
    if (dirtyCount === 0) return true;
    const message = `${dirtyCount} 个标签页有未保存的更改，确定退出吗？`;
    // Tauri 的 WebView2 不弹 window.confirm，桌面端走 dialog 插件的原生对话框
    if (isTauri) {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      return await ask(message, { title: 'Nexus Editor', kind: 'warning' });
    }
    return window.confirm(message);
  }, []);

  /* ---- render ---- */

  const isMarkdown = activeTab?.language === 'markdown';

  return (
    <div className={cn(
      "h-screen flex flex-col overflow-hidden",
      isDarkMode ? "bg-zinc-900 text-zinc-200" : "bg-zinc-50 text-zinc-800"
    )}>
      {/* title bar：logo + 标签页 + 新建 + 窗口控制（空白处可拖拽移动，双击最大化） */}
      <div
        data-tauri-drag-region
        className={cn(
          "h-10 border-b flex items-center pl-3 gap-1.5 shrink-0 select-none",
          isDarkMode ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-white"
        )}
      >
        <div className="flex items-center gap-2 shrink-0" data-tauri-drag-region>
          <HeidMark className="w-10 h-3.5 shrink-0" />
          <span className="text-sm font-semibold tracking-tight" data-tauri-drag-region>H.E.I.D</span>
        </div>

        {/* 标签页 */}
        <div data-tauri-drag-region className="min-w-0 flex items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] shrink-0",
              activeTabId === tab.id
                ? (isDarkMode ? "bg-zinc-700 text-zinc-100" : "bg-zinc-200 text-zinc-800")
                : (isDarkMode ? "text-zinc-500 hover:bg-zinc-700/50" : "text-zinc-500 hover:bg-zinc-100")
              )}
            >
              <span className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                tab.isDirty ? "bg-amber-500" : (activeTabId === tab.id ? "bg-emerald-500" : (isDarkMode ? "bg-zinc-600" : "bg-zinc-300"))
              )} />
              <FileText size={12} className="shrink-0 opacity-60" />
              <span className="truncate">{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm hover:bg-zinc-500/20 transition-all shrink-0"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={handleNewFile}
          className={cn(
            "p-1.5 rounded-md transition-colors shrink-0",
            isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-100 text-zinc-500"
          )}
          title="新建文件 (Ctrl+N)"
        >
          <Plus size={15} />
        </button>

        <div className="flex-1 h-full" data-tauri-drag-region />

        <WindowControls isDarkMode={isDarkMode} onRequestClose={handleWindowClose} />
      </div>

      {/* 菜单栏 */}
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
          title="菜单"
        >
          <Menu size={15} />
        </button>

        <div className="flex-1" />

        {/* 主题三档切换：浅色 | 跟随系统 | 深色 */}
        <div
          role="group"
          aria-label="主题模式"
          className={cn(
            "flex items-center rounded-full p-0.5 shrink-0",
            isDarkMode ? "bg-zinc-700/60" : "bg-zinc-200/80"
          )}
        >
          {([
            { mode: 'light', icon: Sun, title: '主题：浅色', activeColor: 'text-amber-500' },
            { mode: 'system', icon: SunMoon, title: '主题：跟随系统', activeColor: isDarkMode ? 'text-zinc-100' : 'text-zinc-700' },
            { mode: 'dark', icon: Moon, title: '主题：深色', activeColor: 'text-indigo-400' },
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

        {menuOpen && (
          <div className={cn(
            "absolute left-2 top-full -mt-px z-50 w-52 rounded-md border shadow-lg py-1 flex flex-col",
            isDarkMode ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-white"
          )}>
            <button
              onClick={() => { setMenuOpen(false); handleOpenFile(); }}
              className={cn(
                "w-full px-3 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
              )}
            >
              <FolderOpen size={14} />
              打开文件
              <span className="ml-auto text-[10px] opacity-50">Ctrl+O</span>
            </button>
            <button
              onClick={() => { setMenuOpen(false); handleSave(); }}
              disabled={!activeTab || activeTab.readOnly || saving}
              className={cn(
                "w-full px-3 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40",
                isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
              )}
            >
              <Save size={14} />
              保存
              <span className="ml-auto text-[10px] opacity-50">Ctrl+S</span>
            </button>
            <div className={cn("h-px mx-2 my-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
            <button
              onClick={() => { setMenuOpen(false); setAboutOpen(true); }}
              className={cn(
                "w-full px-3 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors",
                isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
              )}
            >
              <Info size={14} />
              关于 H.E.I.D
            </button>
          </div>
        )}
      </div>

      {/* editor area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeTab ? (
          <>
            {/* editor */}
            <div className="flex-1 overflow-hidden">
              <CodeEditor
                key={activeTab.id}
                value={activeTab.content}
                language={activeTab.language}
                isDarkMode={isDarkMode}
                editable={!activeTab.readOnly}
                onChange={(v) => updateTabContent(activeTab.id, v)}
                onSave={handleSave}
              />
            </div>

            {/* bottom status bar：文件信息 + 还原 + 模式 */}
            <div className={cn(
              "h-6 border-t flex items-center px-4 gap-2 text-[11px] shrink-0",
              isDarkMode ? "border-zinc-700 bg-zinc-800 text-zinc-500" : "border-zinc-200 bg-zinc-100 text-zinc-500"
            )}>
              <span className="truncate" title={activeTab.path || '未保存'}>{activeTab.path || '未保存'}</span>
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0">{LANGUAGE_LABELS[activeTab.language] || activeTab.language}</span>
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0">{formatFileSize(activeTab.content)}</span>
              <span className="shrink-0 opacity-50">|</span>
              <span className="shrink-0">{activeTab.content.split('\n').length} 行</span>
              {activeTab.isDirty && <span className="shrink-0 text-amber-500 font-medium">未保存</span>}
              <div className="flex-1" />
              {!activeTab.readOnly && (
                <button
                  onClick={handleRevert}
                  disabled={!activeTab.isDirty}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 disabled:opacity-40",
                    isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
                  )}
                  title="还原到上次保存的内容"
                >
                  <RotateCcw size={10} /> 还原
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6">
            <div className={cn(
              "w-20 h-20 rounded-full flex items-center justify-center mb-4",
              isDarkMode ? "bg-zinc-800" : "bg-zinc-200"
            )}>
              <Code2 size={32} className={cn(isDarkMode ? "text-zinc-400" : "text-zinc-500")} />
            </div>
            <h3 className="text-lg font-medium mb-1">Nexus Editor</h3>
            <p className="text-sm text-zinc-500 max-w-sm text-center mb-4">
              打开一个文件开始编辑，或新建一个空白文件
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleOpenFile}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200" : "bg-zinc-200 hover:bg-zinc-300 text-zinc-700"
                )}
              >
                <FolderOpen size={16} /> 打开文件
              </button>
              <button
                onClick={handleNewFile}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300" : "bg-white hover:bg-zinc-50 text-zinc-600 border border-zinc-200"
                )}
              >
                <Plus size={16} /> 新建文件
              </button>
            </div>
          </div>
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
                title="关闭"
              >
                <X size={14} />
              </button>
              <img
                src={isDarkMode ? heidIconDark : heidIconLight}
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
                版本 1.0.0
              </div>
              <p className={cn(
                "mt-4 text-xs leading-relaxed",
                isDarkMode ? "text-zinc-400" : "text-zinc-500"
              )}>
                一款以语法高亮为核心的轻量级智能文档编辑器，
                基于 Tauri 2 与 CodeMirror 6 构建，
                支持多语言高亮、迷你地图、粘性滚动与代码折叠。
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
  );
}
