import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, highlightWhitespace, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { history as historyExtension, indentWithTab, toggleComment, selectAll, deleteLine, moveLineUp, moveLineDown, copyLineDown } from '@codemirror/commands';import { syntaxTree, ensureSyntaxTree, indentUnit, foldGutter, bracketMatching, indentOnInput, syntaxHighlighting, foldKeymap, HighlightStyle, defaultHighlightStyle, foldAll, unfoldAll, language as languageFacet } from '@codemirror/language';
import { highlightSelectionMatches, selectSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { Tag, tags as t, highlightTree, type Highlighter } from '@lezer/highlight';
import type { Tree } from '@lezer/common';
import { EditorState, Extension, StateEffect } from '@codemirror/state';
import {
  Type,
  Undo2, Redo2, Scissors, Copy, ClipboardPaste, TextSelect, Search, MessageSquareQuote,
  CaseUpper, CaseLower, ArrowUpNarrowWide, ArrowDownWideNarrow, ListX, Eraser,
  CopyPlus, ArrowUp, ArrowDown, Trash2, Regex, FoldVertical, UnfoldVertical,
} from 'lucide-react';
import { useT } from '../lib/i18nContext';
import { cn } from '../lib/utils';
import { FormatMenu, INLINE_WRAPS, transformSlice, footnoteEdit, type MdOp } from './MarkdownTools';
import { spliceSelectionTab } from '../lib/markdownTabs';
import { FindReplaceBar } from './FindReplaceBar';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { findHighlightExtension } from '../lib/editorSearch';
import { readClipboardText, writeClipboardText } from '../lib/fileOps';
import { loadLanguageExtension } from '../lib/codemirror';
import { DEFAULT_SETTINGS, type EditorSettings } from '../lib/settings';
import {
  vsCodeDarkTheme, vsCodeLightTheme,
  vsCodeDarkHighlightStyle, vsCodeLightHighlightStyle,
} from '../lib/codemirror';
import { IS_ANDROID_APP } from '../lib/platform';
import type { PointerPos } from '../hooks/useLastPointer';

const CODE_FONT = '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace';

/* 安卓平台小地图/粘性滚动门槛：手机关闭，平板（≥1024px）开启；再叠加用户设置与大文件降级 */
function platformCodeMapOk(): boolean {
  return !IS_ANDROID_APP || window.matchMedia('(min-width: 1024px)').matches;
}

/* ---------- sticky scroll helpers (extracted from CanvasWorkspace) ---------- */

function getLineIndent(text: string): number {
  let indent = 0;
  for (const ch of text) {
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += 2;
    else break;
  }
  return indent;
}

function isScopeStarter(text: string): boolean {
  if (!text || text.startsWith('}') || text.startsWith(']') || text.startsWith(')')) return false;
  if (/^#{1,6}\s/.test(text)) return true;
  if (/^(export\s+)?(default\s+)?(async\s+)?function\s/.test(text)) return true;
  if (/^(export\s+)?(default\s+)?class\s/.test(text)) return true;
  if (/^(export\s+)?(abstract\s+)?class\s/.test(text)) return true;
  if (/^(export\s+)?interface\s/.test(text)) return true;
  if (/^(export\s+)?type\s+\w+\s*=/.test(text)) return true;
  if (/^(export\s+)?enum\s/.test(text)) return true;
  if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?(\(|function|\[|React\.)/.test(text)) return true;
  if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*\{/.test(text)) return true;
  if (/^(if|else\s+if|else)\s*[\({]/.test(text)) return true;
  if (/^else\s*\{/.test(text)) return true;
  if (/^(for|while|do)\s*[\({]/.test(text)) return true;
  if (/^switch\s*\(/.test(text)) return true;
  if (/^case\s/.test(text)) return true;
  if (/^try\s*\{?/.test(text)) return true;
  if (/^catch\s*[\({]/.test(text)) return true;
  if (/^finally\s*\{?/.test(text)) return true;
  if (/^(def|class)\s/.test(text)) return true;
  if (/^(if|elif|else)\s.*:/.test(text)) return true;
  if (/^(for|while)\s.*:/.test(text)) return true;
  if (/^(try|except|finally)\s*:/.test(text)) return true;
  if (/^with\s.*:/.test(text)) return true;
  if (/^(pub\s+)?(async\s+)?fn\s/.test(text)) return true;
  if (/^(pub\s+)?(struct|enum|trait|impl)\s/.test(text)) return true;
  if (/^(if|else|loop|while|for|match)\b/.test(text)) return true;
  if (/^(public|private|protected)\s+(static\s+)?(class|interface|enum)\s/.test(text)) return true;
  if (/^(public|private|protected)\s+(static\s+)?(void|int|String|boolean|long|double|float)\s+\w+\s*\(/.test(text)) return true;
  if (text.endsWith('{')) return true;
  if (text.endsWith(':') && !text.startsWith('//') && !text.startsWith('/*') && !text.startsWith('*')) return true;
  return false;
}

function findEnclosingScopes(view: EditorView, currentLineNum: number): number[] {
  const doc = view.state.doc;
  const maxStickyLines = 5;
  const stack: { lineNum: number; depthAfter: number }[] = [];
  let depth = 0;

  for (let i = 1; i <= currentLineNum; i++) {
    const line = doc.line(i);
    const text = line.text;
    const trimmed = text.trim();

    let opens = 0, closes = 0;
    for (const ch of text) {
      if (ch === '{') opens++;
      else if (ch === '}') closes++;
    }

    const prevDepth = depth;
    depth = depth - closes + opens;

    while (stack.length > 0 && stack[stack.length - 1].depthAfter > depth) {
      stack.pop();
    }

    if (opens > closes && trimmed && isScopeStarter(trimmed)) {
      stack.push({ lineNum: i, depthAfter: depth });
    }
  }

  return stack.slice(-maxStickyLines).map(s => s.lineNum);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getHighlightedLineHTML(view: EditorView, from: number, to: number, highlightStyle: HighlightStyle): string {
  const tree = syntaxTree(view.state);
  const parts: { from: number; to: number; cls: string }[] = [];

  highlightTree(tree, highlightStyle, (from, to, cls) => {
    if (cls) parts.push({ from, to, cls });
  }, from, to);

  parts.sort((a, b) => a.from - b.from || a.to - b.to);

  let html = '';
  let pos = from;
  const doc = view.state.doc;

  for (const part of parts) {
    if (part.from > pos) {
      html += escapeHtml(doc.sliceString(pos, part.from));
    }
    html += `<span class="${part.cls}">${escapeHtml(doc.sliceString(part.from, part.to))}</span>`;
    pos = part.to;
  }
  if (pos < to) {
    html += escapeHtml(doc.sliceString(pos, to));
  }

  return html;
}

/* ---------- 编辑器右键菜单操作：全部经由 CodeMirror view 读写（不依赖 DOM 焦点） ---------- */

/** 行排序 / 去重共用：数字感知、大小写不敏感 */
const LINE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 选区行范围（多行选区含尾行；单行选区即光标行） */
function selectedLines(view: EditorView): { fromLine: number; toLine: number } {
  const sel = view.state.selection.main;
  return { fromLine: view.state.doc.lineAt(sel.from).number, toLine: view.state.doc.lineAt(sel.to).number };
}

function replaceSelection(view: EditorView, transform: (text: string) => string): void {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const replaced = transform(view.state.sliceDoc(sel.from, sel.to));
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: replaced },
    selection: { anchor: sel.from, head: sel.from + replaced.length },
  });
  view.focus();
}

/** 对选区行（无选区时整篇）做整块行级替换 */
function replaceSelectedLines(view: EditorView, transform: (lines: string[]) => string[] | null): void {
  const { fromLine, toLine } = selectedLines(view);
  const start = view.state.doc.line(fromLine);
  const end = view.state.doc.line(toLine);
  const lines = view.state.sliceDoc(start.from, end.to).split('\n');
  const replaced = transform(lines);
  if (replaced === null) return;
  const text = replaced.join('\n');
  view.dispatch({
    changes: { from: start.from, to: end.to, insert: text },
    selection: { anchor: start.from, head: start.from + text.length },
  });
  view.focus();
}

async function copySelectionText(view: EditorView): Promise<void> {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  await writeClipboardText(view.state.sliceDoc(sel.from, sel.to));
}

async function cutSelectionText(view: EditorView): Promise<void> {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  await writeClipboardText(view.state.sliceDoc(sel.from, sel.to));
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' }, selection: { anchor: sel.from }, userEvent: 'delete.cut' });
  view.focus();
}

async function pasteFromClipboard(view: EditorView): Promise<void> {
  const text = await readClipboardText();
  if (!text) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    userEvent: 'input.paste',
  });
  view.focus();
}

/** 当前语言是否支持注释（commentTokens 语言数据；纯文本无 → 菜单项隐藏） */
function hasCommentTokens(view: EditorView): boolean {
  try {
    const pos = view.state.selection.main.head;
    return view.state
      .languageDataAt<{ line?: string; block?: { open: string; close: string } }>('commentTokens', pos)
      .some(tk => !!tk && (!!tk.line || !!tk.block));
  } catch {
    return false;
  }
}

/* ---------- CodeEditor component ---------- */

export interface CodeEditorProps {
  value: string;
  language: string;
  isDarkMode: boolean;
  editable?: boolean;
  /** 编辑器设置（字体/缩进/换行/minimap 等），缺省用 DEFAULT_SETTINGS */
  editorSettings?: EditorSettings;
  /** 大文件降级：关闭语法高亮/补全/选区匹配/小地图/粘性滚动 */
  lowPerf?: boolean;
  /** meta.major = true 表示这是离散操作（如 markdown 格式化），撤销历史独立成条 */
  onChange?: (value: string, meta?: { major?: boolean }) => void;
  onSave?: () => void;
  onCreateEditor?: (view: EditorView) => void;
  /** 滚动容器回调（分屏同步滚动用） */
  onScroller?: (el: HTMLElement | null) => void;
  /** 光标/选区变化上报（状态栏 行:列 与选中字符数用） */
  onCursor?: (info: { line: number; col: number; selChars: number }) => void;
  /** 查找浮层状态（open 时渲染 FindReplaceBar） */
  find?: { open: boolean; showReplace: boolean; goto: boolean };
  /** 查找浮层关闭回调（Esc / 关闭按钮） */
  onFindClose?: () => void;
  /** 查找浮层弹出定位（打开瞬间的指针位置） */
  getPointer?: () => PointerPos;
  /** 提供（markdown 且可编辑）时，选区右键弹 markdown 格式菜单 */
  markdownMenu?: {
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
  };
  /** 编辑历史（撤销/重做）：通用右键菜单的撤销重做项（与 markdown 菜单同一数据源） */
  history?: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void };
  /** 打开查找浮层（通用右键菜单「查找/替换」入口） */
  onFindOpen?: () => void;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  value,
  language,
  isDarkMode,
  editable = true,
  editorSettings,
  lowPerf = false,
  onChange,
  onSave,
  onCreateEditor,
  onScroller,
  onCursor,
  find,
  onFindClose,
  getPointer,
  markdownMenu,
  history,
  onFindOpen,
}) => {
  /* tags 以 t 导入（@lezer/highlight），翻译函数让位使用别名 tr */
  const tr = useT();
  const settings = editorSettings ?? DEFAULT_SETTINGS;
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const stickyRef = useRef<HTMLElement | null>(null);
  const minimapRef = useRef<{ canvas: HTMLCanvasElement; container: HTMLElement } | null>(null);
  const minimapRafRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const viewReadyRef = useRef<EditorView | null>(null);
  const cleanupFns = useRef<(() => void)[]>([]);
  /* 语言扩展懒加载：语言切换时先清空再异步载入（chunk 已缓存时几乎无感） */
  const [langExtension, setLangExtension] = useState<Extension | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLangExtension(null);
    if (lowPerf) return;
    void loadLanguageExtension(language).then(ext => {
      if (!cancelled) setLangExtension(ext);
    });
    return () => { cancelled = true; };
  }, [language, lowPerf]);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onScrollerRef = useRef(onScroller);
  onScrollerRef.current = onScroller;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  /* 查找浮层状态镜像进 ref：编辑器 keymap 的 Escape 需要同步读到最新值 */
  const findOpenRef = useRef(!!find?.open);
  findOpenRef.current = !!find?.open;
  const onFindCloseRef = useRef(onFindClose);
  onFindCloseRef.current = onFindClose;
  /** 查找栏读取编辑器视图的稳定入口（FindReplaceBar 的 effect 依赖稳定性靠它保证） */
  const getView = useCallback(() => viewReadyRef.current, []);
  /* markdown 右键格式化后，下一次 onChange 以 major 记入撤销历史 */
  const majorNextRef = useRef(false);
  const [mdMenu, setMdMenu] = useState<{ x: number; y: number; from: number; to: number; text: string } | null>(null);
  /* 通用右键菜单（非 markdown 格式化路径都走这里；minimap/行号随容器一并接管） */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  /* 粘贴项可用性：菜单打开后异步探测一次剪贴板读取（无权限时置灰，探测期间按可用展示） */
  const [pasteAvailable, setPasteAvailable] = useState(true);
  useEffect(() => {
    if (!ctxMenu) return;
    let alive = true;
    setPasteAvailable(true);
    readClipboardText()
      .then(() => { if (alive) setPasteAvailable(true); })
      .catch(() => { if (alive) setPasteAvailable(false); });
    return () => { alive = false; };
  }, [ctxMenu]);
  /* 光标上报去重（extensions memo 重建时避免重复回调同值） */
  const lastCursorRef = useRef<{ line: number; col: number; selChars: number } | null>(null);
  /* 触屏：选区非空时浮出「格式化」入口（长按 contextmenu 在安卓上不可靠） */
  const [touchFmtBtn, setTouchFmtBtn] = useState<{ x: number; y: number; from: number; to: number } | null>(null);

  /* line-number click & drag selection */
  const setupLineNumberClick = useCallback((view: EditorView) => {
    const gutters = view.dom.querySelector('.cm-gutters') as HTMLElement | null;
    if (!gutters) return;

    let isDragging = false;
    let startLineNum = 0;

    const getLineAtY = (clientY: number): number | null => {
      const editorRect = view.dom.getBoundingClientRect();
      const y = clientY - editorRect.top + view.scrollDOM.scrollTop;
      try {
        const block = view.lineBlockAtHeight(y);
        if (block && block.from !== undefined) {
          return view.state.doc.lineAt(block.from).number;
        }
      } catch {}
      return null;
    };

    const selectLines = (fromLine: number, toLine: number) => {
      const doc = view.state.doc;
      const minLine = Math.min(fromLine, toLine);
      const maxLine = Math.max(fromLine, toLine);
      const from = doc.line(minLine).from;
      const to = doc.line(maxLine).to;
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'nearest' }),
      });
      view.focus();
    };

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.cm-lineNumbers')) return;
      e.preventDefault();
      const lineNum = getLineAtY(e.clientY);
      if (lineNum === null) return;
      isDragging = true;
      startLineNum = lineNum;
      selectLines(lineNum, lineNum);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const lineNum = getLineAtY(e.clientY);
      if (lineNum === null) return;
      selectLines(startLineNum, lineNum);
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    gutters.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    cleanupFns.current.push(() => {
      gutters.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    });
  }, []);

  /* sticky scope headers */
  const setupStickyScroll = useCallback((view: EditorView) => {
    const highlightStyle = isDarkMode ? vsCodeDarkHighlightStyle : vsCodeLightHighlightStyle;
    const bgColor = isDarkMode ? '#1e1e1e' : '#ffffff';
    const bgColorHover = isDarkMode ? '#2d2d2d' : '#f0f0f0';
    const borderColor = isDarkMode ? '#3f3f46' : '#e1e4e8';
    const lineColor = isDarkMode ? '#d4d4d4' : '#1e1e1e';

    const container = document.createElement('div');
    Object.assign(container.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '20',
      display: 'none',
      userSelect: 'none',
    });

    view.dom.style.position = 'relative';
    view.dom.appendChild(container);
    stickyRef.current = container;

    const updateSticky = () => {
      const scrollTop = view.scrollDOM.scrollTop;
      if (scrollTop <= 20) {
        container.style.display = 'none';
        return;
      }

      try {
        const block = view.lineBlockAtHeight(scrollTop);
        if (!block || block.from === undefined) {
          container.style.display = 'none';
          return;
        }

        const currentLine = view.state.doc.lineAt(block.from);
        const scopeLines = findEnclosingScopes(view, currentLine.number);

        if (scopeLines.length === 0) {
          container.style.display = 'none';
          return;
        }

        const guttersEl = view.dom.querySelector('.cm-gutters');
        const gutterWidth = guttersEl ? guttersEl.getBoundingClientRect().width : 50;

        container.innerHTML = '';

        for (const lineNum of scopeLines) {
          const line = view.state.doc.line(lineNum);
          const indent = getLineIndent(line.text);
          const lineEl = document.createElement('div');
          Object.assign(lineEl.style, {
            background: bgColor,
            borderBottom: `1px solid ${borderColor}`,
            padding: `1px 12px 1px ${gutterWidth + indent * 4}px`,
            fontSize: '13px',
            color: lineColor,
            fontFamily: CODE_FONT,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            lineHeight: '1.5',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          });

          lineEl.addEventListener('mouseenter', () => {
            lineEl.style.backgroundColor = bgColorHover;
          });
          lineEl.addEventListener('mouseleave', () => {
            lineEl.style.backgroundColor = bgColor;
          });
          lineEl.addEventListener('click', () => {
            const targetLine = view.state.doc.line(lineNum);
            view.dispatch({
              effects: EditorView.scrollIntoView(targetLine.from, { y: 'center' }),
              selection: { anchor: targetLine.from },
            });
            view.focus();
          });

          const html = getHighlightedLineHTML(view, line.from, line.to, highlightStyle);
          lineEl.innerHTML = html;
          container.appendChild(lineEl);
        }

        container.style.display = 'block';
      } catch {
        container.style.display = 'none';
      }
    };

    let lastStickyScrollTop = 0;

    const handleScroll = () => {
      const currentScrollTop = view.scrollDOM.scrollTop;
      if (Math.abs(currentScrollTop - lastStickyScrollTop) > 300) {
        container.style.display = 'none';
        lastStickyScrollTop = currentScrollTop;
        return;
      }
      lastStickyScrollTop = currentScrollTop;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateSticky();
      });
    };

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
    cleanupFns.current.push(() => view.scrollDOM.removeEventListener('scroll', handleScroll));
    cleanupFns.current.push(() => {
      if (container.parentNode) container.parentNode.removeChild(container);
      stickyRef.current = null;
    });
  }, [isDarkMode]);

  /* canvas minimap */
  const setupMinimap = useCallback((view: EditorView) => {
    const bgColor = isDarkMode ? '#1e1e1e' : '#ffffff';
    const viewportColor = isDarkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)';
    const viewportBorderColor = isDarkMode ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.18)';
    const selectionColor = isDarkMode ? 'rgba(100, 150, 255, 0.3)' : 'rgba(50, 100, 255, 0.25)';
    const MINIMAP_WIDTH_MIN = 60;
    const MINIMAP_WIDTH_MAX = 170;
    let minimapWidth = Math.min(MINIMAP_WIDTH_MAX, Math.max(MINIMAP_WIDTH_MIN, Math.round(view.dom.clientWidth * 0.08)));
    const BLOCK_HEIGHT = 3;
    const LINE_GAP = 2;
    const LINE_PITCH = BLOCK_HEIGHT + LINE_GAP;
    const CHAR_WIDTH = 1.15;
    const PADDING = 6;

    const existingContainer = view.dom.querySelector('.cm-minimap-container') as HTMLElement | null;
    if (existingContainer) existingContainer.remove();

    const container = document.createElement('div');
    container.className = 'cm-minimap-container';
    Object.assign(container.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      width: `${minimapWidth}px`,
      backgroundColor: bgColor,
      borderLeft: isDarkMode ? '1px solid #3f3f46' : '1px solid #e1e4e8',
      overflow: 'hidden',
      cursor: 'default',
      zIndex: '25',
    });

    const innerWrapper = document.createElement('div');
    Object.assign(innerWrapper.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      willChange: 'transform',
    });
    container.appendChild(innerWrapper);

    const contentCanvas = document.createElement('canvas');
    contentCanvas.style.display = 'block';
    innerWrapper.appendChild(contentCanvas);

    const selectionDiv = document.createElement('div');
    Object.assign(selectionDiv.style, {
      position: 'absolute',
      left: `${PADDING}px`,
      width: `${minimapWidth - PADDING * 2}px`,
      backgroundColor: selectionColor,
      pointerEvents: 'none',
      display: 'none',
    });
    innerWrapper.appendChild(selectionDiv);

    const viewportDiv = document.createElement('div');
    Object.assign(viewportDiv.style, {
      position: 'absolute',
      left: `${PADDING}px`,
      width: `${minimapWidth - PADDING * 2}px`,
      backgroundColor: viewportColor,
      border: `0.5px solid ${viewportBorderColor}`,
      pointerEvents: 'none',
      borderRadius: '2px',
    });
    container.appendChild(viewportDiv);

    view.dom.appendChild(container);
    view.scrollDOM.style.paddingRight = `${minimapWidth}px`;

    minimapRef.current = { canvas: contentCanvas, container };

    let isDragging = false;
    let isDraggingViewport = false;
    let dragStartClientY = 0;
    let dragStartScrollTop = 0;
    let currentMinimapScrollTop = 0;
    let dragRafId = 0;
    let fullParseScheduled = false;
    let forcedTree: Tree | null = null;
    const MIN_VP_HEIGHT = 30;

    const defaultColor = isDarkMode ? '#3d3d42' : '#d8d8db';
    const commentColor = isDarkMode ? '#6a9955' : '#008000';
    const variableColor = isDarkMode ? '#9cdcfe' : '#001080';
    const stringColor = isDarkMode ? '#ce9178' : '#a31515';
    const keywordColor = isDarkMode ? '#569cd6' : '#0000ff';
    const typeColor = isDarkMode ? '#4ec9b0' : '#267f99';
    const funcColor = isDarkMode ? '#dcdcaa' : '#795e26';
    const numberColor = isDarkMode ? '#b5cea8' : '#098658';
    const regexpColor = isDarkMode ? '#d16969' : '#800000';
    const escapeColor = isDarkMode ? '#d7ba7d' : '#098658';
    const operatorColor = isDarkMode ? '#d4d4d4' : '#000000';
    const punctuationColor = isDarkMode ? '#d4d4d4' : '#000000';
    const tagNameColor = isDarkMode ? '#569cd6' : '#800000';
    const attributeNameColor = isDarkMode ? '#9cdcfe' : '#0000ff';
    const attributeValueColor = isDarkMode ? '#ce9178' : '#a31515';
    const metaColor = isDarkMode ? '#d4d4d4' : '#000000';
    const invalidColor = isDarkMode ? '#f44747' : '#ff0000';
    const deletedColor = isDarkMode ? '#ce9178' : '#a31515';
    const insertedColor = isDarkMode ? '#b5cea8' : '#098658';

    const tagColorMap = new Map<string, string>();
    const addTag = (tag: Tag, color: string) => { if (tag) tagColorMap.set(tag.toString(), color); };
    const addStrTag = (name: string, color: string) => { tagColorMap.set(name, color); };
    addTag(t.comment, commentColor);
    addTag(t.lineComment, commentColor);
    addTag(t.blockComment, commentColor);
    addTag(t.docComment, commentColor);
    addTag(t.variableName, variableColor);
    addTag(t.typeName, typeColor);
    addTag(t.className, typeColor);
    addTag(t.namespace, typeColor);
    addTag(t.tagName, tagNameColor);
    addTag(t.propertyName, variableColor);
    addTag(t.attributeName, attributeNameColor);
    addTag(t.attributeValue, attributeValueColor);
    addTag(t.string, stringColor);
    addTag(t.docString, stringColor);
    addTag(t.character, stringColor);
    addTag(t.number, numberColor);
    addTag(t.integer, numberColor);
    addTag(t.float, numberColor);
    addTag(t.bool, keywordColor);
    addTag(t.null, keywordColor);
    addTag(t.atom, keywordColor);
    addTag(t.keyword, keywordColor);
    addTag(t.self, keywordColor);
    addTag(t.operatorKeyword, keywordColor);
    addTag(t.modifier, keywordColor);
    addTag(t.controlKeyword, keywordColor);
    addTag(t.definitionKeyword, keywordColor);
    addTag(t.moduleKeyword, keywordColor);
    addTag(t.operator, operatorColor);
    addTag(t.punctuation, punctuationColor);
    addTag(t.separator, punctuationColor);
    addTag(t.bracket, punctuationColor);
    addTag(t.regexp, regexpColor);
    addTag(t.escape, escapeColor);
    addTag(t.meta, metaColor);
    addTag(t.processingInstruction, keywordColor);
    addTag(t.monospace, stringColor);
    addTag(t.link, keywordColor);
    addTag(t.heading, keywordColor);
    addTag(t.deleted, deletedColor);
    addTag(t.inserted, insertedColor);
    addTag(t.invalid, invalidColor);
    addTag(t.list, metaColor);

    addStrTag('paren', punctuationColor);
    addStrTag('squareBracket', punctuationColor);
    addStrTag('brace', punctuationColor);
    addStrTag('derefOperator', operatorColor);
    addStrTag('definitionOperator', operatorColor);
    addStrTag('arithmeticOperator', operatorColor);
    addStrTag('special(string)', stringColor);

    const minimapHighlighter: Highlighter = {
      style(tagList: readonly Tag[]): string | null {
        for (const tag of tagList) {
          const color = tagColorMap.get(tag.toString());
          if (color) return color;
          if ((tag as any).modified && (tag as any).modified.length > 0) {
            const hasFuncMod = (tag as any).modified.some((m: any) => m.name === 'function');
            if (hasFuncMod) return funcColor;
            const base = (tag as any).base;
            if (base) {
              const baseColor = tagColorMap.get(base.toString());
              if (baseColor) return baseColor;
            }
          }
        }
        return null;
      }
    };

    const renderContent = () => {
      const doc = view.state.doc;
      const lineCount = typeof doc.lines === 'number' ? doc.lines : 1;
      const displayWidth = minimapWidth - PADDING * 2;
      const contentH = Math.max(lineCount * LINE_PITCH + PADDING * 2, container.clientHeight);
      const containerH = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      const scrollH = view.scrollDOM.scrollHeight;
      const scrollTop = view.scrollDOM.scrollTop;
      const scrollerH = view.scrollDOM.clientHeight;
      const maxScroll = Math.max(0, scrollH - scrollerH);

      const naturalVpH = scrollH > 0
        ? (scrollerH / scrollH) * containerH
        : containerH;
      const minVpH = Math.max(MIN_VP_HEIGHT, containerH * 0.08);
      const logicalVpH = Math.max(naturalVpH, minVpH);
      const vpY = maxScroll > 0
        ? (scrollTop / maxScroll) * (containerH - logicalVpH)
        : 0;
      const vpYInContent = scrollH > 0
        ? (scrollTop / scrollH) * contentH
        : 0;
      const maxMinimapScroll = Math.max(0, contentH - containerH);
      const minimapScrollTop = maxMinimapScroll > 0
        ? Math.max(0, Math.min(maxMinimapScroll, vpYInContent - vpY))
        : 0;
      currentMinimapScrollTop = minimapScrollTop;

      const BUFFER_LINES = 15;
      const highlightFirstLine = Math.max(1, Math.floor((minimapScrollTop - PADDING) / LINE_PITCH) + 1 - BUFFER_LINES);
      const highlightLastLine = Math.min(lineCount, Math.ceil((minimapScrollTop + containerH - PADDING) / LINE_PITCH) + BUFFER_LINES);

      contentCanvas.width = displayWidth * dpr;
      contentCanvas.height = contentH * dpr;
      contentCanvas.style.width = `${displayWidth}px`;
      contentCanvas.style.height = `${contentH}px`;
      contentCanvas.style.marginLeft = `${PADDING}px`;
      const ctx = contentCanvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, displayWidth, contentH);

      const tree = forcedTree || syntaxTree(view.state);
      const rangeFrom = doc.line(highlightFirstLine).from;
      const rangeTo = doc.line(highlightLastLine).to;

      const colorRanges: { from: number; to: number; color: string }[] = [];
      highlightTree(tree, minimapHighlighter, (from, to, color) => {
        if (color && from < rangeTo && to > rangeFrom) {
          colorRanges.push({ from, to, color });
        }
      }, rangeFrom, rangeTo);
      colorRanges.sort((a, b) => a.from - b.from || a.to - b.to);

      const lineTokenMap = new Map<number, { from: number; to: number; color: string }[]>();
      for (const range of colorRanges) {
        const fromLine = doc.lineAt(range.from).number;
        const toLine = doc.lineAt(Math.max(range.from, range.to - 1)).number;
        for (let ln = fromLine; ln <= toLine; ln++) {
          if (ln < highlightFirstLine || ln > highlightLastLine) continue;
          if (!lineTokenMap.has(ln)) lineTokenMap.set(ln, []);
          const ls = doc.line(ln).from;
          const le = doc.line(ln).to;
          lineTokenMap.get(ln)!.push({
            from: Math.max(range.from, ls),
            to: Math.min(range.to, le),
            color: range.color
          });
        }
      }

      for (let i = 1; i <= lineCount; i++) {
        const line = doc.line(i);
        const y = PADDING + (i - 1) * LINE_PITCH;
        const lineLen = line.text.length;
        if (lineLen === 0) continue;
        const ranges = lineTokenMap.get(i);
        if (!ranges || ranges.length === 0) {
          ctx.fillStyle = defaultColor;
          ctx.fillRect(0, y, Math.min(lineLen * CHAR_WIDTH, displayWidth), BLOCK_HEIGHT);
          continue;
        }
        let pos = line.from;
        let x = 0;
        for (const range of ranges) {
          if (range.from > pos) {
            const gapLen = range.from - pos;
            ctx.fillStyle = defaultColor;
            ctx.fillRect(x, y, gapLen * CHAR_WIDTH, BLOCK_HEIGHT);
            x += gapLen * CHAR_WIDTH;
            pos = range.from;
          }
          const len = range.to - range.from;
          ctx.fillStyle = range.color;
          ctx.fillRect(x, y, len * CHAR_WIDTH, BLOCK_HEIGHT);
          x += len * CHAR_WIDTH;
          pos = range.to;
          if (x > displayWidth) break;
        }
        if (pos < line.to && x <= displayWidth) {
          const len = line.to - pos;
          ctx.fillStyle = defaultColor;
          ctx.fillRect(x, y, len * CHAR_WIDTH, BLOCK_HEIGHT);
        }
      }

      const treeAfterRender = forcedTree || syntaxTree(view.state);
      if (treeAfterRender.length < doc.length * 0.98 && !fullParseScheduled) {
        fullParseScheduled = true;
        const syncTree = ensureSyntaxTree(view.state, doc.length, 100);
        if (syncTree) {
          forcedTree = syncTree;
          renderContent();
          updateOverlay();
          fullParseScheduled = false;
        } else {
          requestAnimationFrame(() => {
            scheduleProgressiveParse();
          });
        }
      }
      return contentH;

      function scheduleProgressiveParse() {
        const TIMEOUTS = [50, 100, 200, 500, 1000, 2000, 5000];
        let step = 0;

        function parseStep() {
          if (step >= TIMEOUTS.length) {
            renderContent();
            updateOverlay();
            fullParseScheduled = false;
            return;
          }

          const timeout = TIMEOUTS[step++];
          const forced = ensureSyntaxTree(view.state, doc.length, timeout);

          if (forced) {
            forcedTree = forced;
          }

          renderContent();
          updateOverlay();

          if (forcedTree && forcedTree.length >= doc.length * 0.98) {
            fullParseScheduled = false;
            return;
          }

          requestAnimationFrame(parseStep);
        }
        requestAnimationFrame(parseStep);
      }
    };

    const updateOverlay = () => {
      const doc = view.state.doc;
      const lineCount = typeof doc.lines === 'number' ? doc.lines : 1;
      const contentH = Math.max(lineCount * LINE_PITCH + PADDING * 2, container.clientHeight);
      const containerH = container.clientHeight;
      const scrollerH = view.scrollDOM.clientHeight;
      const scrollH = view.scrollDOM.scrollHeight;
      const scrollTop = view.scrollDOM.scrollTop;
      const maxScroll = Math.max(0, scrollH - scrollerH);

      const naturalVpH = scrollH > 0
        ? (scrollerH / scrollH) * containerH
        : containerH;

      const vpW = minimapWidth - PADDING * 2;
      const minVpH = Math.max(MIN_VP_HEIGHT, containerH * 0.08);
      const vpH = Math.max(naturalVpH, minVpH);

      const logicalVpH = Math.max(naturalVpH, minVpH);
      const vpY = maxScroll > 0
        ? (scrollTop / maxScroll) * (containerH - logicalVpH)
        : 0;

      viewportDiv.style.left = `${PADDING}px`;
      viewportDiv.style.width = `${vpW}px`;
      viewportDiv.style.top = `${vpY}px`;
      viewportDiv.style.height = `${vpH}px`;

      const vpYInContent = scrollH > 0
        ? (scrollTop / scrollH) * contentH
        : 0;
      const maxMinimapScroll = Math.max(0, contentH - containerH);
      const minimapScrollTop = maxMinimapScroll > 0
        ? Math.max(0, Math.min(maxMinimapScroll, vpYInContent - vpY))
        : 0;
      innerWrapper.style.transform = `translateY(${-minimapScrollTop}px)`;
      currentMinimapScrollTop = minimapScrollTop;

      const sel = view.state.selection.main;
      if (!sel.empty) {
        const startLine = doc.lineAt(sel.from).number;
        const endLine = doc.lineAt(sel.to).number;
        selectionDiv.style.display = 'block';
        selectionDiv.style.top = `${PADDING + (startLine - 1) * LINE_PITCH}px`;
        selectionDiv.style.height = `${(endLine - startLine + 1) * LINE_PITCH}px`;
      } else {
        selectionDiv.style.display = 'none';
      }
    };

    const onScroll = () => {
      if (minimapRafRef.current !== null) return;
      minimapRafRef.current = requestAnimationFrame(() => {
        minimapRafRef.current = null;
        renderContent();
        updateOverlay();
      });
    };

    const scheduleFullRender = () => {
      if (minimapRafRef.current !== null) cancelAnimationFrame(minimapRafRef.current);
      minimapRafRef.current = requestAnimationFrame(() => {
        minimapRafRef.current = null;
        renderContent();
        updateOverlay();
      });
    };

    const scrollToY = (clientY: number) => {
      const rect = container.getBoundingClientRect();
      const relY = clientY - rect.top;
      const contentH = parseFloat(contentCanvas.style.height) || container.clientHeight;
      const scrollH = view.scrollDOM.scrollHeight;
      const contentY = relY + currentMinimapScrollTop;
      const targetScrollTop = contentH > 0 ? (contentY / contentH) * scrollH : 0;
      const maxScroll = Math.max(0, scrollH - view.scrollDOM.clientHeight);
      view.scrollDOM.scrollTop = Math.max(0, Math.min(maxScroll, targetScrollTop));
    };

    const handleMinimapMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const vpTop = parseFloat(viewportDiv.style.top) || 0;
      const vpHeight = parseFloat(viewportDiv.style.height) || 0;
      const clickedOnViewport = relY >= vpTop && relY <= vpTop + vpHeight;
      isDragging = true;
      isDraggingViewport = clickedOnViewport;
      dragStartClientY = e.clientY;
      dragStartScrollTop = view.scrollDOM.scrollTop;
      if (!clickedOnViewport) {
        scrollToY(e.clientY);
      }
    };

    const handleMinimapMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (dragRafId) return;
      const currentClientY = e.clientY;
      dragRafId = requestAnimationFrame(() => {
        dragRafId = 0;
        if (isDraggingViewport) {
          const deltaY = currentClientY - dragStartClientY;
          const containerH = container.clientHeight;
          const scrollerH = view.scrollDOM.clientHeight;
          const scrollH = view.scrollDOM.scrollHeight;
          const maxScroll = Math.max(0, scrollH - scrollerH);
          const naturalVpH = scrollH > 0 ? (scrollerH / scrollH) * containerH : containerH;
          const minVpH = Math.max(MIN_VP_HEIGHT, containerH * 0.08);
          const logicalVpH = Math.max(naturalVpH, minVpH);
          const scrollRange = containerH - logicalVpH;
          if (scrollRange > 0 && maxScroll > 0) {
            const scrollDelta = (deltaY / scrollRange) * maxScroll;
            view.scrollDOM.scrollTop = Math.max(0, Math.min(maxScroll, dragStartScrollTop + scrollDelta));
          }
        } else {
          scrollToY(currentClientY);
        }
      });
    };

    const handleMinimapMouseUp = () => {
      isDragging = false;
      isDraggingViewport = false;
      if (dragRafId) {
        cancelAnimationFrame(dragRafId);
        dragRafId = 0;
      }
    };

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged || update.geometryChanged) {
        scheduleFullRender();
      } else if (update.selectionSet) {
        updateOverlay();
      }
    });

    renderContent();
    updateOverlay();

    view.dispatch({ effects: StateEffect.appendConfig.of([updateListener]) });
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('mousedown', handleMinimapMouseDown);
    window.addEventListener('mousemove', handleMinimapMouseMove);
    window.addEventListener('mouseup', handleMinimapMouseUp);

    let resizeRafId = 0;
    const resizeObserver = new ResizeObserver(() => {
      const newWidth = Math.min(MINIMAP_WIDTH_MAX, Math.max(MINIMAP_WIDTH_MIN, Math.round(view.dom.clientWidth * 0.08)));
      if (newWidth === minimapWidth) return;
      if (resizeRafId) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        if (newWidth === minimapWidth) return;
        minimapWidth = newWidth;
        container.style.width = `${minimapWidth}px`;
        selectionDiv.style.width = `${minimapWidth - PADDING * 2}px`;
        viewportDiv.style.width = `${minimapWidth - PADDING * 2}px`;
        view.scrollDOM.style.paddingRight = `${minimapWidth}px`;
        scheduleFullRender();
      });
    });
    resizeObserver.observe(view.dom);

    cleanupFns.current.push(() => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      container.removeEventListener('mousedown', handleMinimapMouseDown);
      window.removeEventListener('mousemove', handleMinimapMouseMove);
      window.removeEventListener('mouseup', handleMinimapMouseUp);
      resizeObserver.disconnect();
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      if (minimapRafRef.current !== null) cancelAnimationFrame(minimapRafRef.current);
      if (dragRafId) cancelAnimationFrame(dragRafId);
      if (container.parentNode) container.parentNode.removeChild(container);
      view.scrollDOM.style.paddingRight = '';
      minimapRef.current = null;
    });
  }, [isDarkMode]);

  const fixSelectionLayer = useCallback((view: EditorView) => {
    const selectionLayer = view.scrollDOM.querySelector('.cm-selectionLayer') as HTMLElement | null;
    if (selectionLayer) {
      selectionLayer.style.removeProperty('z-index');
    }
    const contentEl = view.scrollDOM.querySelector('.cm-content') as HTMLElement | null;
    if (contentEl) {
      contentEl.style.removeProperty('position');
      contentEl.style.removeProperty('z-index');
    }
  }, []);

  /* ---- 编辑器右键：markdown 有选区走格式菜单，其余统一弹通用编辑菜单 ---- */

  const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const view = viewReadyRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (markdownMenu && from !== to) {
      setMdMenu({ x: e.clientX, y: e.clientY, from, to, text: view.state.sliceDoc(from, to) });
      return;
    }
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, [markdownMenu]);

  /** 通用编辑菜单项：按当前可编辑/选区/语言状态裁剪（右侧快捷键为真实已绑定的键） */
  const buildEditorMenuItems = useCallback((): ContextMenuItem[] => {
    const view = viewReadyRef.current;
    if (!view) return [];
    const hasSel = view.state.selection.main.from !== view.state.selection.main.to;
    const readOnly = !editable;
    const multiLine = (() => {
      const { fromLine, toLine } = selectedLines(view);
      return fromLine !== toLine;
    })();
    const run = (fn: (view: EditorView) => void | Promise<void>) => () => {
      const v = viewReadyRef.current;
      if (v) void fn(v);
    };
    const items: ContextMenuItem[] = [];
    if (history) {
      items.push(
        { icon: <Undo2 size={13} />, label: tr('menu.undo'), shortcut: 'Ctrl+Z', disabled: readOnly || !history.canUndo, onSelect: history.onUndo },
        { icon: <Redo2 size={13} />, label: tr('menu.redo'), shortcut: 'Ctrl+Y', disabled: readOnly || !history.canRedo, onSelect: history.onRedo, separatorBefore: true },
      );
    }
    items.push(
      { icon: <Scissors size={13} />, label: tr('ctx.cut'), shortcut: 'Ctrl+X', disabled: readOnly || !hasSel, onSelect: run(cutSelectionText) },
      { icon: <Copy size={13} />, label: tr('ctx.copy'), shortcut: 'Ctrl+C', disabled: !hasSel, onSelect: run(copySelectionText) },
      { icon: <ClipboardPaste size={13} />, label: tr('ctx.paste'), shortcut: 'Ctrl+V', disabled: readOnly || !pasteAvailable, onSelect: run(pasteFromClipboard) },
      { icon: <TextSelect size={13} />, label: tr('ctx.selectAll'), shortcut: 'Ctrl+A', onSelect: run(v => { selectAll(v); v.focus(); }), separatorBefore: true },
      { icon: <Search size={13} />, label: tr('ctx.find'), shortcut: 'Ctrl+F', disabled: !onFindOpen, onSelect: () => onFindOpen?.() },
    );
    if (!readOnly && hasCommentTokens(view)) {
      items.push({ icon: <MessageSquareQuote size={13} />, label: tr('ctx.toggleComment'), shortcut: 'Ctrl+/', onSelect: run(v => { toggleComment(v); v.focus(); }) });
    }
    if (!readOnly && hasSel) {
      items.push(
        { icon: <CaseUpper size={13} />, label: tr('ctx.uppercase'), onSelect: run(v => replaceSelection(v, s => s.toUpperCase())), separatorBefore: true },
        { icon: <CaseLower size={13} />, label: tr('ctx.lowercase'), onSelect: run(v => replaceSelection(v, s => s.toLowerCase())) },
      );
      if (multiLine) {
        items.push(
          { icon: <ArrowUpNarrowWide size={13} />, label: tr('ctx.sortAsc'), onSelect: run(v => replaceSelectedLines(v, lines => [...lines].sort((a, b) => LINE_COLLATOR.compare(a, b)))) },
          { icon: <ArrowDownWideNarrow size={13} />, label: tr('ctx.sortDesc'), onSelect: run(v => replaceSelectedLines(v, lines => [...lines].sort((a, b) => LINE_COLLATOR.compare(b, a)))) },
          { icon: <ListX size={13} />, label: tr('ctx.deleteDupLines'), onSelect: run(v => replaceSelectedLines(v, lines => {
              const seen = new Set<string>();
              const kept = lines.filter(l => (seen.has(l) ? false : (seen.add(l), true)));
              return kept.length === lines.length ? null : kept;
            })) },
        );
      }
    }
    if (!readOnly) {
      items.push({ icon: <Eraser size={13} />, label: tr('ctx.trimTrailing'), onSelect: run(v => {
        const sel = v.state.selection.main;
        const first = sel.empty ? 1 : v.state.doc.lineAt(sel.from).number;
        const last = sel.empty ? v.state.doc.lines : v.state.doc.lineAt(sel.to).number;
        const changes: { from: number; to: number }[] = [];
        for (let n = first; n <= last; n++) {
          const line = v.state.doc.line(n);
          const trimmed = line.text.replace(/[ \t]+$/, '');
          if (trimmed.length !== line.text.length) changes.push({ from: line.from + trimmed.length, to: line.to });
        }
        if (changes.length) v.dispatch({ changes });
        v.focus();
      }) });
    }
    if (!readOnly) {
      items.push(
        { icon: <CopyPlus size={13} />, label: tr('ctx.copyLineDown'), onSelect: run(v => { copyLineDown(v); v.focus(); }), separatorBefore: true },
        { icon: <ArrowUp size={13} />, label: tr('ctx.moveLineUp'), onSelect: run(v => { moveLineUp(v); v.focus(); }) },
        { icon: <ArrowDown size={13} />, label: tr('ctx.moveLineDown'), onSelect: run(v => { moveLineDown(v); v.focus(); }) },
        { icon: <Trash2 size={13} />, label: tr('ctx.deleteLine'), onSelect: run(v => { deleteLine(v); v.focus(); }) },
      );
    }
    if (hasSel) {
      items.push({ icon: <Regex size={13} />, label: tr('ctx.selectMatches'), onSelect: run(v => { selectSelectionMatches(v); v.focus(); }), separatorBefore: true });
    }
    if (!!view.state.facet(languageFacet)) {
      items.push(
        { icon: <FoldVertical size={13} />, label: tr('ctx.foldAll'), onSelect: run(v => { foldAll(v); v.focus(); }), separatorBefore: !hasSel },
        { icon: <UnfoldVertical size={13} />, label: tr('ctx.unfoldAll'), onSelect: run(v => { unfoldAll(v); v.focus(); }) },
      );
    }
    return items;
  }, [editable, history, pasteAvailable, onFindOpen, tr]);

  const applyEditorMdOp = useCallback((op: MdOp) => {
    const view = viewReadyRef.current;
    if (!view || !mdMenu) return;
    let { from, to } = mdMenu;
    const doc = view.state.doc;

    /* 块级操作扩展到整行（标题/列表/引用按行生效） */
    const isInline = op.kind === 'link' || op.kind === 'image' || !!INLINE_WRAPS[op.kind];
    if (!isInline) {
      from = doc.lineAt(from).from;
      to = doc.lineAt(to).to;
    }

    /* 行内操作：选区两侧紧邻同种标记时拆掉（切换） */
    const wrap = INLINE_WRAPS[op.kind];
    if (wrap) {
      const [open, close] = wrap;
      const before = doc.sliceString(Math.max(0, from - open.length), from);
      const after = doc.sliceString(to, Math.min(doc.length, to + close.length));
      if (before === open && after === close) {
        majorNextRef.current = true;
        view.dispatch({
          changes: [
            { from: from - open.length, to: from, insert: '' },
            { from: to, to: to + close.length, insert: '' },
          ],
          selection: { anchor: from - open.length },
        });
        setMdMenu(null);
        return;
      }
    }

    /* 选区转页签：整段选区包成一个页签区块；紧邻上一个已关闭的组时并排追加为新区块 */
    if (op.kind === 'tabGroup') {
      const head = doc.sliceString(0, from);
      const slice = doc.sliceString(from, to);
      const tail = doc.sliceString(to);
      const r = spliceSelectionTab(head, slice, tail);
      const changes = [];
      if (r.head !== head) changes.push({ from: 0, to: from, insert: r.head });
      changes.push({ from, to, insert: r.slice });
      if (r.tail !== tail) changes.push({ from, to: doc.length, insert: r.tail });
      const selAt = r.head.length;
      majorNextRef.current = true;
      view.dispatch({
        changes,
        selection: { anchor: selAt, head: selAt + r.slice.length },
      });
      setMdMenu(null);
      return;
    }

    /* 脚注：选中文本后插 [^n] 标记，文末生成定义行 */
    if (op.kind === 'footnote') {
      const fe = footnoteEdit(doc.toString(), { start: from, end: to }, mdMenu.text);
      const changes = fe.defAt > fe.markerAt
        ? [{ from: fe.markerAt, insert: fe.marker }, { from: fe.defAt, insert: fe.def }]
        : [{ from: fe.markerAt, insert: fe.marker + fe.def }];
      majorNextRef.current = true;
      view.dispatch({ changes, selection: { anchor: fe.markerAt + fe.marker.length } });
      setMdMenu(null);
      return;
    }

    const replaced = transformSlice(op, doc.sliceString(from, to), mdMenu.text, tr('md.tableTemplate'));
    majorNextRef.current = true;
    view.dispatch({
      changes: { from, to, insert: replaced },
      selection: { anchor: from, head: from + replaced.length },
    });
    setMdMenu(null);
  }, [mdMenu]);

  const handleCreateEditor = useCallback((view: EditorView) => {
    viewReadyRef.current = view;
    onScrollerRef.current?.(view.scrollDOM);
    cleanupFns.current.forEach(fn => fn());
    cleanupFns.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (minimapRafRef.current !== null) {
      cancelAnimationFrame(minimapRafRef.current);
      minimapRafRef.current = null;
    }
    if (stickyRef.current?.parentNode) {
      stickyRef.current.parentNode.removeChild(stickyRef.current);
    }
    stickyRef.current = null;
    if (minimapRef.current?.container.parentNode) {
      minimapRef.current.container.parentNode.removeChild(minimapRef.current.container);
    }
    minimapRef.current = null;
    fixSelectionLayer(view);
    if (!IS_ANDROID_APP) setupLineNumberClick(view);
    if (!lowPerf && platformCodeMapOk()) {
      if (settings.stickyScroll) setupStickyScroll(view);
      if (settings.minimap) setupMinimap(view);
    }
    onCreateEditor?.(view);
  }, [fixSelectionLayer, setupLineNumberClick, setupStickyScroll, setupMinimap, onCreateEditor, lowPerf, settings.stickyScroll, settings.minimap]);

  /* 拆掉并按当前断点重建粘性滚动/小地图（主题切换与平板旋转断点共用） */
  const reinstallCodeMapFeatures = useCallback(() => {
    const view = viewReadyRef.current;
    if (!view) return;
    cleanupFns.current.forEach(fn => fn());
    cleanupFns.current = [];
    if (stickyRef.current?.parentNode) {
      stickyRef.current.parentNode.removeChild(stickyRef.current);
    }
    stickyRef.current = null;
    if (minimapRef.current?.container.parentNode) {
      minimapRef.current.container.parentNode.removeChild(minimapRef.current.container);
    }
    minimapRef.current = null;
    if (minimapRafRef.current !== null) {
      cancelAnimationFrame(minimapRafRef.current);
      minimapRafRef.current = null;
    }
    fixSelectionLayer(view);
    if (!lowPerf && platformCodeMapOk()) {
      if (settings.stickyScroll) setupStickyScroll(view);
      if (settings.minimap) setupMinimap(view);
    }
  }, [fixSelectionLayer, setupStickyScroll, setupMinimap, lowPerf, settings.stickyScroll, settings.minimap]);

  /* re-setup features on theme change */
  useEffect(() => {
    reinstallCodeMapFeatures();
  }, [isDarkMode, reinstallCodeMapFeatures]);

  /* 安卓平板旋转/分屏跨越 1024px 断点时重建小地图与粘性滚动 */
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    mq.addEventListener('change', reinstallCodeMapFeatures);
    return () => mq.removeEventListener('change', reinstallCodeMapFeatures);
  }, [reinstallCodeMapFeatures]);

  useEffect(() => {
    return () => {
      cleanupFns.current.forEach(fn => fn());
      cleanupFns.current = [];
      viewReadyRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (minimapRafRef.current !== null) {
        cancelAnimationFrame(minimapRafRef.current);
        minimapRafRef.current = null;
      }
    };
  }, []);

  /* 字体/字号/行高：独立小主题叠加在基础主题之后，随设置即时生效 */
  const fontTheme = useMemo(() => EditorView.theme({
    '&': { fontSize: `${settings.fontSize}px`, fontFamily: settings.fontFamily, lineHeight: String(settings.lineHeight) },
    '.cm-scroller': { fontFamily: settings.fontFamily },
    '.cm-content': { fontFamily: settings.fontFamily },
    '.cm-gutters': { fontFamily: settings.fontFamily },
  }), [settings.fontSize, settings.fontFamily, settings.lineHeight]);

  const extensions = useMemo(() => {
    const lineCount = value.split('\n').length;
    const isLargeFile = lowPerf || lineCount > 1000;
    /* 默认模式（'markdown'）覆盖 markdown 与纯文本：纯文本没有语法结构，
       不换行会产生横向长行；代码类语言仍需用户手动选"总是换行" */
    const wrapEnabled = settings.lineWrapMode === 'always'
      || (settings.lineWrapMode === 'markdown' && (language === 'markdown' || language === 'plaintext'));
    const exts: Extension[] = [
      syntaxHighlighting(isDarkMode ? vsCodeDarkHighlightStyle : vsCodeLightHighlightStyle),
      highlightSpecialChars(),
      historyExtension(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentUnit.of(settings.insertSpaces ? ' '.repeat(settings.tabSize) : '\t'),
      EditorState.tabSize.of(settings.tabSize),
      fontTheme,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      foldGutter({
        openText: '▾',
        closedText: '▸',
        markerDOM: (open) => {
          const span = document.createElement('span');
          span.textContent = open ? '▾' : '▸';
          span.style.color = isDarkMode ? '#858585' : '#6e6e6e';
          span.style.fontSize = '12px';
          span.style.cursor = 'pointer';
          return span;
        },
      }),
      keymap.of([
        ...closeBracketsKeymap,
        indentWithTab,
        { key: 'Mod-s', run: () => { onSaveRef.current?.(); return true; } },
        { key: 'Mod-/', run: toggleComment },
        { key: 'Escape', run: () => {
          if (!findOpenRef.current) return false;
          onFindCloseRef.current?.();
          return true;
        } },
        ...foldKeymap,
      ]),
      findHighlightExtension(),
    ];
    if (wrapEnabled) {
      exts.push(EditorView.lineWrapping);
    }
    if (settings.showWhitespace) {
      exts.push(highlightWhitespace());
    }
    /* 触屏选区跟随：非空选区时在其上方浮出格式化入口按钮 */
    exts.push(EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged) return;
      const sel = u.state.selection.main;
      if (sel.empty) { setTouchFmtBtn(null); return; }
      const coords = u.view.coordsAtPos(sel.head);
      if (!coords) { setTouchFmtBtn(null); return; }
      setTouchFmtBtn({ x: coords.left, y: coords.top, from: sel.from, to: sel.to });
    }));
    /* 光标/选区变化上报（状态栏 行:列 / 选中字符数）；值未变化时跳过 */
    exts.push(EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged) return;
      const cb = onCursorRef.current;
      if (!cb) return;
      const sel = u.state.selection.main;
      const line = u.state.doc.lineAt(sel.head);
      const info = {
        line: line.number,
        col: sel.head - line.from + 1,
        selChars: Math.abs(sel.to - sel.from),
      };
      const last = lastCursorRef.current;
      if (last && last.line === info.line && last.col === info.col && last.selChars === info.selChars) return;
      lastCursorRef.current = info;
      cb(info);
    }));
    if (langExtension) exts.push(langExtension);
    if (!isLargeFile) {
      exts.push(highlightSelectionMatches());
      exts.push(autocompletion());
      exts.push(indentOnInput());
    }
    return exts;
  }, [language, value, isDarkMode, settings, fontTheme, langExtension, lowPerf]);

  /* onChange 统一经此中转：markdown 格式化等离散操作附带 major 标记 */
  const handleValueChange = useCallback((val: string) => {
    const meta = majorNextRef.current ? { major: true } : undefined;
    majorNextRef.current = false;
    onChangeRef.current?.(val, meta);
  }, []);

  return (
    <div className="relative h-full w-full" onContextMenu={handleEditorContextMenu}>
      <CodeMirror
        ref={cmRef}
        value={value}
        onChange={handleValueChange}
        extensions={extensions}
        readOnly={!editable}
        editable={editable}
        basicSetup={false}
        theme={isDarkMode ? vsCodeDarkTheme : vsCodeLightTheme}
        onCreateEditor={handleCreateEditor}
        className="h-full w-full"
        style={{
          height: '100%',
          width: '100%',
          fontSize: IS_ANDROID_APP ? '14px' : '13px',
        }}
      />
      {find?.open && (
        <FindReplaceBar
          getView={getView}
          isDarkMode={isDarkMode}
          showReplace={find.showReplace}
          gotoMode={find.goto}
          canReplace={!!editable}
          getPointer={getPointer}
          onClose={() => onFindCloseRef.current?.()}
        />
      )}
      {mdMenu && markdownMenu && (
        <FormatMenu
          menu={mdMenu}
          isDarkMode={isDarkMode}
          canUndo={markdownMenu.canUndo}
          canRedo={markdownMenu.canRedo}
          onUndo={() => { setMdMenu(null); markdownMenu.onUndo(); }}
          onRedo={() => { setMdMenu(null); markdownMenu.onRedo(); }}
          onApply={applyEditorMdOp}
          onClose={() => setMdMenu(null)}
        />
      )}
      {ctxMenu && (
        <ContextMenu
          menu={{ x: ctxMenu.x, y: ctxMenu.y, items: buildEditorMenuItems() }}
          isDarkMode={isDarkMode}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {IS_ANDROID_APP && markdownMenu && touchFmtBtn && !mdMenu && (
        <button
          onClick={() => {
            const view = viewReadyRef.current;
            if (!view) return;
            const { from, to, x, y } = touchFmtBtn;
            setMdMenu({ x, y, from, to, text: view.state.sliceDoc(from, to) });
            setTouchFmtBtn(null);
          }}
          className={cn(
            "fixed z-[85] h-9 px-3 rounded-full border shadow-lg flex items-center gap-1.5 text-xs font-medium select-none",
            isDarkMode ? "border-zinc-600 bg-zinc-800 text-zinc-200" : "border-zinc-300 bg-white text-zinc-700"
          )}
          style={{
            left: Math.max(8, Math.min(touchFmtBtn.x - 28, window.innerWidth - 110)),
            top: Math.max(8, touchFmtBtn.y - 44),
          }}
        >
          <Type size={14} />
          {tr('md.format')}
        </button>
      )}
    </div>
  );
};
