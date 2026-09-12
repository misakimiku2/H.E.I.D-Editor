import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { clampBarPosition } from '../lib/position';
import { findMatches, type MatchRange, type SearchOptions } from '../lib/searchCore';
import type { PointerPos } from '../hooks/useLastPointer';

export interface PreviewFindBarProps {
  /** 取预览渲染容器（搜索范围 = 容器内渲染后的文本） */
  getContainer: () => HTMLElement | null;
  /** markdown 源内容：内容变化时触发重扫 */
  content: string;
  isDarkMode: boolean;
  /** 弹出定位：打开瞬间的指针位置（不跟随） */
  getPointer?: () => PointerPos;
  onClose: () => void;
}

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

const ALL_HIGHLIGHT = 'heid-find';
const CURRENT_HIGHLIGHT = 'heid-find-current';

/** CSS Custom Highlight API 可用性（旧 WebView 降级为仅计数 + 滚动定位） */
function supportsHighlightApi(): boolean {
  return typeof (globalThis as any).Highlight === 'function'
    && typeof (CSS as any)?.highlights?.set === 'function';
}

const BLOCK_TAGS = /^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|TD|TH|HR|SECTION|ARTICLE|FIGURE)$/;

function isBlockEl(el: Element | null): boolean {
  return !!el && BLOCK_TAGS.test(el.tagName);
}

function nearestBlock(node: Node | null): Element | null {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === 1 && isBlockEl(n as Element)) return n as Element;
    n = n.parentNode;
  }
  return null;
}

/** 收集容器内渲染后的文本：跳过脚本/输入框/表格工具浮层；
    块级元素之间补 \n（不产生跨段匹配），行内元素之间不断开（跨 <strong> 等可匹配，与浏览器行为一致） */
function collectText(root: HTMLElement): { text: string; spans: TextSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, input, textarea, select, [contenteditable="true"], [data-md-table-tools]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const spans: TextSpan[] = [];
  let text = '';
  let lastBlock: Element | null = null;
  let current = walker.nextNode();
  while (current) {
    const textNode = current as Text;
    const block = nearestBlock(textNode.parentElement);
    if (spans.length > 0 && block !== lastBlock) text += '\n';
    spans.push({ node: textNode, start: text.length, end: text.length + textNode.data.length });
    text += textNode.data;
    lastBlock = block;
    current = walker.nextNode();
  }
  return { text, spans };
}

/** 拼接文本中的偏移 → (文本节点, 节点内偏移) */
function locate(spans: TextSpan[], pos: number): { node: Text; offset: number } | null {
  for (const s of spans) {
    if (pos >= s.start && pos <= s.end) return { node: s.node, offset: pos - s.start };
  }
  return null;
}

function rangeForMatch(spans: TextSpan[], m: MatchRange): Range | null {
  const start = locate(spans, m.from);
  const end = locate(spans, m.to);
  if (!start || !end) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range;
}

/**
 * Markdown 预览查找浮层：只搜索最终渲染出来的字符（markdown 语法标记不在渲染树中），
 * 匹配项经 CSS Custom Highlight API 高亮，导航循环回绕并滚动到当前项。
 * 不提供替换/跳行（渲染文本无法可靠映射回源码偏移）。
 */
