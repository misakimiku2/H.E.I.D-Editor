import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Check, RotateCcw, AlertTriangle, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { renderMermaidSvg } from '../lib/mermaid';
import { useT, type MessageKey } from '../lib/i18nContext';
import { useDragScroll } from '../hooks/useDragScroll';
import { ConfirmDialog } from './ConfirmDialog';
import {
  DIAGRAM_KINDS,
  defaultModel,
  generateMermaid,
  isModelEmpty,
  parseMermaid,
  type DiagramKind,
  type MermaidModel,
} from '../lib/mermaidModel';
import {
  FlowchartForm,
  SequenceForm,
  PieForm,
  XyChartForm,
  GanttForm,
  TimelineForm,
  MindmapForm,
  Select,
} from './MermaidForms';

/* ---- Markdown 预览内 Mermaid 图表编辑器 ----
   面向「不懂 Mermaid 语法」的编辑方式：按图型拆成结构化表单（节点/连线/数据项…），
   左侧填表、右侧实时预览，保存时把生成的源码块回写到文档。
   想直接改源码的用户可以在 Markdown 源码视图里编辑代码块，这里不再提供源码模式。
   解析遇到不支持的内容时降级为「只读提示 + 预览」，不猜测、不丢内容。 */

interface MermaidEditModalProps {
  /** 当前图表源码（不含 ``` 围栏） */
  initialCode: string;
  isDarkMode: boolean;
  onClose: () => void;
  onSave: (code: string) => void;
}

const PREVIEW_DEBOUNCE = 220;

/* 左右两栏宽度：左栏可拖动分隔条调整，默认给预览留出更多空间 */
const FORM_DEFAULT = 420;
const FORM_MIN = 400;
const PREVIEW_MIN = 320;

/** 图型显示名（含可视化编辑器不支持的图型，用于降级提示） */
const KIND_LABEL_KEYS: Record<string, MessageKey> = {
  flowchart: 'md.mmtype.flowchart',
  sequenceDiagram: 'md.mmtype.sequenceDiagram',
  classDiagram: 'md.mmtype.classDiagram',
  'stateDiagram-v2': 'md.mmtype.stateDiagram-v2',
  gantt: 'md.mmtype.gantt',
  erDiagram: 'md.mmtype.erDiagram',
  pie: 'md.mmtype.pie',
  journey: 'md.mmtype.journey',
  mindmap: 'md.mmtype.mindmap',
  timeline: 'md.mmtype.timeline',
  'xychart-beta': 'md.mmtype.xychart-beta',
};

type ConfirmState = { kind: 'reset' } | { kind: 'switch'; to: DiagramKind };

