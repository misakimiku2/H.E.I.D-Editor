import { pickLister } from '../lib/remoteTree';
import { isRemotePath, parseRemotePath } from '../lib/remote';
import { dirTouched, mountPointTouched, subscribeFileChanges } from '../lib/remoteChanges';
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
  loadTreeSidebarWidth, saveTreeSidebarWidth, clampTreeSidebarWidth, treeSidebarBounds,
  type DirLister, type TreeNode,
} from '../lib/fileTree';
import {
  hitDisplay, pageGroups, searchInDir, searchProgress, cancelInDirSearch, HITS_PER_PAGE,
  type DirSearchOptions, type DirSearchResult, type FileHit, type SearchProgress,
} from '../lib/dirSearch';
import { fsMkdir, fsRename, fsCreateEmptyFile, fsCopy, fsDelete, fsReveal, writeClipboardText } from '../lib/fileOps';
import { appAlert } from '../lib/appAlert';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY, NARROW_QUERY } from '../lib/platform';
import { useMediaQuery } from '../hooks/useMediaQuery';
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
  isDarkMode: boolean;
  activeTabId: string;
  tabs: SidebarTabInfo[];
  /** 点击文件打开；jump 携带行列时打开后定位（跨文件搜索结果） */
  onOpenFile: (path: string, jump?: { line: number; col: number }) => void;
  /** 打开图片文件（走通用图片查看器；缺省时图片仍按文本文件打开） */
  onOpenImage?: (path: string) => void;
  /** 关闭文件夹（清空根目录） */
  onRootChange: (path: string | null) => void;
  /** 收起侧栏（手机端左滑手势；平板与桌面用顶栏开关） */
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

const platformLister: DirLister | null = getDirLister(
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Android/i.test(window.navigator.userAgent),
);

/* ---- 树行虚拟化：扁平可见行 + 视口窗口渲染（大目录数千行时只画可视区附近） ---- */
/**
 * 树行度量：桌面 28px、平板 40px（v1.4 的触屏档，原样保留）、手机 48dp。
 * 虚拟化算总高用的 h 与行内 class 必须同源，否则选中底色和行距对不齐。
 */
const treeRowMetrics = (phone: boolean) => ({
  h: phone ? 48 : IS_TOUCH_PRIMARY ? 40 : 28,
  cls: phone ? 'h-12' : IS_TOUCH_PRIMARY ? 'h-10' : 'h-7',
  label: phone ? 'text-sm' : 'text-xs',
  chevron: phone ? 15 : 12,
  icon: phone ? 16 : 13,
  inputCls: phone ? 'h-9' : 'h-6',
});
type TreeRowMetrics = ReturnType<typeof treeRowMetrics>;
/**
 * 横向拖动多少像素才认定「这是滑动收起」。
 * 6px 是被实测压出来的：行号栏上 CodeMirror 的拖行号选行大约在 9px 接管手势，
 * 晚于它就再也收不到后续事件（pointer 流会被 pointercancel 掐断）。
 * 没到这个距离前不 preventDefault，所以点按与光标定位不受影响。
 */
const SWIPE_COMMIT_PX = 6;
/** 收到不足原宽的这个比例就松手回弹，收到超过则继续收到关闭 */
const TREE_CLOSE_RATIO = 0.55;
/** 收起 / 回弹动画时长（ms） */
const TREE_SWIPE_MS = 190;
/**
 * 必须落在滚动容器自己身上：touch-action 是从命中元素向上求交得到的，但 Chrome 只走到
 * 最近的可滚动祖先就停了——只给面板加 pan-y 时，树体（overflow-y-auto）仍按 auto 处理，
 * 横向拖动约 13px 就被浏览器判成滚动并发出 pointercancel，左滑手势根本收不齐位移。
 */
