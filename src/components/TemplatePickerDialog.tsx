import { useEffect, useState } from 'react';
import { X, LayoutTemplate, FilePlus2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { Dropdown } from './Dropdown';
import {
  ensureMdExtension, renderTemplate, templateTitle, validateFileName, type DocTemplate,
} from '../lib/docTemplates';

export interface TemplateCreateArgs {
  template: DocTemplate;
  fileName: string;
  content: string;
}

interface TemplatePickerDialogProps {
  isDarkMode: boolean;
  templates: DocTemplate[];
  /** 交 App 开一个带内容的未保存标签页（保存时才落盘）；同步、无失败路径 */
  onCreate: (args: TemplateCreateArgs) => void;
  onManage: () => void;
  onClose: () => void;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从模板新建：选模板 + 输文件名 → 渲染占位符 → 交 App 开未保存标签页。 */
export function TemplatePickerDialog({ isDarkMode, templates, onCreate, onManage, onClose }: TemplatePickerDialogProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(templates[0]?.id ?? null);
  const [name, setName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const validation = validateFileName(name);
  const validationError = validation === 'invalidChar' ? t('template.errInvalidChar') : '';
  const selected = templates.find(tp => tp.id === selectedId) ?? null;
  const canCreate = !!selected && validation === null;

  const submit = () => {
    if (!selected || validation !== null) return;
    const fileName = ensureMdExtension(name.trim());
    const content = renderTemplate(selected.content, { title: templateTitle(fileName), date: todayIso() });
    onCreate({ template: selected, fileName, content });
  };

  const inputCls = cn(
    'w-full px-3 py-2 rounded-lg text-xs outline-none border transition-colors pointer-coarse:min-h-[48px] pointer-coarse:text-sm',
    isDarkMode
      ? 'bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200 placeholder:text-zinc-500'
      : 'bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800 placeholder:text-zinc-400',
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" data-testid="template-picker">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md" onClick={onClose} />
      <div className={cn(
        'relative w-[460px] max-w-[94vw] max-h-[86vh] rounded-2xl border shadow-2xl p-5 flex flex-col gap-3',
        isDarkMode ? 'border-zinc-700 bg-zinc-800/95 text-zinc-100' : 'border-zinc-200 bg-white/95 text-zinc-800',
      )}>
        <div className="flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold flex items-center gap-2">
            <LayoutTemplate size={15} /> {t('template.pickerTitle')}
          </div>
          <button
            className={cn('p-2 rounded-md transition-colors', isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-300' : 'hover:bg-zinc-200/70 text-zinc-600')}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        {templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div data-testid="template-picker-empty" className="text-xs opacity-50 text-center">{t('template.empty')}</div>
            <button
              data-testid="template-go-manage"
              onClick={onManage}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 pointer-coarse:min-h-[48px] pointer-coarse:text-sm"
            >
              {t('template.goManage')}
            </button>
          </div>
        ) : (
          <>
            <label className="text-[11px] opacity-70 shrink-0">{t('template.selectTemplate')}</label>
            <Dropdown
              value={selectedId ?? ''}
              onChange={(v) => setSelectedId(v)}
              options={templates.map(tp => ({ value: tp.id, label: tp.name }))}
              dark={isDarkMode}
              label={t('template.selectTemplate')}
              className="w-full"
            />
            <label className="text-[11px] opacity-70 shrink-0">{t('template.fileName')}</label>
            <input
              data-testid="template-filename-input"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canCreate) submit(); }}
              placeholder={t('template.fileNamePlaceholder')}
              spellCheck={false}
              className={inputCls}
            />
            {validationError && <div data-testid="template-picker-error" className="text-[11px] text-red-500 shrink-0">{validationError}</div>}
            <div className="flex items-center justify-between shrink-0">
              <button
                data-testid="template-manage-link"
                onClick={onManage}
                className={cn('text-[11px] underline-offset-2 hover:underline', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}
              >
                {t('template.manage')}
              </button>
              <button
                data-testid="template-create-btn"
                onClick={submit}
                disabled={!canCreate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 pointer-coarse:min-h-[48px] pointer-coarse:text-sm transition-colors"
              >
                <FilePlus2 size={13} />
                {t('template.create')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}