/**
 * SVG 检查面板：属性 / 图层 / 颜色 三个 tab + PNG 导出。
 * 所有编辑都经回调上抛（Workbench 统一手术式提交），面板自身不碰源码：
 * - 属性：位移 X/Y（前导 translate）+ fill/stroke 取色复用 ColorPickerPopover（拖动实时写入，
 *   连续变化合并进一条撤销）；数值/文本字段本地草稿，失焦/回车提交，避免每键一补丁；
 *   X/Y 两侧配 ± 步进，触屏没有方向键也能微调；
 * - 图层：权威树只读大纲，与画布选中双向联动；
 * - 颜色：调色板（fill/stroke/stop-color 聚合），点选颜色后全局替换。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Pipette, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import type { SvgParseResult } from '../lib/svgParse';
import { collectPalette } from '../lib/svgPalette';
import { parseColorLiteral } from '../lib/colorLiteral';
import { type Rgba } from '../lib/colorMath';
import { readTranslate, setTranslate } from '../lib/svgWrite';
import { ColorPickerPopover } from './ColorPickerPopover';
import { copyBlobPng, pngFileName, renderSvgPng, saveBlob } from '../lib/svgExport';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** ± 步进一步多少 SVG 用户单位：与画布方向键的默认档同值（SvgCanvas 的 ArrowLeft 等） */
const NUDGE_STEP = 1;

const rgbaToHex = ({ r, g, b, a }: Rgba): string => {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  const base = `#${h(r)}${h(g)}${h(b)}`;
  return a >= 1 ? base : base + h(clamp01(a) * 255);
};

type Tab = 'props' | 'layers' | 'colors';

