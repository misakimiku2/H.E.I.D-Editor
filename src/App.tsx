import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText, X, Plus, FolderOpen, Save, SaveAll, RotateCcw,
  Sun, Moon, SunMoon, Menu, Info, Eye, Pencil, Undo2, Redo2,
  GitCompare, Columns2, History, ChevronRight, Trash2, Settings, Keyboard, FileDown, Link2, PanelLeft, FolderX,
  Table, Code,
} from 'lucide-react';
import heidIconLight from './assets/heid-icon-light.svg';
import heidIconDark from './assets/heid-icon-dark.svg';
import { cn } from './lib/utils';
import { CodeEditor } from './components/CodeEditor';
import { CsvGridEditor } from './components/CsvGridEditor';
import { LargeFileViewer } from './components/LargeFileViewer';
import { detectDelimiter, delimiterLabel, CSV_GRID_MAX_CHARS, CSV_GRID_MAX_ROWS, type CsvDelimiter } from './lib/csv';
import { MarkdownPreview, type MarkdownPreviewHandle } from './components/MarkdownPreview';
import { WindowControls } from './components/WindowControls';
import { DiffModal } from './components/DiffModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { AlertDialog } from './components/AlertDialog';
import { NotificationStack } from './components/NotificationStack';
import { ReleaseNotesModal } from './components/ReleaseNotesModal';
import { ImageViewer } from './components/ImageViewer';
import { SvgWorkbench } from './components/SvgWorkbench';
import { resolveImageSrc, ImageForbiddenError } from './lib/imageSrc';
import { appAlert, registerAppAlert } from './lib/appAlert';
import { clampDiffEntries } from './lib/diffTimeline';
import { useExternalFileWatcher } from './hooks/useExternalFileWatcher';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY, NARROW_QUERY, displayNameFromPath } from './lib/platform';
import { LANGUAGE_LABELS, detectLanguageFromPath } from './lib/codemirror';
import {
  EOL_LABELS, applyLineEnding, type LineEnding,
} from './lib/lineEndings';
import { ENCODING_OPTIONS, encodingLabel } from './lib/encoding';
import { clearRecentFiles } from './lib/recentFiles';
import {
  loadSettings, saveSettings, type EditorSettings,
} from './lib/settings';
import { countWords } from './lib/wordCount';
import { translate, resolveSystemLang, type Lang, type MessageKey } from './lib/i18n';
import { I18nProvider, rt, setRuntimeLang } from './lib/i18nContext';
import { deleteDraft, draftKeyForTab } from './lib/drafts';
import { SettingsDialog } from './components/SettingsDialog';
import { UrlImportModal } from './components/UrlImportModal';
import { FileTreeSidebar } from './components/FileTreeSidebar';
import { getDirLister, isSvgPath, loadTreeRoot, saveTreeRoot } from './lib/fileTree';
import type { UrlImportResult } from './lib/urlImport';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useLastPointer } from './hooks/useLastPointer';
import { TopAppBar } from './components/mobile/TopAppBar';
import { BottomToolbar } from './components/mobile/BottomToolbar';
import { TabSheet } from './components/mobile/TabSheet';
import { androidCreateDoc, androidWriteUri, formatFileSize, isTauri, writeLocalPath } from './lib/fileIO';
import {
  INITIAL_WELCOME_ID, makeUntitledTab, makeWelcomeTab,
  type FileTab, type MdViewMode,
} from './lib/tabModel';
import { LARGE_HISTORY_CHARS } from './lib/tabHistory';
import { useTheme } from './hooks/useTheme';
import { useEditorState } from './hooks/useEditorState';
import { useDiffTimelines } from './hooks/useDiffTimelines';
import { useDiscardConfirm } from './hooks/useDiscardConfirm';
import { useFileActions } from './hooks/useFileActions';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import { usePlatformIntegration } from './hooks/usePlatformIntegration';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useSplitScroll } from './hooks/useSplitScroll';
import { useUpdater } from './hooks/useUpdater';
import { useUpdateNotifications } from './hooks/useUpdateNotifications';
import {
  consumeStartupReleaseNotes, FALLBACK_APP_VERSION, loadReleaseNotes,
  type StoredReleaseNotes,
} from './lib/update';

/* ---------- App ---------- */

/* H.I.D.E 品牌 >_< 标识（简化自应用图标，随主题变色） */
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