export function PreviewFindBar({ getContainer, content, isDarkMode, getPointer, onClose }: PreviewFindBarProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [count, setCount] = useState({ total: 0, capped: false });
  const [current, setCurrent] = useState(-1);
  const optionsRef = useRef<SearchOptions>({ query: '', caseSensitive: false, regexp: false, wholeWord: false });
  optionsRef.current = { query, caseSensitive, regexp, wholeWord };
  const rangesRef = useRef<Range[]>([]);
  const spansRef = useRef<TextSpan[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* 弹出定位：与编辑器查找栏一致（指针位置，不跟随） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getPointerRef = useRef(getPointer);
  getPointerRef.current = getPointer;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = getPointerRef.current?.() ?? { x: -1, y: -1 };
    setPos(clampBarPosition(p.x, p.y, r.width, r.height));
  }, []);

  const clearHighlights = useCallback(() => {
    if (!supportsHighlightApi()) return;
    (CSS as any).highlights.delete(ALL_HIGHLIGHT);
    (CSS as any).highlights.delete(CURRENT_HIGHLIGHT);
  }, []);

  const applyHighlights = useCallback((cur: number) => {
    if (!supportsHighlightApi()) return;
    const registry = (CSS as any).highlights;
    const H = (globalThis as any).Highlight;
    const ranges = rangesRef.current;
    if (ranges.length === 0) {
      registry.delete(ALL_HIGHLIGHT);
      registry.delete(CURRENT_HIGHLIGHT);
      return;
    }
    const others: Range[] = [];
    ranges.forEach((r, i) => { if (i !== cur) others.push(r); });
    registry.set(ALL_HIGHLIGHT, new H(...others));
    if (cur >= 0) registry.set(CURRENT_HIGHLIGHT, new H(ranges[cur]));
    else registry.delete(CURRENT_HIGHLIGHT);
  }, []);

  const rescan = useCallback(() => {
    rangesRef.current = [];
    spansRef.current = [];
    const o = optionsRef.current;
    if (!o.query) {
      clearHighlights();
      setCount({ total: 0, capped: false });
      setCurrent(-1);
      return;
    }
    const root = getContainer();
    if (!root) return;
    const { text, spans } = collectText(root);
    spansRef.current = spans;
    const result = findMatches(text, o);
    const ranges: Range[] = [];
    for (const m of result.matches) {
      const r = rangeForMatch(spans, m);
      if (r) ranges.push(r);
    }
    rangesRef.current = ranges;
    setCount({ total: ranges.length, capped: result.capped });
    setCurrent(-1);
    applyHighlights(-1);
  }, [applyHighlights, clearHighlights, getContainer]);

  /* 查询 / 内容 / 选项变化 → 重扫（effect 在 DOM 提交后运行，渲染树已是最新） */
  useEffect(() => {
    rescan();
  }, [rescan, query, caseSensitive, regexp, wholeWord, content]);

  /* 卸载清理高亮 */
  useEffect(() => clearHighlights, [clearHighlights]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = useCallback((idx: number) => {
    const ranges = rangesRef.current;
    if (idx < 0 || idx >= ranges.length) return;
    setCurrent(idx);
    applyHighlights(idx);
    const startEl = ranges[idx].startContainer.parentElement
      ?? (ranges[idx].startContainer as Element | null);
    startEl?.scrollIntoView({ block: 'center' });
  }, [applyHighlights]);

  const step = useCallback((dir: 1 | -1) => {
    const total = rangesRef.current.length;
    if (total === 0) return;
    const next = current < 0
      ? (dir > 0 ? 0 : total - 1)
      : (current + dir + total) % total;
    goTo(next);
  }, [current, goTo]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const optBtn = (active: boolean) => cn(
    'w-7 h-7 rounded-md flex items-center justify-center transition-colors',
    active
      ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-300 text-zinc-800')
      : (isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200')
  );

  const navBtn = 'w-7 h-7 rounded-md flex items-center justify-center transition-colors shrink-0 ' + (
    isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'
  );

  const inputCls = cn(
    'h-7 px-2 rounded-md border text-xs outline-none transition-colors w-full',
    isDarkMode
      ? 'border-zinc-600 bg-zinc-900 text-zinc-200 focus:border-blue-500 placeholder:text-zinc-600'
      : 'border-zinc-300 bg-white text-zinc-800 focus:border-blue-500 placeholder:text-zinc-400'
  );

  const countLabel = count.total === 0
    ? (query ? '无结果' : '')
    : current < 0 ? `${count.total}${count.capped ? '+' : ''}` : `${current + 1}/${count.total}${count.capped ? '+' : ''}`;

  return createPortal(
    <div
      ref={rootRef}
      className={cn(
        'fixed z-[70] w-[min(440px,92vw)] rounded-lg border shadow-xl p-1.5 flex items-center gap-1.5',
        isDarkMode ? 'border-zinc-600 bg-zinc-800/95 backdrop-blur-sm' : 'border-zinc-300 bg-white/95 backdrop-blur-sm'
      )}
      style={pos ?? { visibility: 'hidden', left: -9999, top: 0 }}
      role="search"
    >
      <div className="relative flex-1 min-w-0">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="在预览中查找"
          className={cn(inputCls, 'pr-16')}
        />
        <span
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none tabular-nums',
            isDarkMode ? 'text-zinc-500' : 'text-zinc-400'
          )}
        >
          {countLabel}
        </span>
      </div>
      <button onClick={() => setCaseSensitive(v => !v)} className={optBtn(caseSensitive)} title="区分大小写" aria-label="区分大小写">
        <CaseSensitive size={15} />
      </button>
      <button onClick={() => setWholeWord(v => !v)} className={optBtn(wholeWord)} title="全词匹配" aria-label="全词匹配">
        <WholeWord size={15} />
      </button>
      <button onClick={() => setRegexp(v => !v)} className={optBtn(regexp)} title="使用正则" aria-label="使用正则">
        <Regex size={15} />
      </button>
      <div className={cn('w-px h-5 shrink-0', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
      <button onClick={() => step(-1)} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title="上一个 (Shift+Enter)" aria-label="上一个匹配">
        <ArrowUp size={14} />
      </button>
      <button onClick={() => step(1)} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title="下一个 (Enter)" aria-label="下一个匹配">
        <ArrowDown size={14} />
      </button>
      <button onClick={onClose} className={navBtn} title="关闭 (Esc)" aria-label="关闭查找">
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}
