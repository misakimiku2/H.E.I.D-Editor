import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, createContext, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import { ImageViewer } from './ImageViewer';
import { resolveImageSrc, ImageForbiddenError } from '../lib/imageSrc';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkEmoji from 'remark-emoji';
import { remarkGfmStrict, remarkInlineExt } from '../lib/remarkExt';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, ghcolors } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Table, Image as ImageIcon, Plus, Minus, Copy, Scissors, Trash2, Layers, Workflow, Pencil, Maximize2, Minimize2 } from 'lucide-react';
import { renderMermaidSvg } from '../lib/mermaid';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP } from '../lib/platform';
import { FormatMenu, INLINE_WRAPS, transformSlice, footnoteEdit, type MdOp, type MenuState } from './MarkdownTools';
import { ImageInsertModal, type InsertImage } from './ImageInsertModal';
import { MermaidEditModal } from './MermaidEditModal';
import { PreviewFindBar } from './PreviewFindBar';
import type { PointerPos } from '../hooks/useLastPointer';
import { useDragScroll } from '../hooks/useDragScroll';
import { useT } from '../lib/i18nContext';
import { parseLangBlocks } from '../lib/markdownLangs';
import { applyImageTab, applySelectionTab } from '../lib/markdownTabs';

/** 页签文档按块渲染时，块 md 的全文起始偏移（右键选区映射回源码用） */
const BlockBaseContext = createContext(0);

/* markdown 渲染插件管线：组装版 GFM(~~删除线~~/表格/任务列表/脚注，单 ~ 让给下标)
   + 公式($…$/$$…$$，KaTeX) + emoji 短代码 + ==高亮==/^上标^/~下标~ 行内扩展 */
const remarkPlugins = [remarkGfmStrict, remarkMath, remarkEmoji, remarkInlineExt];
const rehypePlugins = [rehypeKatex];

/* 把源码偏移量写到 DOM 上，供右键时把选区映射回源码。
   页签文档按块渲染，remark 的偏移相对块字符串——用 context 注入块的
   原文起始偏移，保证 data-md-* 始终是全文坐标 */
const useSrcData = () => {
  const base = useContext(BlockBaseContext);
  return (node: any) => {
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return {};
    return { 'data-md-start': String(start + base), 'data-md-end': String(end + base) };
  };
};

/* 宽表（材料/倍率表可达十来列）超出容器时横向滚动，而非把标签列挤压成逐字竖排 */
function TableBlock({ node, children, ...props }: any) {
  const srcData = useSrcData();
  const sd = srcData(node);
  return (
    <div {...sd} style={{ overflowX: 'auto' }}>
      <table {...props} {...sd}>{children}</table>
    </div>
  );
}
/* ---- 本地图片：相对/绝对路径经 lib/imageSrc 读取为 blob URL（带缓存），独立查看器共用 ---- */

const MarkdownImage = React.memo<{
  src: string;
  alt: string;
  isDarkMode: boolean;
  /** 图片语法在源码中的偏移（删除/剪切用）；页签文档下已是全文坐标 */
  srcStart?: number;
  srcEnd?: number;
  onOpen?: (src: string, alt: string) => void;
  onMenu?: (e: React.MouseEvent, info: { resolvedSrc: string; alt: string; srcStart?: number; srcEnd?: number }) => void;
}>(({ src, alt, isDarkMode, srcStart, srcEnd, onOpen, onMenu }) => {
  const t = useT();
  const [imgSrc, setImgSrc] = useState<string>('');
  const [loadError, setLoadError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const localMarker = '|||LOCAL-FILE:';
    let displayAlt = alt || '';
    let filePath = '';

    if (displayAlt.includes(localMarker)) {
      const parts = displayAlt.split(localMarker);
      displayAlt = parts[0];
      filePath = parts[1] || '';
      if ((filePath.startsWith('"') && filePath.endsWith('"')) || (filePath.startsWith("'") && filePath.endsWith("'"))) {
        filePath = filePath.slice(1, -1);
      }
    }

    const target = filePath || (src && !src.startsWith('https://local-image.placeholder') ? src : '');
    if (!target) return;
    (async () => {
      try {
        const url = await resolveImageSrc(target);
        if (!cancelled) setImgSrc(url);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof ImageForbiddenError ? t('image.errForbidden') : t('image.errLoad'));
      }
    })();
    return () => { cancelled = true; };
  }, [src, alt, t]);

  if (!imgSrc && !loadError) return null;

  if (loadError) {
    return (
      <span style={{
        display: 'block', margin: '1.5rem auto', maxWidth: '100%', padding: '2rem',
        textAlign: 'center', borderRadius: '0.5rem',
        background: isDarkMode ? 'rgba(39,39,42,0.5)' : 'rgba(244,244,245,0.8)',
        border: `1px dashed ${isDarkMode ? '#52525b' : '#d4d4d8'}`,
        color: isDarkMode ? '#a1a1aa' : '#71717a', fontSize: '0.875rem'
      }}>
        <span style={{ fontSize: '1.5rem', marginBottom: '0.5rem', display: 'block' }}>🖼️</span>
        <span style={{ display: 'block' }}>{(alt || '').split('|||LOCAL-FILE:')[0] || t('image.defaultName')}</span>
        <span style={{ fontSize: '0.75rem', marginTop: '0.25rem', opacity: 0.7, display: 'block' }}>{loadError}</span>
      </span>
    );
  }

  const altName = (alt || '').split('|||LOCAL-FILE:')[0] || '';

  return (
    <img
      src={imgSrc} alt={altName}
      loading="lazy"
      onError={() => setLoadError(t('image.errLoad'))}
      onClick={(e) => { if (!onOpen) return; e.stopPropagation(); e.preventDefault(); onOpen(imgSrc, altName); }}
      onContextMenu={(e) => { if (!onMenu) return; e.stopPropagation(); onMenu(e, { resolvedSrc: imgSrc, alt: altName, srcStart, srcEnd }); }}
      style={{ maxWidth: '100%', height: 'auto', borderRadius: '0.5rem', display: 'block', marginLeft: 'auto', marginRight: 'auto', margin: '1.5rem 0', cursor: onOpen ? 'zoom-in' : undefined }}
    />
  );
});

MarkdownImage.displayName = 'MarkdownImage';

/* ---- Mermaid 图：```mermaid 代码块懒加载渲染为内联 SVG ----
   动态 import 拆出独立 chunk，首次出现图表时才下载，避免拖累移动端主包体积。
   悬停显示「编辑」入口，打开图表编辑器（见 MermaidEditModal）。
   宽图（甘特图/XY 图）按原始尺寸展示并支持按住鼠标拖动平移，右上角可切换「适应宽度」。 */

