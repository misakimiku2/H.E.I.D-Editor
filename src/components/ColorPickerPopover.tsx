/**
 * 轻量取色器浮层（零依赖，VS Code 风格）：
 * 饱和度/亮度色块 + 色相滑条 + 不透明度滑条 + Hex 输入框。
 * 纯受控组件：内部以 HSV + alpha 为唯一状态（挂载时从 color 播种一次），
 * 交互变化经 onChange 上报，不直接触碰文档。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hsvToRgb, rgbToHsv, cssColor, clamp01, type Hsv, type Rgba } from '../lib/colorMath';
import { parseColorLiteral } from '../lib/colorLiteral';
import { useT } from '../lib/i18nContext';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { cn } from '../lib/utils';

/* 触屏档：色块与两条滑条加大、宽度放宽一档，命中区才够手指。
   高度为估算值（仅用于量得真实尺寸前的首帧定位，翻转钳制以实测为准） */
const POPOVER_WIDTH = IS_TOUCH_PRIMARY ? 264 : 232;
const POPOVER_HEIGHT = IS_TOUCH_PRIMARY ? 330 : 252;

const hex2 = (v: number) => v.toString(16).padStart(2, '0');

function rgbaToHex({ r, g, b, a }: Rgba): string {
  const base = hex2(Math.round(r)) + hex2(Math.round(g)) + hex2(Math.round(b));
  return a >= 1 ? `#${base}` : `#${base}${hex2(Math.round(clamp01(a) * 255))}`;
}

interface Props {
  /** 初始颜色（仅挂载时播种一次；会话内以内部 HSV 状态为准） */
  color: Rgba;
  /** 圆点锚点（视口坐标：圆点左下角） */
  anchor: { x: number; y: number };
  isDarkMode: boolean;
  onChange: (rgba: Rgba) => void;
  onClose: () => void;
}

