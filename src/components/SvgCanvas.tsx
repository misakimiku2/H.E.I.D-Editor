/**
 * SVG 编辑画布：sanitize 后的渲染副本内联挂载，hover 高亮、点选、拖拽移动。
 * 安全是 sanitize 层的事（svgSanitize.ts），这里只管交互：
 * - 中键拖动 = 平移画布（任意位置，含元素上方），滚轮以光标为锚缩放，双击适应/原始尺寸；
 * - 左键拖元素 = 移动（拖动过程只改渲染副本，松手才提交一次文本补丁），左键点空白 = 取消选中；
 * - 选中框/悬停轮廓用屏幕坐标覆盖层（getBoundingClientRect），随缩放平移重算；
 * - 键盘：Delete 删除选中，方向键按 SVG 用户单位微调（Shift ×10）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { getIntrinsicSize, parseSvg, type SvgParseResult } from '../lib/svgParse';
import { createRenderCopy, HED_IDX_ATTR } from '../lib/svgSanitize';
import { applyTranslate } from '../lib/svgWrite';

const CANVAS_FALLBACK = { width: 300, height: 150 };

export const SvgCanvas = React.memo<{
  parsed: SvgParseResult | null;
  isDarkMode: boolean;
  selectedIdx: number | null;
  onSelect: (idx: number | null) => void;
  onCommitMove: (idx: number, dx: number, dy: number) => void;
  onDelete: (idx: number) => void;
}>(({ parsed, isDarkMode, selectedIdx, onSelect, onCommitMove, onDelete }) => {
  const t = useT();

  /* ---- 渲染副本挂载（parsed 更换即整体重挂；副本节点永不写回源码） ---- */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>(CANVAS_FALLBACK);
  const findNode = useCallback((idx: number) =>
    hostRef.current?.querySelector(`[${HED_IDX_ATTR}="${idx}"]`) as SVGElement | null, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!parsed) return;
    const root = createRenderCopy(parsed);
    const intrinsic = getIntrinsicSize(root) ?? CANVAS_FALLBACK;
    root.setAttribute('width', String(intrinsic.width));
    root.setAttribute('height', String(intrinsic.height));
    host.appendChild(root);
    host.style.width = `${intrinsic.width}px`;
    host.style.height = `${intrinsic.height}px`;
    setSize(intrinsic);
  }, [parsed]);

  /* ---- 缩放 / 平移（scale 0 = 适应面板） ---- */
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(0);
  const eff = scale || fitScale;
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  const fitToPane = useCallback(() => {
    const pane = paneRef.current;
    if (!pane || !size.width) return;
    const rect = pane.getBoundingClientRect();
    const fit = Math.min((rect.width - 48) / size.width, (rect.height - 48) / size.height, 1);
    setFitScale(Math.max(0.01, fit));
  }, [size]);

  useEffect(() => { fitToPane(); }, [fitToPane]);

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

  /* ---- 背景平移 / 元素拖拽（pointer events，触屏同样成立） ---- */
  const gestureRef = useRef<
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'drag'; idx: number; sx: number; sy: number; moved: boolean }
    | null
  >(null);
  const [panning, setPanning] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const lastDeltaRef = useRef({ x: 0, y: 0 });

  const hitIdx = (target: EventTarget | null): number | null => {
    const el = (target as Element | null)?.closest?.(`[${HED_IDX_ATTR}]`) as Element | null;
    if (!el) return null;
    const v = Number(el.getAttribute(HED_IDX_ATTR));
    return Number.isInteger(v) ? v : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    /* 中键：任意位置平移画布（阻止浏览器中键自动滚动） */
    if (e.button === 1) {
      e.preventDefault();
      gestureRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
      setPanning(true);
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 合成事件无有效 pointerId */ }
      return;
    }
    if (e.button !== 0) return;
    const idx = hitIdx(e.target);
    if (idx !== null && idx > 0) {
      /* 左键元素：选中并准备拖拽（未过位移阈值前不算移动） */
      onSelect(idx);
      gestureRef.current = { kind: 'drag', idx, sx: e.clientX, sy: e.clientY, moved: false };
      setDragIdx(idx);
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 合成事件无有效 pointerId */ }
    } else {
      /* 左键空白：取消选中（平移已让给中键） */
      onSelect(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.kind === 'pan') {
      setOffset({ x: g.ox + (e.clientX - g.sx), y: g.oy + (e.clientY - g.sy) });
      return;
    }
    const dxs = e.clientX - g.sx;
    const dys = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dxs, dys) < 3) return;
    g.moved = true;
    const node = findNode(g.idx);
    if (!node) return;
    /* 增量并进前导 translate：屏幕位移换算为 SVG 用户单位 */
    const ddx = (e.clientX - g.sx) / eff - lastDeltaRef.current.x;
    const ddy = (e.clientY - g.sy) / eff - lastDeltaRef.current.y;
    lastDeltaRef.current = { x: (e.clientX - g.sx) / eff, y: (e.clientY - g.sy) / eff };
    applyTranslate(node, ddx, ddy);
  };

  const endGesture = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    lastDeltaRef.current = { x: 0, y: 0 };
    setPanning(false);
    setDragIdx(null);
    if (g?.kind === 'drag' && g.moved) {
      onCommitMove(g.idx, (e.clientX - g.sx) / eff, (e.clientY - g.sy) / eff);
    }
  };

  /* ---- 悬停轮廓 / 选中框（屏幕坐标覆盖层） ---- */
  type Rect = { left: number; top: number; width: number; height: number };
  const [hoverRect, setHoverRect] = useState<Rect | null>(null);
  const [selRect, setSelRect] = useState<Rect | null>(null);

  const rectInPane = (node: Element | null): Rect | null => {
    if (!node) return null;
    const pane = paneRef.current;
    if (!pane) return null;
    const pr = pane.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { left: r.left - pr.left, top: r.top - pr.top, width: r.width, height: r.height };
  };

  useEffect(() => {
    const host = hostRef.current;

    const onOver = (e: Event) => {
      if (gestureRef.current) return;
      const idx = hitIdx(e.target);
      const node = idx !== null && idx > 0 ? findNode(idx) : null;
      setHoverRect(node ? rectInPane(node) : null);
    };
    const onLeave = () => setHoverRect(null);
    host?.addEventListener('mouseover', onOver);
    host?.addEventListener('mouseleave', onLeave);
    return () => {
      host?.removeEventListener('mouseover', onOver);
      host?.removeEventListener('mouseleave', onLeave);
    };
  }, [findNode]);

  useEffect(() => {
    const recalc = () => {
      setSelRect(selectedIdx !== null ? rectInPane(findNode(selectedIdx)) : null);
    };
    recalc();
    /* 拖拽/平移/缩放中每帧重算（覆盖层是屏幕坐标） */
    const pane = paneRef.current;
    if (!pane) return;
    const onMove = () => { if (gestureRef.current) recalc(); };
    pane.addEventListener('pointermove', onMove);
    return () => pane.removeEventListener('pointermove', onMove);
  }, [selectedIdx, findNode, offset, eff, parsed]);

  /* ---- 键盘：删除 / 方向键微调 ---- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onSelect(null);
      return;
    }
    if (selectedIdx === null) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDelete(selectedIdx);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const d = deltas[e.key];
    if (d) {
      e.preventDefault();
      onCommitMove(selectedIdx, d[0], d[1]);
    }
  };

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
    <div
      ref={paneRef}
      tabIndex={0}
      data-svg-canvas
      title={t('svg.panHint')}
      className={cn('relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-3 select-none outline-none')}
      style={{ ...checker, cursor: panning ? 'grabbing' : 'default', touchAction: 'none' }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onDoubleClick={() => { setOffset({ x: 0, y: 0 }); setScale(scale === 0 ? 1 : 0); scaleRef.current = scale === 0 ? 1 : 0; }}
      onKeyDown={onKeyDown}
    >
      {parsed ? (
        <>
          <div
            className="relative shrink-0"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${eff})`, transformOrigin: 'center center' }}
          >
            <div ref={hostRef} className={dragIdx !== null ? 'opacity-90' : undefined} />
          </div>
          {hoverRect && hoverRect !== selRect && (
            <div
              className="pointer-events-none absolute rounded-sm border border-dashed"
              style={{
                left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height,
                borderColor: isDarkMode ? '#71717a' : '#a1a1aa',
              }}
            />
          )}
          {selRect && (
            <div
              className="pointer-events-none absolute rounded-sm border-2"
              style={{ left: selRect.left - 1, top: selRect.top - 1, width: selRect.width + 2, height: selRect.height + 2, borderColor: '#38bdf8' }}
            />
          )}
        </>
      ) : (
        <div className={cn(
          'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-4 text-xs',
          isDarkMode ? 'border-zinc-600 text-zinc-500' : 'border-zinc-300 text-zinc-400',
        )}>
          <ImageOff size={18} />
          <span>{t('svg.invalid')}</span>
        </div>
      )}
      {/* 缩放工具条（右下角） */}
      {parsed && (
        <div
          className={cn('absolute bottom-2 right-2 flex items-center gap-1 rounded-lg border p-1 shadow-lg',
            isDarkMode ? 'border-zinc-600/60 bg-zinc-800/90' : 'border-zinc-200 bg-white/90')}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        >
          <span className={cn('px-1 text-[11px] tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
            {Math.round(eff * 100)}%
          </span>
          <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScale(0); scaleRef.current = 0; }}>{t('image.viewerFit')}</button>
          <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScale(1); scaleRef.current = 1; }}>{t('image.viewerOriginal')}</button>
        </div>
      )}
    </div>
  );
});

SvgCanvas.displayName = 'SvgCanvas';
