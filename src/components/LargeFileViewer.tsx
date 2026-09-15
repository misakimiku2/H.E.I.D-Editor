import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { encodingLabel } from '../lib/encoding';
import {
  probeLargeFile, readLineWindow, formatBytes, parseFileTooLarge, firstVisibleIndex,
  type LargeFileInfo, type LineWindow,
} from '../lib/largeFile';
import { HexViewer } from './HexViewer';

/** 等宽行高（px）：行渲染与滚动映射共用 */
const LINE_H = 21;
/** 滚动代理高度上限：500MB 文本数百万行 × 行高会超出浏览器布局上限，
    超限时滚动条按比例映射行号（同类编辑器处理超大文档的通行做法） */
const MAX_SCROLL_H = 16_000_000;
/** 换窗去抖：快速滚动时只在停顿后发一次窗口请求 */
const REFETCH_DEBOUNCE_MS = 120;

/**
 * 大文件只读分块预览（第二层 32~512MB）：内存中永远只有可视窗口。
 * probe 一次拿行数/编码/二进制判定；滚动条代理 + sticky 行块做虚拟滚动，
 * 滚动离开当前窗口舒适区即向 Rust 换窗（带去抖与请求序号防竞态）。
 * 二进制文件转 HexViewer；文本行支持「提取到新标签页」编辑出口。
 */
