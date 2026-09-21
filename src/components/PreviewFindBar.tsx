import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY, NARROW_QUERY } from '../lib/platform';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { clampBarPosition } from '../lib/position';
import { findMatches, type MatchRange, type SearchOptions } from '../lib/searchCore';
import type { PointerPos } from '../hooks/useLastPointer';
import { useT } from '../lib/i18nContext';

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
 * 手机端为贴窗口底缘的停靠条，控件分两行排布；桌面与平板仍是指针定位浮层。
 */
export function PreviewFindBar({ getContainer, content, isDarkMode, getPointer, onClose }: PreviewFindBarProps) {
  const t = useT();
  /* 手机端停靠形态：贴窗口底缘、按 --heid-kb 让位键盘（定位见 index.css 的 .heid-find-dock） */
  const docked = IS_ANDROID_APP && useMediaQuery(NARROW_QUERY);
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
    if (docked) return;
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = getPointerRef.current?.() ?? { x: -1, y: -1 };
    setPos(clampBarPosition(p.x, p.y, r.width, r.height));
  }, [docked]);

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
    setCount({ total: ranges.length, capped: result.total > ranges.length });
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
    IS_TOUCH_PRIMARY ? 'w-12 h-12' : 'w-7 h-7',
    'rounded-md flex items-center justify-center transition-colors shrink-0',
    active
      ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-300 text-zinc-800')
      : (isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200')
  );

  const navBtn = (IS_TOUCH_PRIMARY ? 'w-12 h-12 ' : 'w-7 h-7 ') + 'rounded-md flex items-center justify-center transition-colors shrink-0 ' + (
    isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'
  );

  /* 触屏字号 16px：低于 16px 会让 WebView 在聚焦时自动放大整页 */
  const inputCls = cn(
    IS_TOUCH_PRIMARY ? 'h-12 px-3 text-base' : 'h-7 px-2 text-xs',
    'rounded-md border outline-none transition-colors w-full min-w-0',
    isDarkMode
      ? 'border-zinc-600 bg-zinc-900 text-zinc-200 focus:border-blue-500 placeholder:text-zinc-600'
      : 'border-zinc-300 bg-white text-zinc-800 focus:border-blue-500 placeholder:text-zinc-400'
  );

  const countLabel = count.total === 0
    ? (query ? t('find.noResults') : '')
    : current < 0 ? `${count.total}${count.capped ? '+' : ''}` : `${current + 1}/${count.total}${count.capped ? '+' : ''}`;

  /* 行容器：触屏相邻按钮之间留足 8dp，避免命中区互相偷走 */
  const row = cn('flex items-center', IS_TOUCH_PRIMARY ? 'gap-2' : 'gap-1.5');

  const optionButtons = (
    <>
      <button onClick={() => setCaseSensitive(v => !v)} className={optBtn(caseSensitive)} title={t('find.caseSensitive')} aria-label={t('find.caseSensitive')}>
        <CaseSensitive size={15} />
      </button>
      <button onClick={() => setWholeWord(v => !v)} className={optBtn(wholeWord)} title={t('find.wholeWord')} aria-label={t('find.wholeWord')}>
        <WholeWord size={15} />
      </button>
      <button onClick={() => setRegexp(v => !v)} className={optBtn(regexp)} title={t('find.useRegex')} aria-label={t('find.useRegex')}>
        <Regex size={15} />
      </button>
    </>
  );

  const navButtons = (
    <>
      <button onClick={() => step(-1)} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.prevTip')} aria-label={t('find.prevMatch')}>
        <ArrowUp size={14} />
      </button>
      <button onClick={() => step(1)} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.nextTip')} aria-label={t('find.nextMatch')}>
        <ArrowDown size={14} />
      </button>
      <button onClick={onClose} className={navBtn} title={t('find.closeTip')} aria-label={t('find.closeFind')}>
        <X size={14} />
      </button>
    </>
  );

  const findInput = (countInside: boolean) => (
    <div className="relative flex-1 min-w-0">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('find.placeholderPreview')}
        className={cn(inputCls, countInside && 'pr-16')}
      />
      {countInside && (
        <span
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none tabular-nums',
            isDarkMode ? 'text-zinc-500' : 'text-zinc-400'
          )}
        >
          {countLabel}
        </span>
      )}
    </div>
  );

  const panel = (
    <div
      ref={rootRef}
      className={cn(
        'border shadow-xl',
        isDarkMode ? 'border-zinc-600 bg-zinc-800/95 backdrop-blur-sm' : 'border-zinc-300 bg-white/95 backdrop-blur-sm',
        docked
          ? 'heid-find-dock z-[70] rounded-none border-x-0 border-b-0 p-2 flex flex-col gap-2'
          : cn('fixed z-[70] w-[min(440px,92vw)] rounded-lg p-1.5 flex items-center', IS_TOUCH_PRIMARY ? 'gap-2' : 'gap-1.5')
      )}
      style={docked ? undefined : (pos ?? { visibility: 'hidden', left: -9999, top: 0 })}
      role="search"
    >
      {docked ? (
        <>
          <div className={row}>
            {findInput(false)}
            {navButtons}
          </div>
          <div className={row}>
            {optionButtons}
            <span
              className={cn(
                'flex-1 min-w-0 truncate text-right text-xs tabular-nums',
                isDarkMode ? 'text-zinc-400' : 'text-zinc-500'
              )}
            >
              {countLabel}
            </span>
          </div>
        </>
      ) : (
        <>
          {findInput(true)}
          {optionButtons}
          <div className={cn('w-px h-5 shrink-0', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
          {navButtons}
        </>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
