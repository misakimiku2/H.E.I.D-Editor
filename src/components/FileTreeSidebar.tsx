import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, FolderX, FolderOpen,
  Loader2, RefreshCw, Search, X,
  FilePlus, FolderPlus, FileImage, Scissors, Copy, ClipboardPaste, Pencil, Trash2, Link2, FolderSearch,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import {
  getDirLister, makeRoot, toggleDir, withChildren, withError, withRefreshedChildren,
  loadedDirPaths,
  joinPath, parentPathOf, findNode, isValidEntryName, uniqueEntryName, relativePathUnderRoot,
  isImagePath, isSvgPath,
  loadTreeSidebarWidth, saveTreeSidebarWidth, clampTreeSidebarWidth,
  TREE_SIDEBAR_MIN_WIDTH, TREE_SIDEBAR_MAX_WIDTH,
  type DirLister, type TreeNode,
} from '../lib/fileTree';
import {
  hitDisplay, pageGroups, searchInDir, searchProgress, cancelInDirSearch, HITS_PER_PAGE,
  type DirSearchOptions, type DirSearchResult, type FileHit, type SearchProgress,
} from '../lib/dirSearch';
import { fsMkdir, fsRename, fsCopy, fsDelete, fsReveal, writeClipboardText } from '../lib/fileOps';
import { writeLocalPath } from '../lib/fileIO';
import { appAlert } from '../lib/appAlert';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { useLongPress } from '../hooks/useLongPress';
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

/* ---- 树行虚拟化：扁平可见行 + 视口窗口渲染（大目录数千行时只画可视区附近） ---- */
/* 树行高：触屏 40px（虚拟化行高与行内样式同源），桌面 28px */
const TREE_ROW_H = IS_TOUCH_PRIMARY ? 40 : 28;
const ROW_CLS_H = IS_TOUCH_PRIMARY ? 'h-10' : 'h-7';
const TREE_OVERSCAN = 12; /* 视口上下额外渲染的行数 */
const TREE_ALL_ROWS_LIMIT = 300; /* 行数不超过该值直接全量渲染，免滚动窗口计算 */

type TreeRow =
  | { kind: 'node'; key: string; node: TreeNode; depth: number }
  | { kind: 'create'; key: string; parentPath: string; isDir: boolean; depth: number }
  | { kind: 'error'; key: string; node: TreeNode; depth: number }
  | { kind: 'loading'; key: string; depth: number };

/**
 * 展开的树扁平化为行序列（行序与旧 renderNode 递归渲染一致：目录行后跟
 * 命名行/错误行/加载行/子级行；根目录内新建的命名行置顶）。
 */
