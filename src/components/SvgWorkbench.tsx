import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, MousePointerClick } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { parseSvg, type SvgParseResult } from '../lib/svgParse';
import { createRenderCopy } from '../lib/svgSanitize';
import { applyPatches, applyTranslate, deletePatch, elementPatch, setTranslate } from '../lib/svgWrite';
import { replaceColor } from '../lib/svgPalette';
import { loadSvgSplitRatio, saveSvgSplitRatio, splitRatioFromClientX } from '../lib/svgLayout';
import { usePinchZoom } from '../hooks/usePinchZoom';
import { SvgCanvas } from './SvgCanvas';
import { SvgInspector } from './SvgInspector';

/**
 * SVG 可视化工作台：左侧源码编辑器（由 App 传入），右侧预览或编辑画布。
 * - 预览（svgEdit=false）：现状不变——blob URL 以 <img> 渲染（脚本不执行，天然安全），
 *   滚轮以光标为锚缩放、中键拖动平移；触屏改为单指平移 + 双指捏合（锚点=双指中点），
 *   复位走右下角工具条；源码停顿 180ms 后刷新；
 * - 编辑（svgEdit=true）：sanitize 后的内联画布（SvgCanvas）+ 检查面板（SvgInspector）。
 *   编辑统一走「最新源码重新解析 → 权威树变更 → 单元素区间补丁」的手术式写回，
 *   撤销/保存/外部变更检测与手敲源码完全同链路；窄屏（手机）自动上下堆叠。
 */
