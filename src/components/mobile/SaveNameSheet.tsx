/**
 * 安卓保存前的文件名确认抽屉：EMUI 系统保存框会把改过的扩展名强补回 .txt，
 * 用户输入什么应用拿不到——先在自己这里问文件名，系统框只选位置。
 * 停靠在窗口底缘、键盘之上（.heid-savename-dock 读 --heid-kb，WebView 不因输入法收缩视口）；
 * 返回键经 OverlayState 关这层（resolve(null) = 取消保存）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { useT } from '../../lib/i18nContext';

interface SaveNameSheetProps {
  defaultName: string;
  isDarkMode: boolean;
  onResolve: (name: string | null) => void;
}

export function SaveNameSheet({ defaultName, isDarkMode, onResolve }: SaveNameSheetProps) {
  const t = useT();
  const [value, setValue] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* 打开即聚焦并全选：多数时候只是改扩展名，敲一个字就能覆盖原标题 */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const confirm = () => {
    const name = value.trim();
    onResolve(name || defaultName);
  };

  return (
    <div className="fixed inset-0 z-[92]">
      <div className="heid-fade-in absolute inset-0 bg-zinc-950/40" onClick={() => onResolve(null)} />
      <div
        className={cn(
          'heid-savename-dock heid-sheet-panel rounded-t-2xl border-x border-t shadow-2xl',
          isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
        )}
      >
        <div className="flex justify-center pt-2">
          <div className={cn('w-9 h-1 rounded-full', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
        </div>
        <div className={cn('px-4 pt-2 pb-1.5 text-sm font-semibold', isDarkMode ? 'text-zinc-200' : 'text-zinc-700')}>
          {t('save.nameTitle')}
        </div>
        <div className="px-4 pb-2">
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}
            className={cn(
              'w-full h-12 px-3 rounded-xl border text-base outline-none',
              isDarkMode
                ? 'bg-zinc-900 border-zinc-600 text-zinc-100 placeholder-zinc-500'
                : 'bg-zinc-50 border-zinc-300 text-zinc-800 placeholder-zinc-400'
            )}
            enterKeyHint="done"
            spellCheck={false}
          />
        </div>
        <div className={cn('flex gap-2 px-4 pt-1 pb-2 safe-bottom')}>
          <button
            onClick={() => onResolve(null)}
            className={cn(
              'flex-1 h-12 rounded-xl text-base font-medium active:opacity-70',
              isDarkMode ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700'
            )}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={confirm}
            className="flex-1 h-12 rounded-xl text-base font-medium bg-emerald-600 text-white active:opacity-80"
          >
            {t('menu.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
