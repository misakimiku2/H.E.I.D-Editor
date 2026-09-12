import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { useT, type MessageKey } from '../lib/i18nContext';

interface ShortcutHelpDialogProps {
  isDarkMode: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string; key: MessageKey }> = [
  { keys: 'Ctrl+N', key: 'menu.newFile' },
  { keys: 'Ctrl+O', key: 'menu.openFile' },
  { keys: 'Ctrl+S', key: 'menu.save' },
  { keys: 'Ctrl+Shift+S', key: 'menu.saveAs' },
  { keys: 'Ctrl+W', key: 'menu.closeCurrentTab' },
  { keys: 'Ctrl+Tab', key: 'sc.nextTab' },
  { keys: 'Ctrl+Shift+Tab', key: 'sc.prevTab' },
  { keys: 'Ctrl+F', key: 'common.find' },
  { keys: 'Ctrl+H', key: 'sc.findReplace' },
  { keys: 'Ctrl+G', key: 'sc.gotoLine' },
  { keys: 'Ctrl+Z', key: 'menu.undo' },
  { keys: 'Ctrl+Y', key: 'menu.redo' },
  { keys: 'Enter / Shift+Enter', key: 'sc.findNav' },
  { keys: 'Esc', key: 'sc.esc' },
];

/** 快捷键帮助弹窗（桌面列出键盘快捷键；手机端列出等效的界面入口） */
export function ShortcutHelpDialog({ isDarkMode, onClose }: ShortcutHelpDialogProps) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const itemCls = cn(
    "flex items-center justify-between gap-4 px-4 py-1.5 rounded-md text-xs",
    isDarkMode ? "hover:bg-zinc-700/60" : "hover:bg-zinc-100"
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md" onClick={onClose} />
      <div className={cn(
        "relative w-[min(420px,92vw)] max-h-[80vh] overflow-auto heid-scroll rounded-2xl border shadow-2xl",
        isDarkMode ? "border-zinc-700 bg-zinc-800 text-zinc-100" : "border-zinc-200 bg-white text-zinc-800"
      )}>
        <button
          onClick={onClose}
          className={cn(
            "absolute top-3 right-3 p-1 rounded-md transition-colors z-10",
            isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
          )}
          title={t('common.close')}
        >
          <X size={14} />
        </button>
        <h2 className="px-5 pt-5 pb-3 text-base font-bold">{t('menu.shortcuts')}</h2>
        <div className="px-2 pb-4 flex flex-col gap-0.5">
          {SHORTCUTS.map(({ keys, key }) => (
            <div key={keys} className={itemCls}>
              <span className={isDarkMode ? "text-zinc-300" : "text-zinc-600"}>{t(key)}</span>
              <kbd className={cn(
                "px-2 py-0.5 rounded border text-[10px] font-mono whitespace-nowrap",
                isDarkMode ? "border-zinc-600 bg-zinc-900 text-zinc-300" : "border-zinc-300 bg-zinc-50 text-zinc-600"
              )}>
                {keys.replace(/Ctrl/g, IS_TOUCH_PRIMARY && !IS_ANDROID_APP ? 'Cmd' : 'Ctrl')}
              </kbd>
            </div>
          ))}
        </div>
        {IS_ANDROID_APP && (
          <p className={cn("px-5 pb-4 text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            {t('shortcuts.mobileNote')}
          </p>
        )}
      </div>
    </div>
  );
}
