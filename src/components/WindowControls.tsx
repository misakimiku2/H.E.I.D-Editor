import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '../lib/utils';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface WindowControlsProps {
  isDarkMode: boolean;
  /** 关闭前调用，返回 false 则取消关闭（用于未保存内容的确认） */
  onRequestClose: () => Promise<boolean>;
}

export function WindowControls({ isDarkMode, onRequestClose }: WindowControlsProps) {
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
        title="最小化"
      >
        <Minus size={15} strokeWidth={1.8} />
      </button>
      <button
        onClick={() => appWindow.toggleMaximize()}
        className={cn(baseBtn,
          isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'
        )}
        title={maximized ? '向下还原' : '最大化'}
      >
        {maximized ? <Copy size={12} strokeWidth={1.8} /> : <Square size={12} strokeWidth={1.8} />}
      </button>
      <button
        onClick={async () => { if (await onRequestClose()) appWindow.close(); }}
        className={cn(baseBtn,
          isDarkMode ? 'text-zinc-400' : 'text-zinc-500',
          'hover:bg-red-600 hover:text-white'
        )}
        title="关闭"
      >
        <X size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}
