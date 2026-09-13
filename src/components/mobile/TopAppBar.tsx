import { useEffect, useRef, useState } from 'react';
import {
  FileText, FolderOpen, Save, SaveAll, Plus, MoreVertical,
  Info, X, Table, Image as ImageIcon, Settings, Keyboard, Link2, GitCompare,
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
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onInsertTable: () => void;
  onInsertImage: () => void;
  /** 从网址导入（仅原生环境提供；浏览器无原生 HTTP 入口） */
  onImportUrl?: () => void;
  /** Diff 时间线（外部修改 / 软件内编辑） */
  onOpenDiff?: () => void;
  onCloseTab: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onAbout: () => void;
}

/**
 * 手机端顶栏：标签数入口 + 当前文件名（脏点）+ 溢出菜单。
 * 取代桌面端自绘标题栏与菜单栏（安卓没有窗口按钮的概念）。
 * P2 计划：溢出菜单按 isMarkdown 增加「插入图片/插入表格」入口。
 */
export function TopAppBar({
  isDarkMode, title, isDirty, isMarkdown, saving, tabCount,
  onOpenTabs, onNew, onOpen, onSave, onSaveAs, onInsertTable, onInsertImage, onImportUrl, onOpenDiff,
  onCloseTab, onSettings, onShortcuts, onAbout,
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
    'mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 min-h-[44px] text-sm font-medium flex items-center gap-3 transition-colors',
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
        'h-12 border-b flex items-center pl-1.5 pr-1 gap-1 shrink-0 select-none',
        'safe-top',
        isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
      )}
    >
      {/* 标签页入口：数量徽标 */}
      <button
        onClick={onOpenTabs}
        className={cn(
          'flex items-center gap-1 px-2.5 h-9 rounded-md shrink-0 transition-colors',
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

      {/* 当前文件名 + 脏状态点 */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 px-1">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            isDirty ? 'bg-amber-500' : (isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')
          )}
        />
        <span className="truncate text-sm font-medium">{title}</span>
      </div>

      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className={cn(
            'w-9 h-9 rounded-md flex items-center justify-center transition-colors',
            menuOpen
              ? (isDarkMode ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700')
              : (isDarkMode ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500')
          )}
          aria-label={t('mobile.moreMenu')}
        >
          <MoreVertical size={18} />
        </button>

        {menuOpen && (
          <div
            ref={menuBodyRef}
            className={cn(
              'absolute right-1 top-full mt-1 z-50 w-56 rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col',
              isDarkMode ? 'border-zinc-700/70 bg-zinc-800/70' : 'border-zinc-200/80 bg-white/70'
            )}
          >
            {menuItem(<FolderOpen size={16} className="shrink-0" />, t('menu.openFile'), onOpen)}
            {menuItem(<Save size={16} className="shrink-0" />, t('menu.save'), onSave, { disabled: saving })}
            {menuItem(<SaveAll size={16} className="shrink-0" />, t('menu.saveAs'), onSaveAs, { disabled: saving })}
            {menuItem(<Plus size={16} className="shrink-0" />, t('menu.newFile'), onNew)}
            {onOpenDiff && menuItem(<GitCompare size={16} className="shrink-0" />, t('diff.menuTitle'), onOpenDiff)}
            {onImportUrl && menuItem(<Link2 size={16} className="shrink-0" />, t('import.menu'), onImportUrl)}
            {isMarkdown && (
              <>
                {menuItem(<Table size={16} className="shrink-0" />, t('tools.insertTable'), onInsertTable)}
                {menuItem(<ImageIcon size={16} className="shrink-0" />, t('tools.insertImage'), onInsertImage)}
              </>
            )}
            <div className={cn('h-px mx-3 my-1', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
            {menuItem(<X size={16} className="shrink-0" />, t('menu.closeCurrentTab'), onCloseTab)}
            {menuItem(<Settings size={16} className="shrink-0" />, t('menu.settings'), onSettings)}
            {menuItem(<Keyboard size={16} className="shrink-0" />, t('menu.shortcuts'), onShortcuts)}
            {menuItem(<Info size={16} className="shrink-0" />, t('menu.about'), onAbout)}
          </div>
        )}
      </div>
    </div>
  );
}
