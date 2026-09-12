import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderX, FolderOpen,
  Loader2, PanelLeftClose, RefreshCw,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import {
  getDirLister, makeRoot, toggleDir, withChildren, withError, type DirLister, type TreeNode,
} from '../lib/fileTree';

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
  onOpenFile: (path: string) => void;
  /** 关闭文件夹（清空根目录） */
  onRootChange: (path: string | null) => void;
  /** 收起抽屉 */
  onClose: () => void;
}

const lister: DirLister | null = getDirLister(
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Android/i.test(window.navigator.userAgent),
);

/**
 * 文件树侧栏（默认关闭）：懒加载目录树，点击文件走既有打开通道；
 * 活动标签高亮、脏状态橙点；刷新重载根目录；不做重命名/删除/拖拽。
 */
export function FileTreeSidebar({
  rootPath, open, overlay, isDarkMode, activeTabId, tabs,
  onOpenFile, onRootChange, onClose,
}: FileTreeSidebarProps) {
  const t = useT();
  const [tree, setTree] = useState<TreeNode | null>(null);

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

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const active = tabs.some(tb => tb.id === activeTabId && tb.path === node.path);
    return (
      <div key={node.path}>
        <button
          onClick={() => (node.isDir ? handleDirClick(node) : onOpenFile(node.path))}
          style={{ paddingLeft: 8 + depth * 12 }}
          className={cn(
            'w-full pr-2 h-7 rounded-md text-xs flex items-center gap-1.5 transition-colors text-left',
            active
              ? (isDarkMode ? 'bg-zinc-700/80 text-zinc-100' : 'bg-zinc-200/80 text-zinc-900')
              : (isDarkMode ? 'hover:bg-zinc-700/50 text-zinc-300' : 'hover:bg-zinc-200/60 text-zinc-700'),
          )}
          title={node.path}
        >
          {node.isDir ? (
            node.expanded ? <ChevronDown size={12} className="shrink-0 opacity-60" /> : <ChevronRight size={12} className="shrink-0 opacity-60" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {node.isDir
            ? <Folder size={13} className="shrink-0 opacity-70" />
            : <FileText size={13} className="shrink-0 opacity-60" />}
          <span className="truncate flex-1">{node.name}</span>
          {dirtyMap.get(node.path) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />}
        </button>
        {node.isDir && node.expanded && (
          node.error ? (
            <div style={{ paddingLeft: 20 + depth * 12 }} className="pr-2 py-0.5 text-[10px] text-red-500 flex items-center gap-1">
              <span className="truncate flex-1">{node.error}</span>
              <button onClick={() => handleDirClick({ ...node, expanded: false })} className="opacity-70 hover:opacity-100">
                <RefreshCw size={10} />
              </button>
            </div>
          ) : node.children === null ? (
            <div style={{ paddingLeft: 20 + depth * 12 }} className="py-1 text-zinc-500">
              <Loader2 size={11} className="animate-spin" />
            </div>
          ) : (
            node.children.map(c => renderNode(c, depth + 1))
          )
        )}
      </div>
    );
  };

  if (!open) return null;

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
            ? 'heid-fade-in fixed inset-y-0 left-0 z-[80] w-72 max-w-[85vw] border-r shadow-2xl pt-[env(safe-area-inset-top)]'
            : 'relative w-64 shrink-0 border-r',
        )}
      >
        {/* 头部：文件夹名 + 刷新 + 关闭文件夹 + 收起 */}
        <div className={cn(
          'h-10 shrink-0 border-b flex items-center gap-1 pl-3 pr-1.5',
          isDarkMode ? 'border-zinc-700' : 'border-zinc-200',
        )}>
          <FolderOpen size={14} className="shrink-0 opacity-60" />
          <span className="truncate flex-1 text-xs font-semibold" title={rootPath}>
            {lister?.displayName(rootPath) ?? rootPath}
          </span>
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
        {/* 树体 */}
        <div className="flex-1 min-h-0 overflow-y-auto heid-scroll py-1">
          {tree ? tree.children !== null && tree.children.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] opacity-50">{t('tree.empty')}</div>
          ) : (
            renderNode(tree, 0)
          ) : (
            <div className="px-3 py-6 text-center">
              <Loader2 size={13} className="animate-spin mx-auto opacity-50" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