export function LargeFileViewer({
  path, name, isDarkMode, onExtract,
}: {
  path: string;
  name: string;
  isDarkMode: boolean;
  onExtract: (text: string, fromLine: number, toLine: number, sourceName: string) => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<LargeFileInfo | null>(null);
  const [win, setWin] = useState<LineWindow | null>(null);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const [jumpInput, setJumpInput] = useState('');
  /* 窗口请求序号：竞态下只接受最新响应 */
  const seqRef = useRef(0);

  const probe = useCallback(async () => {
    seqRef.current += 1;
    setProbeErr(null);
    setInfo(null);
    setWin(null);
    try {
      const r = await probeLargeFile(path);
      setInfo(r);
    } catch (e) {
      setProbeErr(String(e));
    }
  }, [path]);

  useEffect(() => { void probe(); }, [probe]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const rows = Math.max(1, Math.ceil(viewportH / LINE_H));
  const totalLines = info?.totalLines ?? 0;
  const contentH = Math.min(totalLines * LINE_H, MAX_SCROLL_H);
  const maxScroll = Math.max(0, contentH - viewportH);
  const firstLine = firstVisibleIndex(scrollTop, maxScroll, totalLines, rows);

  /* 换窗：可视区滑出当前窗口即换（去抖合并快速滚动期间的连发请求） */
  useEffect(() => {
    if (!info || info.binary || totalLines === 0) return;
    const covered = win && firstLine >= win.startLine
      && firstLine + rows <= win.startLine + win.lines.length;
    if (covered) return;
    const seq = ++seqRef.current;
    const start = Math.max(0, firstLine - rows);
    const count = Math.max(rows * 3, 300);
    const timer = setTimeout(() => {
      readLineWindow(path, start, count)
        .then(w => { if (seqRef.current === seq) setWin(w); })
        .catch(e => {
          const msg = String(e);
          if (seqRef.current !== seq) return;
          /* 尺寸变化（外部改写）或缓存失效：重新探测 */
          if (msg.includes('FILE_CHANGED') || msg.includes('NOT_PROBED')) {
            void probe();
          } else {
            setProbeErr(msg);
          }
        });
    }, REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [firstLine, info, path, probe, rows, totalLines, win]);

  const jumpToLine = useCallback(() => {
    const el = scrollRef.current;
    if (!el || totalLines === 0) return;
    const n = parseInt(jumpInput, 10);
    if (!Number.isFinite(n)) return;
    const target = Math.min(Math.max(1, n), totalLines) - 1;
    el.scrollTop = maxScroll * (target / Math.max(1, totalLines - rows));
  }, [jumpInput, maxScroll, rows, totalLines]);

  const extractWindow = useCallback(() => {
    if (!win || win.lines.length === 0) return;
    onExtract(win.lines.join('\n'), win.startLine + 1, win.startLine + win.lines.length, name);
  }, [name, onExtract, win]);

  if (probeErr) {
    const tooLarge = parseFileTooLarge(probeErr);
    return (
      <CenteredMessage isDarkMode={isDarkMode}>
        {tooLarge != null
          ? t('open.errTooLarge', { size: formatBytes(tooLarge), max: formatBytes(512 * 1024 * 1024) })
          : t('large.loadError', { msg: probeErr })}
        <button
          className={cn('mt-4 px-3 py-1.5 rounded-md text-xs transition-colors',
            isDarkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200' : 'bg-zinc-200 hover:bg-zinc-300 text-zinc-700')}
          onClick={() => void probe()}
        >
          {t('common.retry')}
        </button>
      </CenteredMessage>
    );
  }

  if (!info) {
    return <CenteredMessage isDarkMode={isDarkMode}>{t('large.probing')}</CenteredMessage>;
  }

  if (info.binary) {
    return <HexViewer path={path} size={info.sizeBytes} isDarkMode={isDarkMode} />;
  }

  const chip = cn(
    'shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium border',
    isDarkMode ? 'border-amber-500/40 text-amber-400 bg-amber-500/10' : 'border-amber-300 text-amber-600 bg-amber-50',
  );
  const toolbarText = cn('shrink-0 text-[11px] tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500');

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏：状态 chip + 文件信息 + 跳转行 + 提取片段 */}
      <div className={cn(
        'flex items-center gap-3 px-3 py-1.5 border-b shrink-0 overflow-x-auto',
        isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-zinc-100',
      )}>
        <span className={chip}>{t('large.readonlyChip')}</span>
        <span className={toolbarText}>{formatBytes(info.sizeBytes)}</span>
        <span className={toolbarText}>{t('large.totalLines', { n: info.totalLines.toLocaleString() })}</span>
        <span className={toolbarText}>{encodingLabel(info.encoding)}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          <input
            value={jumpInput}
            onChange={e => setJumpInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') jumpToLine(); }}
            placeholder={t('large.jumpPlaceholder')}
            className={cn(
              'w-28 px-2 py-1 rounded text-[11px] outline-none border',
              isDarkMode ? 'bg-zinc-900 border-zinc-600 text-zinc-200 placeholder-zinc-600 focus:border-zinc-500' : 'bg-white border-zinc-300 text-zinc-800 placeholder-zinc-400 focus:border-zinc-400',
            )}
            inputMode="numeric"
          />
          <button
            onClick={jumpToLine}
            title={t('find.gotoTip')}
            className={cn('px-2 py-1 rounded text-[11px] transition-colors shrink-0',
              isDarkMode ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' : 'bg-white hover:bg-zinc-200 text-zinc-600 border border-zinc-200')}
          >
            {t('find.gotoLine')}
          </button>
        </div>
        <button
          onClick={extractWindow}
          disabled={!win || win.lines.length === 0}
          className={cn('px-2.5 py-1 rounded text-[11px] font-medium transition-colors shrink-0 disabled:opacity-40',
            isDarkMode ? 'bg-blue-600/90 hover:bg-blue-600 text-white' : 'bg-blue-500 hover:bg-blue-600 text-white')}
          title={t('large.extractTip')}
        >
          {t('large.extract')}
        </button>
      </div>

      {/* 虚拟滚动：spacer 撑滚动条代理高度，sticky 行块贴视口顶渲染当前窗口 */}
      <div
        ref={scrollRef}
        className={cn('relative flex-1 min-h-0 overflow-auto', isDarkMode ? 'bg-zinc-900' : 'bg-white')}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: contentH }} />
        <div className={cn('sticky top-0 font-mono text-[13px] leading-[21px] whitespace-pre', isDarkMode ? 'bg-zinc-900' : 'bg-white')}>
          {win ? win.lines.map((text, i) => (
            <div key={win.startLine + i} className="flex items-center" style={{ height: LINE_H }}>
              <span className={cn('w-20 shrink-0 pr-3 text-right select-none tabular-nums',
                isDarkMode ? 'text-zinc-600' : 'text-zinc-400')}>
                {win.startLine + i + 1}
              </span>
              <span className="flex-1 min-w-0 truncate">{text}</span>
              {win.truncated[i] && (
                <span className={cn('shrink-0 pl-2 select-none', isDarkMode ? 'text-amber-500/70' : 'text-amber-500')}
                  title={t('large.truncatedTip')}>⋯</span>
              )}
            </div>
          )) : (
            <div className={cn('px-6 py-4 text-xs', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
              {t('large.loadingWindow')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CenteredMessage({ isDarkMode, children }: { isDarkMode: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('flex flex-col items-center justify-center h-full text-sm text-center px-8 gap-1',
      isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
      {children}
    </div>
  );
}
