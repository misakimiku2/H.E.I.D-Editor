import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, ghcolors } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Pilcrow,
  Bold, Italic, Strikethrough, Code, TextQuote,
  List, ListOrdered, ListTodo, Braces, Link2, Image as ImageIcon,
  Table, Minus, Undo2, Redo2,
} from 'lucide-react';
import { cn } from '../lib/utils';

/* ---- 本地图片：相对/绝对路径通过 Tauri fs 读取为 blob URL，带缓存 ---- */

const imageCache = new Map<string, string>();

const MarkdownImage = React.memo<{
  src: string;
  alt: string;
  isDarkMode: boolean;
}>(({ src, alt, isDarkMode }) => {
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
          if (errMsg.includes('forbidden')) { setLoadError('权限不足，无法读取该路径的文件'); return; }
          try {
            const { convertFileSrc } = await import('@tauri-apps/api/core');
            let p = /^[A-Za-z]:/.test(filePath) ? '/' + filePath.replace(/\\/g, '/') : filePath;
            const result = convertFileSrc(p);
            if (result && result.length > 0) { setImgSrc(result); }
            else { setLoadError('图片加载失败'); }
          } catch { setLoadError('图片加载失败'); }
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
        <span style={{ display: 'block' }}>{(alt || '').split('|||LOCAL-FILE:')[0] || '图片'}</span>
        <span style={{ fontSize: '0.75rem', marginTop: '0.25rem', opacity: 0.7, display: 'block' }}>{loadError}</span>
      </span>
    );
  }

  return (
    <img
      src={imgSrc} alt={(alt || '').split('|||LOCAL-FILE:')[0] || ''}
      loading="lazy"
      style={{ maxWidth: '100%', height: 'auto', borderRadius: '0.5rem', display: 'block', marginLeft: 'auto', marginRight: 'auto', margin: '1.5rem 0' }}
    />
  );
});

MarkdownImage.displayName = 'MarkdownImage';

/* ---- 选区格式化：把渲染后的选区映射回 markdown 源码并套用语法 ---- */

type MdOp =
  | { kind: 'heading'; level: number }
  | { kind: 'paragraph' }
  | { kind: 'bold' } | { kind: 'italic' } | { kind: 'strike' } | { kind: 'inlineCode' }
  | { kind: 'link' } | { kind: 'image' }
  | { kind: 'quote' } | { kind: 'ul' } | { kind: 'ol' } | { kind: 'task' }
  | { kind: 'codeBlock' } | { kind: 'table' } | { kind: 'hr' };

interface SrcBlock {
  start: number;
  end: number;
}

interface MenuState {
  x: number;
  y: number;
  text: string;
  blocks: SrcBlock[];
}

/* 行内标记 → 包裹符；链接/图片单独处理 */
const INLINE_WRAPS: Partial<Record<MdOp['kind'], [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  inlineCode: ['`', '`'],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 去掉行首的块级标记（标题/引用/列表），方便转换成其他块级语法 */
const stripBlockPrefix = (line: string): string =>
  line.replace(/^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '$1');

/* 在源码片段里定位选中文本；渲染文本与源码空白不一致时按空白归一匹配 */
function findInSlice(slice: string, text: string): { index: number; length: number } | null {
  if (!text) return null;
  const direct = slice.indexOf(text);
  if (direct >= 0) return { index: direct, length: text.length };
  const parts = text.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (parts.length > 0) {
    const m = new RegExp(parts.join('\\s+')).exec(slice);
    if (m) return { index: m.index, length: m[0].length };
  }
  return null;
}

/* 块级操作：给每行加前缀；若所有行已带该前缀则视为取消（还原为普通段落） */
function prefixLines(slice: string, toggleTest: RegExp, make: (lineIndex: number) => string): string {
  const lines = slice.split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  const toggled = nonEmpty.length > 0 && nonEmpty.every(l => toggleTest.test(l));
  return lines.map((l, i) => {
    if (!l.trim()) return l;
    if (toggled) return stripBlockPrefix(l);
    return make(i) + stripBlockPrefix(l);
  }).join('\n');
}

const TABLE_TEMPLATE = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |';

/* 对单个源码块套用操作，返回替换后的文本 */
function transformSlice(op: MdOp, slice: string, selectedText: string): string {
  switch (op.kind) {
    case 'heading':
      return prefixLines(slice, new RegExp(`^${'#'.repeat(op.level)} `), () => `${'#'.repeat(op.level)} `);
    case 'paragraph':
      return slice.split('\n').map(l => stripBlockPrefix(l)).join('\n');
    case 'quote':
      return prefixLines(slice, /^>\s?/, () => '> ');
    case 'ul':
      return prefixLines(slice, /^[-*+]\s+/, () => '- ');
    case 'ol':
      return prefixLines(slice, /^\d+[.)]\s+/, i => `${i + 1}. `);
    case 'task':
      return prefixLines(slice, /^[-*+]\s+\[[ xX]\]\s+/, () => '- [ ] ');
    case 'codeBlock': {
      const trimmed = slice.trim();
      /* 已是围栏代码块则拆除围栏 */
      if (trimmed.startsWith('```')) {
        const body = trimmed.replace(/^```.*\n/, '').replace(/\n?```$/, '');
        return body;
      }
      return '```\n' + slice.replace(/^\n+|\n+$/g, '') + '\n```';
    }
    case 'table':
      return slice.trimEnd() + '\n\n' + TABLE_TEMPLATE;
    case 'hr':
      return slice.trimEnd() + '\n\n---';
    case 'link':
    case 'image':
    case 'bold':
    case 'italic':
    case 'strike':
    case 'inlineCode': {
      const found = findInSlice(slice, selectedText);
      const index = found ? found.index : 0;
      const length = found ? found.length : slice.replace(/^\n+|\n+$/g, '').length;
      const target = slice.slice(index, index + length);
      if (op.kind === 'link') {
        return slice.slice(0, index) + `[${target}](https://)` + slice.slice(index + length);
      }
      if (op.kind === 'image') {
        return slice.slice(0, index) + `![${target}](https://)` + slice.slice(index + length);
      }
      const [open, close] = INLINE_WRAPS[op.kind]!;
      /* 选区已被同样标记包裹则拆掉（切换） */
      const wrapped = open + target + close;
      const wIndex = slice.indexOf(wrapped);
      if (wIndex >= 0 && wIndex <= index && index + length <= wIndex + wrapped.length) {
        return slice.slice(0, wIndex) + target + slice.slice(wIndex + wrapped.length);
      }
      return slice.slice(0, index) + open + target + close + slice.slice(index + length);
    }
  }
}

