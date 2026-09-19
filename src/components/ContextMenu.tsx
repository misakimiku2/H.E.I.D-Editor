import React, { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

/**
 * 纵向列表式右键菜单（编辑器/文件树共用）：样式与标签栏右键菜单同源
 * （zinc 半透明毛玻璃面板 + 圆角行项），支持分组分隔线、置灰与危险色项、
 * 右侧快捷键提示。点击外部（pointerdown 覆盖触屏）/ Esc / 滚动 / 调整窗口时关闭。
 */
export interface ContextMenuItem {
  icon?: React.ReactNode;
  label: string;
  /** 右侧淡色快捷键提示（如 Ctrl+Z） */
  shortcut?: string;
  disabled?: boolean;
  /** 危险操作（删除）：红色文字 */
  danger?: boolean;
  /** 该项之前插入分组分隔线 */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/* 触屏变体：行高 ≥44、字号 sm、面板加宽（视觉估高随之变大，夹紧仍成立） */
const TOUCH = IS_TOUCH_PRIMARY;
const ITEM_H = TOUCH ? 46 : 30;
const PANEL_W = TOUCH ? 280 : 216;
const PANEL_PAD = 8;

export const ContextMenu = React.memo<{
  menu: ContextMenuState;
  isDarkMode: boolean;
  onClose: () => void;
}>(({ menu, isDarkMode, onClose }) => {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [onClose]);

  /* 视口内夹紧：高度按行数估算（分隔线并入行高），足够接近且简单 */
  const separators = menu.items.filter(i => i.separatorBefore).length;
  const estH = menu.items.length * ITEM_H + separators * 2 + PANEL_PAD * 2;
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - PANEL_W - 8));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - estH - 8));

  return (
    <div
      ref={ref}
      className={cn(
        "fixed z-[95] rounded-xl border shadow-xl backdrop-blur-md py-1 flex flex-col select-none overflow-y-auto heid-scroll",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
      )}
      style={{ left, top, width: PANEL_W, maxHeight: 'calc(100dvh - 8px)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) => (
        <React.Fragment key={`${item.label}-${i}`}>
          {item.separatorBefore && (
            <div className={cn("h-px mx-1 my-0.5", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
          )}
          <button
            onClick={() => { onClose(); item.onSelect(); }}
            disabled={item.disabled}
            title={item.label}
            className={cn(
              TOUCH
                ? "mx-1.5 w-[calc(100%-12px)] min-h-[44px] rounded-lg px-3 text-sm font-medium flex items-center gap-2.5 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                : "mx-1.5 w-[calc(100%-12px)] rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none",
              item.danger
                ? "text-red-500 hover:bg-red-500/10"
                : isDarkMode ? "hover:bg-zinc-600/70 text-zinc-200" : "hover:bg-zinc-200/70 text-zinc-700"
            )}
          >
            {item.icon && <span className="shrink-0 flex items-center opacity-80">{item.icon}</span>}
            <span className="flex-1 text-left truncate">{item.label}</span>
            {item.shortcut && (
              <span className={cn("text-[10px] shrink-0", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                {item.shortcut}
              </span>
            )}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
});

ContextMenu.displayName = 'ContextMenu';