export const SvgInspector = React.memo<{
  parsed: SvgParseResult | null;
  selectedIdx: number | null;
  isDarkMode: boolean;
  onSetAttr: (idx: number, name: string, value: string | null) => void;
  /** 按增量挪动元素（± 步进：与画布拖拽/方向键同一条合成路径） */
  onNudge: (idx: number, dx: number, dy: number) => void;
  /** 绝对设置前导位移（X/Y 输入框，失焦/回车提交） */
  onSetPos: (idx: number, x: number, y: number) => void;
  onSetText: (idx: number, text: string) => void;
  onDelete: (idx: number) => void;
  onSelect: (idx: number | null) => void;
  onReplaceColor: (from: string, to: string) => void;
  /** sanitize 后的 SVG 序列化文本（PNG 导出源） */
  exportText: string;
  /** 导出文件名基础（标签页标题） */
  exportBase: string;
}>(({ parsed, selectedIdx, isDarkMode, onSetAttr, onNudge, onSetPos, onSetText, onDelete, onSelect, onReplaceColor, exportText, exportBase }) => {
  const t = useT();
  const [tab, setTab] = useState<Tab>('props');

  const selected = selectedIdx !== null && parsed && selectedIdx < parsed.elements.length
    ? parsed.elements[selectedIdx]
    : null;

  /* 本地草稿：切换选中/重解析时从节点重新播种 */
  const [numDraft, setNumDraft] = useState<{ width: string; opacity: string; x: string; y: string }>({ width: '', opacity: '', x: '', y: '' });
  const [textDraft, setTextDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    const pos = readTranslate(selected.node.getAttribute('transform'));
    setNumDraft({
      width: selected.node.getAttribute('stroke-width') ?? '',
      opacity: selected.node.getAttribute('opacity') ?? '',
      x: pos ? String(pos.x) : '',
      y: pos ? String(pos.y) : '',
    });
    setTextDraft(null);
  }, [selected?.node, selectedIdx]);

  /* 取色浮层 */
  const [pickAttr, setPickAttr] = useState<{ attr: string; anchor: { x: number; y: number } } | null>(null);

  /* 颜色替换 */
  const [replaceFrom, setReplaceFrom] = useState<string | null>(null);
  const [replaceTo, setReplaceTo] = useState('#38bdf8');

  /* 导出反馈（复制成功的短暂对勾） */
  const [copied, setCopied] = useState(false);
  const flash = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const doExport = async (scale: number, copy: boolean) => {
    if (!exportText) return;
    const blob = await renderSvgPng(exportText, scale);
    if (!blob) return;
    const ok = copy ? await copyBlobPng(blob) : await saveBlob(blob, pngFileName(exportBase, scale));
    if (ok && copy) flash();
  };

  const label = cn('text-[11px] shrink-0 pointer-coarse:text-sm', isDarkMode ? 'text-zinc-500' : 'text-zinc-400');
  const inputCls = cn(
    'w-full min-w-0 rounded-md border px-2 py-1 text-xs outline-none transition-colors pointer-coarse:min-h-[48px] pointer-coarse:px-3 pointer-coarse:text-sm',
    isDarkMode ? 'border-zinc-600 bg-zinc-800 text-zinc-200 focus:border-sky-500' : 'border-zinc-300 bg-white text-zinc-700 focus:border-sky-500',
  );
  const btnCls = cn(
    'shrink-0 rounded-md px-2 py-1 text-[11px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:min-w-[48px] pointer-coarse:px-3.5 pointer-coarse:text-sm',
    isDarkMode ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
  );
  /* ± 步进退到输入框两侧，桌面紧凑、触屏撑到 48×48 */
  const stepCls = cn(
    'h-6 w-6 shrink-0 rounded-md text-sm leading-none transition-colors pointer-coarse:h-12 pointer-coarse:w-12 pointer-coarse:text-base',
    isDarkMode ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
  );

  /* ---- 颜色字段（swatch 触发取色浮层 + 文本框直输） ---- */
  const colorField = (attr: 'fill' | 'stroke') => {
    if (!selected) return null;
    const value = selected.node.getAttribute(attr) ?? '';
    const lit = parseColorLiteral(value)?.rgba;
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={cn('h-6 w-6 shrink-0 rounded-md border pointer-coarse:h-12 pointer-coarse:w-12', isDarkMode ? 'border-zinc-600' : 'border-zinc-300')}
          style={{ background: lit ? rgbaToHex(lit) : undefined }}
          title={t('svg.pickColor')}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPickAttr(pickAttr?.attr === attr ? null : { attr, anchor: { x: r.left, y: r.bottom + 4 } });
          }}
        >
          {!lit && <Pipette size={12} className="mx-auto opacity-50" />}
        </button>
        <input
          className={inputCls}
          value={value}
          placeholder={t('svg.notSet')}
          onChange={(e) => onSetAttr(selectedIdx!, attr, e.target.value === '' ? null : e.target.value)}
        />
        {pickAttr?.attr === attr && lit && (
          <ColorPickerPopover
            color={lit}
            anchor={pickAttr.anchor}
            isDarkMode={isDarkMode}
            onChange={(rgba) => onSetAttr(selectedIdx!, attr, rgbaToHex(rgba))}
            onClose={() => setPickAttr(null)}
          />
        )}
      </div>
    );
  };

  /* ---- 位移行：X/Y 读写元素前导 translate（拖拽与方向键改的正是这一段）。
     ± 步进是触屏出口——没有物理键盘就没有方向键微调 ---- */
  const commitAxis = (axis: 'x' | 'y') => {
    if (!selected || selectedIdx === null) return;
    const cur = readTranslate(selected.node.getAttribute('transform')) ?? { x: 0, y: 0 };
    const raw = numDraft[axis].trim();
    const v = Number(raw);
    if (raw === '' || !Number.isFinite(v)) {
      /* 空/垃圾输入不动源码，草稿收回节点现值 */
      setNumDraft(d => ({ ...d, [axis]: String(cur[axis]) }));
      return;
    }
    /* 整对交给 onSetPos（与其余编辑一样落在按最新源码重解析的权威树上），
       本面板自己拼 transform 字符串会绕过那条链路 */
    onSetPos(selectedIdx, axis === 'x' ? v : cur.x, axis === 'y' ? v : cur.y);
  };

  const axisRow = (axis: 'x' | 'y') => {
    const name = axis === 'x' ? t('svg.offsetX') : t('svg.offsetY');
    const step = (sign: number) => onNudge(
      selectedIdx!,
      axis === 'x' ? sign * NUDGE_STEP : 0,
      axis === 'y' ? sign * NUDGE_STEP : 0,
    );
    return (
      <div className="flex items-center gap-2" data-axis={axis}>
        <span className={cn('w-16', label)}>{name}</span>
        <button type="button" className={stepCls} onClick={() => step(-1)} title="−">−</button>
        <input
          type="number" step="any"
          aria-label={name}
          className={inputCls}
          value={numDraft[axis]}
          placeholder={t('svg.notSet')}
          onChange={(e) => setNumDraft(d => ({ ...d, [axis]: e.target.value }))}
          onBlur={() => commitAxis(axis)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <button type="button" className={stepCls} onClick={() => step(1)} title="+">+</button>
      </div>
    );
  };

  /* ---- 图层树（权威树 + 先序下标映射） ---- */
  const idxMap = useMemo(() => new Map(parsed?.elements.map((e, i) => [e.node, i] as const) ?? []), [parsed]);
  const outlineRow = (el: Element, depth: number): React.ReactNode => {
    const idx = idxMap.get(el);
    if (idx === undefined) return null;
    const id = el.getAttribute('id');
    const cls = el.getAttribute('class');
    return (
      <div key={idx}>
        <button
          type="button"
          data-outline={idx}
          className={cn('flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] truncate pointer-coarse:min-h-[48px] pointer-coarse:py-2 pointer-coarse:text-sm',
            idx === selectedIdx
              ? 'bg-sky-500/20 text-sky-500'
              : isDarkMode ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100')}
          style={{ paddingLeft: `${6 + depth * 12}px` }}
          onClick={() => onSelect(idx)}
        >
          <span className="font-medium">{el.tagName}</span>
          {id && <span className="opacity-60">#{id}</span>}
          {cls && <span className="opacity-40 truncate">.{cls.trim().split(/\s+/).join('.')}</span>}
        </button>
        {Array.from(el.children).map(c => outlineRow(c, depth + 1))}
      </div>
    );
  };

  /* 选中变化时让大纲行滚进视野 */
  const layersRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selectedIdx === null || tab !== 'layers') return;
    layersRef.current?.querySelector(`[data-outline="${selectedIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx, tab]);

  const palette = parsed ? collectPalette(parsed).sort((a, b) => b.count - a.count) : [];

  const tabs: { key: Tab; label: string }[] = [
    { key: 'props', label: t('svg.tabProps') },
    { key: 'layers', label: t('svg.tabLayers') },
    { key: 'colors', label: t('svg.tabColors') },
  ];

  return (
    <div className={cn('flex h-full min-w-0 flex-col', isDarkMode ? 'bg-zinc-900' : 'bg-zinc-50')}>
      {/* tab 头 */}
      <div className={cn('flex shrink-0 border-b', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
        {tabs.map(({ key, label: name }) => (
          <button
            key={key}
            type="button"
            className={cn('flex-1 px-2 py-1.5 text-[11px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:text-sm',
              tab === key
                ? isDarkMode ? 'text-sky-400 border-b-2 border-sky-400' : 'text-sky-600 border-b-2 border-sky-500'
                : isDarkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600')}
            onClick={() => setTab(key)}
          >
            {name}
          </button>
        ))}
      </div>

      {/* 主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === 'props' && (!selected || !parsed ? (
          <div className={cn('px-1 pt-6 text-center text-[11px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
            {parsed ? t('svg.noSelection') : t('svg.invalid')}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className={cn('text-[11px] font-medium', isDarkMode ? 'text-zinc-300' : 'text-zinc-600')}>
                &lt;{selected.node.tagName}&gt;
              </span>
              {selectedIdx! > 0 && (
                <button
                  type="button"
                  className={cn('flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:px-3.5 pointer-coarse:text-sm',
                    'text-red-400 hover:bg-red-500/10')}
                  onClick={() => onDelete(selectedIdx!)}
                  title={t('svg.delete')}
                >
                  <Trash2 size={12} />{t('svg.delete')}
                </button>
              )}
            </div>
            {/* 根元素不可挪（画布上的点选同样排除 0 号） */}
            {selectedIdx! > 0 && <>{axisRow('x')}{axisRow('y')}</>}
            <div className="flex items-center gap-2"><span className={cn('w-16', label)}>fill</span><div className="min-w-0 flex-1">{colorField('fill')}</div></div>
            <div className="flex items-center gap-2"><span className={cn('w-16', label)}>stroke</span><div className="min-w-0 flex-1">{colorField('stroke')}</div></div>
            <div className="flex items-center gap-2">
              <span className={cn('w-16', label)}>stroke-width</span>
              <input
                type="number" step="any" min="0"
                className={inputCls}
                value={numDraft.width}
                placeholder={t('svg.notSet')}
                onChange={(e) => setNumDraft(d => ({ ...d, width: e.target.value }))}
                onBlur={() => onSetAttr(selectedIdx!, 'stroke-width', numDraft.width === '' ? null : numDraft.width)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className={cn('w-16', label)}>opacity</span>
              <input
                type="number" step="0.05" min="0" max="1"
                className={inputCls}
                value={numDraft.opacity}
                placeholder={t('svg.notSet')}
                onChange={(e) => setNumDraft(d => ({ ...d, opacity: e.target.value }))}
                onBlur={() => onSetAttr(selectedIdx!, 'opacity', numDraft.opacity === '' ? null : numDraft.opacity)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            </div>
            {selected.node.tagName === 'text' && selected.node.children.length === 0 && (
              <div className="flex flex-col gap-1">
                <span className={label}>text</span>
                <textarea
                  className={cn(inputCls, 'h-16 resize-none')}
                  value={textDraft ?? selected.node.textContent ?? ''}
                  onChange={(e) => setTextDraft(e.target.value)}
                  onBlur={() => { if (textDraft !== null) onSetText(selectedIdx!, textDraft); }}
                />
              </div>
            )}
            <p className={cn('text-[10px] leading-4 pointer-coarse:text-sm', isDarkMode ? 'text-zinc-600' : 'text-zinc-400')}>{t('svg.writeBackHint')}</p>
          </div>
        ))}

        {tab === 'layers' && (
          <div ref={layersRef} className="flex flex-col">
            {parsed ? (
              outlineRow(parsed.dom.documentElement, 0)
            ) : (
              <div className={cn('px-1 pt-6 text-center text-[11px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>{t('svg.invalid')}</div>
            )}
          </div>
        )}

        {tab === 'colors' && (
          <div className="flex flex-col gap-1">
            {palette.length === 0 && (
              <div className={cn('px-1 pt-6 text-center text-[11px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>{t('svg.paletteEmpty')}</div>
            )}
            {palette.map(entry => (
              <button
                key={entry.color}
                type="button"
                className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:py-2 pointer-coarse:text-sm',
                  replaceFrom === entry.color
                    ? 'bg-sky-500/20 text-sky-500'
                    : isDarkMode ? 'text-zinc-400 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100')}
                onClick={() => setReplaceFrom(replaceFrom === entry.color ? null : entry.color)}
              >
                <span
                  className={cn('h-4 w-4 shrink-0 rounded border', isDarkMode ? 'border-zinc-600' : 'border-zinc-300')}
                  style={{ background: entry.color }}
                />
                <span className="flex-1 truncate font-mono">{entry.color}</span>
                <span className="opacity-50">×{entry.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 颜色替换条（选中颜色后出现） */}
      {tab === 'colors' && replaceFrom && (
        <div className={cn('flex shrink-0 items-center gap-1.5 border-t p-2', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
          <span className={cn('truncate text-[10px]', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
            {t('svg.replaceColor', { from: replaceFrom })}
          </span>
          <input
            type="color"
            className="h-6 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 pointer-coarse:min-h-[48px] pointer-coarse:w-12"
            value={/^#[0-9a-fA-F]{6}$/.test(replaceTo) ? replaceTo : '#38bdf8'}
            onChange={(e) => setReplaceTo(e.target.value)}
          />
          <button
            type="button"
            className={cn(btnCls, 'bg-sky-500 text-white hover:bg-sky-400')}
            onClick={() => { onReplaceColor(replaceFrom, replaceTo); setReplaceFrom(null); }}
          >
            {t('svg.applyReplace')}
          </button>
        </div>
      )}

      {/* 导出条 */}
      <div className={cn('flex shrink-0 items-center gap-1 border-t p-2', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
        <span className={cn('flex-1 truncate text-[10px]', isDarkMode ? 'text-zinc-600' : 'text-zinc-400')}>PNG</span>
        {[1, 2, 4].map(k => (
          <button key={k} type="button" className={btnCls} onClick={() => doExport(k, false)} title={t('svg.exportPng', { k: String(k) })}>
            {`${k}×`}
          </button>
        ))}
        <button
          type="button"
          className={cn(btnCls, 'flex items-center gap-1')}
          onClick={() => doExport(2, true)}
          title={t('svg.copyPng')}
        >
          {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
        </button>
      </div>
    </div>
  );
});

SvgInspector.displayName = 'SvgInspector';