export function flattenTreeRows(
  root: TreeNode,
  creating: { parentPath: string; isDir: boolean } | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  if (creating?.parentPath === root.path) {
    rows.push({ kind: 'create', key: `create:${root.path}`, parentPath: root.path, isDir: creating.isDir, depth: 0 });
  }
  const walk = (node: TreeNode, depth: number) => {
    rows.push({ kind: 'node', key: node.path, node, depth });
    if (!node.isDir || !node.expanded) return;
    if (creating && creating.parentPath === node.path && node.path !== root.path) {
      rows.push({ kind: 'create', key: `create:${node.path}`, parentPath: node.path, isDir: creating.isDir, depth: depth + 1 });
    }
    if (node.error) {
      rows.push({ kind: 'error', key: `error:${node.path}`, node, depth: depth + 1 });
      return;
    }
    if (node.children === null) {
      rows.push({ kind: 'loading', key: `loading:${node.path}`, depth: depth + 1 });
      return;
    }
    node.children.forEach(c => walk(c, depth + 1));
  };
  walk(root, 0);
  return rows;
}

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
    <div style={{ paddingLeft: 8 + depth * 12 }} className={`heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 ${ROW_CLS_H} flex items-center gap-1.5`}>
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
  /* 触屏：长按树行/空白区弹右键同款菜单 */
  const { bind: bindMenu } = useLongPress();
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
  const [page, setPage] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const resultsScrollRef = useRef<HTMLDivElement | null>(null);
  const searchSeqRef = useRef(0);
  /* 会话内递增的搜索 id 与在途搜索 id（0 = 无）：进度轮询/取消都以它关联 */
  const searchIdRef = useRef(0);
  const inFlightIdRef = useRef(0);
  const [progress, setProgress] = useState<SearchProgress | null>(null);

  /* 进入搜索态自动聚焦输入框 */
  useEffect(() => {
    if (searching) searchInputRef.current?.focus();
  }, [searching]);

  /* 翻页后结果区回到顶部 */
  useEffect(() => {
    resultsScrollRef.current?.scrollTo?.({ top: 0 });
  }, [page]);

  /* ---- 侧栏宽度（桌面）：右缘拖拽调整，[默认=最小 256, 上限 400]，重启保留 ---- */
  const [width, setWidth] = useState(loadTreeSidebarWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    resizeRef.current = { startX: e.clientX, startWidth: widthRef.current };
  }, []);

  const moveResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = resizeRef.current;
    if (!s) return;
    const next = clampTreeSidebarWidth(s.startWidth + e.clientX - s.startX);
    if (next !== widthRef.current) {
      widthRef.current = next;
      setWidth(next);
    }
  }, []);

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    saveTreeSidebarWidth(widthRef.current);
  }, []);

  /** 取消在途搜索：使结果失效并通知 Rust 排空扫描任务 */
  const cancelSearch = useCallback(() => {
    const searchId = inFlightIdRef.current;
    if (!searchId) return;
    searchSeqRef.current++;
    inFlightIdRef.current = 0;
    setSearchingBusy(false);
    setProgress(null);
    void cancelInDirSearch(searchId).catch(() => { /* 取消失败仅意味着扫描自然跑完 */ });
  }, []);

  /* 根目录变化：搜索结果基于旧根，全部失效；在途搜索直接取消 */
  useEffect(() => {
    setSearching(false);
    setQuery('');
    setResult(null);
    setProgress(null);
    cancelSearch();
  }, [rootPath, cancelSearch]);

  const exitSearch = useCallback(() => {
    cancelSearch();
    setSearching(false);
    setQuery('');
    setResult(null);
    setProgress(null);
  }, [cancelSearch]);

  /** 按需触发：Enter 时一次全量扫描（无索引、无常驻后台）；新结果回到第 1 页。
      扫描期间 150ms 轮询进度快照（已处理文件数/实时命中数），可随时取消 */
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) { setResult(null); return; }
    const seq = ++searchSeqRef.current;
    const searchId = ++searchIdRef.current;
    inFlightIdRef.current = searchId;
    setSearchingBusy(true);
    setProgress(null);
    /* 进度轮询：仅在搜索在途期间运行，随取消/完成/失效自动停止 */
    void (async () => {
      while (inFlightIdRef.current === searchId) {
        await new Promise(r => setTimeout(r, 150));
        if (inFlightIdRef.current !== searchId) break;
        try {
          const p = await searchProgress(searchId);
          if (p && inFlightIdRef.current === searchId) setProgress(p);
        } catch { /* 单次轮询失败忽略，下个周期重试 */ }
      }
    })();
    try {
      const r = await searchInDir(rootPath, q, searchOpts, searchId);
      if (searchSeqRef.current === seq) { setResult(r.cancelled ? null : r); setPage(0); }
    } catch (e) {
      if (searchSeqRef.current === seq) {
        setResult({ matches: [], filesScanned: 0, filesMatched: 0, matchTotal: 0, truncated: false, skippedLarge: 0, skippedBinary: 0, skippedDirs: 0, filesCapped: false, cancelled: false, error: String(e) });
        setPage(0);
      }
    } finally {
      if (searchSeqRef.current === seq) {
        setSearchingBusy(false);
        setProgress(null);
      }
      if (inFlightIdRef.current === searchId) inFlightIdRef.current = 0;
    }
  }, [query, rootPath, searchOpts]);

  /* ---- 树体视口窗口：跟踪滚动与可视高度，大目录只渲染可视区附近的行 ---- */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);

  const onTreeScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  /* 视口高度跟踪（jsdom / 未打开时为 0 → 回退全量渲染）；搜索态与关闭态树体不在 DOM */
  useEffect(() => {
    const el = treeScrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setViewportH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, searching]);

  /* 根目录切换：树体滚动位置与窗口态归零 */
  useEffect(() => {
    treeScrollRef.current?.scrollTo?.({ top: 0 });
    setScrollTop(0);
  }, [rootPath]);

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

  const treeRef = useRef<TreeNode | null>(null);
  treeRef.current = tree;
  const refreshSeqRef = useRef(0);

  /**
   * 重载所有已加载目录并同批合并（父先子后）：手动刷新按钮、外部变更 watcher、
   * 树内管理操作后共用。展开态由 withRefreshedChildren 保留；并发时旧批次
   * （seq 落后）丢弃不回写，避免慢 I/O 的旧结果覆盖新状态。
   */
  const refreshTree = useCallback(async () => {
    if (!lister || !treeRef.current) return;
    const dirs = loadedDirPaths(treeRef.current);
    const seq = ++refreshSeqRef.current;
    const results = await Promise.allSettled(dirs.map(p => lister.list(p)));
    if (seq !== refreshSeqRef.current) return;
    setTree(prev => {
      if (!prev) return prev;
      let next = prev;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') next = withRefreshedChildren(next, dirs[i], r.value);
        else next = withError(next, dirs[i], r.reason instanceof Error ? r.reason.message : String(r.reason));
      });
      return next;
    });
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
    void refreshTree();
  }, [refreshTree]);

  /* 目录变更自动刷新（桌面）：抽屉打开期间递归监视根目录。插件侧为纯 notify
     监听（其 debounce 路径会主线程同步扫全树，大目录秒级冻结 UI），400ms 去抖
     在此完成；外部增删改经去抖后重载已加载层，展开态不丢。监视失败静默退化为
     手动刷新；安卓 SAF 无此能力 */
  useEffect(() => {
    if (!open || !rootPath || !lister?.watch) return;
    let disposed = false;
    let unwatch: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    lister.watch(rootPath, () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) void refreshTree();
      }, 400);
    })
      .then(u => { if (disposed) u(); else unwatch = u; })
      .catch(() => { /* 监视不可用：保持手动刷新 */ });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unwatch?.();
    };
  }, [open, rootPath, refreshTree]);

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
      await refreshTree();
      if (!target.isDir) onOpenFile(newPath);
    } catch (e) { opFailed(e); }
  }, [creating, onOpenFile, opFailed, refreshTree, t]);

  const commitRename = useCallback(async (name: string) => {
    const target = renaming;
    setRenaming(null);
    if (!target || name === target.name) return;
    if (!isValidEntryName(name)) { appAlert(t('tree.invalidName')); return; }
    try {
      const newPath = joinPath(parentPathOf(target.path), name);
      await fsRename(target.path, newPath);
      await refreshTree();
      onTabsRenamed(target.path, newPath, target.isDir);
    } catch (e) { opFailed(e); }
  }, [renaming, onTabsRenamed, opFailed, refreshTree, t]);

  const handleDelete = useCallback(async (node: TreeNode) => {
    const ok = await askDangerConfirm(t('tree.deleteConfirm', { name: node.name }), t('tree.delete'));
    if (!ok) return;
    try {
      await fsDelete(node.path, node.isDir);
      await refreshTree();
      onFileDeleted(node.path);
    } catch (e) { opFailed(e); }
  }, [askDangerConfirm, onFileDeleted, opFailed, refreshTree, t]);

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
      await refreshTree();
    } catch (e) { opFailed(e); }
  }, [clip, opFailed, refreshTree, t]);

  /* ---- 右键菜单（桌面） / 长按菜单（触屏，共用同一份 items） ---- */

  const openMenuAt = useCallback((x: number, y: number, node: TreeNode | null) => {
    if (!canManage) return; /* 安卓 SAF / 浏览器：不接管（保持系统行为） */
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
      items.push({ separatorBefore: true, icon: <RefreshCw size={13} />, label: t('tree.refresh'), onSelect: () => void refreshTree() });
    }
    setMenu({ x, y, items });
  }, [canManage, clip, renaming, rootPath, startCreate, handleDelete, handlePaste, opFailed, refreshTree, t]);

  const openMenu = useCallback((e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    openMenuAt(e.clientX, e.clientY, node);
  }, [openMenuAt]);

  /* 单行渲染（行序与子行展开由 flattenTreeRows 决定；重命名行原位替换节点行） */
  const renderRow = (row: TreeRow): React.ReactNode => {
    if (row.kind === 'create') {
      return (
        <NameRow
          depth={row.depth}
          isDir={row.isDir}
          isDarkMode={isDarkMode}
          placeholder={t('tree.namePlaceholder')}
          onCommit={(name) => void commitCreate(name)}
          onCancel={() => setCreating(null)}
        />
      );
    }
    if (row.kind === 'error') {
      return (
        <div style={{ paddingLeft: 20 + row.depth * 12 }} className={`mx-1.5 w-[calc(100%-12px)] pr-2 ${ROW_CLS_H} text-[10px] text-red-500 flex items-center gap-1`}>
          <span className="truncate flex-1">{row.node.error}</span>
          <button onClick={() => handleDirClick({ ...row.node, expanded: false })} className="opacity-70 hover:opacity-100">
            <RefreshCw size={10} />
          </button>
        </div>
      );
    }
    if (row.kind === 'loading') {
      return (
        <div style={{ paddingLeft: 20 + row.depth * 12 }} className={`mx-1.5 w-[calc(100%-12px)] pr-2 ${ROW_CLS_H} flex items-center text-zinc-500`}>
          <Loader2 size={11} className="animate-spin" />
        </div>
      );
    }
    const node = row.node;
    if (renaming?.path === node.path) {
      return (
        <NameRow
          depth={row.depth}
          isDir={node.isDir}
          initial={node.name}
          selectStem
          isDarkMode={isDarkMode}
          placeholder={t('tree.namePlaceholder')}
          onCommit={(name) => void commitRename(name)}
          onCancel={() => setRenaming(null)}
        />
      );
    }
    const active = tabs.some(tb => tb.id === activeTabId && tb.path === node.path);
    /* 行样式与右键菜单项一致：左右留边距的圆角行，悬停同色调 */
    const rowClass = cn(
      'heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 h-7 rounded-lg text-xs flex items-center gap-1.5 transition-colors text-left',
      active
        ? (isDarkMode ? 'bg-zinc-700/80 text-zinc-100' : 'bg-zinc-200/80 text-zinc-900')
        : (isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-200' : 'hover:bg-zinc-200/70 text-zinc-700'),
    );
    return (
      <button
        {...bindMenu({
          onClick: () => {
            if (node.isDir) handleDirClick(node);
            else if (isImagePath(node.path) && onOpenImage) onOpenImage(node.path);
            else onOpenFile(node.path);
          },
          onLongPress: (pos) => openMenuAt(pos.x, pos.y, node),
          onContextMenu: (e) => openMenu(e, node),
        })}
        onMouseEnter={handleRowEnter}
        style={{ paddingLeft: 8 + row.depth * 12 }}
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
    );
  };

  /* 树扁平行（展开区全部入列；空根目录走占位文案不进列表） */
  const emptyRoot = !!tree && tree.children !== null && tree.children.length === 0 && !creating;
  const treeRows = useMemo(
    () => (tree && !emptyRoot ? flattenTreeRows(tree, creating) : []),
    [tree, creating, emptyRoot],
  );

  if (!open) return null;

  /* ---- 搜索态渲染 ---- */

  /* 窗口切片：视口未知（jsdom/隐藏）或行数少时全量渲染 */
  const renderAll = viewportH <= 0 || treeRows.length <= TREE_ALL_ROWS_LIMIT;
  const firstIndex = renderAll ? 0 : Math.max(0, Math.floor(scrollTop / TREE_ROW_H) - TREE_OVERSCAN);
  const lastIndex = renderAll
    ? treeRows.length
    : Math.min(treeRows.length, Math.ceil((scrollTop + viewportH) / TREE_ROW_H) + TREE_OVERSCAN);
  const visibleRows = renderAll ? treeRows : treeRows.slice(firstIndex, lastIndex);

  const searchOptBtn = (active: boolean) => cn(
    IS_TOUCH_PRIMARY ? 'h-8 px-2.5 rounded-md text-[11px]' : 'h-6 px-2 rounded-md text-[10px]',
    'font-semibold font-mono transition-colors',
    active
      ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-300 text-zinc-800')
      : (isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'),
  );

  /* 命中分页：仅当结果可渲染且超过一页时出翻页条 */
  const paged = result && !result.error ? pageGroups(result.matches, page) : null;
  const pageBtn = cn(
    IS_TOUCH_PRIMARY ? 'p-2.5' : 'p-1.5',
    'rounded-md transition-colors disabled:opacity-30',
    isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500',
  );

  const renderHitRow = (hit: FileHit) => {
    /* 命中靠后时左移显示窗口，保证高亮落入可见区域（行内容被 CSS 裁剪） */
    const d = hitDisplay(hit);
    return (
      <button
        key={`${hit.path}:${hit.line}:${hit.col}`}
        onClick={() => onOpenFile(hit.path, { line: hit.line, col: hit.col })}
        title={`${relativePathUnderRoot(hit.path, rootPath)}:${hit.line}:${hit.col}\n${(d.prefix + hit.text).trim()}`}
        className={cn(
          'heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 rounded-lg text-xs flex items-center gap-1.5 transition-colors text-left',
          IS_TOUCH_PRIMARY ? 'h-9 pl-8' : 'h-6 pl-8',
          isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-300' : 'hover:bg-zinc-200/70 text-zinc-700',
        )}
      >
        <span className="w-9 shrink-0 text-right opacity-50 tabular-nums">{hit.line}</span>
        <span className="heid-name-clip truncate flex-1 min-w-0 font-mono">
          <span className="heid-name-text inline-block whitespace-nowrap">
            {d.prefix}
            {d.text.slice(0, d.from)}
            {/* 高亮色与编辑器内搜索同源（App 注入主题 token 的 CSS 变量；无变量时回退琥珀色） */}
            <mark
              className="rounded-sm"
              style={{
                backgroundColor: 'var(--heid-search-match-bg, rgba(251, 191, 36, 0.5))',
                outline: '1px solid var(--heid-search-match-outline, transparent)',
              }}
            >
              {d.text.slice(d.from, d.to)}
            </mark>
            {d.text.slice(d.to)}
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
          <div className="tabular-nums">
            {progress && progress.filesTotal > 0
              ? t('tree.searchProgress', { done: progress.filesDone, total: progress.filesTotal, hits: progress.matchTotal })
              : t('tree.searchScanning')}
          </div>
          <button
            onClick={cancelSearch}
            className={cn(
              'h-6 px-2 rounded-md text-[10px] flex items-center gap-1 transition-colors',
              isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500',
            )}
          >
            <X size={11} />
            {t('common.cancel')}
          </button>
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
          {result.truncated && ` · ${t('tree.searchCapped', { shown: result.matches.length, total: result.matchTotal })}`}
        </div>
        {paged?.groups.map(g => (
          <div key={g.path}>
            <button
              onClick={() => onOpenFile(g.path)}
              title={g.path}
              className={cn(
                `heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 ${ROW_CLS_H} rounded-lg text-xs flex items-center gap-1.5 transition-colors text-left`,
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
            : 'relative shrink-0 border-r',
        )}
        style={overlay ? undefined : { width }}
      >
        {/* 右缘拖拽手柄：宽度范围 [256, 400]，释放时持久化（安卓抽屉固定宽不显示） */}
        {!overlay && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('tree.resizeHint')}
            title={t('tree.resizeHint')}
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-blue-500/30"
          />
        )}
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
                'rounded-md transition-colors',
                IS_TOUCH_PRIMARY ? 'w-9 h-9 flex items-center justify-center' : 'p-1.5',
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
            className={cn('rounded-md transition-colors', IS_TOUCH_PRIMARY ? 'w-9 h-9 flex items-center justify-center' : 'p-1.5', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => onRootChange(null)}
            title={t('tree.closeFolder')}
            className={cn('rounded-md transition-colors', IS_TOUCH_PRIMARY ? 'w-9 h-9 flex items-center justify-center' : 'p-1.5', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
          >
            <FolderX size={13} />
          </button>
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
        {/* 树体（空白处右键 = 根目录菜单）；搜索态时让位给结果列表。
            虚拟化：总高 = 行数 × 行高的撑高层内绝对定位，只渲染窗口切片 */}
        {searching ? (
          <>
            {paged && paged.pageTotal > 1 && (
              <div className={cn('shrink-0 border-b px-2 py-1 flex items-center gap-1', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
                <button
                  disabled={page <= 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  title={t('tree.searchPrevPage')}
                  className={pageBtn}
                >
                  <ChevronLeft size={13} />
                </button>
                <span className="flex-1 text-center text-[10px] opacity-60 tabular-nums">
                  {t('tree.searchPage', { cur: page + 1, total: paged.pageTotal })}
                </span>
                <button
                  disabled={page >= paged.pageTotal - 1}
                  onClick={() => setPage(p => Math.min(paged.pageTotal - 1, p + 1))}
                  title={t('tree.searchNextPage')}
                  className={pageBtn}
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
            <div ref={resultsScrollRef} className="flex-1 min-h-0 overflow-y-auto heid-scroll py-1">
              {renderSearchBody()}
            </div>
          </>
        ) : (
          <div
            ref={treeScrollRef}
            className="flex-1 min-h-0 overflow-y-auto heid-scroll py-1"
            onScroll={onTreeScroll}
            {...bindMenu({
              onLongPress: (pos) => openMenuAt(pos.x, pos.y, null),
              onContextMenu: (e) => openMenu(e, null),
            })}
          >
            {tree ? (
              emptyRoot ? (
                <div className="px-3 py-6 text-center text-[11px] opacity-50">{t('tree.empty')}</div>
              ) : (
                <div className="heid-tree-spacer relative" style={{ height: treeRows.length * TREE_ROW_H }}>
                  {visibleRows.map((row, i) => (
                    <div
                      key={row.key}
                      className="absolute inset-x-0"
                      style={{ top: (firstIndex + i) * TREE_ROW_H, height: TREE_ROW_H }}
                    >
                      {renderRow(row)}
                    </div>
                  ))}
                </div>
              )
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