export default function App() {
  const { themeMode, setThemeMode, isDarkMode } = useTheme();

  /* 移动端形态：安卓且窄屏（手机）采用专属布局；安卓宽屏（平板）沿用桌面布局 */
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isPhone = IS_ANDROID_APP && isNarrow;

  /* ---- 编辑器设置（弹窗修改即时生效 + 持久化）---- */
  const [settings, setSettings] = useState<EditorSettings>(() => loadSettings());
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  /* ---- 界面语言：settings.language 解析为具体语言；rt/setRuntimeLang 供模块级文案使用 ---- */
  const lang: Lang = settings.language === 'system'
    ? resolveSystemLang(typeof navigator !== 'undefined' ? navigator.language : undefined)
    : settings.language;
  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  useEffect(() => { setRuntimeLang(lang); }, [lang]);

  /* ---- 状态装配：diff 时间线 → 编辑器核心（标签页+撤销历史）→ 丢弃确认 → 外部监听 → 文件操作 → 会话 ---- */
  const diff = useDiffTimelines();
  const editor = useEditorState({
    maxDiffEntries: diff.maxDiffEntries,
    onInternalEdit: diff.recordInternalEdit,
    initialTabs: [makeWelcomeTab(INITIAL_WELCOME_ID)],
  });
  const { pendingDiscard, pendingDiscardRef, askDiscardConfirm } = useDiscardConfirm();
  /* 保存并退出进行中，忽略期间的重复关闭请求 */
  const exitingRef = useRef(false);

  /* 检测到真实外部修改：追加时间线条目（按用户设置的保留条数裁剪），并按标签页脏状态分流处理 */
  const handleExternalChange = useCallback((path: string, before: string, after: string) => {
    diff.appendExternalEntry(path, before, after, Date.now());
    // 先为干净标签页以 major 方式记撤销历史（Ctrl+Z 可回退这次外部替换），再统一更新状态
    for (const t of editor.tabsRef.current) {
      if (t.path === path && !t.isDirty) editor.recordContentChange(t.id, t.content, after, true, 'external');
    }
    editor.setTabs(prev => prev.map(t => {
      if (t.path !== path) return t;
      if (!t.isDirty) {
        // 干净：内容与 originalContent 同步为新磁盘内容，不产生脏状态
        return { ...t, content: after, originalContent: after, isDirty: false };
      }
      // 脏：编辑器内容不动，originalContent 跟踪磁盘最后已知状态，保留冲突标记
      return { ...t, originalContent: after, isDirty: t.content !== after || t.eol !== t.originalEol };
    }));
  }, [diff.appendExternalEntry, editor.recordContentChange, editor.setTabs, editor.tabsRef]);

  /* 浏览器模式与安卓（fs watch 不支持且 SAF 无真实路径）不监听外部，但内部时间线照常记录 */
  const watchedPaths = useMemo(
    () => (isTauri && !IS_ANDROID_APP ? editor.referencedPaths : []),
    [editor.referencedPaths]
  );
  const { updateKnownDiskContent } = useExternalFileWatcher({
    paths: watchedPaths,
    enabled: isTauri && !IS_ANDROID_APP,
    onExternalChange: handleExternalChange,
  });

  const file = useFileActions({
    editor,
    askDiscardConfirm,
    pendingDiscardRef,
    exitingRef,
    updateKnownDiskContent,
    autosaveEnabled: settings.autosaveEnabled,
    autosaveIntervalSec: settings.autosaveIntervalSec,
    t,
  });
  const { writeSessionSnapshot } = useSessionPersistence({
    tabsRef: editor.tabsRef,
    activeTabIdRef: editor.activeTabIdRef,
    setTabs: editor.setTabs,
    setActiveTabId: editor.setActiveTabId,
  });

  /* 快照跟随标签页变化 */
  useEffect(() => {
    writeSessionSnapshot();
  }, [editor.tabs, editor.activeTab, writeSessionSnapshot]);

  /* ---- 撤销外部修改：把该条 before 写回磁盘（按该文件标签页的编码/换行符），编辑器同步回退 ---- */
  const diffTimelinesRef = useRef(diff.diffTimelines);
  diffTimelinesRef.current = diff.diffTimelines;
  const internalDiffTimelinesRef = useRef(diff.internalDiffTimelines);
  internalDiffTimelinesRef.current = diff.internalDiffTimelines;

  const handleRevertDiff = useCallback(async (path: string, entryId: string) => {
    const entry = (diffTimelinesRef.current[path] ?? []).find(e => e.id === entryId);
    if (!entry) return;
    const refTab = editor.tabsRef.current.find(t => t.path === path);
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
    diff.dropExternalFrom(path, entryId);
    // 该路径所有标签页的 originalContent 同步为写回内容（它始终跟踪磁盘最后已知状态）
    for (const t of editor.tabsRef.current) {
      if (t.path === path && !t.isDirty) editor.recordContentChange(t.id, t.content, entry.before, true, 'revert');
    }
    editor.setTabs(prev => prev.map(t => {
      if (t.path !== path) return t;
      if (!t.isDirty) {
        // 干净：编辑器内容同步回退并计入撤销历史
        return { ...t, content: entry.before, originalContent: entry.before, isDirty: false };
      }
      // 脏：本地内容不动，isDirty 依据新的 originalContent 重新成立
      return { ...t, originalContent: entry.before, isDirty: t.content !== entry.before || t.eol !== t.originalEol };
    }));
  }, [diff, editor.recordContentChange, editor.setTabs, editor.tabsRef, updateKnownDiskContent]);

  /* 撤销（内部）：把编辑器内容恢复到该条 before（磁盘不动），该条及其后所有条目移除。
     回退本身以 major 记入撤销历史（Ctrl+Z 可恢复），source=revert 不再进时间线 */
  const handleRevertInternalDiff = useCallback((path: string, entryId: string) => {
    const entry = (internalDiffTimelinesRef.current[path] ?? []).find(e => e.id === entryId);
    if (!entry) return;
    diff.dropInternalFrom(path, entryId);
    for (const t of editor.tabsRef.current) {
      if (t.path === path) editor.recordContentChange(t.id, t.content, entry.before, true, 'revert');
    }
    editor.setTabs(prev => prev.map(t => {
      if (t.path !== path) return t;
      return { ...t, content: entry.before, isDirty: entry.before !== t.originalContent || t.eol !== t.originalEol };
    }));
  }, [diff, editor.recordContentChange, editor.setTabs, editor.tabsRef]);

  /* 路径不再被任何标签页引用：丢弃其两条时间线（外部监听由 hook 自行拆除清理） */
  useEffect(() => {
    const live = new Set(editor.referencedPaths);
    const dropStale = <T,>(prev: Record<string, T[]>): Record<string, T[]> => {
      const stale = Object.keys(prev).filter(p => !live.has(p));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      stale.forEach(p => delete next[p]);
      return next;
    };
    diff.setDiffTimelines(dropStale);
    diff.setInternalDiffTimelines(dropStale);
  }, [editor.referencedPaths, diff.setDiffTimelines, diff.setInternalDiffTimelines]);

  /* 提醒与当前标签页联动：只统计激活文件自己的未处理条数（每标签独立，切换标签页即切换提醒） */
  const activePendingDiffs = editor.activeTab?.path ? (diff.diffTimelines[editor.activeTab.path]?.length ?? 0) : 0;

  /* ---- 查找 / 替换 / 跳转到行（编辑器内浮层 + 预览查找，弹出在指针位置）---- */
  const [findState, setFindState] = useState({ open: false, showReplace: false, goto: false });
  const openFind = useCallback((showReplace = false, goto = false) => {
    /* 查找栏挂在 CodeEditor 上；大文件分块预览标签无编辑器，窗口流式查找未在范围 */
    if (editor.activeTab?.largePreview) return;
    setFindState({ open: true, showReplace, goto });
  }, [editor.activeTab]);
  const closeFind = useCallback(() => {
    setFindState(s => ({ ...s, open: false }));
  }, []);
  const getPointer = useLastPointer();

  /* ---- 弹层与 UI 状态 ---- */
  const [menuOpen, setMenuOpen] = useState(false);
  /* 应用内警示弹窗（毛玻璃，替代原生 alert）：lib 层经 appAlert() 全局入口触发 */
  const [alertState, setAlertState] = useState<{ message: string; resolve: () => void } | null>(null);
  const showAlert = useCallback((message: string) => {
    return new Promise<void>(resolve => {
      setAlertState(prev => { prev?.resolve(); return { message, resolve }; });
    });
  }, []);
  const closeAlert = useCallback(() => {
    setAlertState(s => { s?.resolve(); return null; });
  }, []);
  useEffect(() => {
    registerAppAlert(showAlert);
    return () => registerAppAlert(null);
  }, [showAlert]);
  /* 标签栏右键菜单（tabId 为 null 表示右键在标签条空白处，无「关闭其他」锚点） */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string | null } | null>(null);
  /* 通用图片查看器（文件树点击图片文件打开，复用预览内的查看器组件） */
  const [imageViewer, setImageViewer] = useState<{ src: string; name: string } | null>(null);
  const openImageInViewer = useCallback(async (path: string) => {
    try {
      const src = await resolveImageSrc(path);
      setImageViewer({ src, name: displayNameFromPath(path) });
    } catch (e) {
      appAlert(e instanceof ImageForbiddenError ? t('image.errForbidden') : t('image.errLoad'));
    }
  }, [t]);

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeRootPath, setTreeRootPath] = useState<string | null>(() => loadTreeRoot());
  useEffect(() => { saveTreeRoot(treeRootPath); }, [treeRootPath]);

  /* ---- 文件树管理操作的标签页同步与危险确认（管理命令在 FileTreeSidebar 内执行） ---- */

  /** 删除确认（复用全局自绘确认弹窗，标题换为删除语义） */
  const askTreeConfirm = useCallback((message: string, confirmText: string) => {
    return askDiscardConfirm(message, confirmText, undefined, t('tree.deleteTitle')).then(d => d === 'discard');
  }, [askDiscardConfirm, t]);

  /** 树内重命名/移动后同步受影响标签页：文件自身换路径，目录则替换其子树前缀 */
  const handleTreeTabsRenamed = useCallback((oldPath: string, newPath: string, isDir: boolean) => {
    const prefix = oldPath.endsWith('/') || oldPath.endsWith('\\') ? oldPath : oldPath + '/';
    editor.setTabs(prev => prev.map(tab => {
      const retab = (np: string) => ({
        ...tab, path: np, title: displayNameFromPath(np), language: detectLanguageFromPath(np),
      });
      if (tab.path === oldPath) return retab(newPath);
      if (isDir && tab.path && tab.path.startsWith(prefix)) return retab(newPath + tab.path.slice(oldPath.length));
      return tab;
    }));
  }, [editor.setTabs]);

  /** 树内删除后同步标签页：干净标签直接关闭；脏标签摘除路径保留缓冲（保存时走另存为） */
  const handleTreeFileDeleted = useCallback((path: string) => {
    editor.setTabs(prev => prev.flatMap(tab => {
      if (tab.path !== path) return [tab];
      return tab.isDirty && !tab.readOnly ? [{ ...tab, path: null }] : [];
    }));
  }, [editor.setTabs]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<MarkdownPreviewHandle | null>(null);

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
  }, [menuOpen, cancelRecentSubTimer]);

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

  /* ---- 全局快捷键 ---- */
  const hasTabRef = useRef(!!editor.activeTab);
  hasTabRef.current = !!editor.activeTab;
  useAppShortcuts({
    save: file.handleSave,
    saveAs: file.handleSaveAs,
    openFile: file.handleOpenFile,
    newFile: file.handleNewFile,
    undo: editor.handleUndo,
    redo: editor.handleRedo,
    openFind,
    closeActiveTab: () => {
      if (editor.activeTabIdRef.current) void file.closeTab(editor.activeTabIdRef.current);
    },
    switchTab: (delta) => {
      const list = editor.tabsRef.current;
      if (list.length < 2) return;
      const idx = list.findIndex(t => t.id === editor.activeTabIdRef.current);
      editor.setActiveTabIdRef.current(list[(idx + delta + list.length) % list.length].id);
    },
    hasTab: () => hasTabRef.current,
  });

  /* ---- 退出确认：有未保存标签时弹应用内确认弹窗，返回是否允许关闭 ---- */
  const confirmWindowClose = useCallback(async (): Promise<boolean> => {
    if (exitingRef.current) return false;
    const dirtyCount = editor.tabsRef.current.filter(t => t.isDirty).length;
    if (dirtyCount === 0) return true;
    const decision = await askDiscardConfirm(
      t('confirm.exitDirtyTitle', { n: dirtyCount }),
      t('confirm.exitNoSave'),
      t('confirm.exitAndSave'),
    );
    if (decision === 'cancel') return false;
    if (decision === 'discard') {
      /* 用户明确放弃：清除脏标签草稿并刷新快照，标签不应在崩溃恢复中"复活" */
      for (const tb of editor.tabsRef.current) {
        if (tb.isDirty) deleteDraftFor(tb);
      }
      writeSessionSnapshot();
      return true;
    }
    /* 退出并保存：逐个落盘（有路径静默写盘，无路径走另存为对话框），
       任一保存被取消/失败则中止退出留在应用，避免静默丢数据 */
    exitingRef.current = true;
    try {
      const dirty = editor.tabsRef.current.filter(t => t.isDirty && !t.readOnly);
      for (const tab of dirty) {
        const ok = await file.persistTab(tab, !tab.path);
        if (!ok) return false;
      }
      writeSessionSnapshot();
      return true;
    } finally {
      exitingRef.current = false;
    }
  }, [askDiscardConfirm, file.persistTab, writeSessionSnapshot, editor.tabsRef, t]);
  const confirmWindowCloseRef = useRef(confirmWindowClose);
  confirmWindowCloseRef.current = confirmWindowClose;

  /* ---- 更新说明（只读文档）：更新重启后自动展示一次；「关于」里可重看最近一次 ---- */
  const [releaseNotes, setReleaseNotes] = useState<StoredReleaseNotes | null>(() => loadReleaseNotes());
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);

  /* ---- 平台适配（拖拽 / 链接守卫 / 关闭拦截 / 安卓返回键与安全区 / 浏览器兜底）---- */
  const overlayState = {
    tabSheetOpen, menuOpen, aboutOpen, pendingDiscard, findOpen: findState.open, settingsOpen, shortcutsOpen, tabMenuOpen: !!tabMenu,
    releaseNotesOpen,
  };
  usePlatformIntegration({
    openPathIntoTab: file.openPathIntoTab,
    tabsRef: editor.tabsRef,
    confirmWindowCloseRef,
    overlayState,
    overlayActions: {
      cancelDiscard: () => pendingDiscard?.resolve('cancel'),
      closeFind,
      closeSettings: () => setSettingsOpen(false),
      closeShortcuts: () => setShortcutsOpen(false),
      closeTabMenu: () => setTabMenu(null),
      closeTabSheet: () => setTabSheetOpen(false),
      closeMenu: () => setMenuOpen(false),
      closeAbout: () => setAboutOpen(false),
      closeReleaseNotes: () => setReleaseNotesOpen(false),
    },
  });

  /* ---- 分屏同步滚动 ---- */
  const { attachEditorScroller, attachPreviewScroller } = useSplitScroll();

  /* ---- 应用更新（桌面签名安装 / 安卓版本检查提示；每次启动自动静默检查一次）---- */
  const updater = useUpdater();
  useUpdateNotifications(updater, t);
  const [appVersion, setAppVersion] = useState<string>(FALLBACK_APP_VERSION);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    import('@tauri-apps/api/app')
      .then(m => m.getVersion())
      .then(v => { if (!cancelled && v) setAppVersion(v); })
      .catch(() => { /* 保留兜底版本号 */ });
    return () => { cancelled = true; };
  }, []);

  /* 更新重启后：消费「当前版本」的未展示说明（只自动弹一次；空说明不弹，仍可在「关于」重看）；
     发现新版本时同步「关于」入口可用态 */
  useEffect(() => {
    if (!isTauri) return;
    const pending = consumeStartupReleaseNotes(appVersion);
    setReleaseNotes(loadReleaseNotes());
    if (pending && pending.notes.trim().length > 0) setReleaseNotesOpen(true);
  }, [appVersion]);
  /* 自动检查发现新版本时，通知编排 hook 已把说明落盘——同步「关于」入口的可用态 */
  useEffect(() => {
    if (updater.phase === 'available') setReleaseNotes(loadReleaseNotes());
  }, [updater.phase]);

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
    editor.setTabs(prev => [...prev, newTab]);
    editor.setActiveTabId(newTab.id);
  }, [editor.setActiveTabId, editor.setTabs]);

  /* ---- Markdown 导出为单文件 HTML（桌面另存对话框 / 安卓 SAF 新建文档 / 浏览器 Blob 下载） ---- */
  const handleExportHtml = useCallback(async () => {
    const tab = editor.activeTab;
    if (!tab || tab.language !== 'markdown' || tab.binary) return;
    try {
      const { renderMarkdownToHtml } = await import('./lib/markdownHtml');
      const baseName = tab.title.replace(/\.md$/i, '') || 'export';
      const html = await renderMarkdownToHtml(tab.content, { title: baseName, dark: isDarkMode });
      if (IS_ANDROID_APP) {
        const created = await androidCreateDoc(baseName, 'text/html');
        if (!created) return;
        const ok = await androidWriteUri(created.uri, html, 'utf-8', false);
        if (!ok) appAlert(rt('save.errAndroidWrite'));
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
      appAlert(t('export.errGeneric', { msg: e?.message ?? String(e) }));
    }
  }, [editor.activeTab, isDarkMode, t]);

  /* ---- 状态栏弹出菜单（编码 / 换行符）---- */
  type StatusMenu = null | 'encoding-root' | 'encoding-reopen' | 'encoding-save' | 'eol';
  const [statusMenu, setStatusMenu] = useState<StatusMenu>(null);
  const statusItemCls = cn(
    "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors text-left",
    isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
  );

  /* ---- 状态栏光标信息（行/列/选中字符数）---- */
  const [cursorInfo, setCursorInfo] = useState({ line: 1, col: 1, selChars: 0 });
  useEffect(() => {
    setCursorInfo({ line: 1, col: 1, selChars: 0 });
  }, [editor.activeTabId]);

  /* ---- render ---- */

  const activeTab = editor.activeTab;
  const isMarkdown = activeTab?.language === 'markdown';

  /* ---- CSV 网格视图：检测分隔符、行列规模、性能闸门 ----
     csvView 未设置时按闸门取默认（超大文件默认文本视图，工具栏可手动切网格） */
  const isCsv = activeTab?.language === 'csv';
  const activeContent = activeTab?.content ?? '';
  const csvDelimiter: CsvDelimiter = useMemo(
    () => (isCsv ? detectDelimiter(activeContent) : ','),
    [isCsv, activeContent],
  );
  const isLargeCsv = !!isCsv && (
    activeContent.length > CSV_GRID_MAX_CHARS
    || activeContent.split('\n').length > CSV_GRID_MAX_ROWS
  );
  const effectiveCsvView = activeTab
    ? (activeTab.csvView ?? (isLargeCsv ? 'text' : 'grid'))
    : 'grid';
  const csvGridActive = !!isCsv && !!activeTab && !activeTab.binary && effectiveCsvView === 'grid';
  const [csvShape, setCsvShape] = useState({ rows: 0, cols: 0 });
  useEffect(() => { setCsvShape({ rows: 0, cols: 0 }); }, [editor.activeTabId]);
  const handleCsvShape = useCallback((rows: number, cols: number) => {
    setCsvShape(s => (s.rows === rows && s.cols === cols ? s : { rows, cols }));
  }, []);
  /* 网格视图下无光标概念：Ctrl+F 打开查找时自动落到文本视图（查找栏挂在 CodeEditor 上） */
  const [gateBannerClosedId, setGateBannerClosedId] = useState<string | null>(null);
  useEffect(() => {
    if (findState.open && csvGridActive) editor.setCsvState({ csvView: 'text' });
  }, [findState.open, csvGridActive]);

  /* ---- 大文件只读分块预览（第二层）：无编辑器/网格/预览概念，主区域整块让给 LargeFileViewer ---- */
  const isLargePreview = !!activeTab?.largePreview;
  /* 提取片段编辑出口：当前窗口内容进新标签页（普通可编辑标签，走第一层全部能力） */
  const handleExtractFromLarge = useCallback((text: string, fromLine: number, toLine: number, sourceName: string) => {
    const title = t('large.extractedTitle', { name: sourceName, from: fromLine, to: toLine });
    const extracted: FileTab = {
      ...makeUntitledTab(title),
      content: text,
      originalContent: '',
      isDirty: true,
      language: detectLanguageFromPath(sourceName),
    };
    editor.setTabs(prev => [...prev, extracted]);
    editor.setActiveTabId(extracted.id);
  }, [editor, t]);

  /* 手机端无分屏：split 折叠为预览，由底部工具栏在编辑/预览间切换 */
  const effectiveView: MdViewMode = activeTab
    ? (isPhone && activeTab.mdView === 'split' ? 'preview' : activeTab.mdView)
    : 'edit';
  const toggleMdView = () => {
    if (!activeTab) return;
    editor.setMdView(effectiveView === 'preview' ? 'edit' : 'preview');
  };

  /* 编辑器面板当前是否渲染（分屏/编辑态 Ctrl+F 搜索源码）；同步进 ref 供 window 快捷键读取。
     CSV 网格视图下 CodeEditor 未挂载，同样视为不可见（状态栏光标段随之隐藏） */
  const editorVisible = !!activeTab && !csvGridActive && !isLargePreview && !(isMarkdown && effectiveView === 'preview');

  /* 字数统计：Markdown 按 CJK 感知计数，其余按空白分词（200 万字符单次线性扫描，毫秒级） */
  const activeLanguage = activeTab?.language ?? '';
  const wordCountInfo = useMemo(
    () => countWords(activeContent, activeLanguage === 'markdown'),
    [activeContent, activeLanguage],
  );

  /* ---- markdown 预览保活 ----
     记住最近打开的 markdown 标签：切到代码文件或编辑视图时预览只隐藏不卸载，
     切回免全量重解析（MarkdownPreview 的解析是整篇同步的，重挂载是切换卡顿主因）。
     activeTab 是 markdown 时直接用它（同步，避免先渲染旧文档一帧） */
  const [lastMdTabId, setLastMdTabId] = useState<string | null>(null);
  useEffect(() => {
    if (isMarkdown && activeTab) setLastMdTabId(activeTab.id);
  }, [isMarkdown, activeTab]);
  const mdAliveTab = useMemo(() => {
    if (activeTab && isMarkdown) return activeTab;
    return editor.tabs.find(t => t.id === lastMdTabId && t.language === 'markdown') ?? null;
  }, [activeTab, isMarkdown, editor.tabs, lastMdTabId]);
  /* 预览当前是否处于可见形态（分屏 / 纯预览） */
  const previewVisible = isMarkdown && (effectiveView === 'split' || effectiveView === 'preview');
  /* SVG 标签：源码 + 实时可视化预览工作台（svg 是可编辑的代码，不走图片查看器） */
  const isSvgTab = !!activeTab && !activeTab.readOnly && isSvgPath(activeTab.path ?? activeTab.title);

  const renderMdPreview = () => {
    if (!mdAliveTab) return null;
    return (
      <MarkdownPreview
        ref={previewRef}
        docKey={mdAliveTab.id}
        content={mdAliveTab.content}
        isDarkMode={isDarkMode}
        onChange={mdAliveTab.readOnly ? undefined : (v) => editor.updateTabContent(mdAliveTab.id, v, { major: true })}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onUndo={editor.handleUndo}
        onRedo={editor.handleRedo}
        onScroller={attachPreviewScroller}
        findOpen={previewVisible && effectiveView === 'preview' && findState.open ? true : undefined}
        onFindClose={closeFind}
        getPointer={getPointer}
      />
    );
  };

  const renderCsvGrid = () => {
    if (!activeTab) return null;
    return (
      <CsvGridEditor
        key={activeTab.id}
        content={activeTab.content}
        delimiter={csvDelimiter}
        isDarkMode={isDarkMode}
        headerOn={activeTab.csvHeaderOn ?? true}
        manualWidths={activeTab.csvColWidths}
        readOnly={!!activeTab.readOnly}
        onChange={(v) => editor.updateTabContent(activeTab.id, v)}
        onHeaderToggle={(on) => editor.setCsvState({ csvHeaderOn: on })}
        onWidthsChange={(w) => editor.setCsvState({ csvColWidths: w })}
        onShape={handleCsvShape}
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
        onChange={(v, meta) => editor.updateTabContent(activeTab.id, v, meta)}
        onSave={file.handleSave}
        onScroller={attachEditorScroller}
        onCursor={setCursorInfo}
        find={findState.open ? findState : undefined}
        onFindClose={closeFind}
        onFindOpen={() => openFind(false, false)}
        getPointer={getPointer}
        jumpTo={activeTab.jumpRequest}
        onJumpDone={() => editor.setTabs(prev => prev.map(tb => tb.id === activeTab.id ? { ...tb, jumpRequest: undefined } : tb))}
        history={{ canUndo: editor.canUndo, canRedo: editor.canRedo, onUndo: editor.handleUndo, onRedo: editor.handleRedo }}
        markdownMenu={isMarkdown && !activeTab.readOnly
          ? { canUndo: editor.canUndo, canRedo: editor.canRedo, onUndo: editor.handleUndo, onRedo: editor.handleRedo }
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
          title={activeTab?.title ?? 'H.I.D.E'}
          isDirty={!!activeTab?.isDirty}
          isMarkdown={!!isMarkdown}
          saving={file.saving}
          tabCount={editor.tabs.length}
          onOpenTabs={() => setTabSheetOpen(true)}
          onNew={file.handleNewFile}
          onOpen={file.handleOpenFile}
          onSave={file.handleSave}
          onSaveAs={file.handleSaveAs}
          onImportUrl={isTauri ? () => setUrlImportOpen(true) : undefined}
          onOpenDiff={() => setDiffModalOpen(true)}
          onInsertTable={() => { if (isMarkdown) previewRef.current?.insertTable(); }}
          onInsertImage={() => { if (isMarkdown) previewRef.current?.openImageModal(); }}
          onCloseTab={() => activeTab && void file.closeTab(activeTab.id)}
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
          <span className="text-sm font-semibold tracking-tight" data-tauri-drag-region={!IS_ANDROID_APP}>H.I.D.E</span>
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
          {editor.tabs.map((tab) => {
            /* 脏且存在未处理外部 diff：橙色提示点（外圈样式区别于琥珀色脏状态点） */
            const conflicted = tab.isDirty && !!tab.path && (diff.diffTimelines[tab.path]?.length ?? 0) > 0;
            return (
            <div
              key={tab.id}
              onClick={() => editor.setActiveTabId(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-all group max-w-[180px] shrink-0",
              editor.activeTabId === tab.id
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
                  : tab.isDirty ? "bg-amber-500" : (editor.activeTabId === tab.id ? "bg-emerald-500" : (isDarkMode ? "bg-zinc-600" : "bg-zinc-300"))
              )} />
              <FileText size={12} className="shrink-0 opacity-60" />
              <span className="truncate">{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); void file.closeTab(tab.id); }}
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
          onClick={file.handleNewFile}
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
                  onClick={() => editor.setMdView(m)}
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

        {/* CSV 视图两档切换：网格 | 文本（仅 csv 文件显示） */}
        {isCsv && activeTab && (
          <div
            role="group"
            aria-label={t('csv.viewAria')}
            className={cn(
              "flex items-center rounded-full p-0.5 mr-2 shrink-0",
              isDarkMode ? "bg-zinc-700/60" : "bg-zinc-200/80"
            )}
          >
            {([
              { mode: 'grid', icon: Table, title: t('csv.grid') },
              { mode: 'text', icon: Code, title: t('csv.text') },
            ] as const).map(({ mode: m, icon: Icon, title }) => {
              const active = effectiveCsvView === m;
              return (
                <button
                  key={m}
                  onClick={() => editor.setCsvState({ csvView: m })}
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
              onClick={() => { setMenuOpen(false); file.handleOpenFile(); }}
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
                disabled={file.recentFiles.length === 0}
                className={cn(
                  "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none",
                  isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
                )}
              >
                <History size={14} />
                {t('menu.recent')}
                <ChevronRight size={12} className="ml-auto opacity-50" />
              </button>
              {recentSubOpen && file.recentFiles.length > 0 && recentSubPos && createPortal(
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
                    {file.recentFiles.slice(0, 10).map(f => (
                      <button
                        key={f.path}
                        onClick={() => { setMenuOpen(false); void file.openPathIntoTab(f.path); }}
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
                      onClick={() => { file.setRecentFiles(clearRecentFiles()); }}
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
              onClick={() => { setMenuOpen(false); file.handleSave(); }}
              disabled={!activeTab || activeTab.readOnly || file.saving}
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
              onClick={() => { setMenuOpen(false); file.handleSaveAs(); }}
              disabled={!activeTab || activeTab.readOnly || file.saving}
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
              onClick={() => { setMenuOpen(false); editor.handleUndo(); }}
              disabled={!editor.canUndo}
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
              onClick={() => { setMenuOpen(false); editor.handleRedo(); }}
              disabled={!editor.canRedo}
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
            activeTabId={editor.activeTabId}
            tabs={editor.tabs}
            onOpenFile={(p, jump) => void file.openPathIntoTab(p, jump)}
            onOpenImage={(p) => void openImageInViewer(p)}
            onRootChange={handleTreeRootChange}
            onClose={() => setTreeOpen(false)}
            canManage={isTauri && !IS_ANDROID_APP}
            askDangerConfirm={askTreeConfirm}
            onTabsRenamed={handleTreeTabsRenamed}
            onFileDeleted={handleTreeFileDeleted}
          />
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
        {activeTab ? (
          <>
            {/* CSV 性能闸门提示条：超大文件默认文本视图，可手动改用网格 */}
            {isCsv && isLargeCsv && effectiveCsvView === 'text' && gateBannerClosedId !== activeTab.id && (
              <div className={cn(
                "flex items-center gap-3 px-4 py-1.5 text-xs shrink-0",
                isDarkMode ? "bg-amber-500/10 text-amber-300 border-b border-amber-500/20" : "bg-amber-50 text-amber-700 border-b border-amber-200"
              )}>
                <span className="flex-1 truncate">{t('csv.largeNotice')}</span>
                <button
                  className={cn("px-2 py-0.5 rounded-md font-medium shrink-0", isDarkMode ? "hover:bg-amber-500/20" : "hover:bg-amber-100")}
                  onClick={() => editor.setCsvState({ csvView: 'grid' })}
                >
                  {t('csv.largeOpenGrid')}
                </button>
                <button
                  className={cn("p-0.5 rounded-md shrink-0", isDarkMode ? "hover:bg-amber-500/20" : "hover:bg-amber-100")}
                  onClick={() => setGateBannerClosedId(activeTab.id)}
                  title={t('common.close')}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            {/* 行容器恒定：预览槽位永远是第一个子元素（跨视图/跨标签保活不重挂） */}
            <div className="flex flex-1 overflow-hidden">
              {/* 预览保活槽位：不可见时仅 display:none，不卸载 */}
              {mdAliveTab && (
                <div className={cn("min-w-0 overflow-hidden", previewVisible ? "flex-1" : "hidden")}>
                  {renderMdPreview()}
                </div>
              )}
              {isLargePreview ? (
                /* 大文件只读分块预览：主区域整块让给 viewer（无编辑器/网格概念） */
                <div className="flex-1 min-w-0 overflow-hidden">
                  <LargeFileViewer
                    key={activeTab.id}
                    path={activeTab.path!}
                    name={activeTab.title}
                    isDarkMode={isDarkMode}
                    onExtract={handleExtractFromLarge}
                  />
                </div>
              ) : isMarkdown && effectiveView === 'split' ? (
                <>
                  <div className={cn("w-px shrink-0", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
                  <div className="flex-1 min-w-0 overflow-hidden">
                    {renderEditor()}
                  </div>
                </>
              ) : !previewVisible ? (
                csvGridActive ? (
                  <div className="flex-1 min-w-0 overflow-hidden">
                    {renderCsvGrid()}
                  </div>
                ) : isSvgTab ? (
                  <SvgWorkbench content={activeTab.content} isDarkMode={isDarkMode} stacked={isPhone}>
                    {renderEditor()}
                  </SvgWorkbench>
                ) : (
                  <div className="flex-1 min-w-0 overflow-hidden">
                    {renderEditor()}
                  </div>
                )
              ) : null}
            </div>

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
              {isLargePreview && (
                <span className="shrink-0 text-amber-500 font-medium" title={t('large.extractTip')}>{t('large.readonlyChip')}</span>
              )}
              {activeTab.binary && (
                <span className="shrink-0 text-orange-400 font-medium" title={t('status.binaryTip')}>{t('status.binary')}</span>
              )}
              {!activeTab.binary && activeTab.large && (
                <span className="shrink-0" title={t('status.largeTip')}>{t('status.large')}</span>
              )}
              {!activeTab.binary && activeTab.content.length > LARGE_HISTORY_CHARS && (
                <span className="shrink-0" title={t('status.historyReducedTip')}>{t('status.historyReduced')}</span>
              )}
              {/* 大文件预览标签：大小/行数/字数在编辑器内存模型之外（viewer 工具栏展示），状态栏不显示 */}
              {!isLargePreview && (<>
                <span className="shrink-0 opacity-50">|</span>
                <span className="shrink-0">{formatFileSize(activeTab.content)}</span>
                <span className="shrink-0 opacity-50">|</span>
                <span className="shrink-0">{t('status.lines', { n: activeTab.content.split('\n').length })}</span>
              </>)}
              {csvGridActive && (
                <>
                  <span className="shrink-0 opacity-50">|</span>
                  <span className="shrink-0 tabular-nums">{t('csv.shape', { rows: csvShape.rows, cols: csvShape.cols })}</span>
                  <span className="shrink-0 opacity-50">|</span>
                  <span className="shrink-0">{t('csv.delimiter')} {delimiterLabel(csvDelimiter)}</span>
                </>
              )}
              {!isLargePreview && (<>
                <span className="shrink-0 opacity-50">|</span>
                <span className="shrink-0 tabular-nums">
                  {t('status.charCount', { n: wordCountInfo.chars })} · {t('status.wordCount', { n: wordCountInfo.words })}
                </span>
              </>)}
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

              {/* 换行符菜单（大文件预览无编辑/保存概念，隐藏） */}
              {!isLargePreview && (
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
              )}
              {/* 编码菜单（同上隐藏：编码探测在 Rust probe 侧完成） */}
              {!isLargePreview && (
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
              )}
              {!activeTab.readOnly && (
                <button
                  onClick={file.handleRevert}
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
                              if (statusMenu === 'encoding-reopen') void file.reopenWithEncoding(activeTab, opt.id);
                              else void file.convertEncoding(activeTab, opt.id);
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
                          onClick={() => { setStatusMenu(null); file.setTabEol(activeTab, e); }}
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
              alt="H.I.D.E"
              className="w-20 h-20 drop-shadow-md mb-4"
            />
            <h3 className="text-lg font-medium mb-1">H.I.D.E</h3>
            <p className="text-sm text-zinc-500 max-w-sm text-center mb-4">
              {t('empty.hint')}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={file.handleOpenFile}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200" : "bg-zinc-200 hover:bg-zinc-300 text-zinc-700"
                )}
              >
                <FolderOpen size={16} /> {t('menu.openFile')}
              </button>
              <button
                onClick={file.handleNewFile}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors",
                  isDarkMode ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300" : "bg-white hover:bg-zinc-50 text-zinc-600 border border-zinc-200"
                )}
              >
                <Plus size={16} /> {t('menu.newFile')}
              </button>
            </div>

            {/* 最近打开（最多 5 条，悬浮显示完整路径） */}
            {file.recentFiles.length > 0 && (
              <div className="mt-7 w-full max-w-md flex flex-col items-center">
                <span className={cn(
                  "text-[10px] font-semibold tracking-wider uppercase mb-2",
                  isDarkMode ? "text-zinc-500" : "text-zinc-400"
                )}>
                  {t('menu.recent')}
                </span>
                <div className="w-full flex flex-col gap-0.5">
                  {file.recentFiles.slice(0, 5).map(f => (
                    <button
                      key={f.path}
                      onClick={() => void file.openPathIntoTab(f.path)}
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
            externalTimelines={diff.diffTimelines}
            internalTimelines={diff.internalDiffTimelines}
            isDarkMode={isDarkMode}
            focusPath={activeTab?.path ?? null}
            maxEntries={diff.maxDiffEntries}
            onChangeMaxEntries={(n) => diff.setMaxDiffEntries(clampDiffEntries(n))}
            onClose={() => setDiffModalOpen(false)}
            onAccept={(kind, path, id) => (kind === 'external' ? diff.handleAcceptDiff(path, id) : diff.handleAcceptInternalDiff(path, id))}
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
                alt="H.I.D.E"
                className="w-20 h-20 drop-shadow-md"
              />
              <h2 className="mt-4 text-lg font-bold tracking-widest">H.I.D.E</h2>
              <p className="mt-1 text-[11px] text-zinc-500 tracking-wide">
                Highlighting Intelligent Document Editor
              </p>
              <div className={cn(
                "mt-3 px-2.5 py-0.5 rounded-full text-[10px] font-medium border",
                isDarkMode ? "border-zinc-600 text-zinc-400" : "border-zinc-300 text-zinc-500"
              )}>
                {t('about.version', { v: appVersion })}
              </div>
              <p className={cn(
                "mt-4 text-xs leading-relaxed",
                isDarkMode ? "text-zinc-400" : "text-zinc-500"
              )}>
                {t('about.desc')}
              </p>
              {/* 更新检查（仅 Tauri：桌面安装更新 / 安卓跳转下载页） */}
              {isTauri && (
                <div className="mt-3 flex flex-col items-center gap-1.5">
                  {updater.phase === 'checking' && (
                    <span className="text-[10px] text-zinc-500">{t('update.checking')}</span>
                  )}
                  {updater.phase === 'upToDate' && (
                    <span className="text-[10px] text-emerald-500">{t('update.upToDate')}</span>
                  )}
                  {updater.phase === 'error' && (
                    <span className="text-[10px] text-red-400 truncate max-w-[15rem]" title={updater.errorMessage ?? ''}>
                      {t('update.errGeneric', { msg: updater.errorMessage ?? '' })}
                    </span>
                  )}
                  {updater.phase === 'downloading' && (
                    <span className="text-[10px] text-zinc-500">{t('update.downloading')}</span>
                  )}
                  {updater.phase === 'available' && updater.source === 'manual' && (
                    <button
                      onClick={() => { IS_ANDROID_APP ? updater.goDownload() : void updater.install(); }}
                      className="px-3 py-1 rounded-md text-[10px] font-medium text-white transition-colors bg-blue-600 hover:bg-blue-500"
                    >
                      {t('update.newVersion', { v: updater.latestVersion ?? '' })} ·
                      {IS_ANDROID_APP ? t('update.goDownload') : t('update.installNow')}
                    </button>
                  )}
                  {(updater.phase === 'idle' || updater.phase === 'error' || updater.phase === 'upToDate') && (
                    <button
                      onClick={updater.checkManually}
                      className={cn(
                        "px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors",
                        isDarkMode ? "border-zinc-600 text-zinc-400 hover:bg-zinc-700" : "border-zinc-300 text-zinc-500 hover:bg-zinc-100"
                      )}
                    >
                      {t('update.check')}
                    </button>
                  )}
                  {/* 最近一次更新的说明（更新重启后自动弹出，关闭后从这里重看） */}
                  {releaseNotes && (
                    <button
                      onClick={() => { setAboutOpen(false); setReleaseNotesOpen(true); }}
                      className={cn(
                        "px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors flex items-center gap-1",
                        isDarkMode ? "border-zinc-600 text-zinc-400 hover:bg-zinc-700" : "border-zinc-300 text-zinc-500 hover:bg-zinc-100"
                      )}
                    >
                      <FileText size={10} />
                      {t('update.viewNotes')}
                    </button>
                  )}
                </div>
              )}
              <div className={cn(
                "mt-4 pt-3 w-full text-[10px] border-t",
                isDarkMode ? "border-zinc-700 text-zinc-500" : "border-zinc-200 text-zinc-400"
              )}>
                © 2026 H.I.D.E
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
            { icon: <Plus size={13} />, label: t('tabs.new'), action: () => file.handleNewFile(), disabled: false },
            { icon: <X size={13} />, label: t('tabs.closeOthers'), action: () => void file.closeOtherTabs(tabMenu.tabId!), disabled: !tabMenu.tabId || editor.tabs.length <= 1 },
            { icon: <Trash2 size={13} />, label: t('tabs.closeAll'), action: () => void file.closeAllTabs(), disabled: editor.tabs.length === 0 },
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
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          saving={file.saving}
          isMarkdown={!!isMarkdown}
          view={effectiveView === 'preview' ? 'preview' : 'edit'}
          onOpen={file.handleOpenFile}
          onSave={file.handleSave}
          onUndo={editor.handleUndo}
          onRedo={editor.handleRedo}
          onToggleView={toggleMdView}
          onFind={() => openFind(false, false)}
        />
      )}

      {/* 移动端标签页抽屉 */}
      <TabSheet
        open={tabSheetOpen}
        isDarkMode={isDarkMode}
        onClose={() => setTabSheetOpen(false)}
        tabs={editor.tabs}
        activeTabId={editor.activeTabId}
        onSelect={editor.setActiveTabId}
        onCloseTab={(id) => { void file.closeTab(id); }}
        onNew={file.handleNewFile}
      />

      {/* 更新提示已改为左下角通用通知卡片（useUpdateNotifications 编排），
          手动检查的结果仍在「关于」弹窗内展示 */}

      {/* 丢弃确认弹窗（退出应用 / 关闭脏标签共用，自绘以统一三端视觉） */}
      {pendingDiscard && (
        <ConfirmDialog
          title={pendingDiscard.title ?? t('confirm.unsavedTitle')}
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

      {/* 应用内警示弹窗（替代原生 alert，毛玻璃单按钮） */}
      {alertState && (
        <AlertDialog
          title={t('alert.title')}
          message={alertState.message}
          isDarkMode={isDarkMode}
          onClose={closeAlert}
        />
      )}

      {/* 通用通知卡片（左下角；窄屏移到顶部避让拇指工具栏） */}
      <NotificationStack isDarkMode={isDarkMode} />

      {/* 更新说明弹窗（只读 Markdown，更新重启后自动弹出；「关于」里可重看） */}
      {releaseNotesOpen && releaseNotes && (
        <ReleaseNotesModal
          version={releaseNotes.version}
          notes={releaseNotes.notes}
          isDarkMode={isDarkMode}
          onClose={() => setReleaseNotesOpen(false)}
        />
      )}

      {/* 通用图片查看器（文件树点击图片文件；z 层高于弹窗） */}
      {imageViewer && (
        <ImageViewer
          src={imageViewer.src}
          alt={imageViewer.name}
          isDarkMode={isDarkMode}
          onClose={() => setImageViewer(null)}
        />
      )}
    </div>
    </I18nProvider>
  );
}

/* 脏标签放弃时清除草稿（从 lib/drafts 转引，保持调用点简短） */
function deleteDraftFor(tab: { path: string | null; title: string; readOnly: boolean }): void {
  deleteDraft(draftKeyForTab(tab));
}
