import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderX, FolderOpen,
  Loader2, PanelLeftClose, RefreshCw, Search, X,
  FilePlus, FolderPlus, FileImage, Scissors, Copy, ClipboardPaste, Pencil, Trash2, Link2, FolderSearch,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import {
  getDirLister, makeRoot, toggleDir, withChildren, withError,
  joinPath, parentPathOf, findNode, isValidEntryName, uniqueEntryName, relativePathUnderRoot,
  isImagePath, isSvgPath,
  type DirLister, type TreeNode,
} from '../lib/fileTree';
import {
  groupByFile, hitRangeInSnippet, searchInDir,
  type DirSearchOptions, type DirSearchResult, type FileHit,
} from '../lib/dirSearch';
import { fsMkdir, fsRename, fsCopy, fsDelete, fsReveal, writeClipboardText } from '../lib/fileOps';
import { writeLocalPath } from '../lib/fileIO';
import { appAlert } from '../lib/appAlert';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

export interface SidebarTabInfo {
  id: string;
  path: string | null;
  isDirty: boolean;
}

interface FileTreeSidebarProps {
  /** 已打开的根目录（桌面=绝对路径，安卓=SAF tree URI） */
  rootPath: string;
  open: boolean;
  /** 安卓 = 覆盖式抽屉（带遮罩）；桌面 = 占位面板（编辑区让位） */
  overlay: boolean;
  isDarkMode: boolean;
  activeTabId: string;
  tabs: SidebarTabInfo[];
  /** 点击文件打开；jump 携带行列时打开后定位（跨文件搜索结果） */
  onOpenFile: (path: string, jump?: { line: number; col: number }) => void;
  /** 打开图片文件（走通用图片查看器；缺省时图片仍按文本文件打开） */
  onOpenImage?: (path: string) => void;
  /** 关闭文件夹（清空根目录） */
  onRootChange: (path: string | null) => void;
  /** 收起抽屉 */
  onClose: () => void;
  /** 文件管理（新建/重命名/删除/剪贴板）当前环境是否可用（桌面 Tauri） */
  canManage: boolean;
  /** 危险操作确认（删除）：resolve true = 确认 */
  askDangerConfirm: (message: string, confirmText: string) => Promise<boolean>;
  /** 树内重命名/移动完成后同步标签页（oldPath 自身或其子树内路径 → newPath） */
  onTabsRenamed: (oldPath: string, newPath: string, isDir: boolean) => void;
  /** 树内删除完成后同步标签页（干净标签关闭，脏标签摘除路径保留缓冲） */
  onFileDeleted: (path: string) => void;
}

const lister: DirLister | null = getDirLister(
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Android/i.test(window.navigator.userAgent),
);

/** 新建/重命名共用的内联命名行：Enter 确认、Esc 取消、失焦确认（确认/取消只生效一次） */
function NameRow({
  depth, isDir, initial = '', selectStem = false, isDarkMode, placeholder, onCommit, onCancel,
}: {
  depth: number;
  isDir: boolean;
  initial?: string;
  selectStem?: boolean;
  isDarkMode: boolean;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectStem) {
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    } else {
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const value = inputRef.current?.value ?? '';
    if (!value.trim()) { onCancel(); return; }
    onCommit(value);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };
  return (
    <div style={{ paddingLeft: 8 + depth * 12 }} className="heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 h-7 flex items-center gap-1.5">
      {isDir
        ? <Folder size={13} className="shrink-0 opacity-70" />
        : <FileText size={13} className="shrink-0 opacity-60" />}
      <input
        ref={inputRef}
        defaultValue={initial}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
          else e.stopPropagation();
        }}
        onBlur={commit}
        className={cn(
          'flex-1 min-w-0 h-6 px-1.5 rounded-md border text-xs outline-none',
          isDarkMode
            ? 'bg-zinc-900 border-emerald-500/60 text-zinc-100 placeholder-zinc-600'
            : 'bg-white border-emerald-500 text-zinc-800 placeholder-zinc-400',
        )}
      />
    </div>
  );
}

/**
 * 文件树侧栏（默认关闭）：懒加载目录树，点击文件走既有打开通道；
 * 活动标签高亮、脏状态橙点；刷新重载根目录。
 * 桌面端附带文件管理：右键新建/重命名/删除/剪切复制粘贴/复制路径/资源管理器中显示
 * （走自定义 fs_* 命令；安卓 SAF 桥无对应能力，canManage=false 时仅导航）。
 */
