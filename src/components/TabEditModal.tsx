import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';

export interface TabEditValues {
  label: string;
  body: string;
}

interface TabEditModalProps {
  title: string;
  initialLabel: string;
  initialBody: string;
  isDarkMode: boolean;
  onSave: (values: TabEditValues) => void;
  onClose: () => void;
}

/** 页签的新建/编辑弹窗：标签 + Markdown 正文，不再要求用户手写标记语法 */
export function TabEditModal({ title, initialLabel, initialBody, isDarkMode, onSave, onClose }: TabEditModalProps) {
  const t = useT();
  const [label, setLabel] = useState(initialLabel);
  const [body, setBody] = useState(initialBody);
  const labelRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    /* 新建时标签已有默认值，直接聚焦正文；编辑时先改标签更常见 */
    (initialBody ? labelRef : bodyRef).current?.focus();
  }, []);

  const canSave = label.trim().length > 0;
  const submit = () => {
    if (!canSave) return;
    onSave({ label: label.trim(), body });
  };

  const fieldCls = cn(
    'w-full box-border rounded-lg border px-3 py-2 text-xs outline-none transition-colors',
    isDarkMode
      ? 'bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200 placeholder:text-zinc-500'
      : 'bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800 placeholder:text-zinc-400',
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md" onClick={onClose} />
      <form
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className={cn(
          'relative flex w-[520px] max-w-[92vw] flex-col gap-3 rounded-2xl border p-5 shadow-2xl',
          isDarkMode ? 'border-zinc-700 bg-zinc-800/95 text-zinc-100' : 'border-zinc-200 bg-white/95 text-zinc-800',
        )}
      >
        <button
          type="button"
          onClick={onClose}
          title={t('common.close')}
          className={cn(
            'absolute right-3 top-3 rounded-md p-1 transition-colors',
            isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200',
          )}
        >
          <X size={14} />
        </button>
        <div className="shrink-0 text-sm font-semibold">{title}</div>

        <label className="flex flex-col gap-1">
          <span className={cn('text-[10px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
            {t('md.tabLabel')}
          </span>
          <input
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('md.tabLabelPlaceholder')}
            className={cn(fieldCls, 'pointer-coarse:min-h-[48px] pointer-coarse:text-sm')}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={cn('text-[10px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
            {t('md.tabContent')}
          </span>
          <textarea
            ref={bodyRef}
            rows={8}
            spellCheck={false}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('md.tabContentHint')}
            className={cn(fieldCls, 'max-h-[45vh] min-h-[140px] resize-y font-mono leading-5 pointer-coarse:text-sm')}
          />
        </label>

        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs transition-colors pointer-coarse:min-h-[48px]',
              isDarkMode ? 'text-zinc-300 hover:bg-zinc-700' : 'text-zinc-600 hover:bg-zinc-100',
            )}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-[48px]"
          >
            {t('menu.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