/* ---- 右键格式菜单 ---- */

const MENU_SECTIONS: Array<{ label: string; ops: Array<{ op: MdOp; icon: React.ElementType; title: string; text: string }> }> = [
  {
    label: '标题',
    ops: [
      { op: { kind: 'heading', level: 1 }, icon: Heading1, title: '一级标题', text: 'H1' },
      { op: { kind: 'heading', level: 2 }, icon: Heading2, title: '二级标题', text: 'H2' },
      { op: { kind: 'heading', level: 3 }, icon: Heading3, title: '三级标题', text: 'H3' },
      { op: { kind: 'heading', level: 4 }, icon: Heading4, title: '四级标题', text: 'H4' },
      { op: { kind: 'heading', level: 5 }, icon: Heading5, title: '五级标题', text: 'H5' },
      { op: { kind: 'heading', level: 6 }, icon: Heading6, title: '六级标题', text: 'H6' },
      { op: { kind: 'paragraph' }, icon: Pilcrow, title: '正文段落', text: '正文' },
    ],
  },
  {
    label: '行内格式',
    ops: [
      { op: { kind: 'bold' }, icon: Bold, title: '粗体 **', text: '粗体' },
      { op: { kind: 'italic' }, icon: Italic, title: '斜体 *', text: '斜体' },
      { op: { kind: 'strike' }, icon: Strikethrough, title: '删除线 ~~', text: '删除线' },
      { op: { kind: 'inlineCode' }, icon: Code, title: '行内代码 `', text: '行内码' },
    ],
  },
  {
    label: '块级格式',
    ops: [
      { op: { kind: 'quote' }, icon: TextQuote, title: '引用 >', text: '引用' },
      { op: { kind: 'ul' }, icon: List, title: '无序列表 -', text: '无序' },
      { op: { kind: 'ol' }, icon: ListOrdered, title: '有序列表 1.', text: '有序' },
      { op: { kind: 'task' }, icon: ListTodo, title: '任务列表 - [ ]', text: '任务' },
      { op: { kind: 'codeBlock' }, icon: Braces, title: '代码块 ```', text: '代码块' },
    ],
  },
  {
    label: '插入',
    ops: [
      { op: { kind: 'link' }, icon: Link2, title: '链接 []()', text: '链接' },
      { op: { kind: 'image' }, icon: ImageIcon, title: '图片 ![]()', text: '图片' },
      { op: { kind: 'table' }, icon: Table, title: '插入表格', text: '表格' },
      { op: { kind: 'hr' }, icon: Minus, title: '分割线 ---', text: '分割线' },
    ],
  },
];