export const SvgWorkbench = React.memo<{
  /** 实时源码（标签页内容） */
  content: string;
  isDarkMode: boolean;
  /** 窄屏：预览堆叠在源码下方 */
  stacked?: boolean;
  /** 源码编辑器（App 的 renderEditor()，带全部既有接线） */
  children: React.ReactNode;
  /** 可视化编辑模式（页签状态，App 持有） */
  svgEdit?: boolean;
  /** 切换编辑/预览（未提供则不显示切换按钮） */
  onToggleEdit?: () => void;
  /** 手术式写回的新源码（未提供则编辑入口只读展示） */
  onContentChange?: (v: string) => void;
  /** 导出 PNG 的文件名基础（标签页标题） */
  exportBase?: string;
}>(({ content, isDarkMode, stacked, children, svgEdit, onToggleEdit, onContentChange, exportBase = 'svg' }) => {
  const t = useT();

  /* 预览解析防抖：连续输入停顿 180ms 后才重新渲染（与 markdown 预览同策略） */
  const [rendered, setRendered] = useState(content);
  useEffect(() => {
    if (content === rendered) return;
    const id = setTimeout(() => setRendered(content), 180);
    return () => clearTimeout(id);
  }, [content, rendered]);

  /* ---- 编辑区宽度：右缘分隔条拖拽调整（释放持久化；手机堆叠布局固定不减） ---- */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSvgSplitRatio);
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  const splitDragRef = useRef<{ left: number; width: number } | null>(null);

  const startSplitResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || stacked) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    splitDragRef.current = { left: rect.left, width: rect.width };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件无有效 pointerId */ }
  };
  const moveSplitResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = splitDragRef.current;
    if (!s) return;
    setSplitRatio(splitRatioFromClientX(e.clientX, s.left, s.width));
  };
  const endSplitResize = () => {
    if (!splitDragRef.current) return;
    splitDragRef.current = null;
    saveSvgSplitRatio(splitRatioRef.current);
  };

  /* ---- 预览模式：<img> blob 渲染 + 缩放，平移 = 中键拖动 ---- */
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (svgEdit || !rendered.trim()) { setUrl(''); setInvalid(false); return; }
    const blob = new Blob([rendered], { type: 'image/svg+xml' });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setInvalid(false);
    return () => URL.revokeObjectURL(u);
  }, [rendered, svgEdit]);

  const paneRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(0);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const eff = scale || fitScale;
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  const fitToPane = useCallback(() => {
    const pane = paneRef.current;
    const img = pane?.querySelector('img');
    if (!pane || !img || !img.naturalWidth) return;
    const rect = pane.getBoundingClientRect();
    const fit = Math.min((rect.width - 24) / img.naturalWidth, (rect.height - 24) / img.naturalHeight, 1);
    setFitScale(Math.max(0.01, fit));
  }, []);

  useEffect(() => {
    if (svgEdit) return;
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
  }, [fitScale, svgEdit]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault(); /* 拦下浏览器中键自动滚动 */
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

  const setScaleAndRef = useCallback((v: number) => { setScale(v); scaleRef.current = v; }, []);

  /* 触屏：单指平移 + 双指捏合缩放替代中键平移与滚轮缩放（锚点数学与滚轮同源，
     只是锚点取双指中点而非光标） */
  const { bind: bindPinch } = usePinchZoom();
  const pinchBind = bindPinch({
    onPan: (dx, dy) => setOffset(o => ({ x: o.x + dx, y: o.y + dy })),
    onPinch: (ratio, mx, my, mdx, mdy) => {
      const rect = paneRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const from = scaleRef.current || fitScale;
      const next = Math.min(16, Math.max(0.02, from * ratio));
      const f = next / from;
      /* 以上一事件的中点为锚缩放，再并入中点位移（双指整体拖动即纯平移） */
      const ax = mx - mdx;
      const ay = my - mdy;
      setOffset(o => ({
        x: (ax - cx) - (ax - cx - o.x) * f + mdx,
        y: (ay - cy) - (ay - cy - o.y) * f + mdy,
      }));
      setScaleAndRef(next);
    },
  });

  /* ---- 编辑模式：解析（防抖后）+ 手术式提交管线 ---- */
  const parsed = useMemo<SvgParseResult | null>(() => (svgEdit ? parseSvg(rendered) : null), [rendered, svgEdit]);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (selected !== null && (!parsed || selected >= parsed.elements.length)) setSelected(null);
  }, [parsed, selected]);

  /* 提交一律基于最新 content 重新解析（防抖窗口内连点也安全），补丁最小化 */
  const commitMutate = useCallback((idx: number, mutate: (node: Element) => void) => {
    if (!onContentChange) return;
    const fresh = parseSvg(content);
    if (!fresh || idx <= 0 || idx >= fresh.elements.length) return;
    const el = fresh.elements[idx];
    mutate(el.node);
    onContentChange(applyPatches(content, [elementPatch(content, el)]));
  }, [content, onContentChange]);

  const commitDelete = useCallback((idx: number) => {
    if (!onContentChange) return;
    const fresh = parseSvg(content);
    if (!fresh || idx <= 0 || idx >= fresh.elements.length) return;
    const patch = deletePatch(content, fresh.elements[idx]);
    if (patch) onContentChange(applyPatches(content, [patch]));
  }, [content, onContentChange]);

  const commitReplaceColor = useCallback((from: string, to: string) => {
    if (!onContentChange) return;
    const fresh = parseSvg(content);
    if (!fresh) return;
    onContentChange(replaceColor(content, fresh, from, to));
  }, [content, onContentChange]);

  /* 导出源：sanitize 且不盖编辑器索引章的序列化文本 */
  const exportText = useMemo(() => {
    if (!parsed) return '';
    return new XMLSerializer().serializeToString(createRenderCopy(parsed, { stamp: false }));
  }, [parsed]);

  /* ---- 主题公共件 ---- */
  const checker = useMemo(() => ({
    backgroundImage: isDarkMode
      ? 'conic-gradient(#27272a 0 25%, #3f3f46 0 50%, #27272a 0 75%, #3f3f46 0)'
      : 'conic-gradient(#e4e4e7 0 25%, #f4f4f5 0 50%, #e4e4e7 0 75%, #f4f4f5 0)',
    backgroundSize: '16px 16px',
  }), [isDarkMode]);

  const btn = cn(
    'px-1.5 py-0.5 rounded-md text-[11px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:px-3.5 pointer-coarse:text-sm',
    isDarkMode ? 'bg-zinc-800/90 text-zinc-300 hover:bg-zinc-700' : 'bg-white/90 text-zinc-600 hover:bg-zinc-100',
  );

  /* 编辑/预览切换按钮（右上角悬浮）。触屏下它落在画布内，必须挡下 pointerdown，
     否则画布的捏合/平移会捕获指针、把这一下点击吞掉 */
  const toggleBtn = onToggleEdit && (
    <button
      type="button"
      className={cn('absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] shadow-sm transition-colors pointer-coarse:min-h-[48px] pointer-coarse:px-3 pointer-coarse:text-sm',
        svgEdit
          ? 'border-sky-500/60 bg-sky-500/15 text-sky-500 hover:bg-sky-500/25'
          : isDarkMode ? 'border-zinc-600/60 bg-zinc-800/90 text-zinc-400 hover:bg-zinc-700' : 'border-zinc-200 bg-white/90 text-zinc-500 hover:bg-zinc-100')}
      onClick={onToggleEdit}
      onPointerDown={(e) => { if (e.pointerType !== 'mouse') e.stopPropagation(); }}
      title={svgEdit ? t('common.preview') : t('svg.editMode')}
    >
      <MousePointerClick size={12} />
      {svgEdit ? t('common.preview') : t('svg.editMode')}
    </button>
  );

  return (
    <div ref={rootRef} className={cn('flex min-w-0 flex-1 overflow-hidden', stacked ? 'flex-col' : 'flex-row')}>
      <div
        className={cn('min-w-0 overflow-hidden', stacked ? 'h-1/2 shrink-0' : 'shrink-0')}
        style={stacked ? undefined : { width: `${splitRatio * 100}%` }}
      >
        {children}
      </div>

      {/* 编辑区|预览区 分隔条：桌面端为拖宽手柄（对齐侧栏模式），手机堆叠为普通分隔线 */}
      {stacked ? (
        <div className={cn('h-px w-full shrink-0', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
      ) : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('svg.resizeHint')}
          title={t('svg.resizeHint')}
          onPointerDown={startSplitResize}
          onPointerMove={moveSplitResize}
          onPointerUp={endSplitResize}
          onPointerCancel={endSplitResize}
          className="group relative w-1.5 shrink-0 cursor-col-resize touch-none pointer-coarse:w-3"
        >
          <div
            className={cn(
              'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-blue-500/50',
              isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200',
            )}
          />
        </div>
      )}

      {svgEdit ? (
        <>
          <div className="relative flex min-w-0 flex-1 items-stretch">
            <SvgCanvas
              parsed={parsed}
              isDarkMode={isDarkMode}
              selectedIdx={selected}
              onSelect={setSelected}
              onCommitMove={(idx, dx, dy) => commitMutate(idx, n => applyTranslate(n, dx, dy))}
              onDelete={commitDelete}
            />
            {toggleBtn}
          </div>
          <div className={cn('shrink-0', stacked ? 'h-px w-full' : 'h-full w-px', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
          <div className={cn('flex min-w-0 flex-col', stacked ? 'h-56 shrink-0' : 'w-[264px] shrink-0')}>
            <SvgInspector
              parsed={parsed}
              selectedIdx={selected}
              isDarkMode={isDarkMode}
              onSetAttr={(idx, name, value) => commitMutate(idx, n => {
                if (value === null || value === '') n.removeAttribute(name);
                else n.setAttribute(name, value);
              })}
              onNudge={(idx, dx, dy) => commitMutate(idx, n => applyTranslate(n, dx, dy))}
              onSetPos={(idx, x, y) => commitMutate(idx, n => {
                const v = setTranslate(n.getAttribute('transform'), x, y);
                if (v === null) n.removeAttribute('transform');
                else n.setAttribute('transform', v);
              })}
              onSetText={(idx, text) => commitMutate(idx, n => { n.textContent = text; })}
              onDelete={commitDelete}
              onSelect={setSelected}
              onReplaceColor={commitReplaceColor}
              exportText={exportText}
              exportBase={exportBase}
            />
          </div>
        </>
      ) : (
        <div
          ref={paneRef}
          data-svg-preview
          className={cn('relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-3 select-none', IS_TOUCH_PRIMARY && 'touch-none')}
          style={{ ...checker, cursor: dragging ? 'grabbing' : 'default' }}
          title={IS_TOUCH_PRIMARY ? t('svg.panHintTouch') : t('svg.panHint')}
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={startDrag}
          {...pinchBind}
        >
          {toggleBtn}
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
                cursor: dragging ? 'grabbing' : 'default',
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
              onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              onPointerDown={(e) => { if (e.pointerType !== 'mouse') e.stopPropagation(); }}
            >
              <span className={cn('px-1 text-[11px] tabular-nums', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
                {Math.round(eff * 100)}%
              </span>
              <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScale(0); }}>{t('image.viewerFit')}</button>
              <button className={btn} onClick={() => { setOffset({ x: 0, y: 0 }); setScale(1); }}>{t('image.viewerOriginal')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

SvgWorkbench.displayName = 'SvgWorkbench';
