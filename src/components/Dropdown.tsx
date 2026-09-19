import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

/** 找到最近的滚动祖先（下拉面板会被它裁剪，展开方向按它的可视范围判定） */
function scrollClip(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * 自定义下拉：替代原生 <select>（其弹出选项列表是系统渲染的，无法定制样式）。
 * 面板与弹窗/菜单同风格（毛玻璃）；下方空间不足时向上展开；
 * Esc 只关下拉（capture 阶段拦截，不触发外层弹窗的 Esc 关闭）；点击外部收起。
 * 宽度等外观由 className 叠加（设置弹窗用 min-w-[150px]，表单内自然收缩）。
 */
export function Dropdown<T extends string>({
  value,
  onChange,
  options,
  dark,
  label,
  className,
  align = 'left',
  title,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  dark: boolean;
  /** 无障碍名（触发按钮与选项面板的 aria-label） */
  label?: string;
  className?: string;
  align?: 'left' | 'right';
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  /* 打开后按「最近滚动祖先」的可视范围决定展开方向，并把选中项滚进可视区 */
  useEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const clip = scrollClip(el);
    const clipRect = clip?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const rect = el.getBoundingClientRect();
    const listH = list.scrollHeight;
    const spaceBelow = clipRect.bottom - rect.bottom;
    const spaceAbove = rect.top - clipRect.top;
    setDropUp(spaceBelow < listH + 8 && spaceAbove > spaceBelow);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const current = options.find(o => o.value === value);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => setOpen(v => !v)}
        className={cn(
          IS_TOUCH_PRIMARY
            ? "h-11 pl-3 pr-2.5 rounded-lg border text-sm outline-none cursor-pointer flex items-center justify-between gap-1.5 transition-colors"
            : "h-7 pl-2.5 pr-2 rounded-lg border text-xs outline-none cursor-pointer flex items-center justify-between gap-1.5 transition-colors",
          dark
            ? "border-zinc-600 bg-zinc-900/80 text-zinc-200 hover:border-zinc-500"
            : "border-zinc-300 bg-white/90 text-zinc-800 hover:border-zinc-400",
          open && (dark ? "border-[#A3B3FF]/60" : "border-[#A3B3FF]"),
          className
        )}
      >
        <span className="truncate">{current?.label}</span>
        <ChevronDown size={12} className={cn("shrink-0 transition-transform", open && "rotate-180", dark ? "text-zinc-500" : "text-zinc-400")} />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className={cn(
            "absolute z-30 min-w-full w-max max-h-52 overflow-auto heid-scroll rounded-lg border py-1 shadow-xl backdrop-blur-md heid-fade-in",
            align === 'right' ? "right-0" : "left-0",
            dropUp ? "bottom-full mb-1" : "top-full mt-1",
            dark ? "border-zinc-700/70 bg-zinc-800/90" : "border-zinc-200 bg-white/95"
          )}
        >
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(
                IS_TOUCH_PRIMARY
                  ? "flex items-center gap-2.5 w-full text-left min-h-[44px] px-3.5 text-sm transition-colors"
                  : "flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors",
                o.value === value
                  ? "text-[#A3B3FF] font-medium"
                  : dark
                    ? "text-zinc-300 hover:bg-zinc-600/60"
                    : "text-zinc-700 hover:bg-zinc-200/70"
              )}
            >
              <span className="flex-1 truncate whitespace-nowrap">{o.label}</span>
              {o.value === value && <Check size={12} className="shrink-0 text-[#A3B3FF]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