const FormatMenu = React.memo<{
  menu: MenuState;
  isDarkMode: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onApply: (op: MdOp) => void;
  onClose: () => void;
}>(({ menu, isDarkMode, canUndo, canRedo, onUndo, onRedo, onApply, onClose }) => {
  const ref = useRef<HTMLDivElement | null>(null);

  /* 点击外部 / Esc / 滚动 / 调整窗口时关闭 */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose]);

  /* 视口内夹紧，避免菜单溢出屏幕 */
  const MENU_W = 272;
  const MENU_H = 395;
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_W - 8));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - MENU_H - 8));

  const itemBase = "flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors";
  const itemTone = isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600";

  return (
    <div
      ref={ref}
      className={cn(
        "fixed z-[90] rounded-xl border shadow-xl p-2 flex flex-col gap-1.5 select-none",
        isDarkMode ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-white"
      )}
      style={{ left, top, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {(onUndo || onRedo) && (
        <>
          <div className={cn("text-[9px] font-semibold tracking-wider px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            编辑
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              title="撤销 (Ctrl+Z)"
              className={cn(itemBase, itemTone, !canUndo && "opacity-40 pointer-events-none")}
            >
              <Undo2 size={14} />
              <span className="text-[9px] leading-none whitespace-nowrap">撤销</span>
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              title="重做 (Ctrl+Y)"
              className={cn(itemBase, itemTone, !canRedo && "opacity-40 pointer-events-none")}
            >
              <Redo2 size={14} />
              <span className="text-[9px] leading-none whitespace-nowrap">重做</span>
            </button>
          </div>
          <div className={cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
        </>
      )}
      {MENU_SECTIONS.map((section, si) => (
        <React.Fragment key={section.label}>
          {si > 0 && <div className={cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />}
          <div className={cn("text-[9px] font-semibold tracking-wider px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            {section.label}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {section.ops.map(({ op, icon: Icon, title, text }) => (
              <button
                key={title}
                onClick={() => onApply(op)}
                title={title}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors",
                  isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
                )}
              >
                <Icon size={14} />
                <span className="text-[9px] leading-none whitespace-nowrap">{text}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
});

FormatMenu.displayName = 'FormatMenu';

/* ---- Markdown 预览：GFM + 代码块高亮 + 本地图片 + 表格样式 + 右键格式化 ---- */

interface MarkdownPreviewProps {
  content: string;
  isDarkMode: boolean;
  /** 提供后（非只读标签页）才允许选区右键格式化 */
  onChange?: (next: string) => void;
  /** 撤销/重做控制，透传给右键菜单 */
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

export const MarkdownPreview = React.memo<MarkdownPreviewProps>(({
  content, isDarkMode, onChange, canUndo, canRedo, onUndo, onRedo,
}) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

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
        const filePath = fixedUrl.replace(/^file:\/+/, '');
        const encodedAlt = `${alt}|||LOCAL-FILE:${filePath}`;
        return `![${encodedAlt}](https://local-image.placeholder)`;
      }
    );
  }, [content]);

  /* 右键：有选区时打开格式菜单 */
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onChange) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!sel || sel.isCollapsed || !text) return;
    const range = sel.getRangeAt(0);
    const root = contentRef.current;
    if (!root) return;

    /* 收集与选区相交、且带源码位置的最内层块 */
    const tagged = Array.from(root.querySelectorAll<HTMLElement>('[data-md-start]'));
    const hits = tagged.filter(el => range.intersectsNode(el));
    const innermost = hits.filter(el => !hits.some(o => o !== el && el.contains(o)));
    const blocks = innermost
      .map(el => ({ start: Number(el.dataset.mdStart), end: Number(el.dataset.mdEnd) }))
      .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
      .sort((a, b) => a.start - b.start);
    if (blocks.length === 0) return;

    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, text, blocks });
  }, [onChange]);

  /* 套用操作：从后往前替换，保证偏移量不失效 */
  const handleApply = useCallback((op: MdOp) => {
    if (!menu || !onChange) return;
    const inlineKinds: Array<MdOp['kind']> = ['link', 'image', 'bold', 'italic', 'strike', 'inlineCode'];
    const targets = inlineKinds.includes(op.kind) ? menu.blocks.slice(0, 1) : menu.blocks;
    let next = content;
    for (const b of [...targets].sort((x, y) => y.start - x.start)) {
      const slice = content.slice(b.start, b.end);
      next = next.slice(0, b.start) + transformSlice(op, slice, menu.text) + next.slice(b.end);
    }
    setMenu(null);
    onChange(next);
  }, [menu, content, onChange]);

  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div
      ref={contentRef}
      className="h-full overflow-auto"
      onContextMenu={handleContextMenu}
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
    </div>
  );
});

MarkdownPreview.displayName = 'MarkdownPreview';

/* prose 默认样式不覆盖的部分（表格 / 行内代码 / 图片）在这里补齐 */
const MarkdownStyles = React.memo<{ isDarkMode: boolean }>(({ isDarkMode }) => {
  return (
    <style>{`
      .prose { --tw-prose-body: ${isDarkMode ? '#d4d4d8' : '#374151'}; }
      .prose table { width: 100%; border-collapse: collapse; margin: 1rem 0; display: table; }
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