const MermaidRenderer = React.memo(function MermaidRenderer({ code, isDarkMode, canEdit, onEdit, onMenu }: {
  code: string;
  isDarkMode: boolean;
  canEdit?: boolean;
  onEdit?: (e: React.MouseEvent) => void;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /* false = 保持 mermaid 的原始尺寸（宽图横向滚动，文字清晰）；true = 缩到容器宽看全貌 */
  const [fitWidth, setFitWidth] = useState(false);
  /* 图比容器宽时才显示缩放切换按钮（窄到溢出才有选择的意义） */
  const [overflowing, setOverflowing] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(`md-mermaid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  const bindRef = useRef<((el: HTMLElement | null) => void) | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSvg(null);
    renderMermaidSvg(code, isDarkMode, idRef.current)
      .then(({ svg: out, bind }) => {
        if (cancelled) return;
        bindRef.current = bind;
        setSvg(out);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [code, isDarkMode]);

  /* SVG 注入后绑定交互（点击等），需在真实 DOM 上调用 */
  useEffect(() => {
    if (svg === null) return;
    bindRef.current?.(holderRef.current);
  }, [svg]);

  /* mermaid 默认输出 width:100%：宽图（甘特图/XY 图）被压到容器宽后文字小到看不清。
     这里按「原始尺寸 / 适应宽度」两种模式套用 mermaid 算出的原始宽度：
     原始尺寸下由容器横向滚动查看，小图则自然居中（mx-auto + w-max）。 */
  useEffect(() => {
    if (svg === null) return;
    const el = holderRef.current?.querySelector('svg');
    if (!el) return;
    if (!el.dataset.rawWidth) {
      const raw = el.style.maxWidth;
      if (raw && raw !== 'none') el.dataset.rawWidth = raw;
    }
    const raw = el.dataset.rawWidth;
    if (!raw) return;
    el.style.maxWidth = 'none';
    el.style.height = 'auto';
    el.style.width = fitWidth ? '100%' : raw;
  }, [svg, fitWidth]);

  /* 跟随容器宽度判断是否溢出（分屏切换/改窗口大小都要重算） */
  useEffect(() => {
    if (svg === null) return;
    const holder = holderRef.current;
    const pane = holder?.parentElement;
    if (!holder || !pane) return;
    const update = () => {
      const el = holder.querySelector('svg');
      const raw = parseFloat(el?.dataset.rawWidth ?? '0') || 0;
      /* 容器 p-3：可用内容宽 = clientWidth - 24，留 4px 余量 */
      setOverflowing(raw > pane.clientWidth - 20);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [svg]);

  /* 宽图（原始尺寸）支持按住鼠标拖动平移（单击/双击/右键不受影响，阈值见 useDragScroll） */
  const { dragging, handlers: dragHandlers } = useDragScroll<HTMLDivElement>();
  const canDrag = overflowing && !fitWidth;

  if (err) {
    return (
      <div
        className="my-4 rounded-lg overflow-auto"
        style={{ background: isDarkMode ? '#1e1e1e' : '#f3f4f6' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1.25rem', fontSize: '13px', lineHeight: '1.6' }}>
          <div style={{ fontWeight: 600, color: isDarkMode ? '#f87171' : '#b91c1c' }}>Mermaid 解析失败</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', color: isDarkMode ? '#a1a1aa' : '#71717a' }}>{err}</pre>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', color: isDarkMode ? '#d4d4d8' : '#374151' }}>{code}</pre>
        </div>
      </div>
    );
  }

  return (
    /* 外层不滚动：右上角按钮固定在这里，图表横向滚动时不会跟着跑 */
    <div
      className="group relative my-4"
      /* 双击图表也能进编辑器（悬停右上角有按钮，双击是更顺手的入口） */
      onDoubleClick={canEdit ? onEdit : undefined}
      onContextMenu={canEdit ? onMenu : undefined}
    >
      <div
        className={cn(
          'heid-scroll rounded-lg p-3 overflow-x-auto',
          /* 可用鼠标按住左右拖动平移（仅在宽图原始尺寸下；触屏交给原生手势） */
          canDrag && (dragging ? 'cursor-grabbing select-none' : 'cursor-grab'),
        )}
        style={{ background: isDarkMode ? 'rgba(39,39,42,0.4)' : 'rgba(244,244,245,0.5)' }}
        {...dragHandlers}
      >
        {svg === null ? (
          <div style={{ padding: '1rem', fontSize: '12px', color: isDarkMode ? '#a1a1aa' : '#71717a' }}>{t('md.mermaidLoading')}</div>
        ) : (
          <div ref={holderRef} className={fitWidth ? 'w-full' : 'mx-auto w-max'} dangerouslySetInnerHTML={{ __html: svg }} />
        )}
      </div>
      {canEdit && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {(overflowing || fitWidth) && (
            <button
              onClick={() => setFitWidth((v) => !v)}
              title={fitWidth ? t('md.mm.actualSize') : t('md.mm.fitWidth')}
              className={cn(
                'flex items-center rounded-md px-1.5 py-1 backdrop-blur-md border shadow-sm transition-colors',
                isDarkMode
                  ? 'bg-zinc-800/80 border-zinc-700 text-zinc-200 hover:bg-zinc-700'
                  : 'bg-white/80 border-zinc-200 text-zinc-600 hover:bg-zinc-50',
              )}
            >
              {fitWidth ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          )}
          <button
            onClick={onEdit}
            title={t('md.mermaidEdit')}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium backdrop-blur-md border shadow-sm transition-colors',
              isDarkMode
                ? 'bg-zinc-800/80 border-zinc-700 text-zinc-200 hover:bg-zinc-700'
                : 'bg-white/80 border-zinc-200 text-zinc-600 hover:bg-zinc-50',
            )}
          >
            <Pencil size={12} />{t('common.edit')}
          </button>
        </div>
      )}
    </div>
  );
});

MermaidRenderer.displayName = 'MermaidRenderer';

/* ---- 图片右键菜单：复制 / 剪切 / 删除 / 设为页签 ---- */

function ImageContextMenu({ x, y, canEdit, isDarkMode, onClose, onCopy, onCut, onDelete, onTab }: {
  x: number; y: number; canEdit: boolean; isDarkMode: boolean;
  onClose: () => void;
  onCopy: () => void;
  onCut: () => void;
  onDelete: () => void;
  onTab: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  const left = Math.min(x, window.innerWidth - 158);
  const top = Math.min(y, window.innerHeight - (canEdit ? 158 : 52));

  const item = cn(
    'flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs transition-colors text-left',
    isDarkMode ? 'hover:bg-zinc-700/70 text-zinc-200' : 'hover:bg-zinc-100 text-zinc-700',
  );

  return (
    <div
      ref={ref}
      className={cn(
        'fixed z-[150] w-40 rounded-lg border shadow-xl backdrop-blur-md p-1 flex flex-col',
        isDarkMode ? 'border-zinc-700/70 bg-zinc-800/70' : 'border-zinc-200/80 bg-white/70',
      )}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className={item} onClick={onCopy}><Copy size={13} />{t('image.copy')}</button>
      {canEdit && <button className={item} onClick={onCut}><Scissors size={13} />{t('image.cut')}</button>}
      {canEdit && <button className={cn(item, isDarkMode ? 'hover:bg-red-900/50' : 'hover:bg-red-50')} onClick={onDelete}><Trash2 size={13} />{t('image.delete')}</button>}
      {canEdit && <button className={item} onClick={onTab}><Layers size={13} />{t('image.toTab')}</button>}
    </div>
  );
}

/* ---- 图表右键菜单：编辑 / 删除（与图片菜单同风格） ---- */

function MermaidContextMenu({ x, y, isDarkMode, onClose, onEdit, onDelete }: {
  x: number; y: number; isDarkMode: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  const left = Math.min(x, window.innerWidth - 158);
  const top = Math.min(y, window.innerHeight - 84);
  const item = cn(
    'flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs transition-colors text-left',
    isDarkMode ? 'hover:bg-zinc-700/70 text-zinc-200' : 'hover:bg-zinc-100 text-zinc-700',
  );

  return (
    <div
      ref={ref}
      className={cn(
        'fixed z-[150] w-40 rounded-lg border shadow-xl backdrop-blur-md p-1 flex flex-col',
        isDarkMode ? 'border-zinc-700/70 bg-zinc-800/70' : 'border-zinc-200/80 bg-white/70',
      )}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className={item} onClick={onEdit}><Pencil size={13} />{t('md.mermaidEdit')}</button>
      <button
        className={cn(item, isDarkMode ? 'hover:bg-red-900/50' : 'hover:bg-red-50')}
        onClick={onDelete}
      >
        <Trash2 size={13} />{t('md.mermaidDelete')}
      </button>
    </div>
  );
}

/* ---- 图片写入剪贴板：fetch → blob 优先，canvas 兜底，统一转 PNG ---- */

async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    let blob: Blob | null = null;
    try {
      const r = await fetch(src);
      if (r.ok) blob = await r.blob();
    } catch { /* 跨域 fetch 失败走 canvas */ }
    if (!blob || !blob.type.startsWith('image/')) {
      blob = await new Promise<Blob | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            canvas.getContext('2d')!.drawImage(img, 0, 0);
            canvas.toBlob(b => resolve(b), 'image/png');
          } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = src;
      });
    }
    if (!blob) return false;
    if (blob.type !== 'image/png') {
      const url = URL.createObjectURL(blob);
      const png = await new Promise<Blob | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            canvas.getContext('2d')!.drawImage(img, 0, 0);
            canvas.toBlob(b => resolve(b), 'image/png');
          } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
      URL.revokeObjectURL(url);
      if (!png) return false;
      blob = png;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

/* ---- markdown 表格源码的解析 / 序列化 / 块插入 ---- */

export interface ParsedTable {
  rows: string[][];
  aligns: string[];
}

function parseTableSrc(src: string): ParsedTable | null {
  const lines = src.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;
  const splitRow = (line: string) => {
    let s = line;
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim().replace(/\\\|/g, '|'));
  };
  const rows = [splitRow(lines[0])];
  const aligns = splitRow(lines[1]).map(c => (/^:?-+:?$/.test(c) ? c : '---'));
  for (let i = 2; i < lines.length; i++) rows.push(splitRow(lines[i]));
  const width = rows[0].length || 1;
  rows.forEach(r => { while (r.length < width) r.push(''); });
  return { rows, aligns };
}

function serializeTableSrc(t: ParsedTable): string {
  const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const width = Math.max(t.rows[0]?.length ?? 0, t.aligns.length, 1);
  const row = (r: string[]) => '| ' + Array.from({ length: width }, (_, i) => esc(r[i] ?? '')).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: width }, (_, i) => t.aligns[i] ?? '---').join(' | ') + ' |';
  return [row(t.rows[0] ?? []), sep, ...t.rows.slice(1).map(r => row(r))].join('\n');
}

/* 在文档的 at 位置插入一个独立块，自动补齐前后空行 */
function insertBlockAt(content: string, at: number, block: string): string {
  const before = content.slice(0, at).replace(/\n+$/, '');
  const after = content.slice(at);
  const head = before.length === 0 ? '' : before + '\n\n';
  const tail = after.length === 0 ? '' : (after.startsWith('\n') ? after : '\n\n' + after);
  return head + block + tail;
}

const BLANK_TABLE = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';

/* 本地路径 → markdown 图片 URL：反斜杠转正斜杠并对空格/括号/#/? 百分号编码。
   不编码的话解析器会在第一个空格或括号处截断 URL，产生裂图和残留文本 */
const encodeLocalImageUrl = (p: string): string => {
  const normalized = p.replace(/\\/g, '/');
  const prefixed = /^[A-Za-z]:/.test(normalized) ? 'file:///' + normalized : normalized;
  return encodeURI(prefixed)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23');
};

/* ---- 图片插入弹窗的源码上下文：以插入锚点所在行为中心取最多 7 行 ----
   caret 为锚点在片段内的偏移，用户在源码框中移动光标后按光标绝对位置精确插入 */
export interface SourceSnippet {
  text: string;
  caret: number;
  start: number;
}

function buildSourceSnippet(content: string, at: number): SourceSnippet {
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const line of content.split('\n')) {
    lines.push({ text: line, start: pos });
    pos += line.length + 1;
  }
  let idx = lines.findIndex(l => at <= l.start + l.text.length);
  if (idx < 0) idx = lines.length - 1;
  const from = Math.max(0, idx - 3);
  const to = Math.min(lines.length - 1, idx + 3);
  const text = lines.slice(from, to + 1).map(l => l.text).join('\n');
  return {
    text,
    caret: Math.min(Math.max(0, at - lines[from].start), text.length),
    start: lines[from].start,
  };
}

/* 鼠标未点中任何渲染块时（落在空隙/空白处），按 Y 坐标就近取块边界作为插入锚点，
   避免退化成“追加到文档末尾” */
function findNearestBlockBoundary(root: HTMLElement, clientY: number): number | null {
  const proseEl = root.querySelector('.prose') as HTMLElement | null;
  if (!proseEl) return null;
  const blocks = (Array.from(proseEl.children) as HTMLElement[])
    .filter(c => c.dataset?.mdStart && c.dataset?.mdEnd);
  if (blocks.length === 0) return null;
  const rects = blocks.map(b => b.getBoundingClientRect());
  if (clientY <= rects[0].top) return Number(blocks[0].dataset.mdStart);
  for (let i = 0; i < blocks.length; i++) {
    const r = rects[i];
    const next = i + 1 < rects.length ? rects[i + 1] : null;
    if (clientY >= r.top && clientY <= r.bottom) {
      /* 点在块内但没被上游命中（如块内空白较大处）：取更近的上下边缘 */
      return (clientY - r.top <= r.bottom - clientY)
        ? (i === 0 ? Number(blocks[0].dataset.mdStart) : Number(blocks[i - 1].dataset.mdEnd))
        : Number(blocks[i].dataset.mdEnd);
    }
    if (next && clientY > r.bottom && clientY < next.top) {
      return Number(blocks[i].dataset.mdEnd);
    }
  }
  return Number(blocks[blocks.length - 1].dataset.mdEnd);
}

/* ---- 空白处右键插入菜单 ---- */

const InsertMenu = React.memo<{
  x: number;
  y: number;
  isDarkMode: boolean;
  onTable: () => void;
  onImage: () => void;
  onDiagram: () => void;
  onClose: () => void;
}>(({ x, y, isDarkMode, onTable, onImage, onDiagram, onClose }) => {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose]);

  const left = Math.max(4, Math.min(x, window.innerWidth - 176));
  const top = Math.max(4, Math.min(y, window.innerHeight - 148));

  return (
    <div
      ref={ref}
      className={cn(
        "fixed z-[90] w-40 rounded-xl border shadow-xl backdrop-blur-md p-1 flex flex-col",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
      )}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className={cn("text-[10px] font-semibold tracking-wider px-2 pt-1 pb-0.5", isDarkMode ? "text-zinc-400" : "text-zinc-500")}>
        {t('md.sectionInsert')}
      </div>
      <button
        onClick={onTable}
        className={cn(
          "mx-1 w-[calc(100%-8px)] px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 rounded-lg transition-colors",
          isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
        )}
      >
        <Table size={13} />
        {t('image.menuTable')}
        <span className="ml-auto text-[9px] opacity-50">3×3</span>
      </button>
      <button
        onClick={onImage}
        className={cn(
          "mx-1 w-[calc(100%-8px)] px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 rounded-lg transition-colors",
          isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
        )}
      >
        <ImageIcon size={13} />
        {t('image.menuImage')}
      </button>
      <button
        onClick={onDiagram}
        className={cn(
          "mx-1 w-[calc(100%-8px)] px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 rounded-lg transition-colors",
          isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
        )}
      >
        <Workflow size={13} />
        {t('md.mermaid')}
      </button>
    </div>
  );
});

InsertMenu.displayName = 'InsertMenu';

/* ---- Markdown 预览：GFM + 代码块高亮 + 本地图片 + 表格样式 + 右键格式化 ---- */

interface MarkdownPreviewProps {
  content: string;
  /** 文档标识（标签页 id）：变化表示打开了另一篇文档，预览立即重渲染（跳过防抖） */
  docKey?: string;
  isDarkMode: boolean;
  /** 提供后（非只读标签页）才允许选区右键格式化与插入菜单 */
  onChange?: (next: string) => void;
  /** 撤销/重做控制，透传给右键菜单 */
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** 滚动容器回调（分屏同步滚动用） */
  onScroller?: (el: HTMLDivElement | null) => void;
  /** true 时渲染预览查找浮层（只搜渲染后的文本） */
  findOpen?: boolean;
  onFindClose?: () => void;
  /** 查找浮层弹出定位（打开瞬间的指针位置） */
  getPointer?: () => PointerPos;
}

interface PreviewMenuState extends MenuState {
  blocks: Array<{ start: number; end: number }>;
}

interface TableRange {
  start: number;
  end: number;
}

interface TableAction {
  range: TableRange;
  /** delete：线头处删除整条线（该行/列）；insert：线段中点插入一条垂直于它的线（列/行） */
  button: { kind: 'delete' | 'insert'; target: 'row' | 'col'; index: number };
  /** 按钮锚点（固定在线头 / 线段中点，不随鼠标移动） */
  x: number;
  y: number;
}

interface CellEdit {
  range: TableRange;
  row: number;
  col: number;
  value: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

const BORDER_TOLERANCE = 5;

/** 移动端顶栏触发的插入动作（插入点 = 文末） */
export interface MarkdownPreviewHandle {
  insertTable: () => void;
  openImageModal: () => void;
}

export const MarkdownPreview = React.memo(React.forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(({
  content, docKey, isDarkMode, onChange, canUndo, canRedo, onUndo, onRedo, onScroller,
  findOpen, onFindClose, getPointer,
}, ref) => {
  const t = useT();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<PreviewMenuState | null>(null);
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number; insertAt: number } | null>(null);
  const [imageModal, setImageModal] = useState<SourceSnippet | null>(null);
  const [tableAction, setTableAction] = useState<TableAction | null>(null);
  const [cellEdit, setCellEdit] = useState<CellEdit | null>(null);

  /* 顶栏「插入表格/插入图片」入口（移动端编辑视图下也能插入） */
  React.useImperativeHandle(ref, () => ({
    insertTable: () => { if (onChange) onChange(insertBlockAt(content, content.length, BLANK_TABLE)); },
    openImageModal: () => { setImageModal(buildSourceSnippet(content, content.length)); },
  }), [content, onChange]);

  /* 剥离语法高亮主题的背景色，交给外层容器控制 */
  const cleanTheme = useMemo(() => {
    const base = isDarkMode ? oneDark : ghcolors;
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(base)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const sub: Record<string, any> = {};
        for (const [k, v] of Object.entries(val as Record<string, any>)) {
          if (k === 'backgroundColor' || k === 'background') continue;
          sub[k] = v;
        }
        cleaned[key] = sub;
      } else {
        cleaned[key] = val;
      }
    }
    return cleaned;
  }, [isDarkMode]);

  /* 块级元素统一包一层以携带源码位置 */
  const block = (Tag: string) =>
    function Block({ node, children, ...props }: any) {
      const srcData = useSrcData();
      return <Tag {...props} {...srcData(node)}>{children}</Tag>;
    };

  const codeComponent = useMemo(() => {
    return function CodeBlock({ node, className, children, ...props }: { node?: any; className?: string; children?: React.ReactNode; [key: string]: any }) {
      const srcData = useSrcData();
      const match = /language-(\w+)/.exec(className || '');
      const codeContent = String(children).replace(/\n$/, '');
      const hasNewlines = codeContent.includes('\n');
      const isCodeBlock = hasNewlines && (match || codeContent.trim().length > 0);

      if (isCodeBlock) {
        const lang = match ? match[1] : 'text';
        if (lang === 'mermaid') {
          const sd = srcData(node);
          return (
            <div {...sd}>
              <MermaidRenderer
                code={codeContent}
                isDarkMode={isDarkMode}
                canEdit={!!onChangeRef.current}
                onEdit={(e) => {
                  e.stopPropagation();
                  const start = sd['data-md-start'] ? Number(sd['data-md-start']) : NaN;
                  const end = sd['data-md-end'] ? Number(sd['data-md-end']) : NaN;
                  if (Number.isFinite(start) && Number.isFinite(end)) requestMermaidEditRef.current(codeContent, start, end);
                }}
                onMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const start = sd['data-md-start'] ? Number(sd['data-md-start']) : NaN;
                  const end = sd['data-md-end'] ? Number(sd['data-md-end']) : NaN;
                  if (Number.isFinite(start) && Number.isFinite(end)) requestMermaidMenuRef.current(e, codeContent, start, end);
                }}
              />
            </div>
          );
        }
        return (
          <div
            className="my-4 rounded-lg overflow-hidden"
            {...srcData(node)}
            style={{
              background: isDarkMode ? '#1e1e1e' : '#f3f4f6',
              boxShadow: 'none',
              border: 'none',
              outline: 'none'
            }}
          >
            <style>{`
              .md-code-block span[style*="background"],
              .md-code-block span { background: transparent !important; background-color: transparent !important; }
              .md-code-block code { background: transparent !important; }
              .md-code-block,
              .md-code-block *,
              .md-code-block div,
              .md-code-block pre { border: none !important; outline: none !important; box-shadow: none !important; }
            `}</style>
            <div className="md-code-block">
              <SyntaxHighlighter
                style={cleanTheme}
                language={lang}
                PreTag="div"
                wrapLongLines={true}
                customStyle={{
                  margin: 0,
                  borderRadius: 0,
                  fontSize: '13px',
                  padding: '1.25rem',
                  background: 'transparent',
                  lineHeight: '1.6',
                  border: 'none'
                }}
                codeTagProps={{
                  style: {
                    fontFamily: '"Fira Code", "Cascadia Code", Consolas, Monaco, "Courier New", monospace',
                    fontSize: 'inherit',
                    background: 'transparent'
                  }
                }}
              >
                {codeContent}
              </SyntaxHighlighter>
            </div>
          </div>
        );
      }

      return (
        <code
          className={`${className || ''} ${isDarkMode ? 'bg-zinc-700/50 text-zinc-200' : 'bg-zinc-100 text-zinc-800'} px-1.5 py-0.5 rounded font-mono text-[0.9em]`}
          {...props}
        >
          {children}
        </code>
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDarkMode, cleanTheme]);

  const mdComponents = useMemo(() => ({
    code: codeComponent,
    pre({ children }: { children?: React.ReactNode }) {
      return <>{children}</>;
    },
    img({ src, alt, node, ...props }: any) {
      const srcData = useSrcData();
      const sd = srcData(node);
      return (
        <MarkdownImage
          src={src || ''} alt={alt || ''} isDarkMode={isDarkMode}
          srcStart={sd['data-md-start'] ? Number(sd['data-md-start']) : undefined}
          srcEnd={sd['data-md-end'] ? Number(sd['data-md-end']) : undefined}
          onOpen={(s, a) => setViewer({ src: s, alt: a })}
          onMenu={(e, info) => {
            e.preventDefault();
            setImageMenu({ x: e.clientX, y: e.clientY, ...info, canEdit: !!onChangeRef.current });
          }}
        />
      );
    },
    /* 宽表（材料/倍率表可达十来列）超出容器时横向滚动，而非把标签列挤压成逐字竖排 */
    table({ node, ...props }: any) {
      return <TableBlock node={node} {...props} />;
    },
    p: block('p'),
    h1: block('h1'),
    h2: block('h2'),
    h3: block('h3'),
    h4: block('h4'),
    h5: block('h5'),
    h6: block('h6'),
    li: block('li'),
    blockquote: block('blockquote'),
    ul: block('ul'),
    ol: block('ol'),
    td: block('td'),
    th: block('th'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [isDarkMode, cleanTheme, codeComponent]);

  const proseClassName = useMemo(() => {
    return cn(
      "prose prose-sm max-w-none",
      isDarkMode
        ? "prose-invert prose-headings:text-zinc-100"
        : "prose-headings:text-zinc-900",
      "prose-table:border-collapse"
    );
  }, [isDarkMode]);

  /* ---- 预览解析防抖 ----
     渲染管线只读 renderedContent（滞后镜像）：连续内容变化（打字）停顿 180ms 后才整篇重解析；
     docKey 变化（打开/切换文档）在 render 期立即跟上，不引入切换延迟。
     编辑类操作（表格/图片/插入）仍读写实时 content */
  const [renderedContent, setRenderedContent] = useState(content);
  const docKeyRef = useRef(docKey);
  if (docKeyRef.current !== docKey) {
    docKeyRef.current = docKey;
    setRenderedContent(content);
  }
  useEffect(() => {
    if (content === renderedContent) return;
    const id = setTimeout(() => setRenderedContent(content), 180);
    return () => clearTimeout(id);
  }, [content, renderedContent]);

  /* 页签/多语言块：文档含 `<!-- lang|tab:标签 -->` 标记时解析为块序列，
     每个页签组在文档原位渲染切换标签、独立切换（去 sticky，跟随内容位置） */
  const langBlocks = useMemo(() => parseLangBlocks(renderedContent), [renderedContent]);
  const [tabSelections, setTabSelections] = useState<Record<number, number>>({});
  const selectTab = useCallback((blockIdx: number, sectionIdx: number) => {
    setTabSelections(prev => ({ ...prev, [blockIdx]: sectionIdx }));
  }, []);

  /* ---- 图片查看器 / 图片右键菜单 / 轻提示 ---- */
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);
  const [imageMenu, setImageMenu] = useState<{
    x: number; y: number; resolvedSrc: string; alt: string;
    srcStart?: number; srcEnd?: number; canEdit: boolean;
  } | null>(null);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* 图片删除/剪切需要最新的 content 与 onChange（mdComponents 已 memo 化） */
  const contentStrRef = useRef(content);
  contentStrRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /* ---- Mermaid 图表编辑：打开/保存图表编辑器，把编辑后的源码块回写文档 ---- */
  const [mermaidEdit, setMermaidEdit] = useState<{ code: string; start: number; end: number } | null>(null);
  const mermaidEditRef = useRef(mermaidEdit);
  mermaidEditRef.current = mermaidEdit;
  /* codeComponent 已 memo 化，这里用一个惰性 ref 提供最新回调，避免改动其依赖 */
  const requestMermaidEditRef = useRef<(code: string, start: number, end: number) => void>(() => {});
  requestMermaidEditRef.current = (code, start, end) => {
    if (!onChangeRef.current) return;
    setMermaidEdit({ code, start, end });
  };

  /* ---- 图表右键菜单：编辑 / 删除 ---- */
  const [mermaidMenu, setMermaidMenu] = useState<{
    x: number; y: number; code: string; start: number; end: number;
  } | null>(null);
  const requestMermaidMenuRef = useRef<(e: React.MouseEvent, code: string, start: number, end: number) => void>(() => {});
  requestMermaidMenuRef.current = (e, code, start, end) => {
    if (!onChangeRef.current) return;
    setMermaidMenu({ x: e.clientX, y: e.clientY, code, start, end });
  };
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2200);
  }, []);

  const closeImageMenu = useCallback(() => setImageMenu(null), []);
  /* 内容替换后图片重新挂载、高度塌陷会把滚动条挤回顶部——改前记住位置，渲染后还原 */
  const withScrollRestore = useCallback((mutate: () => void) => {
    const scroller = contentRef.current;
    const top = scroller?.scrollTop ?? 0;
    mutate();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { if (scroller) scroller.scrollTop = top; });
    });
  }, []);
  const handleMermaidSave = useCallback((code: string) => {
    const ed = mermaidEditRef.current;
    if (!ed || !onChangeRef.current) return;
    withScrollRestore(() => {
      const cur = contentStrRef.current;
      const block = '```mermaid\n' + code.replace(/\n+$/, '') + '\n```';
      onChangeRef.current!(cur.slice(0, ed.start) + block + cur.slice(ed.end));
    });
    setMermaidEdit(null);
  }, [withScrollRestore]);
  /* 图表右键「删除」：连同块前后紧邻的换行一起收拢成一个空行，避免留下成片空白 */
  const handleMermaidDelete = useCallback((start: number, end: number) => {
    setMermaidMenu(null);
    if (!onChangeRef.current) return;
    withScrollRestore(() => {
      const cur = contentStrRef.current;
      let s = start;
      let e = end;
      let before = 0;
      while (s - 1 >= 0 && cur[s - 1] === '\n') { s -= 1; before += 1; }
      let after = 0;
      while (e < cur.length && cur[e] === '\n') { e += 1; after += 1; }
      const sep = before > 0 && after > 0 ? '\n\n' : '';
      onChangeRef.current!(cur.slice(0, s) + sep + cur.slice(e));
    });
  }, [withScrollRestore]);
  const handleImageCopy = useCallback(async (src: string) => {
    setImageMenu(null);
    const ok = await copyImageToClipboard(src);
    showToast(ok ? t('image.copied') : t('image.copyFailed'));
  }, [showToast, t]);
  const handleImageDelete = useCallback((srcStart?: number, srcEnd?: number) => {
    setImageMenu(null);
    if (srcStart == null || srcEnd == null || !onChangeRef.current) return;
    withScrollRestore(() => {
      const cur = contentStrRef.current;
      let next = cur.slice(0, srcStart) + cur.slice(srcEnd);
      next = next.replace(/\n{3,}/g, '\n\n');
      onChangeRef.current!(next);
    });
  }, [withScrollRestore]);
  const handleImageCut = useCallback(async (info: { resolvedSrc: string; srcStart?: number; srcEnd?: number }) => {
    const ok = await copyImageToClipboard(info.resolvedSrc);
    if (ok) handleImageDelete(info.srcStart, info.srcEnd);
    else showToast(t('image.copyFailed'));
  }, [handleImageDelete, showToast, t]);
  /* 设为页签：把图片所在行包成页签区块；若紧邻上一个已关闭的页签组，
     则把该组末尾的结束标记挪到本图之后——连续右键多张图即逐张并入同组 */
  const handleImageToTab = useCallback((srcStart?: number, srcEnd?: number) => {
    setImageMenu(null);
    if (srcStart == null || srcEnd == null || !onChangeRef.current) return;
    withScrollRestore(() => {
      onChangeRef.current!(applyImageTab(contentStrRef.current, srcStart, srcEnd));
    });
  }, [withScrollRestore]);

  /* 将本地图片路径改写为可由 MarkdownImage 读取的形式（按块处理） */
  const processedBlocks = useMemo(() => {
    const rewrite = (base: string) =>
      base.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (match, alt, url) => {
          if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
            return match;
          }
          let fixedUrl = url;
          if ((fixedUrl.startsWith('"') && fixedUrl.endsWith('"')) || (fixedUrl.startsWith("'") && fixedUrl.endsWith("'"))) {
            fixedUrl = fixedUrl.slice(1, -1);
          }
          if (fixedUrl.includes('\\')) {
            fixedUrl = fixedUrl.replace(/\\/g, '/');
          }
          if (!fixedUrl.startsWith('file://') && /^[A-Za-z]:/.test(fixedUrl)) {
            fixedUrl = 'file:///' + fixedUrl;
          } else if (!fixedUrl.startsWith('/') && !fixedUrl.startsWith('./') && !fixedUrl.startsWith('file://')) {
            fixedUrl = 'file:///' + fixedUrl;
          }
          const rawPath = fixedUrl.replace(/^file:\/+/, '');
          /* 插入端写入的是百分号编码后的 URL，这里还原为真实路径再交给 fs 读取 */
          let filePath = rawPath;
          try { filePath = decodeURIComponent(rawPath); } catch { /* 含孤立 % 时保留原样 */ }
          const encodedAlt = `${alt}|||LOCAL-FILE:${filePath}`;
          return `![${encodedAlt}](https://local-image.placeholder)`;
        }
      );
    if (!langBlocks) return null;
    return langBlocks.map((b, i) => {
      if (b.type === 'md') return { md: rewrite(b.md), base: b.start };
      const sel = Math.min(tabSelections[i] ?? 0, b.sections.length - 1);
      return { md: rewrite(b.sections[sel].md), base: b.sections[sel].start };
    });
  }, [langBlocks, tabSelections]);

  /* ---- 表格行/列尺寸：只由表格源码内容决定（每次全量重算，不依赖 DOM 上的
     历史内联样式——React 复用表格 DOM 时历史状态会让同源表格渲染不一致）。
     有内容的行列按内容自适应；空行列在表格已有两行/列以上内容时参照相邻
     内容格（网格图类表格的空列保持紧凑），否则用默认尺寸（全新/初填表格
     的空格稳定可点，输入一格不会牵连全表缩放） ---- */
  const BLANK_COL_W = 112;
  const BLANK_ROW_H = 40;
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    root.querySelectorAll('table').forEach(tbl => {
      const trs = Array.from(tbl.querySelectorAll('tr'));
      if (trs.length === 0) return;
      const nCols = trs[0].querySelectorAll('td, th').length;
      if (nCols === 0) return;

      const rowCells = trs.map(tr => Array.from(tr.querySelectorAll('td, th')) as HTMLElement[]);
      const rowAllEmpty = rowCells.map(cs => cs.length > 0 && cs.every(c => !c.textContent?.trim()));
      const colCells: HTMLElement[][] = [];
      const colAllEmpty: boolean[] = [];
      for (let j = 0; j < nCols; j++) {
        const cs = rowCells.map(rc => rc[j]).filter(Boolean) as HTMLElement[];
        colCells.push(cs);
        colAllEmpty.push(cs.length > 0 && cs.every(c => !c.textContent?.trim()));
      }
      const nonEmptyRows = rowAllEmpty.filter(e => !e).length;
      const nonEmptyCols = colAllEmpty.filter(e => !e).length;

      /* 先清非空行列的内联尺寸（保证后续测量到自然宽高），再统一为空行列定尺寸 */
      rowCells.forEach((cs, i) => {
        if (!rowAllEmpty[i]) cs.forEach(c => { c.style.height = ''; });
      });
      colCells.forEach((cs, j) => {
        if (!colAllEmpty[j]) cs.forEach(c => { c.style.minWidth = ''; });
      });

      rowCells.forEach((cs, i) => {
        if (!rowAllEmpty[i]) return;
        let h = BLANK_ROW_H;
        if (nonEmptyRows >= 2) {
          let ni = i - 1;
          while (ni >= 0 && rowAllEmpty[ni]) ni--;
          if (ni < 0) { ni = i + 1; while (ni < trs.length && rowAllEmpty[ni]) ni++; }
          const nh = ni >= 0 && ni < trs.length ? trs[ni].getBoundingClientRect().height : 0;
          if (nh > 0) h = nh;
        }
        cs.forEach(c => { c.style.height = `${h}px`; });
      });

      const colWidths = colCells.map(cs =>
        cs.length ? Math.max(...cs.map(c => c.getBoundingClientRect().width)) : 0);
      colCells.forEach((cs, j) => {
        if (!colAllEmpty[j]) return;
        let w = BLANK_COL_W;
        if (nonEmptyCols >= 2) {
          let nj = j - 1;
          while (nj >= 0 && colAllEmpty[nj]) nj--;
          if (nj < 0) { nj = j + 1; while (nj < nCols && colAllEmpty[nj]) nj++; }
          const nw = nj >= 0 && nj < nCols ? colWidths[nj] : 0;
          if (nw > 0) w = nw;
        }
        cs.forEach(c => { c.style.minWidth = `${w}px`; });
      });
    });
    /* content 必须入依赖：普通文档（无页签标记）下 processedBlocks/langBlocks
       恒为 null，仅靠它们内容变化后不会重新测量（加行/列、输入后尺寸不更新） */
  }, [content, processedBlocks, langBlocks, tabSelections, isDarkMode]);

  /* ---- 右键：有选区弹格式菜单；无选区弹插入菜单（表格/图片） ---- */

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onChange) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';

    if (sel && !sel.isCollapsed && text) {
      const range = sel.getRangeAt(0);
      const root = contentRef.current;
      if (root) {
        /* 收集与选区相交、且带源码位置的最内层块 */
        const tagged = Array.from(root.querySelectorAll<HTMLElement>('[data-md-start]'));
        const hits = tagged.filter(el => range.intersectsNode(el));
        const innermost = hits.filter(el => !hits.some(o => o !== el && el.contains(o)));
        const blocks = innermost
          .map(el => ({ start: Number(el.dataset.mdStart), end: Number(el.dataset.mdEnd) }))
          .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
          .sort((a, b) => a.start - b.start);
        if (blocks.length > 0) {
          e.preventDefault();
          setTableAction(null);
          setMenu({ x: e.clientX, y: e.clientY, text, blocks });
          return;
        }
      }
    }

    /* 空白处（无选区）：插入锚点 = 点中块的最外层末尾；未点中块（空隙/空白）→ 按鼠标 Y 就近取块边界 */
    e.preventDefault();
    setMenu(null);
    setTableAction(null);
    let el: HTMLElement | null = e.target as HTMLElement;
    let mdEnd: number | null = null;
    while (el) {
      const cand = el.closest?.('[data-md-end]') as HTMLElement | null;
      if (cand && cand.dataset.mdEnd) mdEnd = Number(cand.dataset.mdEnd);
      el = el.parentElement;
    }
    let insertAt = mdEnd;
    if (insertAt == null) {
      const root = contentRef.current;
      const near = root ? findNearestBlockBoundary(root, e.clientY) : null;
      insertAt = near ?? content.length;
    }
    setBlankMenu({ x: e.clientX, y: e.clientY, insertAt });
  }, [onChange, content.length]);

  /* 选区格式化：从后往前替换，保证偏移量不失效 */
  const handleApply = useCallback((op: MdOp) => {
    if (!menu || !onChange) return;
    withScrollRestore(() => {
      let next = content;
      if (op.kind === 'tabGroup') {
        /* 整个选区（首块到末块）包成一个页签；紧邻上一个已关闭的组时并排追加为新区块 */
        const first = menu.blocks[0];
        const last = menu.blocks[menu.blocks.length - 1];
        next = applySelectionTab(content, first.start, last.end);
      } else if (op.kind === 'footnote') {
        /* 选中文本后插 [^n] 标记，文末生成定义行 */
        const fe = footnoteEdit(content, menu.blocks[0], menu.text);
        next = content.slice(0, fe.markerAt) + fe.marker
          + content.slice(fe.markerAt, fe.defAt) + fe.def + content.slice(fe.defAt);
      } else {
        const targets = (op.kind === 'link' || op.kind === 'image' || op.kind === 'mermaid' || !!INLINE_WRAPS[op.kind])
          ? menu.blocks.slice(0, 1)
          : menu.blocks;
        const sorted = [...targets].sort((x, y) => y.start - x.start);
        for (let d = 0; d < sorted.length; d++) {
          const b = sorted[d];
          const slice = content.slice(b.start, b.end);
          next = next.slice(0, b.start)
            + transformSlice(op, slice, menu.text, t('md.tableTemplate'), t('md.mermaidTemplate'))
            + next.slice(b.end);
        }
      }
      onChangeRef.current!(next);
    });
    setMenu(null);
  }, [menu, content, onChange, withScrollRestore, t]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeBlankMenu = useCallback(() => setBlankMenu(null), []);

  /* ---- 插入：空白 3×3 表格 / 图片 ---- */

  const handleInsertTable = useCallback(() => {
    if (!blankMenu || !onChange) return;
    onChange(insertBlockAt(content, blankMenu.insertAt, BLANK_TABLE));
    setBlankMenu(null);
  }, [blankMenu, content, onChange]);

  const handleInsertDiagram = useCallback(() => {
    if (!blankMenu || !onChange) return;
    onChange(insertBlockAt(content, blankMenu.insertAt, t('md.mermaidTemplate')));
    setBlankMenu(null);
  }, [blankMenu, content, onChange, t]);

  const handleInsertImages = useCallback((images: InsertImage[], caretAbs: number) => {
    if (!onChange || images.length === 0) return;
    const at = Math.min(Math.max(0, caretAbs), content.length);
    const before = content.slice(0, at);
    const after = content.slice(at);
    /* 图片独立成段：光标在行中时自动补前后空行 */
    const head = before.length === 0 ? '' : (before.endsWith('\n\n') ? before : before.replace(/\n+$/, '') + '\n\n');
    const tail = after.length === 0 ? '' : (after.startsWith('\n\n') ? after : (after.startsWith('\n') ? '\n' + after : '\n\n' + after));
    const block = images.map(img => {
      const isLocal = !/^(https?:|data:)/.test(img.src);
      const url = isLocal ? encodeLocalImageUrl(img.src) : img.src;
      return `![${img.name}](${url})`;
    }).join('\n');
    onChange(head + block + tail);
    setImageModal(null);
  }, [content, onChange]);

  /* ---- 渲染表格的可视化编辑：悬停边线出单个圆形按钮 ----
     线头（两端）= 「−」删除整条线；线段中点 = 「+」插入一条垂直于它的线。
     所有候选锚点中取距鼠标最近者，一次只显示一个。 */

  const mutateTable = useCallback((range: TableRange, mutate: (t: ParsedTable) => void) => {
    if (!onChange) return;
    const parsed = parseTableSrc(content.slice(range.start, range.end));
    if (!parsed) return;
    mutate(parsed);
    setTableAction(null);
    onChange(content.slice(0, range.start) + serializeTableSrc(parsed) + content.slice(range.end));
  }, [content, onChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!onChange) return;
    const target = e.target as HTMLElement;
    /* 悬停在工具按钮上时保持现状，避免按钮消失 */
    if (target.closest?.('[data-md-table-tools]')) return;
    const table = target.closest?.('table') as HTMLElement | null;
    if (!table || !table.dataset.mdStart || !table.dataset.mdEnd) {
      setTableAction(null);
      return;
    }
    const range: TableRange = { start: Number(table.dataset.mdStart), end: Number(table.dataset.mdEnd) };
    const trs = Array.from(table.querySelectorAll('tr'));
    if (trs.length === 0) { setTableAction(null); return; }
    const tableRect = table.getBoundingClientRect();
    const mx = e.clientX;
    const my = e.clientY;

    /* 列边界（含右边缘）与行边界（含下边缘） */
    const colEdges: number[] = [];
    table.querySelectorAll('td, th').forEach(c => {
      const left = c.getBoundingClientRect().left;
      if (!colEdges.some(v => Math.abs(v - left) < 3)) colEdges.push(left);
    });
    colEdges.sort((a, b) => a - b);
    colEdges.push(tableRect.right);
    const rowEdges: number[] = trs.map(tr => tr.getBoundingClientRect().top);
    rowEdges.push(tableRect.bottom);

    const dist2 = (x: number, y: number) => (mx - x) * (mx - x) + (my - y) * (my - y);
    const candidates: TableAction[] = [];

    /* 横线（每行上边缘 + 表格下边缘）上的锚点 */
    for (let i = 0; i < rowEdges.length; i++) {
      const y = rowEdges[i];
      if (Math.abs(my - y) > BORDER_TOLERANCE) continue;
      if (mx < tableRect.left - BORDER_TOLERANCE || mx > tableRect.right + BORDER_TOLERANCE) continue;
      const delIdx = Math.min(i, trs.length - 1);
      /* 线头（左、右两端）：删除该横线（行） */
      candidates.push({ range, button: { kind: 'delete', target: 'row', index: delIdx }, x: tableRect.left, y });
      candidates.push({ range, button: { kind: 'delete', target: 'row', index: delIdx }, x: tableRect.right, y });
      /* 线段中点：插入一条竖线（列），加在该段所在列之后 */
      for (let j = 0; j < colEdges.length - 1; j++) {
        if (mx >= colEdges[j] && mx <= colEdges[j + 1]) {
          candidates.push({
            range,
            button: { kind: 'insert', target: 'col', index: j },
            x: (colEdges[j] + colEdges[j + 1]) / 2,
            y,
          });
        }
      }
    }

    /* 竖线（每列左边缘 + 表格右边缘）上的锚点 */
    for (let j = 0; j < colEdges.length; j++) {
      const x = colEdges[j];
      if (Math.abs(mx - x) > BORDER_TOLERANCE) continue;
      if (my < tableRect.top - BORDER_TOLERANCE || my > tableRect.bottom + BORDER_TOLERANCE) continue;
      const delIdx = Math.min(j, colEdges.length - 2);
      /* 线头（上、下两端）：删除该竖线（列） */
      candidates.push({ range, button: { kind: 'delete', target: 'col', index: delIdx }, x, y: tableRect.top });
      candidates.push({ range, button: { kind: 'delete', target: 'col', index: delIdx }, x, y: tableRect.bottom });
      /* 线段中点：插入一条横线（行），加在该段所在行之后 */
      for (let r = 0; r < rowEdges.length - 1; r++) {
        if (my >= rowEdges[r] && my <= rowEdges[r + 1]) {
          candidates.push({
            range,
            button: { kind: 'insert', target: 'row', index: r },
            x,
            y: (rowEdges[r] + rowEdges[r + 1]) / 2,
          });
        }
      }
    }

    if (candidates.length === 0) { setTableAction(null); return; }
    let best = candidates[0];
    let bestDist = dist2(best.x, best.y);
    for (let i = 1; i < candidates.length; i++) {
      const d = dist2(candidates[i].x, candidates[i].y);
      if (d < bestDist) { bestDist = d; best = candidates[i]; }
    }
    setTableAction(best);
  }, [onChange]);

  const handleTableTool = useCallback(() => {
    if (!tableAction) return;
    const { button, range } = tableAction;
    mutateTable(range, t => {
      const cols = t.rows[0]?.length ?? 0;
      if (button.kind === 'delete') {
        if (button.target === 'row') {
          if (t.rows.length > 1) t.rows.splice(button.index, 1);
        } else if (cols > 1) {
          t.rows.forEach(r => r.splice(button.index, 1));
          t.aligns.splice(button.index, 1);
        }
      } else {
        const at = Math.min(button.index + 1, button.target === 'col' ? cols : t.rows.length);
        if (button.target === 'col') {
          t.rows.forEach(r => r.splice(at, 0, ''));
          t.aligns.splice(at, 0, '---');
        } else {
          t.rows.splice(at, 0, Array.from({ length: cols }, () => ''));
        }
      }
    });
  }, [tableAction, mutateTable]);

  /* 点击单元格 → 覆盖输入框编辑，回写源码对应单元格 */
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (!onChange) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-md-table-tools]')) return;
    if (target.closest('a')) return;
    const cell = target.closest('td, th') as HTMLElement | null;
    if (!cell) { setCellEdit(null); return; }
    if (!window.getSelection()?.isCollapsed) return;
    const table = cell.closest('table') as HTMLElement | null;
    const tr = cell.closest('tr');
    if (!table?.dataset.mdStart || !table.dataset.mdEnd || !tr) return;
    const rowIdx = Array.from(table.querySelectorAll('tr')).indexOf(tr);
    const colIdx = Array.from(tr.querySelectorAll('td, th')).indexOf(cell);
    if (rowIdx < 0 || colIdx < 0) return;
    const parsed = parseTableSrc(content.slice(Number(table.dataset.mdStart), Number(table.dataset.mdEnd)));
    if (!parsed || !parsed.rows[rowIdx]) return;
    const rect = cell.getBoundingClientRect();
    /* 记录为滚动容器内容系坐标（而非视口坐标）：编辑框 absolute 定位在容器内，
       滚动页面时跟随单元格移动，而不是钉在屏幕上 */
    const scroller = contentRef.current;
    const sRect = scroller?.getBoundingClientRect();
    setTableAction(null);
    setCellEdit({
      range: { start: Number(table.dataset.mdStart), end: Number(table.dataset.mdEnd) },
      row: rowIdx,
      col: colIdx,
      value: parsed.rows[rowIdx][colIdx] ?? '',
      left: rect.left - (sRect?.left ?? 0) + (scroller?.scrollLeft ?? 0),
      top: rect.top - (sRect?.top ?? 0) + (scroller?.scrollTop ?? 0),
      width: rect.width,
      height: rect.height,
    });
  }, [content, onChange]);

  const commitCellEdit = useCallback(() => {
    setCellEdit(prev => {
      if (!prev) return null;
      const parsed = parseTableSrc(content.slice(prev.range.start, prev.range.end));
      if (parsed && parsed.rows[prev.row]) {
        parsed.rows[prev.row][prev.col] = prev.value;
        onChange?.(content.slice(0, prev.range.start) + serializeTableSrc(parsed) + content.slice(prev.range.end));
      }
      return null;
    });
  }, [content, onChange]);

  /* 触屏表格工具条：先提交未保存的单元格值，再做结构变更（同一片段整体替换，偏移不失效） */
  const handleTableBarAction = useCallback((kind: 'addRow' | 'delRow' | 'addCol' | 'delCol') => {
    if (!cellEdit || !onChange) return;
    const { start, end } = cellEdit.range;
    const { row, col } = cellEdit;
    let seg = content.slice(start, end);
    const committed = parseTableSrc(seg);
    if (committed && committed.rows[row]) {
      committed.rows[row][col] = cellEdit.value;
      seg = serializeTableSrc(committed);
    }
    const parsed = parseTableSrc(seg);
    if (parsed) {
      const cols = parsed.rows[0]?.length ?? 0;
      if (kind === 'addRow') parsed.rows.splice(row + 1, 0, Array.from({ length: cols }, () => ''));
      if (kind === 'delRow' && parsed.rows.length > 1) parsed.rows.splice(row, 1);
      if (kind === 'addCol') {
        parsed.rows.forEach(r => r.splice(col + 1, 0, ''));
        parsed.aligns.splice(col + 1, 0, '---');
      }
      if (kind === 'delCol' && cols > 1) {
        parsed.rows.forEach(r => r.splice(col, 1));
        parsed.aligns.splice(col, 1);
      }
      seg = serializeTableSrc(parsed);
    }
    setCellEdit(null);
    setTableAction(null);
    onChange(content.slice(0, start) + seg + content.slice(end));
  }, [cellEdit, content, onChange]);

  return (
    <div
      ref={(el) => {
        contentRef.current = el;
        onScroller?.(el);
      }}
      className="relative h-full overflow-auto heid-scroll"
      onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove}
      onClick={handleContainerClick}
    >
      <div className="mx-auto p-6 text-left max-w-[900px]">
        <div className={proseClassName}>
          <MarkdownStyles isDarkMode={isDarkMode} />
          {processedBlocks && langBlocks ? (
            processedBlocks.map((processed, i) => {
              const block = langBlocks[i];
              const content = (
                <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents as any}>
                  {processed.md}
                </ReactMarkdown>
              );
              if (block.type !== 'tabs') {
                return (
                  <BlockBaseContext.Provider key={i} value={processed.base}>
                    {content}
                  </BlockBaseContext.Provider>
                );
              }
              const selIdx = Math.min(tabSelections[i] ?? 0, block.sections.length - 1);
              return (
                <div key={i}>
                  <div className="flex flex-wrap items-center gap-1 mb-4 -mx-1 px-1">
                    {block.sections.map((s, j) => (
                      <button
                        key={s.label + j}
                        onClick={(e) => { e.stopPropagation(); selectTab(i, j); }}
                        className={cn(
                          'px-2.5 py-1 rounded-full text-xs font-medium transition-colors border',
                          j === selIdx
                            ? 'border-transparent bg-[#96A5EB] text-white'
                            : isDarkMode
                              ? 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                              : 'border-zinc-300 text-zinc-500 hover:bg-zinc-100',
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <BlockBaseContext.Provider value={processed.base}>
                    {content}
                  </BlockBaseContext.Provider>
                </div>
              );
            })
          ) : (
            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents as any}>
              {renderedContent}
            </ReactMarkdown>
          )}
        </div>
      </div>

      {/* 表格边线工具：单个圆形按钮，锚定在线头（−）/ 线段中点（+） */}
      {tableAction && onChange && (() => {
        const isInsert = tableAction.button.kind === 'insert';
        const title = tableAction.button.kind === 'delete'
          ? (tableAction.button.target === 'row' ? t('md.delRowTitle') : t('md.delColTitle'))
          : (tableAction.button.target === 'row' ? t('md.insertRowHere') : t('md.insertColHere'));
        const left = Math.max(4, Math.min(tableAction.x - 11, window.innerWidth - 26));
        const top = Math.max(4, Math.min(tableAction.y - 11, window.innerHeight - 26));
        return (
          <button
            data-md-table-tools
            onClick={(e) => { e.stopPropagation(); handleTableTool(); }}
            title={title}
            className={cn(
              "fixed z-[95] w-[22px] h-[22px] rounded-full text-white flex items-center justify-center shadow-md transition-colors",
              isInsert ? "bg-indigo-500 hover:bg-indigo-400" : "bg-zinc-500 hover:bg-red-500"
            )}
            style={{ left, top }}
          >
            {isInsert ? <Plus size={13} /> : <Minus size={13} />}
          </button>
        );
      })()}

      {/* 触屏表格结构工具条：点选单元格时浮出（取代悬停边线的 +/− 按钮） */}
      {cellEdit && onChange && IS_ANDROID_APP && (() => {
        const actions = [
          { label: t('md.rowAdd'), kind: 'addRow' }, { label: t('md.rowDel'), kind: 'delRow' },
          { label: t('md.colAdd'), kind: 'addCol' }, { label: t('md.colDel'), kind: 'delCol' },
        ] as const;
        return (
          <div
            data-md-table-tools
            onPointerDown={(e) => e.preventDefault()}
            className={cn(
              'absolute z-[96] flex items-center rounded-lg border shadow-lg overflow-hidden',
              isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
            )}
            style={{ left: Math.max(0, cellEdit.left), top: Math.max(0, cellEdit.top - 38) }}
          >
            {actions.map(({ label, kind }) => (
              <button
                key={kind}
                onClick={() => handleTableBarAction(kind)}
                className={cn(
                  'px-2.5 h-8 text-[11px] font-medium transition-colors',
                  isDarkMode ? 'text-zinc-300 active:bg-zinc-700' : 'text-zinc-600 active:bg-zinc-100'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        );
      })()}

      {/* 单元格编辑输入框 */}
      {cellEdit && onChange && (
        <input
          data-md-table-tools
          autoFocus
          value={cellEdit.value}
          onChange={(e) => setCellEdit(prev => prev ? { ...prev, value: e.target.value } : prev)}
          onBlur={commitCellEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCellEdit();
            if (e.key === 'Escape') setCellEdit(null);
          }}
          className={cn(
            "absolute z-[95] box-border px-2 text-sm outline-none border-2 rounded-sm",
            isDarkMode ? "bg-zinc-800 border-indigo-400 text-zinc-100" : "bg-white border-indigo-400 text-zinc-800"
          )}
          style={{ left: cellEdit.left, top: cellEdit.top, width: cellEdit.width, height: cellEdit.height }}
        />
      )}

      {/* 选区格式化菜单 */}
      {menu && (
        <FormatMenu
          menu={menu}
          isDarkMode={isDarkMode}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo ? () => { setMenu(null); onUndo(); } : undefined}
          onRedo={onRedo ? () => { setMenu(null); onRedo(); } : undefined}
          onApply={handleApply}
          onClose={closeMenu}
        />
      )}

      {/* 空白处插入菜单 */}
      {blankMenu && onChange && (
        <InsertMenu
          x={blankMenu.x}
          y={blankMenu.y}
          isDarkMode={isDarkMode}
          onTable={handleInsertTable}
          onImage={() => { setImageModal(buildSourceSnippet(content, blankMenu.insertAt)); setBlankMenu(null); }}
          onDiagram={handleInsertDiagram}
          onClose={closeBlankMenu}
        />
      )}

      {/* 预览查找浮层：只搜索渲染后的文本（portal 渲染到 body，弹出在指针位置） */}
      {findOpen && (
        <PreviewFindBar
          getContainer={() => contentRef.current}
          content={content}
          isDarkMode={isDarkMode}
          getPointer={getPointer}
          onClose={() => onFindClose?.()}
        />
      )}

      {/* 图片插入弹窗 */}
      {imageModal && onChange && (
        <ImageInsertModal
          isDarkMode={isDarkMode}
          snippet={imageModal}
          onConfirm={handleInsertImages}
          onClose={() => setImageModal(null)}
        />
      )}

      {/* 图片右键菜单：复制 / 剪切 / 删除 / 设为页签 */}
      {imageMenu && (
        <ImageContextMenu
          x={imageMenu.x}
          y={imageMenu.y}
          canEdit={imageMenu.canEdit}
          isDarkMode={isDarkMode}
          onClose={closeImageMenu}
          onCopy={() => handleImageCopy(imageMenu.resolvedSrc)}
          onCut={() => handleImageCut(imageMenu)}
          onDelete={() => handleImageDelete(imageMenu.srcStart, imageMenu.srcEnd)}
          onTab={() => handleImageToTab(imageMenu.srcStart, imageMenu.srcEnd)}
        />
      )}

      {/* 图表右键菜单：编辑 / 删除 */}
      {mermaidMenu && (
        <MermaidContextMenu
          x={mermaidMenu.x}
          y={mermaidMenu.y}
          isDarkMode={isDarkMode}
          onClose={() => setMermaidMenu(null)}
          onEdit={() => {
            setMermaidEdit({ code: mermaidMenu.code, start: mermaidMenu.start, end: mermaidMenu.end });
            setMermaidMenu(null);
          }}
          onDelete={() => handleMermaidDelete(mermaidMenu.start, mermaidMenu.end)}
        />
      )}

      {/* 图片查看器：点击图片进入，滚轮缩放，双击/按钮切 1:1 原始尺寸 */}
      {viewer && (
        <ImageViewer
          src={viewer.src}
          alt={viewer.alt}
          isDarkMode={isDarkMode}
          onClose={() => setViewer(null)}
        />
      )}

      {/* 图表编辑器：悬停图表点「编辑」打开，保存后回写源码块 */}
      {mermaidEdit && (
        <MermaidEditModal
          initialCode={mermaidEdit.code}
          isDarkMode={isDarkMode}
          onClose={() => setMermaidEdit(null)}
          onSave={handleMermaidSave}
        />
      )}

      {/* 轻提示（复制成功/失败等） */}
      {toastMsg && (
        <div
          className={cn(
            'fixed bottom-6 left-1/2 -translate-x-1/2 z-[210] rounded-lg px-3 py-1.5 text-xs shadow-lg',
            isDarkMode ? 'bg-zinc-800/95 text-zinc-200 border border-zinc-700' : 'bg-white/95 text-zinc-700 border border-zinc-200',
          )}
        >
          {toastMsg}
        </div>
      )}
    </div>
  );
}));

MarkdownPreview.displayName = 'MarkdownPreview';

/* prose 默认样式不覆盖的部分（表格 / 行内代码 / 图片）在这里补齐 */
const MarkdownStyles = React.memo<{ isDarkMode: boolean }>(({ isDarkMode }) => {
  return (
    <style>{`
      .prose { --tw-prose-body: ${isDarkMode ? '#d4d4d8' : '#374151'}; }
      .prose table { border-collapse: collapse; margin: 1rem 0; display: table; width: fit-content; }
      .prose table th, .prose table td { border: 1px solid ${isDarkMode ? '#3f3f46' : '#d4d4d8'}; padding: 0.5rem 0.75rem; text-align: left; }
      .prose th { background-color: ${isDarkMode ? '#27272a' : '#f4f4f5'}; font-weight: 600; }
      .prose tr:nth-child(even) { background-color: ${isDarkMode ? 'rgba(39, 39, 42, 0.3)' : 'rgba(244, 244, 245, 0.5)'}; }
      .prose pre { background-color: transparent !important; padding: 0 !important; margin: 0 !important; border: none !important; box-shadow: none !important; }
      /* 引用块：灰底圆角衬块，文字比正文降一档（导入文档的标题/来源注释走这里） */
      .prose blockquote {
        background-color: ${isDarkMode ? 'rgba(39, 39, 42, 0.5)' : 'rgba(244, 244, 245, 0.8)'};
        color: ${isDarkMode ? '#a1a1aa' : '#71717a'};
        border-radius: 0.5rem;
        padding: 0.5rem 1rem;
        font-weight: normal;
      }
      .prose blockquote strong { color: ${isDarkMode ? '#a1a1aa' : '#71717a'}; }
      .prose img {
        display: block !important;
        margin-left: auto !important;
        margin-right: auto !important;
        max-width: 100% !important;
        height: auto;
        /* 圆角矩形灰底衬框（无描边），透明立绘也可辨 */
        background-color: ${isDarkMode ? '#27272a' : '#f4f4f5'};
        padding: 0.5rem;
        border-radius: 0.75rem;
      }
      .prose :not(pre) > code {
        background-color: ${isDarkMode ? 'rgba(63, 63, 70, 0.5)' : 'rgba(244, 244, 245, 1)'};
        padding: 0.2em 0.4em;
        border-radius: 0.25rem;
        font-weight: normal;
      }
      /* 扩展语法：==高亮== 与块级公式（KaTeX 输出沿用文字色，超宽横向滚动） */
      .prose mark {
        background-color: ${isDarkMode ? 'rgba(250, 204, 21, 0.30)' : '#fef08a'};
        color: inherit;
        padding: 0 0.15em;
        border-radius: 0.25rem;
      }
      .prose mark.md-mark-red { background-color: ${isDarkMode ? 'rgba(248, 113, 113, 0.32)' : '#fecaca'}; }
      .prose mark.md-mark-orange { background-color: ${isDarkMode ? 'rgba(251, 146, 60, 0.32)' : '#ffedd5'}; }
      .prose mark.md-mark-green { background-color: ${isDarkMode ? 'rgba(74, 222, 128, 0.30)' : '#bbf7d0'}; }
      .prose mark.md-mark-blue { background-color: ${isDarkMode ? 'rgba(96, 165, 250, 0.32)' : '#bfdbfe'}; }
      .prose mark.md-mark-purple { background-color: ${isDarkMode ? 'rgba(192, 132, 252, 0.32)' : '#e9d5ff'}; }
      .prose .katex-display { overflow-x: auto; overflow-y: hidden; padding: 0.25rem 0; }
    `}</style>
  );
});

MarkdownStyles.displayName = 'MarkdownStyles';
