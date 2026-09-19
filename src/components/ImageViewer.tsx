import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { usePinchZoom } from '../hooks/usePinchZoom';

/** 字节数 → 展示文本（B / KB / MB） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 图片查看器：预览内点击图片与文件树打开图片文件共用。
 * 初始尺寸：图片大于窗口时适应窗口，小于窗口时按原始尺寸显示；
 * 滚轮缩放（以光标为锚），拖拽平移，双击/按钮切 1:1 原始尺寸与适应窗口，Esc/点击空白关闭。
 * 底部信息栏：文件名（加粗加大）+ 像素尺寸 + 文件大小。
 */
export function ImageViewer({ src, alt, isDarkMode, onClose }: { src: string; alt: string; isDarkMode: boolean; onClose: () => void }) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0); /* 0 = 适应窗口 */
  const [fitScale, setFitScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);
  const scaleRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  /* 图片信息（底部信息栏）：像素尺寸取自加载结果，文件大小经 blob 尽力获取（拿不到就隐藏） */
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);

  const eff = scale || fitScale;
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  /* 触屏：单指平移 + 双指捏合缩放（锚点=上一事件双指中点，与滚轮锚点数学同源） */
  const { bind: bindPinch } = usePinchZoom();
  const pinchBind = bindPinch({
    onPan: (dx, dy) => setOffset(o => ({ x: o.x + dx, y: o.y + dy })),
    onPinch: (ratio, mx, my, mdx, mdy) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const from = scaleRef.current || fitScale;
      const next = Math.min(8, Math.max(0.05, from * ratio));
      const f = next / from;
      const ax = mx - mdx;
      const ay = my - mdy;
      setOffset(o => ({
        x: (ax - cx) - (ax - cx - o.x) * f + mdx,
        y: (ay - cy) - (ay - cy - o.y) * f + mdy,
      }));
      setScaleAndRef(next);
      movedRef.current = true;
    },
    onMoved: () => { movedRef.current = true; },
  });

  useEffect(() => {
    let alive = true;
    setBytes(null);
    (async () => {
      try {
        const r = await fetch(src);
        const b = await r.blob();
        if (alive) setBytes(b.size);
      } catch { /* 跨域等取不到大小时不显示该项 */ }
    })();
    return () => { alive = false; };
  }, [src]);

  /* 滚轮缩放（以光标为锚）：下载到 wrap 层并阻止页面滚动 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const from = scaleRef.current || fitScale;
      const next = Math.min(8, Math.max(0.05, from * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const f = next / from;
      setOffset(o => ({
        x: (e.clientX - cx) - (e.clientX - cx - o.x) * f,
        y: (e.clientY - cy) - (e.clientY - cy - o.y) * f,
      }));
      setScale(next);
      scaleRef.current = next;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fitScale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setScaleAndRef = useCallback((v: number) => { setScale(v); scaleRef.current = v; }, []);
  const fitToWindow = useCallback(() => { setScaleAndRef(0); setOffset({ x: 0, y: 0 }); }, [setScaleAndRef]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    movedRef.current = false;
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) movedRef.current = true;
      setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const btn = cn(
    'px-2 py-1 rounded-md text-xs transition-colors pointer-coarse:min-h-[44px] pointer-coarse:px-3.5 pointer-coarse:text-sm',
    isDarkMode ? 'bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700' : 'bg-white/85 text-zinc-700 hover:bg-zinc-200',
  );

  return (
    <div
      ref={wrapRef}
      className={cn(
        'fixed inset-0 z-[200] flex items-center justify-center select-none backdrop-blur-2xl',
        isDarkMode ? 'bg-zinc-900/60' : 'bg-white/60',
      )}
      onClick={() => { if (!movedRef.current) onClose(); }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={startDrag}
      {...pinchBind}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth <= 0) return;
          const w = window.innerWidth;
          const h = window.innerHeight;
          setFitScale(Math.min((w * 0.9) / img.naturalWidth, (h * 0.9) / img.naturalHeight));
          /* 大于窗口 → 适应窗口（scale 0）；小于窗口 → 原始尺寸（100%） */
          if (img.naturalWidth <= w && img.naturalHeight <= h) setScaleAndRef(1);
          setDims({ w: img.naturalWidth, h: img.naturalHeight });
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); setOffset({ x: 0, y: 0 }); setScaleAndRef(scaleRef.current === 1 ? 0 : 1); }}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${eff})`,
          transformOrigin: 'center center',
          maxWidth: scale ? 'none' : '90vw',
          maxHeight: scale ? 'none' : '90vh',
          imageRendering: eff >= 3 ? 'pixelated' : 'auto',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      />
      <div
        className={cn('fixed top-3 right-3 flex items-center gap-1.5 rounded-lg p-1.5 border shadow-xl',
          isDarkMode ? 'bg-zinc-800 border-zinc-600/60' : 'bg-white border-zinc-200')}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className={cn('text-xs px-1 tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
          {Math.round(eff * 100)}%
        </span>
        {scale === 1 ? (
          <button className={btn} onClick={fitToWindow}>{t('image.viewerFit')}</button>
        ) : (
          <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScaleAndRef(1); }}>{t('image.viewerOriginal')}</button>
        )}
        <button className={btn} onClick={onClose} title={t('image.viewerClose')}>✕</button>
      </div>
      {(alt || dims) && (
        <div className={cn(
          'fixed bottom-3 left-1/2 -translate-x-1/2 max-w-[86vw] flex items-center gap-3 rounded-lg px-3.5 py-2 border shadow-xl',
          isDarkMode ? 'bg-zinc-800 border-zinc-600/60' : 'bg-white border-zinc-200',
        )}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        >
          {alt && (
            <span className={cn('truncate font-semibold text-sm', isDarkMode ? 'text-zinc-100' : 'text-zinc-800')}>
              {alt}
            </span>
          )}
          {dims && (
            <span className={cn('shrink-0 text-xs tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
              {dims.w} × {dims.h} px
            </span>
          )}
          {bytes != null && (
            <span className={cn('shrink-0 text-xs tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
              {formatBytes(bytes)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
