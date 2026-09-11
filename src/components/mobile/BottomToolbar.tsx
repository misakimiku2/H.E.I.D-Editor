import { FolderOpen, Save, Undo2, Redo2, Eye, Pencil } from 'lucide-react';
import { cn } from '../../lib/utils';

interface BottomToolbarProps {
  isDarkMode: boolean;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  isMarkdown: boolean;
  /** 当前生效视图（手机上分屏折叠为预览） */
  view: 'edit' | 'preview';
  onOpen: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleView: () => void;
}

/**
 * 手机端底部工具栏（拇指区）：打开 / 撤销 / 保存 / 重做 / 编辑预览切换。
 * 取代桌面端键盘快捷键；触控目标 ≥44px。
 */
export function BottomToolbar({
  isDarkMode, isDirty, canUndo, canRedo, saving, isMarkdown, view,
  onOpen, onSave, onUndo, onRedo, onToggleView,
}: BottomToolbarProps) {
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
    >
      <button onClick={onOpen} className={btnCls()} aria-label="打开文件">
        <FolderOpen size={19} />
        打开
      </button>
      <button onClick={onUndo} disabled={!canUndo} className={btnCls(!canUndo)} aria-label="撤销">
        <Undo2 size={19} />
        撤销
      </button>
      {/* 保存：高频操作居中，脏状态时文件图标带琥珀点 */}
      <button
        onClick={onSave}
        disabled={saving}
        className={cn(btnCls(saving), 'relative')}
        aria-label="保存"
      >
        <span className="relative">
          <Save size={21} />
          {isDirty && (
            <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-amber-500" />
          )}
        </span>
        保存
      </button>
      <button onClick={onRedo} disabled={!canRedo} className={btnCls(!canRedo)} aria-label="重做">
        <Redo2 size={19} />
        重做
      </button>
      <button
        onClick={onToggleView}
        disabled={!isMarkdown}
        className={btnCls(!isMarkdown)}
        aria-label={view === 'preview' ? '切换到编辑' : '切换到预览'}
      >
        {view === 'preview' ? <Pencil size={19} /> : <Eye size={19} />}
        {view === 'preview' ? '编辑' : '预览'}
      </button>
    </div>
  );
}
