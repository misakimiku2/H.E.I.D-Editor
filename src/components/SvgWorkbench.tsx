import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';

/**
 * SVG 可视化编辑工作台：左侧源码编辑器（由 App 传入），右侧实时预览。
 * 预览经 blob URL 以 <img> 渲染——SVG 作为图片加载时内部脚本不执行、外部资源不加载，天然安全；
 * 预览支持滚轮缩放（以光标为锚）、拖拽平移、双击切换适应/原始尺寸；
 * 源码停顿 180ms 后刷新；窄屏（手机）自动上下堆叠。
 */
export const SvgWorkbench = React.memo<{
  /** 实时源码（标签页内容） */
  content: string;
  isDarkMode: boolean;
  /** 窄屏：预览堆叠在源码下方 */
  stacked?: boolean;
  /** 源码编辑器（App 的 renderEditor()，带全部既有接线） */
  children: React.ReactNode;
}>(({ content, isDarkMode, stacked, children }) => {
  const t = useT();

  /* 预览解析防抖：连续输入停顿 180ms 后才重新渲染（与 markdown 预览同策略） */
  const [rendered, setRendered] = useState(content);
  useEffect(() => {
    if (content === rendered) return;
    const id = setTimeout(() => setRendered(content), 180);
    return () => clearTimeout(id);
  }, [content, rendered]);

  /* 源码 → blob URL；旧 URL 在效果清理时回收，避免泄漏 */
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!rendered.trim()) { setUrl(''); setInvalid(false); return; }
    const blob = new Blob([rendered], { type: 'image/svg+xml' });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setInvalid(false);
    return () => URL.revokeObjectURL(u);
  }, [rendered]);

  /* ---- 预览缩放/平移（scale 0 = 适应面板；超过面板的 SVG 缩到面板内，小的保持原尺寸） ---- */
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const eff = scale || fitScale;
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  /* 适应面板：按 img 固有尺寸与面板可视区计算（上限 1——小图不放大，保持原始尺寸） */
  const fitToPane = useCallback(() => {
    const pane = paneRef.current;
    const img = pane?.querySelector('img');
    if (!pane || !img || !img.naturalWidth) return;
    const rect = pane.getBoundingClientRect();
    const fit = Math.min((rect.width - 24) / img.naturalWidth, (rect.height - 24) / img.naturalHeight, 1);
    setFitScale(Math.max(0.01, fit));
  }, []);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const from = scaleRef.current || fitScale;
      const next = Math.min(16, Math.max(0.02, from * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
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

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
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

  /* 透明区域棋盘格底（跟随主题） */
  const checker = useMemo(() => ({
    backgroundImage: isDarkMode
      ? 'conic-gradient(#27272a 0 25%, #3f3f46 0 50%, #27272a 0 75%, #3f3f46 0)'
      : 'conic-gradient(#e4e4e7 0 25%, #f4f4f5 0 50%, #e4e4e7 0 75%, #f4f4f5 0)',
    backgroundSize: '16px 16px',
  }), [isDarkMode]);

  const btn = cn(
    'px-1.5 py-0.5 rounded-md text-[11px] transition-colors',
    isDarkMode ? 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700' : 'bg-white/90 text-zinc-600 hover:bg-zinc-100',
  );

  return (
    <div className={cn('flex min-w-0 flex-1 overflow-hidden', stacked ? 'flex-col' : 'flex-row')}>
      <div className={cn('min-w-0 overflow-hidden', stacked ? 'h-1/2 shrink-0' : 'w-[55%] shrink-0')}>
        {children}
      </div>
      <div className={cn('shrink-0', stacked ? 'h-px w-full' : 'h-full w-px', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
      <div
        ref={paneRef}
        className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-3 select-none"
        style={{ ...checker, cursor: dragging ? 'grabbing' : 'grab' }}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={startDrag}
      >
        {url && !invalid ? (
          <img
            src={url}
            alt="SVG"
            draggable={false}
            onLoad={() => { fitToPane(); setOffset({ x: 0, y: 0 }); setScale(0); }}
            onError={() => setInvalid(true)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${eff})`,
              transformOrigin: 'center center',
              maxWidth: 'none',
              imageRendering: eff >= 3 ? 'pixelated' : 'auto',
              cursor: dragging ? 'grabbing' : 'grab',
              userSelect: 'none',
            }}
          />
        ) : (
          <div className={cn(
            'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-4 text-xs',
            isDarkMode ? 'border-zinc-600 text-zinc-500' : 'border-zinc-300 text-zinc-400',
          )}>
            <ImageOff size={18} />
            <span>{invalid ? t('svg.invalid') : t('svg.empty')}</span>
          </div>
        )}
        {/* 缩放工具条（右下角）：百分比 + 适应面板 + 原始尺寸 */}
        {url && !invalid && (
          <div
            className={cn('absolute bottom-2 right-2 flex items-center gap-1 rounded-lg border p-1 shadow-lg',
              isDarkMode ? 'border-zinc-600/60 bg-zinc-800/90' : 'border-zinc-200 bg-white/90')}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <span className={cn('px-1 text-[11px] tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
              {Math.round(eff * 100)}%
            </span>
            <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScale(0); }}>{t('image.viewerFit')}</button>
            <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScale(1); }}>{t('image.viewerOriginal')}</button>
          </div>
        )}
      </div>
    </div>
  );
});

SvgWorkbench.displayName = 'SvgWorkbench';
