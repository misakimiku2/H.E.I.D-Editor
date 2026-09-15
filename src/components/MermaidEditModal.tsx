import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { X, Check, RotateCcw } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  renderMermaidSvg,
  MERMAID_TEMPLATES,
  detectMermaidType,
  mermaidTemplateOf,
} from '../lib/mermaid';
import { vsCodeDarkTheme, vsCodeLightTheme, vsCodeDarkHighlightStyle, vsCodeLightHighlightStyle } from '../lib/codemirror';
import { useT } from '../lib/i18nContext';

/* ---- Markdown 预览内 Mermaid 图表编辑器 ----
   左侧：图型下拉 + 源码编辑器（复用项目 CodeMirror 主题）+ 错误提示；
   右侧：实时渲染预览（防抖）。保存后把编辑后的源码块回写到文档。 */

interface MermaidEditModalProps {
  /** 当前图表源码（不含 ``` 围栏） */
  initialCode: string;
  isDarkMode: boolean;
  onClose: () => void;
  onSave: (code: string) => void;
}

const PREVIEW_DEBOUNCE = 220;

export function MermaidEditModal({ initialCode, isDarkMode, onClose, onSave }: MermaidEditModalProps) {
  const t = useT();
  const [code, setCode] = useState(initialCode);
  const [previewCode, setPreviewCode] = useState(initialCode);
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [type, setType] = useState(() => detectMermaidType(initialCode));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  /* 防抖后再渲染预览 */
  useEffect(() => {
    if (code === previewCode) return;
    const id = setTimeout(() => setPreviewCode(code), PREVIEW_DEBOUNCE);
    return () => clearTimeout(id);
  }, [code, previewCode]);

  useEffect(() => {
    let cancelled = false;
    const uid = `mdmm-${Date.now()}-${seqRef.current++}`;
    setErr(null);
    setSvg(null);
    renderMermaidSvg(previewCode, isDarkMode, uid)
      .then(({ svg: out }) => { if (!cancelled) setSvg(out); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [previewCode, isDarkMode]);

  useEffect(() => {
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (!modalRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const editorExtensions = useMemo(
    () => [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      syntaxHighlighting(isDarkMode ? vsCodeDarkHighlightStyle : vsCodeLightHighlightStyle),
    ],
    [isDarkMode],
  );

  const currentType = detectMermaidType(code);

  const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value;
    const template = mermaidTemplateOf(nextType);
    setType(nextType);
    setCode(template.code);
  };

  const handleReset = () => {
    const template = mermaidTemplateOf(currentType);
    setCode(template.code);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.35)' }}>
      <div
        ref={modalRef}
        className={cn(
          'flex flex-col w-full max-w-[860px] h-[76vh] rounded-xl border shadow-2xl overflow-hidden',
          isDarkMode ? 'border-zinc-700/70' : 'border-zinc-200/80',
        )}
        style={isDarkMode ? { background: '#262626' } : { background: '#ffffff' }}
      >
        {/* 标题栏 */}
        <div className={cn('flex items-center gap-2 px-4 h-12 shrink-0 border-b', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
          <span className={cn('text-sm font-semibold', isDarkMode ? 'text-zinc-100' : 'text-zinc-900')}>
            {t('md.mermaidEdit')}
          </span>
          <div className="flex-1" />
          <button
            onClick={handleReset}
            title={t('md.mermaidFillTemplate')}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
              isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600',
            )}
          >
            <RotateCcw size={13} />{t('md.mermaidFillTemplate')}
          </button>
          <button
            onClick={onClose}
            title={t('common.close')}
            className={cn('p-1 rounded-md transition-colors', isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体：编辑 | 预览 */}
        <div className="flex-1 flex min-h-0">
          {/* 编辑侧 */}
          <div className="flex-1 flex flex-col min-w-0 border-r" style={{ borderColor: isDarkMode ? '#3f3f46' : '#e4e4e7' }}>
            <div className="flex items-center gap-2 px-3 py-2 shrink-0">
              <label className={cn('text-xs shrink-0', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>{t('md.mermaidType')}</label>
              <select
                value={currentType}
                onChange={handleTypeChange}
                className={cn(
                  'flex-1 h-8 text-xs rounded-md border outline-none',
                  isDarkMode
                    ? 'bg-zinc-800 border-zinc-700 text-zinc-200'
                    : 'bg-white border-zinc-300 text-zinc-700',
                )}
              >
                {MERMAID_TEMPLATES.map((tpl) => (
                  <option key={tpl.type} value={tpl.type}>{tpl.label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <CodeMirror
                value={code}
                onChange={setCode}
                theme={isDarkMode ? vsCodeDarkTheme : vsCodeLightTheme}
                extensions={editorExtensions}
                basicSetup={false}
                height="100%"
              />
            </div>
            {err && (
              <div
                className={cn('mx-3 mb-2 px-3 py-2 rounded-md text-xs max-h-28 overflow-auto shrink-0', isDarkMode ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600')}
                style={{ whiteSpace: 'pre-wrap', fontFamily: '"Fira Code", Consolas, monospace' }}
              >
                <div className="font-semibold mb-1">{t('md.mermaidErr')}</div>
                {err}
              </div>
            )}
          </div>

          {/* 预览侧 */}
          <div className="flex-1 min-w-0 flex items-start justify-center overflow-auto p-4">
            {!err && svg === null && (
              <div className={cn('text-xs mt-8', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>{t('md.mermaidLoading')}</div>
            )}
            {!err && svg !== null && <div dangerouslySetInnerHTML={{ __html: svg }} />}
          </div>
        </div>

        {/* 底部操作 */}
        <div className={cn('flex items-center justify-end gap-2 px-4 h-14 shrink-0 border-t', isDarkMode ? 'border-zinc-700 bg-transparent' : 'border-zinc-200')}>
          <button
            onClick={onClose}
            className={cn(
              'px-4 h-8 rounded-md text-xs font-medium transition-colors border',
              isDarkMode ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100',
            )}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onSave(code)}
            disabled={!!err}
            className={cn(
              'flex items-center gap-1.5 px-4 h-8 rounded-md text-xs font-semibold text-white transition-colors disabled:opacity-50',
              'bg-[#96A5EB] hover:bg-[#8596e6]',
            )}
          >
            <Check size={14} />{t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}