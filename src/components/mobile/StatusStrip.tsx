import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface StatusStripProps {
  isDarkMode: boolean;
  /** 文件语言标签（TypeScript / Markdown …） */
  languageLabel: string;
  /** 编码标签（含 BOM 后缀） */
  encodingLabel: string;
  /** 换行符标签（LF / CRLF / CR） */
  eolLabel: string;
  /** 行:列 文本（App 侧已按 i18n 组装） */
  cursorLabel: string;
  onEncoding: () => void;
  onEol: () => void;
  /** 编码 / 换行符弹出菜单（App 的 statusMenuPanel，锚定在本条内向上弹出） */
  menuSlot?: ReactNode;
}

/**
 * 手机端精简状态栏（v1.4 手机端补齐）：底部工具栏上方一行——
 * 语言 · 编码 · 换行符 · 行:列。编码 / 换行符可点开与桌面状态栏同款的弹出菜单，
 * 其余信息只读；替代桌面完整状态栏（路径/大小/字数等在手机上收起）。
 */
export function StatusStrip({
  isDarkMode, languageLabel, encodingLabel, eolLabel, cursorLabel,
  onEncoding, onEol, menuSlot,
}: StatusStripProps) {
  const chip = cn(
    'min-h-[44px] px-2.5 rounded font-medium transition-colors flex items-center gap-1 shrink-0',
    isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-200 text-zinc-600'
  );
  return (
    <div
      className={cn(
        'border-t relative flex items-center px-3 gap-1.5 text-[11px] shrink-0 h-11',
        isDarkMode ? 'border-zinc-700 bg-zinc-800 text-zinc-500' : 'border-zinc-200 bg-zinc-100 text-zinc-500'
      )}
    >
      <span className="shrink-0">{languageLabel}</span>
      <span className="opacity-50 shrink-0">·</span>
      <button onClick={onEncoding} className={chip} aria-label="encoding">{encodingLabel}</button>
      <button onClick={onEol} className={chip} aria-label="line-ending">{eolLabel}</button>
      <div className="flex-1" />
      <span className="shrink-0 tabular-nums">{cursorLabel}</span>
      {menuSlot}
    </div>
  );
}
