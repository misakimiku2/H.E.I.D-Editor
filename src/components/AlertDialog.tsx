import { useEffect } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';

export interface AlertDialogProps {
  title: string;
  message: string;
  isDarkMode: boolean;
  onClose: () => void;
}

/**
 * 应用内警示弹窗（单按钮，毛玻璃面板，样式与右键菜单/确认弹窗同源）。
 * 替代原生 alert()：Tauri WebView 下原生对话框与应用视觉割裂且阻塞样式不可控。
 * Esc / 点击遮罩 / 确定均可关闭。
 */
export function AlertDialog({ title, message, isDarkMode, onClose }: AlertDialogProps) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      {/* 遮罩：压暗 + 毛玻璃（模糊弹窗背后的应用界面） */}
      <div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" onClick={onClose} />
      <div className={cn(
        "relative w-72 rounded-xl border shadow-2xl backdrop-blur-md p-4",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/70 text-zinc-100" : "border-zinc-200/80 bg-white/70 text-zinc-800"
      )}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className={cn("mt-2 text-xs leading-relaxed break-words", isDarkMode ? "text-zinc-400" : "text-zinc-500")}>
          {message}
        </p>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium pointer-coarse:min-h-[48px] pointer-coarse:px-4 pointer-coarse:text-sm text-white transition-colors bg-blue-600 hover:bg-blue-500"
          >
            {t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
