import { useEffect } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  isDarkMode: boolean;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（如写回磁盘）时确认按钮用红色 */
  danger?: boolean;
  /** 可选的中部动作（如「退出并保存」），蓝色强调，位于取消与主确认之间 */
  extraAction?: { text: string; onAction: () => void };
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用小型二次确认模态。fixed 覆盖整个视口而非父级 padding box：
 * 父级弹窗的边框在确认态下需一并压暗，否则会残留一圈亮色描边。
 * Tauri WebView2 下 window.confirm 不可靠，且自绘与应用视觉统一。
 * Esc / 点击遮罩等同取消。
 */
export function ConfirmDialog({
  title,
  message,
  isDarkMode,
  confirmText,
  cancelText,
  danger = false,
  extraAction,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const confirmTextResolved = confirmText ?? t('common.confirm');
  const cancelTextResolved = cancelText ?? t('common.cancel');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      {/* 遮罩：压暗 + 毛玻璃（模糊弹窗背后的应用界面） */}
      <div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" onClick={onCancel} />
      <div className={cn(
        "relative w-72 rounded-xl border shadow-2xl backdrop-blur-md p-4",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/70 text-zinc-100" : "border-zinc-200/80 bg-white/70 text-zinc-800"
      )}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className={cn("mt-2 text-xs leading-relaxed", isDarkMode ? "text-zinc-400" : "text-zinc-500")}>
          {message}
        </p>
        <div className="mt-4 flex justify-end gap-2 flex-wrap">
          <button
            onClick={onCancel}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              isDarkMode ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-300" : "bg-zinc-100 hover:bg-zinc-200 text-zinc-600"
            )}
          >
            {cancelTextResolved}
          </button>
          {extraAction && (
            <button
              onClick={extraAction.onAction}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors bg-blue-600 hover:bg-blue-500"
            >
              {extraAction.text}
            </button>
          )}
          <button
            onClick={onConfirm}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors",
              danger ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"
            )}
          >
            {confirmTextResolved}
          </button>
        </div>
      </div>
    </div>
  );
}
