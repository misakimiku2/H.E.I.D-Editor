import { useEffect, useRef, useState } from 'react';
import {
  FileText, Folder, FolderOpen,
  Info, SaveAll, Plus, MoreVertical,
  Keyboard, Link2, GitCompare,
  Eye, Pencil, Code, Table, Image as ImageIcon, Settings,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useT } from '../../lib/i18nContext';

interface TopAppBarProps {
  isDarkMode: boolean;
  title: string;
  isDirty: boolean;
  isMarkdown: boolean;
  saving: boolean;
  tabCount: number;
  onOpenTabs: () => void;
  onNew: () => void;
  /** 另存为（底栏的「保存」在无名文档上也会走系统另存为，但这里保留显式入口） */
  onSaveAs: () => void;
  onInsertTable: () => void;
  onInsertImage: () => void;
  /** 从网址导入（仅原生环境提供；浏览器无原生 HTTP 入口） */
  onImportUrl?: () => void;
  /** Diff 时间线（外部修改 / 软件内编辑） */
  onOpenDiff?: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onAbout: () => void;
  /** 文件树抽屉：已开 → 收起；未开 → 无根目录时唤起系统目录选择，有根目录 → 展开 */
  treeOpen?: boolean;
  hasTreeRoot?: boolean;
  onToggleTree?: () => void;
  /** 预览切换（仅 markdown 等支持预览的内容提供；放在顶栏，见 v1.4 用户反馈） */
  canToggleView?: boolean;
  view?: 'edit' | 'preview';
  onToggleView?: () => void;
  /** CSV 网格/文本视图切换（仅 CSV 标签提供；手机布局没有桌面工具栏行，
      缺了它从文本视图（如大文件/查找自动切换）就回不去网格） */
  csvView?: 'grid' | 'text';
  onToggleCsvView?: () => void;
}

/**
 * 手机端顶栏：标签数入口 + 当前文件名（脏点）+ 溢出菜单。
 * 取代桌面端自绘标题栏与菜单栏（安卓没有窗口按钮的概念）。
 * 溢出菜单只放底栏没有的：新建 / 另存为 / 导入网址 / Diff / markdown 插入 / 设置等。
 * 打开文件、保存、关闭当前标签页已移除（v1.4.1 反馈）——前两项底部工具栏已有，
 * 关标签在标签页抽屉里做，不该藏进二级菜单。
 */
