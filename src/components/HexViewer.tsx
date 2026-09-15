import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { readByteWindow, firstVisibleIndex } from '../lib/largeFile';

const LINE_H = 21;
const BYTES_PER_ROW = 16;
/** 与 LargeFileViewer 同理：字节行数 × 行高可能超出浏览器布局上限 */
const MAX_SCROLL_H = 16_000_000;
const REFETCH_DEBOUNCE_MS = 120;

/** ASCII 可打印区间之外的显示占位 */
const UNPRINTABLE = '·';

function hexByte(b: number): string {
  return b.toString(16).padStart(2, '0');
}

function asciiChar(b: number): string {
  return b >= 32 && b < 127 ? String.fromCharCode(b) : UNPRINTABLE;
}

interface ByteWindow {
  startRow: number;
  data: Uint8Array;
}

/**
 * 十六进制只读视图（大文件二进制判定后）：每行 16 字节（偏移 | hex 8+8 | ASCII），
 * 滚动条代理虚拟滚动，按可视行 3 倍预算向 Rust 读字节窗口。
 */
export function HexViewer({ path, size, isDarkMode }: { path: string; size: number; isDarkMode: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [win, setWin] = useState<ByteWindow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const seqRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const rows = Math.max(1, Math.ceil(viewportH / LINE_H));
  const totalRows = Math.ceil(size / BYTES_PER_ROW);
  const contentH = Math.min(totalRows * LINE_H, MAX_SCROLL_H);
  const maxScroll = Math.max(0, contentH - viewportH);
  const firstRow = firstVisibleIndex(scrollTop, maxScroll, totalRows, rows);

  useEffect(() => {
    if (size === 0) return;
    const covered = win && firstRow >= win.startRow
      && firstRow + rows <= win.startRow + Math.ceil(win.data.length / BYTES_PER_ROW);
    if (covered) return;
    const seq = ++seqRef.current;
    const startRow = Math.max(0, firstRow - rows);
    const rowCount = Math.max(rows * 3, 240);
    const timer = setTimeout(() => {
      readByteWindow(path, startRow * BYTES_PER_ROW, rowCount * BYTES_PER_ROW)
        .then(data => { if (seqRef.current === seq) setWin({ startRow, data }); })
        .catch(e => { if (seqRef.current === seq) setErr(String(e)); });
    }, REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [firstRow, path, rows, size, win]);

  const gutterCls = cn('w-20 shrink-0 pr-3 text-right select-none tabular-nums',
    isDarkMode ? 'text-zinc-600' : 'text-zinc-400');
  const rowStart = win ? win.startRow : firstRow;
  const renderRows = win ? Math.ceil(win.data.length / BYTES_PER_ROW) : rows;

  return (
    <div
      ref={scrollRef}
      className={cn('relative h-full overflow-auto font-mono text-[13px] leading-[21px]',
        isDarkMode ? 'bg-zinc-900 text-zinc-300' : 'bg-white text-zinc-800')}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
    >
      {err && <div className="px-6 py-4 text-xs text-red-500">{err}</div>}
      <div style={{ height: contentH }} />
      <div className={cn('sticky top-0', isDarkMode ? 'bg-zinc-900' : 'bg-white')}>
        {win && renderRows > 0 ? Array.from({ length: renderRows }, (_, i) => {
          const row = rowStart + i;
          if (row >= totalRows) return null;
          const offset = row * BYTES_PER_ROW;
          const lineBytes = win.data.subarray(i * BYTES_PER_ROW, Math.min((i + 1) * BYTES_PER_ROW, win.data.length));
          if (lineBytes.length === 0) return null;
          return (
            <div key={row} className="flex items-center whitespace-pre" style={{ height: LINE_H }}>
              <span className={gutterCls}>{offset.toString(16).padStart(8, '0')}</span>
              <span className="shrink-0 tracking-wider">
                {Array.from({ length: BYTES_PER_ROW }, (_, j) => (
                  <span key={j} className={cn(
                    j === 8 ? 'pl-2' : 'pl-1',
                    j < lineBytes.length ? (isDarkMode ? 'text-zinc-300' : 'text-zinc-700') : 'opacity-20',
                  )}>
                    {j < lineBytes.length ? hexByte(lineBytes[j]) : '00'}
                  </span>
                ))}
              </span>
              <span className={cn('pl-4 shrink-0 select-none', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
                |{Array.from(lineBytes, asciiChar).join('')}|
              </span>
            </div>
          );
        }) : size > 0 && !err ? (
          <div className={cn('px-6 py-4 text-xs', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>…</div>
        ) : null}
      </div>
    </div>
  );
}