export function MermaidEditModal({ initialCode, isDarkMode, onClose, onSave }: MermaidEditModalProps) {
  const t = useT();
  /* 初始解析只做一次：弹窗每次打开都是全新挂载 */
  const [init] = useState(() => parseMermaid(initialCode));
  const [model, setModel] = useState<MermaidModel | null>(init.ok ? init.model : null);
  const [extras, setExtras] = useState<string[]>(init.ok ? init.extras : []);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /* 预览默认「适应宽度」看全貌（不出现横向滚动条），需要看细节时切到原始尺寸 */
  const [fitWidth, setFitWidth] = useState(true);
  const [previewCode, setPreviewCode] = useState(() => (init.ok ? generateMermaid(init.model, init.extras) : initialCode));
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seqRef = useRef(0);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  /* 预览区支持按住鼠标拖动平移（原始尺寸下横向、适应宽度下纵向） */
  const { dragging, handlers: dragHandlers } = useDragScroll<HTMLDivElement>();

  /* ---- 左栏宽度可拖动调整 ---- */
  const [formWidth, setFormWidth] = useState(FORM_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{ left: number; width: number } | null>(null);

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return;
    resizeRef.current = { left: rect.left, width: rect.width };
    setResizing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已失效则忽略 */
    }
  };

  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = resizeRef.current;
    if (!st) return;
    const max = Math.max(FORM_MIN, st.width - PREVIEW_MIN);
    setFormWidth(Math.min(Math.max(e.clientX - st.left, FORM_MIN), max));
  };

  const onDividerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 未捕获则忽略 */
    }
  };

  const code = useMemo(() => (model ? generateMermaid(model, extras) : initialCode), [model, extras, initialCode]);
  /* 与打开时等价的源码（用于判断「有没有真的改过」，没改就直接关闭、不重写文档） */
  const baseCode = useMemo(() => (init.ok ? generateMermaid(init.model, init.extras) : initialCode), [init, initialCode]);

  /* 表单改动 → 防抖后进入预览（首次立即渲染） */
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
      .then(({ svg: out }) => {
        if (!cancelled) setSvg(out);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [previewCode, isDarkMode]);

  /* mermaid 输出的 svg 是 width:100% + max-width:原始宽度，在半栏预览里会被压小；
     首次渲染时记下原始宽度，之后按「原始尺寸 / 适应宽度」两种模式套用 */
  useEffect(() => {
    if (!svg) return;
    const el = previewRef.current?.querySelector('svg');
    if (!el) return;
    if (!el.dataset.rawWidth) {
      const maxW = el.style.maxWidth;
      if (maxW && maxW !== 'none') el.dataset.rawWidth = maxW;
    }
    const raw = el.dataset.rawWidth;
    if (!raw) return;
    el.style.maxWidth = 'none';
    el.style.height = 'auto';
    el.style.width = fitWidth ? '100%' : raw;
  }, [svg, fitWidth]);

  /* Esc 关闭；确认框打开时交给确认框处理 */
  const confirmOpenRef = useRef(false);
  confirmOpenRef.current = confirm !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmOpenRef.current) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleKindSelect = (k: DiagramKind) => {
    if (!model || k === model.kind) return;
    if (isModelEmpty(model) && extras.length === 0) {
      setModel(defaultModel(k));
      return;
    }
    setConfirm({ kind: 'switch', to: k });
  };

  const applyConfirm = () => {
    if (!confirm) return;
    setModel(defaultModel(confirm.kind === 'reset' ? (model?.kind ?? 'flowchart') : confirm.to));
    setExtras([]);
    setConfirm(null);
  };

  const handleDone = () => {
    if (!model) return;
    if (code !== baseCode) onSave(code);
    else onClose();
  };

  const unsupported = !init.ok ? init : null;
  const unsupportedKindName = unsupported?.kind
    ? (KIND_LABEL_KEYS[unsupported.kind] ? t(KIND_LABEL_KEYS[unsupported.kind]) : unsupported.kind)
    : '';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* 遮罩：压暗 + 毛玻璃（与项目其他弹窗一致） */}
      <div
        className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md"
        onClick={() => {
          if (!confirmOpenRef.current) onClose();
        }}
      />
      <div
        ref={modalRef}
        className={cn(
          'relative flex flex-col w-full max-w-[1180px] h-[84vh] rounded-xl border shadow-2xl overflow-hidden',
          isDarkMode ? 'border-zinc-700/70' : 'border-zinc-200/80',
        )}
        style={isDarkMode ? { background: '#262626' } : { background: '#ffffff' }}
      >
        {/* 标题栏 */}
        <div className={cn('flex items-center gap-2 px-4 h-12 shrink-0 border-b', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
          <span className={cn('text-sm font-semibold', isDarkMode ? 'text-zinc-100' : 'text-zinc-900')}>{t('md.mermaidEdit')}</span>
          {model ? (
            <Select
              value={model.kind}
              onChange={handleKindSelect}
              options={DIAGRAM_KINDS.map((k) => ({ value: k, label: t((`md.mmtype.${k}`) as MessageKey) }))}
              isDark={isDarkMode}
              className="w-[124px]"
              title={t('md.mm.kind')}
            />
          ) : (
            <span className={cn('text-xs', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>{unsupportedKindName}</span>
          )}
          <div className="flex-1" />
          {model && svg && (
            <button
              onClick={() => setFitWidth((v) => !v)}
              title={fitWidth ? t('md.mm.actualSize') : t('md.mm.fitWidth')}
              className={cn(
                'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
                isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600',
              )}
            >
              {fitWidth ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              {fitWidth ? t('md.mm.actualSize') : t('md.mm.fitWidth')}
            </button>
          )}
          {model && (
            <button
              onClick={() => setConfirm({ kind: 'reset' })}
              title={t('md.mermaidFillTemplate')}
              className={cn(
                'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
                isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600',
              )}
            >
              <RotateCcw size={13} />
              {t('md.mermaidFillTemplate')}
            </button>
          )}
          <button
            onClick={onClose}
            title={t('common.close')}
            className={cn('p-1 rounded-md transition-colors', isDarkMode ? 'hover:bg-zinc-700 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主体：表单 | 分隔条 | 预览（分隔条可拖动调整左右宽度） */}
        <div className={cn('flex-1 flex min-h-0', resizing && 'select-none')}>
          <div
            className="flex flex-col min-w-0 shrink-0"
            style={{ width: formWidth, minWidth: FORM_MIN, maxWidth: `calc(100% - ${PREVIEW_MIN}px)` }}
          >
            {model ? (
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {model.kind === 'flowchart' && <FlowchartForm model={model} onChange={setModel} isDark={isDarkMode} />}
                {model.kind === 'sequenceDiagram' && <SequenceForm model={model} onChange={setModel} isDark={isDarkMode} />}
                {model.kind === 'pie' && <PieForm model={model} onChange={setModel} isDark={isDarkMode} />}
                {model.kind === 'xychart-beta' && <XyChartForm model={model} onChange={setModel} isDark={isDarkMode} />}
                {model.kind === 'gantt' && <GanttForm model={model} onChange={setModel} isDark={isDarkMode} />}
                {model.kind === 'timeline' && <TimelineForm model={model} onChange={setModel} isDark={isDarkMode} />}
                {model.kind === 'mindmap' && <MindmapForm model={model} onChange={setModel} isDark={isDarkMode} />}

                {extras.length > 0 && (
                  <details className={cn('rounded-md border p-2 text-[11px]', isDarkMode ? 'border-zinc-700 text-zinc-400' : 'border-zinc-200 text-zinc-500')}>
                    <summary className="cursor-pointer select-none">{t('md.mm.extras', { n: extras.length })}</summary>
                    <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[10px] leading-relaxed opacity-75">{extras.join('\n')}</pre>
                  </details>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto p-4">
                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed',
                    isDarkMode ? 'border-amber-700/50 bg-amber-900/20 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800',
                  )}
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <div className="space-y-1.5">
                    <div className="font-semibold">{t('md.mm.unsupportedTitle')}</div>
                    {unsupported && (
                      <div>
                        {unsupported.reason === 'unsupported' && unsupported.kind
                          ? t('md.mm.unsupportedKind', { kind: unsupportedKindName })
                          : t('md.mm.unsupportedLine', { line: unsupported.line, text: unsupported.text })}
                      </div>
                    )}
                    <div className={isDarkMode ? 'text-amber-300/80' : 'text-amber-700/80'}>{t('md.mm.unsupportedHint')}</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 分隔条：左右拖动调整表单宽度（最窄 400px，预览保底 320px），双击复位 */}
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            onPointerCancel={onDividerUp}
            onDoubleClick={() => setFormWidth(FORM_DEFAULT)}
            title={t('md.mm.resizeHint')}
            className={cn(
              'w-1.5 shrink-0 cursor-col-resize touch-none transition-colors',
              resizing ? 'bg-[#96A5EB]' : isDarkMode ? 'bg-zinc-700/60 hover:bg-zinc-600' : 'bg-zinc-200 hover:bg-zinc-300',
            )}
          />

          {/* 预览侧：SVG 按 mermaid 算出的原始宽度展示（宽图横向滚动），避免被半栏压扁；
              按住鼠标可直接拖动平移（适应宽度下高度超出时可上下拖） */}
          <div
            className={cn(
              'heid-scroll flex-1 min-w-0 overflow-auto p-4',
              svg !== null && (dragging ? 'cursor-grabbing select-none' : 'cursor-grab'),
            )}
            {...dragHandlers}
          >
            {err ? (
              <div
                className={cn('w-full rounded-md px-3 py-2 text-xs', isDarkMode ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600')}
                style={{ whiteSpace: 'pre-wrap', fontFamily: '"Fira Code", Consolas, monospace' }}
              >
                <div className="mb-1 font-semibold">{t('md.mermaidErr')}</div>
                {err}
              </div>
            ) : svg === null ? (
              <div className={cn('mt-8 text-center text-xs', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>{t('md.mermaidLoading')}</div>
            ) : (
              <div ref={previewRef} className={fitWidth ? 'w-full' : 'mx-auto w-max'} dangerouslySetInnerHTML={{ __html: svg }} />
            )}
          </div>
        </div>

        {/* 底部操作 */}
        <div className={cn('flex items-center justify-end gap-2 px-4 h-14 shrink-0 border-t', isDarkMode ? 'border-zinc-700 bg-transparent' : 'border-zinc-200')}>
          <button
            onClick={onClose}
            className={cn(
              'px-4 h-8 rounded-md text-xs font-medium pointer-coarse:h-11 pointer-coarse:text-sm transition-colors border',
              isDarkMode ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100',
            )}
          >
            {model ? t('common.cancel') : t('common.close')}
          </button>
          <button
            onClick={handleDone}
            disabled={!model || !!err}
            className={cn(
              'flex items-center gap-1.5 px-4 h-8 rounded-md text-xs font-semibold text-white transition-colors disabled:opacity-50',
              'bg-[#96A5EB] hover:bg-[#8596e6]',
            )}
          >
            <Check size={14} />
            {t('common.done')}
          </button>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'reset' ? t('md.mm.resetTitle') : t('md.mm.switchTitle')}
          message={confirm.kind === 'reset' ? t('md.mm.resetMsg') : t('md.mm.switchMsg')}
          isDarkMode={isDarkMode}
          danger
          onConfirm={applyConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
