import { FolderOpen, Save, Undo2, Redo2, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useT } from '../../lib/i18nContext';

interface BottomToolbarProps {
  isDarkMode: boolean;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  onOpen: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFind: () => void;
}

/**
 * 手机端底部工具栏（拇指区）：打开 / 撤销 / 保存 / 重做 / 查找。
 * 触控目标 ≥44px；预览切换已移至顶栏（v1.4 用户反馈）。
 */
export function BottomToolbar({
  isDarkMode, isDirty, canUndo, canRedo, saving,
  onOpen, onSave, onUndo, onRedo, onFind,
}: BottomToolbarProps) {
  const t = useT();
  const btnCls = (disabled?: boolean) => cn(
    'flex-1 min-h-[52px] rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors',
    'text-[10px] font-medium',
    disabled
      ? (isDarkMode ? 'text-zinc-600' : 'text-zinc-300')
      : (isDarkMode ? 'text-zinc-300 active:bg-zinc-700/70' : 'text-zinc-600 active:bg-zinc-200/70')
  );

  return (
    <div
      className={cn(
        'border-t flex items-stretch gap-0.5 px-1.5 shrink-0 select-none',
        'safe-bottom',
        isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
      )}
      /* 键盘弹出时按钮栏沉回键盘后方（v1.4 用户反馈：键盘上方只保留信息栏）；
         --heid-kb 由 MainActivity 的 IME insets 注入，桌面恒为 0 无效果 */
      style={{ transform: 'translateY(var(--heid-kb, 0px))' }}
    >
      <button onClick={onOpen} className={btnCls()} aria-label={t('menu.openFile')}>
        <FolderOpen size={19} />
        {t('common.open')}
      </button>
      <button onClick={onUndo} disabled={!canUndo} className={btnCls(!canUndo)} aria-label={t('menu.undo')}>
        <Undo2 size={19} />
        {t('menu.undo')}
      </button>
      {/* 保存：高频操作居中，脏状态时文件图标带琥珀点 */}
      <button
        onClick={onSave}
        disabled={saving}
        className={cn(btnCls(saving), 'relative')}
        aria-label={t('menu.save')}
      >
        <span className="relative">
          <Save size={21} />
          {isDirty && (
            <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-amber-500" />
          )}
        </span>
        {t('menu.save')}
      </button>
      <button onClick={onRedo} disabled={!canRedo} className={btnCls(!canRedo)} aria-label={t('menu.redo')}>
        <Redo2 size={19} />
        {t('menu.redo')}
      </button>
      {/* 编辑/预览态都可用：预览态自动路由到预览查找（只搜渲染文本） */}
      <button onClick={onFind} className={btnCls()} aria-label={t('find.replaceTitle')}>
        <Search size={19} />
        {t('common.find')}
      </button>
    </div>
  );
}
