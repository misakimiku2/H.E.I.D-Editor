import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';

interface ShortcutHelpDialogProps {
  isDarkMode: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string; desc: string; mobile?: boolean }> = [
  { keys: 'Ctrl+N', desc: '新建文件' },
  { keys: 'Ctrl+O', desc: '打开文件' },
  { keys: 'Ctrl+S', desc: '保存' },
  { keys: 'Ctrl+Shift+S', desc: '另存为' },
  { keys: 'Ctrl+W', desc: '关闭当前标签页' },
  { keys: 'Ctrl+Tab', desc: '切换到下一个标签页' },
  { keys: 'Ctrl+Shift+Tab', desc: '切换到上一个标签页' },
  { keys: 'Ctrl+F', desc: '查找' },
  { keys: 'Ctrl+H', desc: '查找并替换' },
  { keys: 'Ctrl+G', desc: '跳转到指定行' },
  { keys: 'Ctrl+Z', desc: '撤销' },
  { keys: 'Ctrl+Y', desc: '重做' },
  { keys: 'Enter / Shift+Enter', desc: '查找栏：下一个 / 上一个匹配' },
  { keys: 'Esc', desc: '关闭查找栏 / 弹窗' },
];

/** 快捷键帮助弹窗（桌面列出键盘快捷键；手机端列出等效的界面入口） */
export function ShortcutHelpDialog({ isDarkMode, onClose }: ShortcutHelpDialogProps) {
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
          title="关闭"
        >
          <X size={14} />
        </button>
        <h2 className="px-5 pt-5 pb-3 text-base font-bold">键盘快捷键</h2>
        <div className="px-2 pb-4 flex flex-col gap-0.5">
          {SHORTCUTS.map(({ keys, desc }) => (
            <div key={keys} className={itemCls}>
              <span className={isDarkMode ? "text-zinc-300" : "text-zinc-600"}>{desc}</span>
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
            手机端：顶栏与底部工具栏提供 打开 / 保存 / 撤销 / 重做 / 查找 / 视图切换 的等效入口；
            系统返回键逐层关闭弹层。
          </p>
        )}
      </div>
    </div>
  );
}
