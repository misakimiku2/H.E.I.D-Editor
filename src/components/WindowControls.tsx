import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface WindowControlsProps {
  isDarkMode: boolean;
}

export function WindowControls({ isDarkMode }: WindowControlsProps) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  /* 跟踪最大化状态，切换最大化/还原图标 */
  useEffect(() => {
    if (!isTauri) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;

    appWindow.isMaximized()
      .then(v => { if (!disposed) setMaximized(v); })
      .catch(() => {});
    appWindow.onResized(async () => {
      try {
        const v = await appWindow.isMaximized();
        if (!disposed) setMaximized(v);
      } catch { /* ignore */ }
    })
      .then(fn => { if (disposed) fn(); else unlisten = fn; })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri) return null;

  const appWindow = getCurrentWindow();
  const baseBtn = 'w-11 h-full flex items-center justify-center transition-colors';

  return (
    <div className="flex items-stretch h-full shrink-0">
      <button
        onClick={() => appWindow.minimize()}
        className={cn(baseBtn,
          isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'
        )}
        title={t('win.minimize')}
      >
        <Minus size={15} strokeWidth={1.8} />
      </button>
      <button
        onClick={() => appWindow.toggleMaximize()}
        className={cn(baseBtn,
          isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'
        )}
        title={maximized ? t('win.restore') : t('win.maximize')}
      >
        {maximized ? <Copy size={12} strokeWidth={1.8} /> : <Square size={12} strokeWidth={1.8} />}
      </button>
      {/* 关闭走 App 的 close-requested 统一拦截（未保存内容确认）后销毁窗口 */}
      <button
        onClick={() => appWindow.close()}
        className={cn(baseBtn,
          isDarkMode ? 'text-zinc-400' : 'text-zinc-500',
          'hover:bg-red-600 hover:text-white'
        )}
        title={t('common.close')}
      >
        <X size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}