export function FileTreeSidebar({
  rootPath, open, overlay, isDarkMode, activeTabId, tabs,
  onOpenFile, onOpenImage, onRootChange, onClose,
  canManage, askDangerConfirm, onTabsRenamed, onFileDeleted,
}: FileTreeSidebarProps) {
  const t = useT();
  const [tree, setTree] = useState<TreeNode | null>(null);
  /* 文件剪贴板（树内剪切/复制）；cut=true 表示粘贴后删除源 */
  const [clip, setClip] = useState<{ path: string; name: string; isDir: boolean; cut: boolean } | null>(null);
  /* 内联命名行：新建（挂载于父目录内）/ 重命名（替换原行） */
  const [creating, setCreating] = useState<{ parentPath: string; isDir: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string; isDir: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  /* ---- 跨文件搜索态（桌面；结果替代树体展示） ---- */
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpts, setSearchOpts] = useState<DirSearchOptions>({ caseSensitive: false, regexp: false, wholeWord: false });
  const [result, setResult] = useState<DirSearchResult | null>(null);
  const [searchingBusy, setSearchingBusy] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchSeqRef = useRef(0);

  /* 进入搜索态自动聚焦输入框 */
  useEffect(() => {
    if (searching) searchInputRef.current?.focus();
  }, [searching]);

  /* 根目录变化：搜索结果基于旧根，全部失效 */
  useEffect(() => {
    setSearching(false);
    setQuery('');
    setResult(null);
  }, [rootPath]);

  const exitSearch = useCallback(() => {
    setSearching(false);
    setQuery('');
    setResult(null);
  }, []);

  /** 按需触发：Enter 时一次全量扫描（无索引、无常驻后台） */
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) { setResult(null); return; }
    const seq = ++searchSeqRef.current;
    setSearchingBusy(true);
    try {
      const r = await searchInDir(rootPath, q, searchOpts);
      if (searchSeqRef.current === seq) setResult(r);
    } catch (e) {
      if (searchSeqRef.current === seq) {
        setResult({ matches: [], filesScanned: 0, filesMatched: 0, matchTotal: 0, truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, error: String(e) });
      }
    } finally {
      if (searchSeqRef.current === seq) setSearchingBusy(false);
    }
  }, [query, rootPath, searchOpts]);

  const dirtyMap = useMemo(() => {
    const m = new Map<string, boolean>();
    tabs.forEach(tb => { if (tb.path) m.set(tb.path, tb.isDirty); });
    return m;
  }, [tabs]);

  const ensureChildren = useCallback(async (node: TreeNode) => {
    if (!lister) return;
    try {
      const entries = await lister.list(node.path);
      setTree(prev => (prev ? withChildren(prev, node.path, entries) : prev));
    } catch (e: any) {
      setTree(prev => (prev ? withError(prev, node.path, e?.message ?? String(e)) : prev));
    }
  }, []);

  /** 重载单个目录（管理操作后同步该层视图；失败静默，下次展开会重读） */
  const reloadDir = useCallback(async (dirPath: string) => {
    if (!lister) return;
    try {
      const entries = await lister.list(dirPath);
      setTree(prev => (prev ? withChildren(prev, dirPath, entries) : prev));
    } catch { /* 忽略：下次展开时重读 */ }
  }, []);

  /* 抽屉首次打开时恢复根目录列表（启动本身不产生 I/O） */
  useEffect(() => {
    if (!open || !rootPath || tree) return;
    const root = makeRoot(rootPath);
    setTree(root);
    void ensureChildren(root);
  }, [open, rootPath, tree, ensureChildren]);

  /* 根目录变化（打开新文件夹）时重建树 */
  useEffect(() => {
    setTree(prev => (rootPath && prev?.path !== rootPath ? null : prev));
  }, [rootPath]);

  const handleRefresh = useCallback(() => {
    if (!rootPath) return;
    const root = makeRoot(rootPath);
    setTree(root);
    void ensureChildren(root);
  }, [rootPath, ensureChildren]);

  const handleDirClick = useCallback((node: TreeNode) => {
    setTree(prev => (prev ? toggleDir(prev, node.path) : prev));
    if (!node.expanded && node.children === null) void ensureChildren(node);
  }, [ensureChildren]);

  /* 长文件名悬停滚动：进入行时测量溢出量写入 --name-shift（无溢出为 0，动画静止） */
  const handleRowEnter = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const clip = e.currentTarget.querySelector<HTMLElement>('.heid-name-clip');
    const text = e.currentTarget.querySelector<HTMLElement>('.heid-name-text');
    if (!clip || !text) return;
    const shift = clip.clientWidth - text.scrollWidth - 4; /* 滚到底留一点呼吸空隙 */
    text.style.setProperty('--name-shift', `${Math.min(0, shift)}px`);
  }, []);

  /* ---- 管理操作（桌面） ---- */

  const opFailed = useCallback((e: unknown) => {
    appAlert(t('ctx.opFailed', { msg: e instanceof Error ? e.message : String(e) }));
  }, [t]);

  const startCreate = useCallback((parentPath: string, isDir: boolean) => {
    setCreating({ parentPath, isDir });
    /* 父目录折叠时先展开（含未加载的懒加载层） */
    const node = tree ? findNode(tree, parentPath) : null;
    if (node && !node.expanded) {
      setTree(prev => (prev ? toggleDir(prev, parentPath) : prev));
      if (node.children === null) void ensureChildren(node);
    }
  }, [tree, ensureChildren]);

  const commitCreate = useCallback(async (name: string) => {
    const target = creating;
    setCreating(null);
    if (!target) return;
    if (!isValidEntryName(name)) { appAlert(t('tree.invalidName')); return; }
    const newPath = joinPath(target.parentPath, name);
    try {
      if (target.isDir) await fsMkdir(newPath);
      else await writeLocalPath(newPath, '', 'utf-8', false);
      await reloadDir(target.parentPath);
      if (!target.isDir) onOpenFile(newPath);
    } catch (e) { opFailed(e); }
  }, [creating, onOpenFile, opFailed, reloadDir, t]);

  const commitRename = useCallback(async (name: string) => {
    const target = renaming;
    setRenaming(null);
    if (!target || name === target.name) return;
    if (!isValidEntryName(name)) { appAlert(t('tree.invalidName')); return; }
    try {
      const newPath = joinPath(parentPathOf(target.path), name);
      await fsRename(target.path, newPath);
      await reloadDir(parentPathOf(target.path));
      onTabsRenamed(target.path, newPath, target.isDir);
    } catch (e) { opFailed(e); }
  }, [renaming, onTabsRenamed, opFailed, reloadDir, t]);

  const handleDelete = useCallback(async (node: TreeNode) => {
    const ok = await askDangerConfirm(t('tree.deleteConfirm', { name: node.name }), t('tree.delete'));
    if (!ok) return;
    try {
      await fsDelete(node.path, node.isDir);
      await reloadDir(parentPathOf(node.path));
      onFileDeleted(node.path);
    } catch (e) { opFailed(e); }
  }, [askDangerConfirm, onFileDeleted, opFailed, reloadDir, t]);

  const handlePaste = useCallback(async (targetDir: string) => {
    const c = clip;
    if (!c) return;
    try {
      const entries = await lister?.list(targetDir).catch(() => []) ?? [];
      const destName = uniqueEntryName(c.name, entries.map(e => e.name), t('tree.copySuffix'));
      const dest = joinPath(targetDir, destName);
      if (dest !== c.path) {
        if (c.cut) {
          try {
            await fsRename(c.path, dest);
          } catch {
            /* 跨盘移动 rename 不支持：复制 + 删除兜底 */
            await fsCopy(c.path, dest);
            await fsDelete(c.path, c.isDir);
          }
        } else {
          await fsCopy(c.path, dest);
        }
      }
      if (c.cut) setClip(null);
      await reloadDir(targetDir);
    } catch (e) { opFailed(e); }
  }, [clip, opFailed, reloadDir, t]);

  /* ---- 右键菜单 ---- */

  const openMenu = useCallback((e: React.MouseEvent, node: TreeNode | null) => {
    if (!canManage) return; /* 安卓 SAF / 浏览器：不接管（保持系统行为） */
    e.preventDefault();
    e.stopPropagation();
    const isRoot = node === null || node.path === rootPath;
    const selfDir = node?.isDir ? node.path : rootPath;
    const parentDir = node && !node.isDir ? parentPathOf(node.path) : selfDir;
    const isDir = !!node?.isDir;
    const items: ContextMenuItem[] = [
      { icon: <FilePlus size={13} />, label: t('menu.newFile'), onSelect: () => startCreate(selfDir, false) },
      { icon: <FolderPlus size={13} />, label: t('tree.newFolder'), onSelect: () => startCreate(selfDir, true) },
      { separatorBefore: true, icon: <Scissors size={13} />, label: t('ctx.cut'), disabled: isRoot, onSelect: () => node && setClip({ path: node.path, name: node.name, isDir: node.isDir, cut: true }) },
      { icon: <Copy size={13} />, label: t('ctx.copy'), disabled: isRoot, onSelect: () => node && setClip({ path: node.path, name: node.name, isDir: node.isDir, cut: false }) },
      { icon: <ClipboardPaste size={13} />, label: t('ctx.paste'), disabled: !clip, onSelect: () => void handlePaste(parentDir) },
      { separatorBefore: true, icon: <Pencil size={13} />, label: t('tree.rename'), disabled: isRoot || !!renaming, onSelect: () => node && setRenaming({ path: node.path, name: node.name, isDir: node.isDir }) },
      { icon: <Trash2 size={13} />, label: t('tree.delete'), danger: true, disabled: isRoot, onSelect: () => node && void handleDelete(node) },
      { separatorBefore: true, icon: <Link2 size={13} />, label: t('tree.copyPath'), onSelect: () => void writeClipboardText(node?.path ?? rootPath).catch(() => {}) },
      { icon: <Link2 size={13} />, label: t('tree.copyRelPath'), onSelect: () => void writeClipboardText(relativePathUnderRoot(node?.path ?? rootPath, rootPath)).catch(() => {}) },
      { icon: <FolderSearch size={13} />, label: t('tree.reveal'), onSelect: () => void fsReveal(node?.path ?? rootPath).catch(opFailed) },
    ];
    /* 目录/根才有「刷新」语义（对文件无意义） */
    if (!node || isDir) {
      items.push({ separatorBefore: true, icon: <RefreshCw size={13} />, label: t('tree.refresh'), onSelect: () => void reloadDir(selfDir) });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, [canManage, clip, renaming, rootPath, startCreate, handleDelete, handlePaste, opFailed, reloadDir, t]);

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const active = tabs.some(tb => tb.id === activeTabId && tb.path === node.path);
    /* 行样式与右键菜单项一致：左右留边距的圆角行，悬停同色调 */
    const rowClass = cn(
      'heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 h-7 rounded-lg text-xs flex items-center gap-1.5 transition-colors text-left',
      active
        ? (isDarkMode ? 'bg-zinc-700/80 text-zinc-100' : 'bg-zinc-200/80 text-zinc-900')
        : (isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-200' : 'hover:bg-zinc-200/70 text-zinc-700'),
    );
    return (
      <div key={node.path}>
        {renaming?.path === node.path ? (
          <NameRow
            depth={depth}
            isDir={node.isDir}
            initial={node.name}
            selectStem
            isDarkMode={isDarkMode}
            placeholder={t('tree.namePlaceholder')}
            onCommit={(name) => void commitRename(name)}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <button
            onClick={() => {
              if (node.isDir) handleDirClick(node);
              else if (isImagePath(node.path) && onOpenImage) onOpenImage(node.path);
              else onOpenFile(node.path);
            }}
            onContextMenu={(e) => openMenu(e, node)}
            onMouseEnter={handleRowEnter}
            style={{ paddingLeft: 8 + depth * 12 }}
            className={rowClass}
            title={node.path}
          >
            {node.isDir ? (
              node.expanded ? <ChevronDown size={12} className="shrink-0 opacity-60" /> : <ChevronRight size={12} className="shrink-0 opacity-60" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {node.isDir ? (
              <Folder size={13} className="shrink-0 opacity-70" />
            ) : isImagePath(node.path) || isSvgPath(node.path) ? (
              <FileImage size={13} className="shrink-0 opacity-70" />
            ) : (
              <FileText size={13} className="shrink-0 opacity-60" />
            )}
            <span className="heid-name-clip truncate flex-1 min-w-0">
              <span className="heid-name-text inline-block whitespace-nowrap">{node.name}</span>
            </span>
            {dirtyMap.get(node.path) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />}
          </button>
        )}
        {node.isDir && node.expanded && (
          <>
            {creating?.parentPath === node.path && (
              <NameRow
                depth={depth + 1}
                isDir={creating.isDir}
                isDarkMode={isDarkMode}
                placeholder={t('tree.namePlaceholder')}
                onCommit={(name) => void commitCreate(name)}
                onCancel={() => setCreating(null)}
              />
            )}
            {node.error ? (
              <div style={{ paddingLeft: 20 + depth * 12 }} className="mx-1.5 w-[calc(100%-12px)] pr-2 py-0.5 text-[10px] text-red-500 flex items-center gap-1">
                <span className="truncate flex-1">{node.error}</span>
                <button onClick={() => handleDirClick({ ...node, expanded: false })} className="opacity-70 hover:opacity-100">
                  <RefreshCw size={10} />
                </button>
              </div>
            ) : node.children === null ? (
              <div style={{ paddingLeft: 20 + depth * 12 }} className="mx-1.5 py-1 text-zinc-500">
                <Loader2 size={11} className="animate-spin" />
              </div>
            ) : (
              node.children.map(c => renderNode(c, depth + 1))
            )}
          </>
        )}
      </div>
    );
  };

  if (!open) return null;

  /* ---- 搜索态渲染 ---- */

  const searchOptBtn = (active: boolean) => cn(
    'h-6 px-2 rounded-md text-[10px] font-semibold font-mono transition-colors',
    active
      ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-300 text-zinc-800')
      : (isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'),
  );

  const renderHitRow = (hit: FileHit) => {
    const { from, to } = hitRangeInSnippet(hit);
    return (
      <button
        key={`${hit.path}:${hit.line}:${hit.col}`}
        onClick={() => onOpenFile(hit.path, { line: hit.line, col: hit.col })}
        title={`${relativePathUnderRoot(hit.path, rootPath)}:${hit.line}:${hit.col}`}
        className={cn(
          'heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 h-6 pl-8 rounded-lg text-[11px] flex items-center gap-1.5 transition-colors text-left',
          isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-300' : 'hover:bg-zinc-200/70 text-zinc-700',
        )}
      >
        <span className="w-9 shrink-0 text-right opacity-50 tabular-nums">{hit.line}</span>
        <span className="heid-name-clip truncate flex-1 min-w-0 font-mono">
          <span className="heid-name-text inline-block whitespace-nowrap">
            {hit.text.slice(0, from)}
            <mark className={isDarkMode ? 'bg-amber-500/40 text-amber-200 rounded-sm' : 'bg-amber-300/70 text-amber-900 rounded-sm'}>
              {hit.text.slice(from, to)}
            </mark>
            {hit.text.slice(to)}
          </span>
        </span>
      </button>
    );
  };

  const renderSearchBody = () => {
    if (searchingBusy) {
      return (
        <div className="px-3 py-6 text-center text-[11px] opacity-60 flex flex-col items-center gap-2">
          <Loader2 size={13} className="animate-spin" />
          {t('tree.searchScanning')}
        </div>
      );
    }
    if (!result) return null;
    if (result.error) {
      return <div className="px-3 py-4 text-[11px] text-red-500 break-all">{result.error}</div>;
    }
    if (result.matches.length === 0) {
      return <div className="px-3 py-6 text-center text-[11px] opacity-50">{t('tree.searchNoResults')}</div>;
    }
    return (
      <>
        <div className="px-3 pt-1.5 pb-1 text-[10px] opacity-50 shrink-0">
          {t('tree.searchSummary', { files: result.filesMatched, total: result.matchTotal, scanned: result.filesScanned })}
          {result.truncated && ` · ${t('tree.searchCapped', { max: result.matches.length })}`}
        </div>
        {groupByFile(result.matches).map(g => (
          <div key={g.path}>
            <button
              onClick={() => onOpenFile(g.path)}
              title={g.path}
              className={cn(
                'heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 h-7 rounded-lg text-xs flex items-center gap-1.5 transition-colors text-left',
                isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-200' : 'hover:bg-zinc-200/70 text-zinc-700',
              )}
            >
              <FileText size={13} className="shrink-0 opacity-60" />
              <span className="heid-name-clip truncate flex-1 min-w-0 font-medium">
                <span className="heid-name-text inline-block whitespace-nowrap">{relativePathUnderRoot(g.path, rootPath)}</span>
              </span>
              <span className="text-[10px] opacity-50 shrink-0">{g.hits.length}</span>
            </button>
            {g.hits.map(renderHitRow)}
          </div>
        ))}
      </>
    );
  };

  const panel = cn(
    'flex flex-col bg-white/95 dark:bg-zinc-800/95',
    isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white',
  );

  return (
    <>
      {overlay && (
        <div className="heid-fade-in fixed inset-0 z-[79] bg-zinc-950/40" onClick={onClose} />
      )}
      <div
        className={cn(
          panel,
          overlay
            ? 'heid-fade-in fixed inset-y-0 left-0 z-[80] w-72 max-w-[85vw] border-r shadow-2xl pt-[var(--heid-safe-top,0px)]'
            : 'relative w-64 shrink-0 border-r',
        )}
      >
        {/* 头部：文件夹名 + 搜索 + 刷新 + 关闭文件夹 + 收起 */}
        <div className={cn(
          'h-10 shrink-0 border-b flex items-center gap-1 pl-3 pr-1.5',
          isDarkMode ? 'border-zinc-700' : 'border-zinc-200',
        )}>
          <FolderOpen size={14} className="shrink-0 opacity-60" />
          <span className="truncate flex-1 text-xs font-semibold" title={rootPath}>
            {lister?.displayName(rootPath) ?? rootPath}
          </span>
          {canManage && (
            <button
              onClick={() => (searching ? exitSearch() : setSearching(true))}
              title={t('tree.searchInFiles')}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                searching
                  ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-200 text-zinc-800')
                  : (isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500'),
              )}
            >
              <Search size={13} />
            </button>
          )}
          <button
            onClick={handleRefresh}
            title={t('tree.refresh')}
            className={cn('p-1.5 rounded-md transition-colors', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => onRootChange(null)}
            title={t('tree.closeFolder')}
            className={cn('p-1.5 rounded-md transition-colors', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
          >
            <FolderX size={13} />
          </button>
          {!overlay && (
            <button
              onClick={onClose}
              title={t('common.close')}
              className={cn('p-1.5 rounded-md transition-colors', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
            >
              <PanelLeftClose size={13} />
            </button>
          )}
        </div>
        {/* 搜索态：输入区 + 结果列表（替代树体） */}
        {searching && (
          <div className={cn('shrink-0 border-b px-2 py-1.5 flex flex-col gap-1', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
            <div className="flex items-center gap-1">
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void runSearch(); }
                  else if (e.key === 'Escape') { e.preventDefault(); exitSearch(); }
                  else e.stopPropagation();
                }}
                placeholder={t('tree.searchPlaceholder')}
                className={cn(
                  'flex-1 min-w-0 h-7 px-2 rounded-md border text-xs outline-none transition-colors',
                  isDarkMode
                    ? 'bg-zinc-900 border-zinc-600 text-zinc-200 focus:border-blue-500 placeholder:text-zinc-600'
                    : 'bg-white border-zinc-300 text-zinc-800 focus:border-blue-500 placeholder:text-zinc-400',
                )}
              />
              <button
                onClick={exitSearch}
                title={t('common.close')}
                className={cn('p-1.5 rounded-md transition-colors shrink-0', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
              >
                <X size={13} />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSearchOpts(o => ({ ...o, caseSensitive: !o.caseSensitive }))}
                className={searchOptBtn(searchOpts.caseSensitive)}
                title={t('find.caseSensitive')}
              >
                Aa
              </button>
              <button
                onClick={() => setSearchOpts(o => ({ ...o, wholeWord: !o.wholeWord }))}
                className={searchOptBtn(searchOpts.wholeWord)}
                title={t('find.wholeWord')}
              >
                ab
              </button>
              <button
                onClick={() => setSearchOpts(o => ({ ...o, regexp: !o.regexp }))}
                className={searchOptBtn(searchOpts.regexp)}
                title={t('find.useRegex')}
              >
                .*
              </button>
            </div>
          </div>
        )}
        {/* 树体（空白处右键 = 根目录菜单）；搜索态时让位给结果列表 */}
        {searching ? (
          <div className="flex-1 min-h-0 overflow-y-auto heid-scroll py-1">
            {renderSearchBody()}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto heid-scroll py-1" onContextMenu={(e) => openMenu(e, null)}>
            {tree ? (
              <>
                {/* 根目录内新建：命名行置顶（目录内的在对应目录展开区里） */}
                {creating?.parentPath === rootPath && (
                  <NameRow
                    depth={0}
                    isDir={creating.isDir}
                    isDarkMode={isDarkMode}
                    placeholder={t('tree.namePlaceholder')}
                    onCommit={(name) => void commitCreate(name)}
                    onCancel={() => setCreating(null)}
                  />
                )}
                {tree.children !== null && tree.children.length === 0 && !creating ? (
                  <div className="px-3 py-6 text-center text-[11px] opacity-50">{t('tree.empty')}</div>
                ) : (
                  renderNode(tree, 0)
                )}
              </>
            ) : (
              <div className="px-3 py-6 text-center">
                <Loader2 size={13} className="animate-spin mx-auto opacity-50" />
              </div>
            )}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu menu={{ x: menu.x, y: menu.y, items: menu.items }} isDarkMode={isDarkMode} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
