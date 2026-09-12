import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, ghcolors } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Table, Image as ImageIcon, Plus, Minus } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP } from '../lib/platform';
import { FormatMenu, transformSlice, type MdOp, type MenuState } from './MarkdownTools';
import { ImageInsertModal, type InsertImage } from './ImageInsertModal';
import { PreviewFindBar } from './PreviewFindBar';
import type { PointerPos } from '../hooks/useLastPointer';
import { useT } from '../lib/i18nContext';

/* ---- 本地图片：相对/绝对路径通过 Tauri fs 读取为 blob URL，带缓存 ---- */

const imageCache = new Map<string, string>();

const MarkdownImage = React.memo<{
  src: string;
  alt: string;
  isDarkMode: boolean;
}>(({ src, alt, isDarkMode }) => {
  const t = useT();
  const [imgSrc, setImgSrc] = useState<string>('');
  const [loadError, setLoadError] = useState<string>('');

  useEffect(() => {
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

    if (filePath) {
      const cached = imageCache.get(filePath);
      if (cached) { setImgSrc(cached); return; }
      (async () => {
        try {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          const data = await readFile(filePath);
          const ext = filePath.split('.').pop()?.toLowerCase() || 'png';
          const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
            bmp: 'image/bmp', ico: 'image/x-icon'
          };
          const mimeType = mimeMap[ext] || 'image/png';
          const blob = new Blob([new Uint8Array(data)], { type: mimeType });
          const url = URL.createObjectURL(blob);
          imageCache.set(filePath, url);
          setImgSrc(url);
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          if (errMsg.includes('forbidden')) { setLoadError(t('image.errForbidden')); return; }
          try {
            const { convertFileSrc } = await import('@tauri-apps/api/core');
            let p = /^[A-Za-z]:/.test(filePath) ? '/' + filePath.replace(/\\/g, '/') : filePath;
            const result = convertFileSrc(p);
            if (result && result.length > 0) { setImgSrc(result); }
            else { setLoadError(t('image.errLoad')); }
          } catch { setLoadError(t('image.errLoad')); }
        }
      })();
    } else if (src && !src.startsWith('https://local-image.placeholder')) {
      setImgSrc(src);
    }
  }, [src, alt]);

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

  return (
    <img
      src={imgSrc} alt={(alt || '').split('|||LOCAL-FILE:')[0] || ''}
      loading="lazy"
      onError={() => setLoadError(t('image.errLoad'))}
      style={{ maxWidth: '100%', height: 'auto', borderRadius: '0.5rem', display: 'block', marginLeft: 'auto', marginRight: 'auto', margin: '1.5rem 0' }}
    />
  );
});

