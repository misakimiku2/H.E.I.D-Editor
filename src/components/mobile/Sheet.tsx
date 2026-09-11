import React from 'react';
import { cn } from '../../lib/utils';

interface SheetProps {
  open: boolean;
  isDarkMode: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

/** 移动端底部抽屉：遮罩点击关闭，从底部滑入，底部预留手势条安全区 */
export function Sheet({ open, isDarkMode, onClose, title, children }: SheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex flex-col justify-end">
      <div className="heid-fade-in absolute inset-0 bg-zinc-950/40" onClick={onClose} />
      <div
        className={cn(
          'heid-sheet-panel relative max-h-[75%] rounded-t-2xl border-x border-t shadow-2xl flex flex-col',
          'safe-bottom',
          isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
        )}
      >
        <div className="flex justify-center pt-2 shrink-0">
          <div className={cn('w-9 h-1 rounded-full', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
        </div>
        {title && (
          <div
            className={cn(
              'px-4 pt-2 pb-1.5 text-sm font-semibold shrink-0',
              isDarkMode ? 'text-zinc-200' : 'text-zinc-700'
            )}
          >
            {title}
          </div>
        )}
        <div className="overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}