export function TopAppBar({
  isDarkMode, title, isDirty, isMarkdown, saving, tabCount,
  onOpenTabs, onNew, onSaveAs, onInsertTable, onInsertImage, onImportUrl, onOpenDiff,
  onSettings, onShortcuts, onAbout,
  treeOpen, hasTreeRoot, onToggleTree,
  canToggleView, view, onToggleView,
  csvView, onToggleCsvView,
}: TopAppBarProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuBodyRef = useRef<HTMLDivElement | null>(null);

  /* 菜单展开时：点击菜单外部关闭（pointerdown 同时覆盖触摸与鼠标） */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuBodyRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const itemCls = cn(
    'mx-1.5 w-[calc(100%-12px)] rounded-lg px-3 min-h-[48px] text-sm font-medium flex items-center gap-3 transition-colors',
    isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-200' : 'hover:bg-zinc-200/70 text-zinc-700'
  );

  const menuItem = (
    icon: React.ReactNode, label: string, onClick: () => void,
    opts?: { disabled?: boolean },
  ) => (
    <button
      onClick={() => { setMenuOpen(false); onClick(); }}
      disabled={opts?.disabled}
      className={cn(itemCls, opts?.disabled && 'opacity-40 pointer-events-none')}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      className={cn(
        'border-b flex items-center pl-1.5 pr-1 gap-1 shrink-0 select-none',
        'safe-top',
        isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
      )}
      /* 高度须在 safe-top 之外另有 48px 内容区：固定 h-12 会被系统状态栏 padding
         挤压导致按钮被裁切（v1.4 用户反馈），与桌面标题栏同用 calc 方案 */
      style={{ height: 'calc(3rem + var(--heid-safe-top, 0px))' }}
    >
      {/* 标签页入口：数量徽标 */}
      <button
        onClick={onOpenTabs}
        className={cn(
          'flex items-center gap-1 px-2.5 h-12 rounded-md shrink-0 transition-colors',
          isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600'
        )}
        aria-label={t('mobile.openTabs')}
      >
        <FileText size={17} />
        <span
          className={cn(
            'min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center',
            isDarkMode ? 'bg-zinc-700 text-zinc-300' : 'bg-zinc-200 text-zinc-600'
          )}
        >
          {tabCount}
        </span>
      </button>

      {/* 当前文件名 + 状态点：这一行显示的就是当前标签，所以干净时是「当前」的绿点
          （与标签条 TabBar、标签页抽屉 TabSheet 同配色），只有未保存才换成琥珀 */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 px-1">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            isDirty ? 'bg-amber-500' : 'bg-emerald-500'
          )}
        />
        <span className="truncate text-sm font-medium">{title}</span>
      </div>

      {/* 预览切换：仅支持预览的内容（markdown）显示，放在顶栏（v1.4 用户反馈：
          不占据全局底栏位置） */}
      {canToggleView && onToggleView && (
        <button
          onClick={onToggleView}
          className={cn(
            'w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors',
            isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500'
          )}
          aria-label={view === 'preview' ? t('mobile.switchToEdit') : t('mobile.switchToPreview')}
        >
          {view === 'preview' ? <Pencil size={19} /> : <Eye size={19} />}
        </button>
      )}

      {/* CSV 网格/文本切换：图标指向可切换到的视图 */}
      {csvView && onToggleCsvView && (
        <button
          onClick={onToggleCsvView}
          className={cn(
            'w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors',
            isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500'
          )}
          aria-label={csvView === 'text' ? t('csv.grid') : t('csv.text')}
        >
          {csvView === 'text' ? <Table size={19} /> : <Code size={19} />}
        </button>
      )}

      {/* 文件树抽屉入口：已开=实心(点击收起)；未开且有根目录=展开；无根目录=唤起系统目录选择 */}
      {onToggleTree && (
        <button
          onClick={onToggleTree}
          className={cn(
            'w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors',
            treeOpen
              ? (isDarkMode ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700')
              : (isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500')
          )}
          aria-label={hasTreeRoot ? t('tree.toggle') : t('tree.openFolder')}
        >
          {treeOpen || !hasTreeRoot ? <Folder size={19} /> : <FolderOpen size={19} />}
        </button>
      )}

      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className={cn(
            'w-12 h-12 rounded-md flex items-center justify-center transition-colors',
            menuOpen
              ? (isDarkMode ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700')
              : (isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500')
          )}
          aria-label={t('mobile.moreMenu')}
        >
          <MoreVertical size={20} />
        </button>

        {menuOpen && (
          <div
            ref={menuBodyRef}
            className={cn(
              'absolute right-1 top-full mt-1 z-50 w-56 rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col',
              isDarkMode ? 'border-zinc-700/70 bg-zinc-800/70' : 'border-zinc-200/80 bg-white/70'
            )}
          >
            {menuItem(<Plus size={16} className="shrink-0" />, t('menu.newFile'), onNew)}
            {menuItem(<SaveAll size={16} className="shrink-0" />, t('menu.saveAs'), onSaveAs, { disabled: saving })}
            {onOpenDiff && menuItem(<GitCompare size={16} className="shrink-0" />, t('diff.menuTitle'), onOpenDiff)}
            {onImportUrl && menuItem(<Link2 size={16} className="shrink-0" />, t('import.menu'), onImportUrl)}
            {isMarkdown && (
              <>
                {menuItem(<Table size={16} className="shrink-0" />, t('tools.insertTable'), onInsertTable)}
                {menuItem(<ImageIcon size={16} className="shrink-0" />, t('tools.insertImage'), onInsertImage)}
              </>
            )}
            <div className={cn('h-px mx-3 my-1', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
            {menuItem(<Settings size={16} className="shrink-0" />, t('menu.settings'), onSettings)}
            {menuItem(<Keyboard size={16} className="shrink-0" />, t('menu.shortcuts'), onShortcuts)}
            {menuItem(<Info size={16} className="shrink-0" />, t('menu.about'), onAbout)}
          </div>
        )}
      </div>
    </div>
  );
}