MarkdownImage.displayName = 'MarkdownImage';

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
  onClose: () => void;
}>(({ x, y, isDarkMode, onTable, onImage, onClose }) => {
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
  const top = Math.max(4, Math.min(y, window.innerHeight - 100));

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
      <div className={cn("text-[9px] font-semibold tracking-wider px-2 pt-1 pb-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
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
    </div>
  );
});

InsertMenu.displayName = 'InsertMenu';

/* ---- Markdown 预览：GFM + 代码块高亮 + 本地图片 + 表格样式 + 右键格式化 ---- */

interface MarkdownPreviewProps {
  content: string;
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
  content, isDarkMode, onChange, canUndo, canRedo, onUndo, onRedo, onScroller,
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

  /* 把源码偏移量写到 DOM 上，供右键时把选区映射回源码 */
  const srcData = (node: any) => {
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return {};
    return { 'data-md-start': String(start), 'data-md-end': String(end) };
  };

  /* 块级元素统一包一层以携带源码位置 */
  const block = (Tag: string) =>
    function Block({ node, children, ...props }: any) {
      return <Tag {...props} {...srcData(node)}>{children}</Tag>;
    };

  const codeComponent = useMemo(() => {
    return function CodeBlock({ node, className, children, ...props }: { node?: any; className?: string; children?: React.ReactNode; [key: string]: any }) {
      const match = /language-(\w+)/.exec(className || '');
      const codeContent = String(children).replace(/\n$/, '');
      const hasNewlines = codeContent.includes('\n');
      const isCodeBlock = hasNewlines && (match || codeContent.trim().length > 0);

      if (isCodeBlock) {
        const lang = match ? match[1] : 'text';
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
    img({ src, alt, ...props }: { src?: string; alt?: string; [key: string]: any }) {
      return <MarkdownImage src={src || ''} alt={alt || ''} isDarkMode={isDarkMode} />;
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
    table: block('table'),
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

  /* 将本地图片路径改写为可由 MarkdownImage 读取的形式 */
  const processedContent = useMemo(() => {
    return content.replace(
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
  }, [content]);

  /* ---- 空行/空列沿用相邻行/列的尺寸，输入内容后恢复按内容自适应 ---- */
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    /* 先清除上一轮的临时尺寸，让浏览器按内容重新布局 */
    root.querySelectorAll<HTMLElement>('td, th').forEach(c => {
      c.style.minWidth = '';
      c.style.height = '';
    });

    root.querySelectorAll('table').forEach(tbl => {
      const trs = Array.from(tbl.querySelectorAll('tr'));
      if (trs.length === 0) return;
      const nCols = trs[0].querySelectorAll('td, th').length;
      if (nCols === 0) return;

      const rowAllEmpty = trs.map(tr => {
        const cs = Array.from(tr.querySelectorAll('td, th'));
        return cs.length > 0 && cs.every(c => !c.textContent?.trim());
      });
      const colAllEmpty: boolean[] = [];
      const colWidths: number[] = [];
      for (let j = 0; j < nCols; j++) {
        const cs = trs.map(tr => tr.querySelectorAll('td, th')[j]).filter(Boolean) as HTMLElement[];
        colAllEmpty.push(cs.length > 0 && cs.every(c => !c.textContent?.trim()));
        colWidths.push(cs.length ? Math.max(...cs.map(c => c.getBoundingClientRect().width)) : 0);
      }

      /* 整行为空：行高取最近的非空行 */
      trs.forEach((tr, i) => {
        if (!rowAllEmpty[i]) return;
        let ni = i - 1;
        while (ni >= 0 && rowAllEmpty[ni]) ni--;
        if (ni < 0) { ni = i + 1; while (ni < trs.length && rowAllEmpty[ni]) ni++; }
        if (ni < 0 || ni >= trs.length) return;
        const h = trs[ni].getBoundingClientRect().height;
        if (h <= 0) return;
        tr.querySelectorAll('td, th').forEach(c => { (c as HTMLElement).style.height = `${h}px`; });
      });

      /* 整列为空：列宽取最近的非空列 */
      for (let j = 0; j < nCols; j++) {
        if (!colAllEmpty[j]) continue;
        let nj = j - 1;
        while (nj >= 0 && colAllEmpty[nj]) nj--;
        if (nj < 0) { nj = j + 1; while (nj < nCols && colAllEmpty[nj]) nj++; }
        if (nj < 0 || nj >= nCols || colWidths[nj] <= 0) continue;
        trs.forEach(tr => {
          const c = tr.querySelectorAll('td, th')[j] as HTMLElement | undefined;
          if (c) c.style.minWidth = `${colWidths[nj]}px`;
        });
      }
    });
  }, [processedContent, isDarkMode]);

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
    const inlineKinds: Array<MdOp['kind']> = ['link', 'image', 'bold', 'italic', 'strike', 'inlineCode'];
    const targets = inlineKinds.includes(op.kind) ? menu.blocks.slice(0, 1) : menu.blocks;
    let next = content;
    for (const b of [...targets].sort((x, y) => y.start - x.start)) {
      const slice = content.slice(b.start, b.end);
      next = next.slice(0, b.start) + transformSlice(op, slice, menu.text, t('md.tableTemplate')) + next.slice(b.end);
    }
    setMenu(null);
    onChange(next);
  }, [menu, content, onChange]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeBlankMenu = useCallback(() => setBlankMenu(null), []);

  /* ---- 插入：空白 3×3 表格 / 图片 ---- */

  const handleInsertTable = useCallback(() => {
    if (!blankMenu || !onChange) return;
    onChange(insertBlockAt(content, blankMenu.insertAt, BLANK_TABLE));
    setBlankMenu(null);
  }, [blankMenu, content, onChange]);

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
    setTableAction(null);
    setCellEdit({
      range: { start: Number(table.dataset.mdStart), end: Number(table.dataset.mdEnd) },
      row: rowIdx,
      col: colIdx,
      value: parsed.rows[rowIdx][colIdx] ?? '',
      left: rect.left,
      top: rect.top,
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
      className="h-full overflow-auto heid-scroll"
      onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove}
      onClick={handleContainerClick}
    >
      <div className="mx-auto p-6 text-left max-w-[900px]">
        <div className={proseClassName}>
          <MarkdownStyles isDarkMode={isDarkMode} />
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={mdComponents as any}
          >
            {processedContent}
          </ReactMarkdown>
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
              'fixed z-[96] flex items-center rounded-lg border shadow-lg overflow-hidden',
              isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
            )}
            style={{ left: Math.max(4, cellEdit.left), top: Math.max(4, cellEdit.top - 38) }}
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
            "fixed z-[95] box-border px-2 text-sm outline-none border-2 rounded-sm",
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
    </div>
  );
}));

MarkdownPreview.displayName = 'MarkdownPreview';

/* prose 默认样式不覆盖的部分（表格 / 行内代码 / 图片）在这里补齐 */
const MarkdownStyles = React.memo<{ isDarkMode: boolean }>(({ isDarkMode }) => {
  return (
    <style>{`
      .prose { --tw-prose-body: ${isDarkMode ? '#d4d4d8' : '#374151'}; }
      .prose table { border-collapse: collapse; margin: 1rem 0; display: table; width: fit-content; max-width: 100%; }
      .prose th, .prose td { border: 1px solid ${isDarkMode ? '#3f3f46' : '#d4d4d8'}; padding: 0.5rem 0.75rem; text-align: left; }
      .prose th { background-color: ${isDarkMode ? '#27272a' : '#f4f4f5'}; font-weight: 600; }
      .prose tr:nth-child(even) { background-color: ${isDarkMode ? 'rgba(39, 39, 42, 0.3)' : 'rgba(244, 244, 245, 0.5)'}; }
      .prose pre { background-color: transparent !important; padding: 0 !important; margin: 0 !important; border: none !important; box-shadow: none !important; }
      .prose img { display: block !important; margin-left: auto !important; margin-right: auto !important; max-width: 100% !important; height: auto; border-radius: 0.5rem; }
      .prose :not(pre) > code {
        background-color: ${isDarkMode ? 'rgba(63, 63, 70, 0.5)' : 'rgba(244, 244, 245, 1)'};
        padding: 0.2em 0.4em;
        border-radius: 0.25rem;
        font-weight: normal;
      }
    `}</style>
  );
});

MarkdownStyles.displayName = 'MarkdownStyles';
