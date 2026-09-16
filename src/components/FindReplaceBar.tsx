import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import {
  ArrowDown, ArrowUp, CaseSensitive, ChevronDown, Regex, Replace, ReplaceAll,
  WholeWord, X, Hash,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { clampBarPosition } from '../lib/position';
import { setFindMatchesEffect } from '../lib/editorSearch';
import {
  findMatches, matchAtSelection, nextMatchIndex, prevMatchIndex,
  replaceAllInText, replacementFor, RESCAN_DOC_LIMIT, type MatchRange, type SearchOptions,
} from '../lib/searchCore';
import type { PointerPos } from '../hooks/useLastPointer';
import { useT } from '../lib/i18nContext';

export interface FindReplaceBarProps {
  /** 取当前编辑器视图（由 CodeEditor 提供 viewReadyRef 的读取器） */
  getView: () => EditorView | null;
  isDarkMode: boolean;
  /** 初始展开替换行（Ctrl+H 打开） */
  showReplace: boolean;
  /** 初始为跳转到行模式（Ctrl+G 打开） */
  gotoMode: boolean;
  /** 编辑器可编辑时才提供替换（只读标签仅查找与跳转） */
  canReplace: boolean;
  /** 弹出定位：打开瞬间的指针位置（不跟随） */
  getPointer?: () => PointerPos;
  /** 订阅编辑器视图更新；返回退订函数。由 CodeEditor 提供（挂在根配置里，reconfigure 后依然有效） */
  subscribeViewUpdate?: (fn: (update: ViewUpdate) => void) => () => void;
  onClose: () => void;
}

interface MatchState {
  matches: MatchRange[];
  capped: boolean;
  error: string | null;
}

/**
 * 查找 / 替换 / 跳转到行浮层（三端统一自绘，不使用 CodeMirror 官方面板）：
 * - 计数与高亮经 setFindMatchesEffect 下发给 editorSearch 扩展；
 * - 导航在匹配列表上循环回绕，替换支持正则 $1 引用；
 * - 手机端为近全宽紧凑布局，触控目标 ≥28px。
 */
export function FindReplaceBar({ getView, isDarkMode, showReplace, gotoMode, canReplace, getPointer, subscribeViewUpdate, onClose }: FindReplaceBarProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(showReplace && canReplace);
  const [gotoOpen, setGotoOpen] = useState(gotoMode);
  const [gotoLineText, setGotoLineText] = useState('');
  const [count, setCount] = useState({ total: 0, capped: false });
  const [current, setCurrent] = useState(0);
  const matchStateRef = useRef<MatchState>({ matches: [], capped: false, error: null });
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const gotoInputRef = useRef<HTMLInputElement | null>(null);
  /* 弹出定位：测量自身尺寸后按指针位置钳制（仅弹出时计算一次，不跟随） */
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

  const optionsRef = useRef<SearchOptions>({ query: '', caseSensitive: false, regexp: false, wholeWord: false });
  optionsRef.current = { query, caseSensitive, regexp, wholeWord };

  /** 计算当前匹配下标：选区恰为某匹配则即其下标，否则取光标后的下一个 */
  const computeCurrent = useCallback((matches: MatchRange[]): number => {
    const view = getView();
    if (!view || matches.length === 0) return 0;
    const sel = view.state.selection.main;
    const at = matchAtSelection(matches, sel.from, sel.to);
    if (at >= 0) return at;
    return nextMatchIndex(matches, sel.head);
  }, [getView]);

  /** 全量重扫：更新计数、下发给高亮扩展 */
  const rescan = useCallback(() => {
    const view = getView();
    if (!view) return;
    const o = optionsRef.current;
    if (!o.query) {
      matchStateRef.current = { matches: [], capped: false, error: null };
      setCount({ total: 0, capped: false });
      view.dispatch({ effects: setFindMatchesEffect.of(null) });
      return;
    }
    const r = findMatches(view.state.doc.toString(), o);
    matchStateRef.current = r;
    setCount({ total: r.total, capped: r.capped });
    const cur = r.error ? 0 : computeCurrent(r.matches);
    setCurrent(cur);
    view.dispatch({ effects: setFindMatchesEffect.of({ matches: r.matches, current: cur }) });
  }, [computeCurrent, getView]);

  /* 查询条件变化 → 重扫 */
  useEffect(() => {
    rescan();
  }, [query, caseSensitive, regexp, wholeWord, rescan]);

  /* 打开即聚焦查找输入（跳行模式聚焦行号输入）。
     首帧浮层尚未测得位置时是 visibility:hidden，hidden 元素 focus() 静默无效，
     因此等 pos 就绪（浮层可见）后再聚焦 */
  useEffect(() => {
    if (!pos) return;
    (gotoOpen ? gotoInputRef : findInputRef).current?.focus();
    if (!gotoOpen) findInputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  /* 文档与选区变化跟随：文档变化重扫，纯选区移动仅更新当前下标。
     订阅经 CodeEditor 的视图更新分发（挂在根配置里）——早先用 StateEffect.appendConfig 追加监听器，
     会被 CM6 的 reconfigure 丢弃（本组件的 extensions 每次编辑都会重建），导致查找栏不再跟随文档。 */
  useEffect(() => {
    if (!subscribeViewUpdate) return;
    return subscribeViewUpdate((u) => {
      if (u.docChanged) {
        if (u.state.doc.length <= RESCAN_DOC_LIMIT) rescan();
        return;
      }
      if (u.selectionSet && matchStateRef.current.matches.length > 0) {
        const cur = computeCurrent(matchStateRef.current.matches);
        setCurrent(cur);
        u.view.dispatch({ effects: setFindMatchesEffect.of({ matches: matchStateRef.current.matches, current: cur }) });
      }
    });
  }, [rescan, computeCurrent, subscribeViewUpdate]);

  /** 把匹配列表选中并滚动到视野中央（保持查找栏焦点） */
  const goToMatch = useCallback((idx: number) => {
    const view = getView();
    const { matches } = matchStateRef.current;
    if (!view || idx < 0 || idx >= matches.length) return;
    const m = matches[idx];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
    });
    setCurrent(idx);
    view.dispatch({ effects: setFindMatchesEffect.of({ matches, current: idx }) });
  }, [getView]);

  const goNext = useCallback(() => {
    const { matches } = matchStateRef.current;
    if (matches.length === 0) return;
    const view = getView();
    if (!view) return;
    const sel = view.state.selection.main;
    const at = matchAtSelection(matches, sel.from, sel.to);
    const idx = at >= 0 ? (at + 1) % matches.length : nextMatchIndex(matches, sel.head);
    goToMatch(idx);
  }, [getView, goToMatch]);

  const goPrev = useCallback(() => {
    const { matches } = matchStateRef.current;
    if (matches.length === 0) return;
    const view = getView();
    if (!view) return;
    const sel = view.state.selection.main;
    const at = matchAtSelection(matches, sel.from, sel.to);
    const idx = at >= 0 ? (at - 1 + matches.length) % matches.length : prevMatchIndex(matches, sel.head);
    goToMatch(idx);
  }, [getView, goToMatch]);

  /** 替换当前项：选区恰好命中才替换，否则先定位到下一个匹配 */
  const replaceCurrent = useCallback(() => {
    const view = getView();
    if (!view) return;
    const { matches } = matchStateRef.current;
    const sel = view.state.selection.main;
    const at = matchAtSelection(matches, sel.from, sel.to);
    if (at < 0) {
      goNext();
      return;
    }
    const m = matches[at];
    const insert = replacementFor(view.state.doc.toString(), m, optionsRef.current, replaceText);
    view.dispatch({
      changes: { from: m.from, to: m.to, insert },
      selection: { anchor: m.from + insert.length },
    });
  }, [getView, goNext, replaceText]);

  const replaceAll = useCallback(() => {
    const view = getView();
    if (!view) return;
    if (matchStateRef.current.error) return;
    const text = view.state.doc.toString();
    const insert = replaceAllInText(text, optionsRef.current, replaceText);
    if (insert === text) return;
    view.dispatch({ changes: { from: 0, to: text.length, insert } });
  }, [getView, replaceText]);

  const jumpToLine = useCallback(() => {
    const view = getView();
    if (!view) return;
    const n = parseInt(gotoLineText, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const line = view.state.doc.line(Math.min(n, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
    onClose();
  }, [getView, gotoLineText, onClose]);

  const close = useCallback(() => {
    const view = getView();
    if (view) view.dispatch({ effects: setFindMatchesEffect.of(null) });
    view?.focus();
    onClose();
  }, [getView, onClose]);

  const onKeyDown = (e: React.KeyboardEvent, field: 'find' | 'replace' | 'goto') => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (field === 'find') e.shiftKey ? goPrev() : goNext();
      else if (field === 'replace') replaceCurrent();
      else jumpToLine();
    }
  };

  const optBtn = (active: boolean) => cn(
    'w-7 h-7 rounded-md flex items-center justify-center transition-colors',
    active
      ? (isDarkMode ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-300 text-zinc-800')
      : (isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200')
  );

  /* 输入框毛玻璃：半透明底 + 背景模糊，聚焦时略微加深保证可读性 */
  const inputCls = cn(
    'h-7 px-2 rounded-md border text-xs outline-none transition-colors w-full backdrop-blur-md',
    isDarkMode
      ? 'border-zinc-600 bg-zinc-900/45 text-zinc-200 focus:border-blue-500 focus:bg-zinc-900/70 placeholder:text-zinc-600'
      : 'border-zinc-300 bg-white/55 text-zinc-800 focus:border-blue-500 focus:bg-white/85 placeholder:text-zinc-400'
  );

  const navBtn = 'w-7 h-7 rounded-md flex items-center justify-center transition-colors shrink-0 ' + (
    isDarkMode ? 'text-zinc-400 hover:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-200'
  );

  const countLabel = matchStateRef.current.error
    ? t('find.invalidRegex')
    : count.total === 0
      ? (query ? t('find.noResults') : '')
      : count.capped
        ? `${current + 1}/${matchStateRef.current.matches.length} · ${t('find.matchTotal', { total: count.total })}`
        : `${current + 1}/${count.total}`;

  return createPortal(
    <div
      ref={rootRef}
      className={cn(
        'fixed z-[70] w-[min(540px,92vw)] rounded-lg border shadow-xl p-1.5 flex flex-col gap-1.5',
        isDarkMode ? 'border-zinc-600 bg-zinc-800/95 backdrop-blur-sm' : 'border-zinc-300 bg-white/95 backdrop-blur-sm'
      )}
      style={pos ?? { visibility: 'hidden', left: -9999, top: 0 }}
      role="search"
    >
      {/* 查找行 */}
      <div className="flex items-center gap-1.5">
        {canReplace && (
          <button
            onClick={() => setReplaceOpen(v => !v)}
            className={navBtn}
            title={replaceOpen ? t('find.collapseReplace') : t('find.expandReplace')}
            aria-label={replaceOpen ? t('find.collapseReplace') : t('find.expandReplace')}
          >
            <ChevronDown size={14} className={cn('transition-transform', replaceOpen && 'rotate-180')} />
          </button>
        )}
        <div className="relative flex-1 min-w-0">
          <input
            ref={findInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => onKeyDown(e, 'find')}
            placeholder={t('find.placeholderFind')}
            className={cn(inputCls, 'pr-16')}
          />
          <span
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none tabular-nums',
              matchStateRef.current.error ? 'text-red-500' : (isDarkMode ? 'text-zinc-500' : 'text-zinc-400')
            )}
          >
            {countLabel}
          </span>
        </div>
        <button onClick={() => setCaseSensitive(v => !v)} className={optBtn(caseSensitive)} title={t('find.caseSensitive')} aria-label={t('find.caseSensitive')}>
          <CaseSensitive size={15} />
        </button>
        <button onClick={() => setWholeWord(v => !v)} className={optBtn(wholeWord)} title={t('find.wholeWord')} aria-label={t('find.wholeWord')}>
          <WholeWord size={15} />
        </button>
        <button onClick={() => setRegexp(v => !v)} className={optBtn(regexp)} title={t('find.useRegex')} aria-label={t('find.useRegex')}>
          <Regex size={15} />
        </button>
        <div className={cn('w-px h-5 shrink-0', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
        <button onClick={goPrev} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.prevTip')} aria-label={t('find.prevMatch')}>
          <ArrowUp size={14} />
        </button>
        <button onClick={goNext} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.nextTip')} aria-label={t('find.nextMatch')}>
          <ArrowDown size={14} />
        </button>
        <button onClick={close} className={navBtn} title={t('find.closeTip')} aria-label={t('find.closeFind')}>
          <X size={14} />
        </button>
      </div>

      {/* 替换行 */}
      {replaceOpen && (
        <div className="flex items-center gap-1.5">
          <div className="w-7 shrink-0" />
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={(e) => onKeyDown(e, 'replace')}
            placeholder={t('find.placeholderReplace')}
            className={inputCls}
          />
          <div className={cn('w-px h-5 shrink-0', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
          <button onClick={replaceCurrent} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.replaceTip')} aria-label={t('find.replaceCurrent')}>
            <Replace size={15} />
          </button>
          <button onClick={replaceAll} disabled={!count.total} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.replaceAll')} aria-label={t('find.replaceAll')}>
            <ReplaceAll size={15} />
          </button>
          <div className="w-14 shrink-0" />
        </div>
      )}

      {/* 跳转到行 */}
      {gotoOpen && (
        <div className="flex items-center gap-1.5">
          <div className="w-7 shrink-0 flex justify-center">
            <Hash size={13} className={isDarkMode ? 'text-zinc-500' : 'text-zinc-400'} />
          </div>
          <input
            ref={gotoInputRef}
            value={gotoLineText}
            onChange={(e) => setGotoLineText(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => onKeyDown(e, 'goto')}
            placeholder={t('find.placeholderGoto')}
            className={inputCls}
            inputMode="numeric"
          />
          <button onClick={jumpToLine} disabled={!gotoLineText} className={cn(navBtn, 'disabled:opacity-40')} title={t('find.gotoTip')} aria-label={t('find.gotoLine')}>
            <ArrowDown size={14} />
          </button>
          <div className="w-[86px] shrink-0" />
        </div>
      )}
    </div>,
    document.body,
  );
}
