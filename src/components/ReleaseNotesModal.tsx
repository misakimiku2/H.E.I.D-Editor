/**
 * 更新说明弹窗：更新重启后自动弹出一次，也可在「关于」里重看最近一次的说明。
 * 只读展示（MarkdownPreview 不传 onChange 即只读，无编辑/保存入口），
 * 内容来自 updater 的 latest.json notes，随安装持久化到 localStorage（lib/update.ts）。
 */
import { useEffect } from 'react';
import { FileText, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { MarkdownPreview } from './MarkdownPreview';
import { useT } from '../lib/i18nContext';

export interface ReleaseNotesModalProps {
  version: string;
  notes: string;
  isDarkMode: boolean;
  onClose: () => void;
}

export function ReleaseNotesModal({ version, notes, isDarkMode, onClose }: ReleaseNotesModalProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center p-4">
      {/* 遮罩：压暗 + 毛玻璃 */}
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-md" onClick={onClose} />
      <div className={cn(
        "relative w-[34rem] max-w-full h-[min(80vh,42rem)] rounded-2xl border shadow-2xl backdrop-blur-md flex flex-col overflow-hidden",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/90 text-zinc-100" : "border-zinc-200/80 bg-white/90 text-zinc-800",
      )}>
        {/* 标题栏：不可编辑的文档头 */}
        <div className={cn(
          "flex items-center gap-2 px-4 py-2.5 border-b shrink-0",
          isDarkMode ? "border-zinc-700/70" : "border-zinc-200/80",
        )}>
          <FileText size={14} className="text-blue-500 shrink-0" />
          <h3 className="text-sm font-semibold">{t('update.releaseNotes')}</h3>
          <span className={cn(
            "px-2 py-0.5 rounded-full text-[10px] font-medium border",
            isDarkMode ? "border-zinc-600 text-zinc-400" : "border-zinc-300 text-zinc-500",
          )}>
            {t('about.version', { v: version })}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className={cn(
              "p-1 rounded-md transition-colors",
              isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500",
            )}
            title={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>
        {/* 正文：只读 Markdown 预览（无 onChange 即无编辑/右键格式化入口） */}
        <div className="flex-1 overflow-y-auto">
          {notes.trim().length > 0 ? (
            <MarkdownPreview
              content={notes}
              docKey={`release-notes-${version}`}
              isDarkMode={isDarkMode}
            />
          ) : (
            <p className={cn(
              "p-6 text-xs text-center",
              isDarkMode ? "text-zinc-500" : "text-zinc-400",
            )}>
              {t('update.notesEmpty')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