const TOUCH_PAN_Y = 'touch-pan-y';
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
  depth, isDir, initial = '', selectStem = false, isDarkMode, placeholder, metrics, onCommit, onCancel,
}: {
  depth: number;
  isDir: boolean;
  initial?: string;
  selectStem?: boolean;
  isDarkMode: boolean;
  placeholder?: string;
  /** 行高度量：与树行同源，新建 / 重命名输入行要和上下行对齐 */
  metrics: TreeRowMetrics;
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
    <div style={{ paddingLeft: 8 + depth * 12 }} className={`heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 ${metrics.cls} flex items-center gap-1.5`}>
      {isDir
        ? <Folder size={metrics.icon} className="shrink-0 opacity-70" />
        : <FileText size={metrics.icon} className="shrink-0 opacity-60" />}
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
          'flex-1 min-w-0 px-1.5 rounded-md border outline-none',
          metrics.label,
          metrics.inputCls,
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
  rootPath, open, isDarkMode, activeTabId, tabs,
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

  /* ---- 形态：手机端（安卓 + 窄屏）才有 48dp 行与左滑收起；平板沿用 v1.4 的 40dp 档 ---- */
  const phone = IS_ANDROID_APP && useMediaQuery(NARROW_QUERY);
  const metrics = treeRowMetrics(phone);

  /* ---- 侧栏宽度：右缘拖拽调整，上下限按形态分档，释放时持久化 ----
     手机档按视口比例算（默认 2/3 屏），桌面的 256dp 下限在 411dp 的屏上会把代码区压到 155dp */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bounds = useMemo(() => treeSidebarBounds(phone, window.innerWidth), [phone]);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const [width, setWidth] = useState(() => loadTreeSidebarWidth(undefined, bounds));
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /* 拖把手期间也不能开 transition，否则右边缘慢半拍、不跟手 */
  const [resizing, setResizing] = useState(false);

  /* 跨断点（旋转 / 折叠屏展开）时把当前宽度收敛回本档范围，避免带着另一档的值 */
  useEffect(() => {
    setWidth(w => clampTreeSidebarWidth(w, bounds));
  }, [bounds]);

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    resizeRef.current = { startX: e.clientX, startWidth: widthRef.current };
    setResizing(true);
  }, []);

  const moveResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = resizeRef.current;
    if (!s) return;
    const next = clampTreeSidebarWidth(s.startWidth + e.clientX - s.startX, boundsRef.current);
    if (next !== widthRef.current) {
      widthRef.current = next;
      setWidth(next);
    }
  }, []);

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    saveTreeSidebarWidth(widthRef.current, undefined, boundsRef.current);
    setResizing(false);
  }, []);

  /* ---- 手机端横向左滑收起侧栏（平板 / 桌面没有这个手势） ----
     起手范围是「编辑区那一行」＝树 + 行号栏 + 代码视图：树开着时代码视图只剩 1/3 屏，
     在那儿横向拖动没有横向滚动的用途，就让它和树上一样能收树。

     跟手的方式是改宽度、不是 transform 平移：推拉式侧栏平移会在原位留下一条空白，
     而让右边缘跟着手指收回去，编辑区同步补上来，全程没有空洞。
     只允许变窄（右拖不放大），右拖仍然走右缘把手。

     整条手势走 touch 流，不走 pointer 流：行号栏上的横向拖动会被 CodeMirror 的
     「拖行号选行」接管，接管时浏览器给我们的 pointer 流发 pointercancel（实测 9px 就发，
     比判定阈值还早），pointermove 直接断掉；而 touchmove 在 pointercancel 之后仍继续派发，
     且只有在 touchmove 上 preventDefault 才拦得住 CodeMirror 起手的选区。 */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startWidth: number; claimed: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  /* 收到关闭后先播「宽度收到 0」的动画，落定才真正卸载（否则是硬切） */
  const [collapsing, setCollapsing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!phone || !open) return;
    const host = panelRef.current?.parentElement;
    if (!host) return;

    const startsInHost = (t: EventTarget | null) =>
      t instanceof Element && (t === host || host.contains(t));

    const onStart = (e: TouchEvent) => {
      /* 多指交给捏合缩放，不判滑动 */
      const t = e.touches.length === 1 ? e.touches[0] : null;
      if (!t || !startsInHost(t.target) || (t.target as Element).closest('[role=separator]')) {
        dragRef.current = null;
        return;
      }
      dragRef.current = { startX: t.clientX, startY: t.clientY, startWidth: widthRef.current, claimed: false };
    };

    const onMoveEvt = (e: TouchEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - d.startX;
      const dy = t.clientY - d.startY;
      if (!d.claimed) {
        /* 竖向为主 = 在滚树 / 滚代码，整个手势让出去 */
        if (Math.abs(dy) >= Math.abs(dx)) { dragRef.current = null; return; }
        /* 还没走够判定距离：先不 preventDefault，保证点按、光标定位照常 */
        if (dx > -SWIPE_COMMIT_PX) return;
        d.claimed = true;
        setDragging(true);
      }
      e.preventDefault();
      const next = Math.max(0, Math.min(d.startWidth, d.startWidth + dx));
      widthRef.current = next;
      setWidth(next);
    };

    const onEnd = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.claimed) return;
      setDragging(false);
      if (widthRef.current <= d.startWidth * TREE_CLOSE_RATIO) {
        setCollapsing(true);
        widthRef.current = 0;
        setWidth(0);
      } else {
        /* 没收到阈值：回弹到起手前的宽度（transition 由 dragging 翻回 false 打开） */
        widthRef.current = d.startWidth;
        setWidth(d.startWidth);
      }
    };

    const opts = { capture: true, passive: false } as const;
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMoveEvt, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onStart, opts);
      document.removeEventListener('touchmove', onMoveEvt, opts);
      document.removeEventListener('touchend', onEnd, opts);
      document.removeEventListener('touchcancel', onEnd, opts);
    };
  }, [phone, open]);

  /* transitionend 不保险（后台标签、宽度没变等场景不发），配一个兜底定时器 */
  useEffect(() => {
    if (!collapsing) return;
    const id = window.setTimeout(() => onCloseRef.current(), TREE_SWIPE_MS + 120);
    return () => window.clearTimeout(id);
  }, [collapsing]);

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

  /* 目录提供者按**根目录的形态**选，不按运行平台选：远程根（hide-remote://）在手机上
     也要走 link 通道，而平台那一份此刻指的是 SAF。根变化即换实现，树本身不用知道对面是谁 */
  const lister = useMemo(() => pickLister(rootPath ?? null, platformLister), [rootPath]);

  const ensureChildren = useCallback(async (node: TreeNode) => {
    if (!lister) return;
    try {
      const entries = await lister.list(node.path);
      setTree(prev => (prev ? withChildren(prev, node.path, entries) : prev));
    } catch (e: any) {
      setTree(prev => (prev ? withError(prev, node.path, e?.message ?? String(e)) : prev));
    }
  }, [lister]);

  const treeRef = useRef<TreeNode | null>(null);
  treeRef.current = tree;
  const refreshSeqRef = useRef(0);

  /**
   * 重载已加载目录并同批合并（父先子后）：手动刷新按钮、外部变更 watcher、
   * 树内管理操作后共用。展开态由 withRefreshedChildren 保留；并发时旧批次
   * （seq 落后）丢弃不回写，避免慢 I/O 的旧结果覆盖新状态。
   *
   * `only` 是远程根那侧的收窄判据：桌面的 watcher 给不出「变了哪几层」，只能整棵重载，
   * 而桌面的推送给得出。传了就只重列这些目录，一个都不在已加载之列时**一次请求都不发**。
   */
  const refreshTree = useCallback(async (only?: string[]) => {
    if (!lister || !treeRef.current) return;
    const all = loadedDirPaths(treeRef.current);
    const dirs = only ? all.filter(p => only.includes(p)) : all;
    if (!dirs.length) return;
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
  }, [lister]);

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

  /* 远程根（阶段 4）：桌面推来一帧文件变更，只重列**受影响的那几层**。
     桌面自己那份 watcher 给不出"哪几层变了"（通知里不带类型，也不区分文件与目录），
     只能整棵重载；远程这一路桌面是按目录合并着推的，于是就真能只刷那几层。
     换根单独处理：那是另一棵树 —— 留着旧的展开态只会让人以为看的还是原来那份内容。 */
  useEffect(() => {
    if (!open || !isRemotePath(rootPath)) return;
    const rootRel = parseRemotePath(rootPath)?.rel ?? '';
    return subscribeFileChanges({
      onDirs: dirs => {
        const t = treeRef.current;
        if (!t) return;
        const hit = loadedDirPaths(t).filter(p => {
          const rel = parseRemotePath(p)?.rel ?? '';
          return dirTouched(rel, dirs) || (rel === rootRel && mountPointTouched(rootRel, dirs));
        });
        if (hit.length) void refreshTree(hit);
      },
      onRootChanged: () => setTree(null),
    });
  }, [open, rootPath, refreshTree]);

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
  }, [open, rootPath, refreshTree, lister]);

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
    const joined = joinPath(target.parentPath, name);
    let newPath = joined;
    try {
      if (target.isDir) await fsMkdir(newPath);
      /* 安卓：经 SAF 新建空文档，实际路径为返回的 content URI（桌面=写空文件） */
      else newPath = await fsCreateEmptyFile(joined);
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
      const joined = joinPath(parentPathOf(target.path), name);
      /* 安卓文件重命名后旧 content URI 失效，以提供器返回的新 URI 为准 */
      const newPath = await fsRename(target.path, joined);
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
    /* SAF 桥只覆盖新建/重命名/删除：剪切移动（需 moveDocument）与树内复制暂不提供 */
    const noSafMove = IS_ANDROID_APP;
    const items: ContextMenuItem[] = [
      { icon: <FilePlus size={13} />, label: t('menu.newFile'), onSelect: () => startCreate(selfDir, false) },
      { icon: <FolderPlus size={13} />, label: t('tree.newFolder'), onSelect: () => startCreate(selfDir, true) },
      { separatorBefore: true, icon: <Scissors size={13} />, label: t('ctx.cut'), disabled: isRoot || noSafMove, onSelect: () => node && setClip({ path: node.path, name: node.name, isDir: node.isDir, cut: true }) },
      { icon: <Copy size={13} />, label: t('ctx.copy'), disabled: isRoot || noSafMove, onSelect: () => node && setClip({ path: node.path, name: node.name, isDir: node.isDir, cut: false }) },
      { icon: <ClipboardPaste size={13} />, label: t('ctx.paste'), disabled: !clip || noSafMove, onSelect: () => void handlePaste(parentDir) },
      { separatorBefore: true, icon: <Pencil size={13} />, label: t('tree.rename'), disabled: isRoot || !!renaming, onSelect: () => node && setRenaming({ path: node.path, name: node.name, isDir: node.isDir }) },
      { icon: <Trash2 size={13} />, label: t('tree.delete'), danger: true, disabled: isRoot, onSelect: () => node && void handleDelete(node) },
      { separatorBefore: true, icon: <Link2 size={13} />, label: t('tree.copyPath'), onSelect: () => void writeClipboardText(node?.path ?? rootPath).catch(() => {}) },
      { icon: <Link2 size={13} />, label: t('tree.copyRelPath'), onSelect: () => void writeClipboardText(relativePathUnderRoot(node?.path ?? rootPath, rootPath)).catch(() => {}) },
      { icon: <FolderSearch size={13} />, label: t('tree.reveal'), disabled: noSafMove, onSelect: () => void fsReveal(node?.path ?? rootPath).catch(opFailed) },
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
          metrics={metrics}
          placeholder={t('tree.namePlaceholder')}
          onCommit={(name) => void commitCreate(name)}
          onCancel={() => setCreating(null)}
        />
      );
    }
    if (row.kind === 'error') {
      return (
        <div style={{ paddingLeft: 20 + row.depth * 12 }} className={`mx-1.5 w-[calc(100%-12px)] pr-2 ${metrics.cls} text-[10px] text-red-500 flex items-center gap-1`}>
          <span className="truncate flex-1">{row.node.error}</span>
          <button onClick={() => handleDirClick({ ...row.node, expanded: false })} className="opacity-70 hover:opacity-100">
            <RefreshCw size={10} />
          </button>
        </div>
      );
    }
    if (row.kind === 'loading') {
      return (
        <div style={{ paddingLeft: 20 + row.depth * 12 }} className={`mx-1.5 w-[calc(100%-12px)] pr-2 ${metrics.cls} flex items-center text-zinc-500`}>
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
          metrics={metrics}
          placeholder={t('tree.namePlaceholder')}
          onCommit={(name) => void commitRename(name)}
          onCancel={() => setRenaming(null)}
        />
      );
    }
    const active = tabs.some(tb => tb.id === activeTabId && tb.path === node.path);
    /* 行样式与右键菜单项一致：左右留边距的圆角行，悬停同色调。
       行高必须用 metrics.cls（手机 48dp）——此前写死 h-7，选中底色比行距矮一截 */
    const rowClass = cn(
      `heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 ${metrics.cls} ${metrics.label} rounded-lg flex items-center gap-1.5 transition-colors text-left`,
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
          node.expanded ? <ChevronDown size={metrics.chevron} className="shrink-0 opacity-60" /> : <ChevronRight size={metrics.chevron} className="shrink-0 opacity-60" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {node.isDir ? (
          <Folder size={metrics.icon} className="shrink-0 opacity-70" />
        ) : isImagePath(node.path) || isSvgPath(node.path) ? (
          <FileImage size={metrics.icon} className="shrink-0 opacity-70" />
        ) : (
          <FileText size={metrics.icon} className="shrink-0 opacity-60" />
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
  const firstIndex = renderAll ? 0 : Math.max(0, Math.floor(scrollTop / metrics.h) - TREE_OVERSCAN);
  const lastIndex = renderAll
    ? treeRows.length
    : Math.min(treeRows.length, Math.ceil((scrollTop + viewportH) / metrics.h) + TREE_OVERSCAN);
  const visibleRows = renderAll ? treeRows : treeRows.slice(firstIndex, lastIndex);

  const searchOptBtn = (active: boolean) => cn(
    phone ? 'min-h-[48px] px-4 rounded-md text-sm' : IS_TOUCH_PRIMARY ? 'h-8 px-2.5 rounded-md text-[11px]' : 'h-6 px-2 rounded-md text-[10px]',
    'font-semibold font-mono transition-colors',
    active
      ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-300 text-zinc-800')
      : (isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'),
  );

  /* 命中分页：仅当结果可渲染且超过一页时出翻页条 */
  const paged = result && !result.error ? pageGroups(result.matches, page) : null;
  const pageBtn = cn(
    phone ? 'w-12 h-12 flex items-center justify-center' : IS_TOUCH_PRIMARY ? 'p-2.5' : 'p-1.5',
    'rounded-md transition-colors disabled:opacity-30 shrink-0',
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
          'heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 rounded-lg flex items-center gap-1.5 transition-colors text-left',
          phone ? 'h-12 pl-3 text-sm' : IS_TOUCH_PRIMARY ? 'h-9 pl-8 text-xs' : 'h-6 pl-8 text-xs',
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
                `heid-tree-row mx-1.5 w-[calc(100%-12px)] pr-2 ${metrics.cls} ${metrics.label} rounded-lg flex items-center gap-1.5 transition-colors text-left`,
                isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-200' : 'hover:bg-zinc-200/70 text-zinc-700',
              )}
            >
              <FileText size={metrics.icon} className="shrink-0 opacity-60" />
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
      {/* 三端统一的推拉式侧栏：占布局、挤压编辑区、右缘可拖宽。
          （手机端此前是 fixed 覆盖抽屉 + 遮罩，抽屉宽只有 288px 且看不到编辑区，已废弃） */}
      <div
        ref={panelRef}
        className={cn(panel, 'relative shrink-0 border-r overflow-hidden', phone && TOUCH_PAN_Y)}
        /* 手指拖动期间关 transition 让右边缘严格跟手；松手后交给 transition 做回弹 / 收拢 */
        style={{
          width,
          transition: phone && !dragging && !resizing ? `width ${TREE_SWIPE_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1)` : undefined,
        }}
        onTransitionEnd={(e) => {
          if (collapsing && e.propertyName === 'width') onClose();
        }}
      >
        {/* 右缘拖拽手柄：宽度上下限按形态取档（见 treeSidebarBounds），释放时持久化 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('tree.resizeHint')}
          title={t('tree.resizeHint')}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className={cn(
            'absolute inset-y-0 right-0 z-10 cursor-col-resize touch-none transition-colors hover:bg-blue-500/30',
            /* 触屏把手加宽（6px 手指抓不住）；桌面保持窄把手不遮内容 */
            IS_TOUCH_PRIMARY ? 'w-3' : 'w-1.5',
          )}
        />
        {/* 头部：文件夹名 + 搜索 + 刷新 + 关闭文件夹 + 收起 */}
        {/* 头部：根目录名 + 搜索 / 刷新 / 关闭文件夹。
            触屏排成两行：三个 48dp 图标按钮横排在桌面 256dp 的树里没问题，
            但手机树只有 176dp，挤在一行会把目录名压没——名字要看得见才知道开的是哪个文件夹 */}
        <div className={cn(
          'shrink-0 border-b',
          phone ? 'pt-1' : 'h-10 flex items-center gap-1 pl-3 pr-1.5',
          isDarkMode ? 'border-zinc-700' : 'border-zinc-200',
        )}>
          {(() => {
            const buttons = (
              <>
                {/* 跨文件搜索要按真实路径递归读目录，安卓 SAF 的树内路径（treeUri\0相对路径）
                    喂不进去、什么都搜不到，所以安卓不放这个入口 */}
                {canManage && !IS_ANDROID_APP && (
                  <button
                    onClick={() => (searching ? exitSearch() : setSearching(true))}
                    title={t('tree.searchInFiles')}
                    aria-label={t('tree.searchInFiles')}
                    className={cn(
                      'rounded-md transition-colors',
                      phone ? 'w-12 h-12 flex items-center justify-center' : IS_TOUCH_PRIMARY ? 'w-9 h-9 flex items-center justify-center' : 'p-1.5',
                      searching
                        ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-200 text-zinc-800')
                        : (isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500'),
                    )}
                  >
                    <Search size={metrics.icon} />
                  </button>
                )}
                <button
                  onClick={handleRefresh}
                  title={t('tree.refresh')}
                  aria-label={t('tree.refresh')}
                  className={cn('rounded-md transition-colors', phone ? 'w-12 h-12 flex items-center justify-center' : IS_TOUCH_PRIMARY ? 'w-9 h-9 flex items-center justify-center' : 'p-1.5', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
                >
                  <RefreshCw size={metrics.icon} />
                </button>
                <button
                  onClick={() => onRootChange(null)}
                  title={t('tree.closeFolder')}
                  aria-label={t('tree.closeFolder')}
                  className={cn('rounded-md transition-colors', phone ? 'w-12 h-12 flex items-center justify-center' : IS_TOUCH_PRIMARY ? 'w-9 h-9 flex items-center justify-center' : 'p-1.5', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
                >
                  <FolderX size={metrics.icon} />
                </button>
              </>
            );
            const title = (
              <>
                <FolderOpen size={phone ? 16 : 14} className="shrink-0 opacity-60" />
                <span className="truncate flex-1 text-xs font-semibold" title={rootPath}>
                  {lister?.displayName(rootPath) ?? rootPath}
                </span>
              </>
            );
            return phone ? (
              <>
                <div className="h-8 min-w-0 flex items-center gap-1.5 px-3">{title}</div>
                <div className="h-12 flex items-center gap-1 px-1.5">{buttons}</div>
              </>
            ) : (
              <>
                {title}
                {buttons}
              </>
            );
          })()}
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
                  'flex-1 min-w-0 px-2 rounded-md border outline-none transition-colors',
                  /* 触屏 16px 字号：低于 16px 会让 WebView 聚焦时自动放大整页 */
                  phone ? 'h-12 text-base' : 'h-7 text-xs',
                  isDarkMode
                    ? 'bg-zinc-900 border-zinc-600 text-zinc-200 focus:border-blue-500 placeholder:text-zinc-600'
                    : 'bg-white border-zinc-300 text-zinc-800 focus:border-blue-500 placeholder:text-zinc-400',
                )}
              />
              <button
                onClick={exitSearch}
                title={t('common.close')}
                className={cn('rounded-md transition-colors shrink-0', phone ? 'w-12 h-12 flex items-center justify-center' : 'p-1.5', isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
              >
                <X size={phone ? 16 : 13} />
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
            <div ref={resultsScrollRef} className={cn("flex-1 min-h-0 overflow-y-auto heid-scroll py-1", phone && TOUCH_PAN_Y)}>
              {renderSearchBody()}
            </div>
          </>
        ) : (
          <div
            ref={treeScrollRef}
            className={cn("flex-1 min-h-0 overflow-y-auto heid-scroll py-1", phone && TOUCH_PAN_Y)}
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
                <div className="heid-tree-spacer relative" style={{ height: treeRows.length * metrics.h }}>
                  {visibleRows.map((row, i) => (
                    <div
                      key={row.key}
                      className="absolute inset-x-0"
                      style={{ top: (firstIndex + i) * metrics.h, height: metrics.h }}
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