export const ColorPickerPopover: React.FC<Props> = ({ color, anchor, isDarkMode, onChange, onClose }) => {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const dragKindRef = useRef<'sv' | 'hue' | 'alpha' | null>(null);
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(color));
  const [alpha, setAlpha] = useState<number>(() => clamp01(color.a));
  const [pos, setPos] = useState(() => clampPosition(anchor));
  /* hex 输入框草稿：输入期间显示原文，失焦/回车后回到派生值 */
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const rgb = hsvToRgb(hsv);
  const current: Rgba = { ...rgb, a: alpha };

  /* 锚点变化（滚动/编辑导致圆点移动）时重新贴靠，并做屏幕内翻转钳制。
     量真实尺寸而非用常量：触屏档加大后估算会偏小、底部翻转判定失准 */
  useLayoutEffect(() => {
    const r = rootRef.current?.getBoundingClientRect();
    setPos(clampPosition(anchor, r?.width ? { w: r.width, h: r.height } : undefined));
  }, [anchor.x, anchor.y]);

  const emit = (h: Hsv, a: number) => onChange({ ...hsvToRgb(h), a });

  /* 点击浮层外关闭；Escape 只关浮层（capture 阶段拦下，不再传给编辑器快捷键） */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  /** 拖拽通用：pointer capture 到轨道元素上，move 持续换算 */
  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    kind: 'sv' | 'hue' | 'alpha',
    apply: (el: HTMLDivElement, clientX: number, clientY: number) => void,
  ) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragKindRef.current = kind;
    apply(el, e.clientX, e.clientY);
  };
  const moveDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    apply: (el: HTMLDivElement, clientX: number, clientY: number) => void,
  ) => {
    if (dragKindRef.current === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    apply(e.currentTarget, e.clientX, e.clientY);
  };
  const endDrag = () => { dragKindRef.current = null; };

  const applySv = (el: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    const s = clamp01((clientX - rect.left) / rect.width);
    const v = 1 - clamp01((clientY - rect.top) / rect.height);
    const next = { ...hsv, s, v };
    setHsv(next);
    emit(next, alpha);
  };
  const applyHue = (el: HTMLDivElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    const h = clamp01((clientX - rect.left) / rect.width) * 360;
    const next = { ...hsv, h };
    setHsv(next);
    emit(next, alpha);
  };
  const applyAlpha = (el: HTMLDivElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    const a = clamp01((clientX - rect.left) / rect.width);
    setAlpha(a);
    emit(hsv, a);
  };

  const hueCss = `hsl(${hsv.h}, 100%, 50%)`;
  const hexDisplay = hexDraft ?? rgbaToHex(current);

  const handleHexInput = (text: string) => {
    setHexDraft(text);
    const parsed = parseColorLiteral(text.startsWith('#') ? text : `#${text}`);
    if (!parsed || parsed.style.kind !== 'hex') return;
    const nextHsv = rgbToHsv(parsed.rgba);
    setHsv(nextHsv);
    setAlpha(clamp01(parsed.rgba.a));
    emit(nextHsv, parsed.rgba.a);
  };

  const thumbCls = 'absolute w-3.5 h-3.5 pointer-coarse:w-5 pointer-coarse:h-5 rounded-full border-2 border-white shadow-[0_0_2px_rgba(0,0,0,0.6)] -translate-x-1/2 -translate-y-1/2 pointer-events-none';

  return (
    <div
      ref={rootRef}
      data-color-picker=""
      className={cn(
        'fixed z-[90] rounded-xl border p-2.5 select-none shadow-xl backdrop-blur-md',
        isDarkMode ? 'border-zinc-700/70 bg-zinc-800/50' : 'border-zinc-200/80 bg-white/50',
      )}
      style={{ left: pos.x, top: pos.y, width: POPOVER_WIDTH }}
      onPointerDown={e => e.stopPropagation()}
    >
      {/* 饱和度 / 亮度色块 */}
      <div
        role="slider"
        aria-label={t('colorDot.sv')}
        aria-valuenow={Math.round(hsv.s * 100)}
        className="relative h-[130px] rounded cursor-crosshair touch-none pointer-coarse:h-[176px]"
        style={{
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), ${hueCss}`,
        }}
        onPointerDown={e => startDrag(e, 'sv', applySv)}
        onPointerMove={e => moveDrag(e, applySv)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className={thumbCls}
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            backgroundColor: cssColor({ ...rgb, a: 1 }),
          }}
        />
      </div>

      {/* 色相滑条 */}
      <div
        role="slider"
        aria-label={t('colorDot.hue')}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        className="relative h-3 rounded-full mt-2.5 cursor-pointer touch-none pointer-coarse:h-7"
        style={{ background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)' }}
        onPointerDown={e => startDrag(e, 'hue', applyHue)}
        onPointerMove={e => moveDrag(e, applyHue)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className={thumbCls} style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%', backgroundColor: hueCss }} />
      </div>

      {/* 不透明度滑条（棋盘格底纹 + 当前色渐变） */}
      <div
        role="slider"
        aria-label={t('colorDot.alpha')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(alpha * 100)}
        className="relative h-3 rounded-full mt-2.5 cursor-pointer touch-none pointer-coarse:h-7"
        style={{
          backgroundColor: '#fff',
          backgroundImage: 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)',
          backgroundSize: '8px 8px',
          backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
        }}
        onPointerDown={e => startDrag(e, 'alpha', applyAlpha)}
        onPointerMove={e => moveDrag(e, applyAlpha)}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{ background: `linear-gradient(to right, ${cssColor({ ...rgb, a: 0 })}, ${cssColor({ ...rgb, a: 1 })})` }}
        />
        <div className={thumbCls} style={{ left: `${alpha * 100}%`, top: '50%', backgroundColor: cssColor(current) }} />
      </div>

      {/* 当前色预览 + Hex 输入 */}
      <div className="flex items-center gap-2 mt-2.5">
        <div
          className="w-8 h-8 rounded border shrink-0 pointer-coarse:h-11 pointer-coarse:w-11"
          style={{
            borderColor: isDarkMode ? '#52525b' : '#d4d4d8',
            backgroundColor: '#fff',
            backgroundImage: 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)',
            backgroundSize: '8px 8px',
            backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
          }}
        >
          <div className="w-full h-full" style={{ backgroundColor: cssColor(current) }} />
        </div>
        <input
          value={hexDisplay}
          onChange={e => handleHexInput(e.target.value)}
          onBlur={() => setHexDraft(null)}
          onKeyDown={e => { if (e.key === 'Enter') setHexDraft(null); }}
          aria-label={t('colorDot.hex')}
          spellCheck={false}
          className={cn(
            'flex-1 min-w-0 h-8 px-2 rounded border text-xs font-mono outline-none pointer-coarse:h-11 pointer-coarse:px-3 pointer-coarse:text-sm',
            isDarkMode ? 'border-zinc-600 bg-zinc-900 text-zinc-200 focus:border-blue-500' : 'border-zinc-300 bg-white text-zinc-800 focus:border-blue-500',
          )}
        />
      </div>
    </div>
  );
};

/** 视口内钳制 + 边缘翻转：默认出现在锚点（圆点左下角）下方，放不下就翻到上方 */
function clampPosition(anchor: { x: number; y: number }, size?: { w: number; h: number }): { x: number; y: number } {
  const margin = 8;
  const w = size?.w ?? POPOVER_WIDTH;
  const h = size?.h ?? POPOVER_HEIGHT;
  let x = anchor.x - 4;
  let y = anchor.y + 6;
  if (x + w > window.innerWidth - margin) x = window.innerWidth - margin - w;
  if (x < margin) x = margin;
  if (y + h > window.innerHeight - margin) y = anchor.y - h - 18;
  if (y < margin) y = margin;
  return { x: Math.round(x), y: Math.round(y) };
}
