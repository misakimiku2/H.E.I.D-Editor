import { useEffect, useRef, useState } from 'react';
import { X, Plus, Pencil, Trash2, LayoutTemplate, ArrowLeft, Eye } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { ConfirmDialog } from './ConfirmDialog';
import { CodeEditor } from './CodeEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { TEMPLATE_CONTENT_MAX, TEMPLATE_NAME_MAX, type DocTemplate } from '../lib/docTemplates';
import { canRedoHistory, canUndoHistory, recordStep, redoStep, undoStep, type TabHistory } from '../lib/tabHistory';

/* 弹窗内的紧凑编辑器：关迷你地图与粘性滚动（小容器里两者徒占空间），其余沿用默认 */
const COMPACT_EDITOR_SETTINGS = { ...DEFAULT_SETTINGS, minimap: false, stickyScroll: false };

interface TemplateManagerDialogProps {
  isDarkMode: boolean;
  templates: DocTemplate[];
  onChange: (next: DocTemplate[]) => void;
  onClose: () => void;
  /** 返回来源页（从模板新建 / 设置）；关闭按钮则直接收回弹窗 */
  onBack: () => void;
}

interface EditState { id: string | null; name: string; content: string; }

/** 文档模板管理：列表 / 编辑两视图。新建、编辑（名称 + 等宽内容框）、删除（二次确认）。
    所有改动经 onChange 上抛，由 App 合并进 settings 持久化。 */
