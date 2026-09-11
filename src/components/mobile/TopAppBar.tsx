import { useEffect, useRef, useState } from 'react';
import {
  FileText, FolderOpen, Save, SaveAll, Plus, MoreVertical,
  Sun, SunMoon, Moon, Info, X, Table, Image as ImageIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils';

type ThemeMode = 'light' | 'dark' | 'system';

interface TopAppBarProps {
  isDarkMode: boolean;
  title: string;
  isDirty: boolean;
  isMarkdown: boolean;
  saving: boolean;
  tabCount: number;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  onOpenTabs: () => void;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onInsertTable: () => void;
  onInsertImage: () => void;
  onCloseTab: () => void;
  onAbout: () => void;
}

/**
 * 手机端顶栏：标签数入口 + 当前文件名（脏点）+ 溢出菜单。
 * 取代桌面端自绘标题栏与菜单栏（安卓没有窗口按钮的概念）。
 * P2 计划：溢出菜单按 isMarkdown 增加「插入图片/插入表格」入口。
 */
export function TopAppBar({
  isDarkMode, title, isDirty, isMarkdown, saving, tabCount, themeMode,
  onThemeMode, onOpenTabs, onNew, onOpen, onSave, onSaveAs, onInsertTable, onInsertImage,
  onCloseTab, onAbout,
}: TopAppBarProps) {
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
    'w-full px-4 min-h-[44px] text-sm font-medium flex items-center gap-3 transition-colors',
    isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600'
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
        aria-label="打开标签页列表"
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
          aria-label="更多菜单"
        >
          <MoreVertical size={18} />
        </button>

        {menuOpen && (
          <div
            ref={menuBodyRef}
            className={cn(
              'absolute right-1 top-full mt-1 z-50 w-56 rounded-lg border shadow-xl py-1 flex flex-col',
              isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
            )}
          >
            {menuItem(<FolderOpen size={16} className="shrink-0" />, '打开文件', onOpen)}
            {menuItem(<Save size={16} className="shrink-0" />, '保存', onSave, { disabled: saving })}
            {menuItem(<SaveAll size={16} className="shrink-0" />, '另存为', onSaveAs, { disabled: saving })}
            {menuItem(<Plus size={16} className="shrink-0" />, '新建文件', onNew)}
            {isMarkdown && (
              <>
                {menuItem(<Table size={16} className="shrink-0" />, '插入表格', onInsertTable)}
                {menuItem(<ImageIcon size={16} className="shrink-0" />, '插入图片', onInsertImage)}
              </>
            )}
            <div className={cn('h-px mx-3 my-1', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
            {/* 主题三档 */}
            <div className={cn('px-4 py-1 text-[11px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
              主题
            </div>
            <div className="px-3 pb-1.5 flex items-center gap-2">
              {([
                { mode: 'light', icon: Sun, label: '浅色' },
                { mode: 'system', icon: SunMoon, label: '系统' },
                { mode: 'dark', icon: Moon, label: '深色' },
              ] as const).map(({ mode: m, icon: Icon, label }) => {
                const active = themeMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => onThemeMode(m)}
                    className={cn(
                      'flex-1 min-h-[40px] rounded-md text-[11px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors',
                      active
                        ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-200 text-zinc-700')
                        : (isDarkMode ? 'bg-zinc-700/50 text-zinc-400' : 'bg-zinc-100 text-zinc-500')
                    )}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                );
              })}
            </div>
            <div className={cn('h-px mx-3 my-1', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
            {menuItem(<X size={16} className="shrink-0" />, '关闭当前标签', onCloseTab)}
            {menuItem(<Info size={16} className="shrink-0" />, '关于 H.E.I.D', onAbout)}
          </div>
        )}
      </div>
    </div>
  );
}