export function TemplateManagerDialog({ isDarkMode, templates, onChange, onClose, onBack }: TemplateManagerDialogProps) {
  const t = useT();
  const [editing, setEditing] = useState<EditState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocTemplate | null>(null);
  const [nameError, setNameError] = useState(false);
  const [preview, setPreview] = useState(false);
  /* 本次编辑会话的内容历史（撤销/重做），进编辑视图时按初始内容重置 */
  const histRef = useRef<TabHistory | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || deleteTarget) return;
      if (editing) { setEditing(null); setNameError(false); } else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [deleteTarget, editing, onClose]);

  const startNew = () => { histRef.current = { stack: [''], index: 0, lastAt: 0 }; setEditing({ id: null, name: '', content: '' }); setNameError(false); setPreview(false); };
  const startEdit = (tpl: DocTemplate) => { histRef.current = { stack: [tpl.content], index: 0, lastAt: 0 }; setEditing({ id: tpl.id, name: tpl.name, content: tpl.content }); setNameError(false); setPreview(false); };

  const handleContentChange = (v: string, meta?: { major?: boolean }) => {
    if (!editing) return;
    const next = v.length > TEMPLATE_CONTENT_MAX ? v.slice(0, TEMPLATE_CONTENT_MAX) : v;
    if (histRef.current) recordStep(histRef.current, editing.content, next, meta?.major, Date.now());
    setEditing({ ...editing, content: next });
  };
  const handleUndo = () => {
    if (!editing) return;
    const c = undoStep(histRef.current ?? undefined, Date.now());
    if (c !== null) setEditing({ ...editing, content: c });
  };
  const handleRedo = () => {
    if (!editing) return;
    const c = redoStep(histRef.current ?? undefined, Date.now());
    if (c !== null) setEditing({ ...editing, content: c });
  };
  const canUndo = canUndoHistory(histRef.current ?? undefined);
  const canRedo = canRedoHistory(histRef.current ?? undefined);

  const saveEdit = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setNameError(true); return; }
    const content = editing.content.slice(0, TEMPLATE_CONTENT_MAX);
    if (editing.id) {
      onChange(templates.map(tp => (tp.id === editing.id ? { ...tp, name, content } : tp)));
    } else {
      onChange([...templates, { id: crypto.randomUUID(), name, content }]);
    }
    setEditing(null);
    setNameError(false);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    onChange(templates.filter(tp => tp.id !== deleteTarget.id));
    setDeleteTarget(null);
  };

  const inputCls = cn(
    'w-full px-3 py-2 rounded-lg text-xs outline-none border transition-colors pointer-coarse:min-h-[48px] pointer-coarse:text-sm',
    isDarkMode
      ? 'bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200 placeholder:text-zinc-500'
      : 'bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800 placeholder:text-zinc-400',
  );
  const iconBtnCls = cn(
    'p-2 rounded-md transition-colors pointer-coarse:min-h-[48px] pointer-coarse:min-w-[48px] flex items-center justify-center',
    isDarkMode ? 'hover:bg-zinc-600/70 text-zinc-300' : 'hover:bg-zinc-200/70 text-zinc-600',
  );

  const previewOf = (content: string) => content.split('\n').find(l => l.trim()) ?? t('template.previewEmpty');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" data-testid="template-manager">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md" onClick={onClose} />
      <div className={cn(
        'relative w-[520px] max-w-[94vw] max-h-[86vh] rounded-2xl border shadow-2xl p-5 flex flex-col gap-3',
        isDarkMode ? 'border-zinc-700 bg-zinc-800/95 text-zinc-100' : 'border-zinc-200 bg-white/95 text-zinc-800',
      )}>
        {editing ? (
          <>
            <div className="flex items-center justify-between shrink-0">
              <div className="text-sm font-semibold">{editing.id ? t('template.edit') : t('template.new')}</div>
              <button className={iconBtnCls} onClick={() => { setEditing(null); setNameError(false); }} aria-label={t('common.cancel')}>
                <X size={16} />
              </button>
            </div>
            <label className="text-[11px] opacity-70 shrink-0">{t('template.nameLabel')}</label>
            <input
              autoFocus
              data-testid="template-name-input"
              value={editing.name}
              maxLength={TEMPLATE_NAME_MAX}
              onChange={e => { setEditing({ ...editing, name: e.target.value }); setNameError(false); }}
              placeholder={t('template.namePlaceholder')}
              spellCheck={false}
              className={inputCls}
            />
            {nameError && <div data-testid="template-name-error" className="text-[11px] text-red-500 shrink-0">{t('template.errNameEmpty')}</div>}
            <div className="flex items-center justify-between shrink-0">
              <label className="text-[11px] opacity-70">{t('template.contentLabel')}</label>
              <button
                data-testid="template-preview-toggle"
                onClick={() => setPreview(v => !v)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors pointer-coarse:min-h-[48px] pointer-coarse:text-sm',
                  isDarkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700',
                )}
              >
                {preview ? <Pencil size={12} /> : <Eye size={12} />}
                {preview ? t('common.edit') : t('common.preview')}
              </button>
            </div>
            <div className={cn(
              'h-[260px] shrink-0 rounded-lg border overflow-hidden',
              isDarkMode ? 'border-zinc-600' : 'border-zinc-300',
            )}>
              {preview ? (
                <MarkdownPreview content={editing.content} isDarkMode={isDarkMode} />
              ) : (
                <CodeEditor
                  value={editing.content}
                  language="markdown"
                  isDarkMode={isDarkMode}
                  editorSettings={COMPACT_EDITOR_SETTINGS}
                  onChange={handleContentChange}
                  history={{ canUndo, canRedo, onUndo: handleUndo, onRedo: handleRedo }}
                  markdownMenu={{ canUndo, canRedo, onUndo: handleUndo, onRedo: handleRedo }}
                />
              )}
            </div>
            <p className="text-[10px] opacity-50 shrink-0">{t('template.contentHint')}</p>
            <div className="flex justify-end gap-2 shrink-0">
              <button
                data-testid="template-cancel-btn"
                onClick={() => { setEditing(null); setNameError(false); }}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium pointer-coarse:min-h-[48px] pointer-coarse:text-sm transition-colors',
                  isDarkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-600',
                )}
              >
                {t('common.cancel')}
              </button>
              <button
                data-testid="template-save-btn"
                onClick={saveEdit}
                className="px-3 py-1.5 rounded-md text-xs font-medium pointer-coarse:min-h-[48px] pointer-coarse:text-sm text-white transition-colors bg-indigo-600 hover:bg-indigo-500"
              >
                {t('template.save')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1">
                <button data-testid="template-back-btn" className={iconBtnCls} onClick={onBack} aria-label={t('common.back')} title={t('common.back')}>
                  <ArrowLeft size={16} />
                </button>
                <div className="text-sm font-semibold flex items-center gap-2">
                  <LayoutTemplate size={15} /> {t('template.managerTitle')}
                </div>
              </div>
              <button className={iconBtnCls} onClick={onClose} aria-label={t('common.close')}>
                <X size={16} />
              </button>
            </div>
            <button
              data-testid="template-new-btn"
              onClick={startNew}
              className={cn(
                'self-start flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium pointer-coarse:min-h-[48px] pointer-coarse:text-sm transition-colors',
                isDarkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700',
              )}
            >
              <Plus size={13} /> {t('template.new')}
            </button>
            <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 min-h-[80px]">
              {templates.length === 0 && (
                <div data-testid="template-manager-empty" className="text-xs opacity-50 py-6 text-center">{t('template.empty')}</div>
              )}
              {templates.map(tp => (
                <div
                  key={tp.id}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border',
                    isDarkMode ? 'border-zinc-700 bg-zinc-900/40' : 'border-zinc-200 bg-zinc-50',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{tp.name}</div>
                    <div className="text-[10px] opacity-50 truncate">{previewOf(tp.content)}</div>
                  </div>
                  <button data-testid={`template-edit-${tp.id}`} className={iconBtnCls} onClick={() => startEdit(tp)} title={t('common.edit')} aria-label={t('common.edit')}>
                    <Pencil size={14} />
                  </button>
                  <button
                    data-testid={`template-delete-${tp.id}`}
                    className={cn(iconBtnCls, isDarkMode ? 'hover:bg-red-900/50 text-red-400' : 'hover:bg-red-50 text-red-500')}
                    onClick={() => setDeleteTarget(tp)}
                    title={t('template.delete')}
                    aria-label={t('template.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {deleteTarget && (
        <ConfirmDialog
          title={t('template.deleteConfirmTitle')}
          message={t('template.deleteConfirmMsg', { name: deleteTarget.name })}
          isDarkMode={isDarkMode}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}