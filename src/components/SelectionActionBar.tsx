import React, { useEffect, useRef } from 'react';
import { Copy, MoreHorizontal } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { MENU_SECTIONS, type MdMenuOp, type MdOp } from './MarkdownTools';
import { mdOpKey } from '../lib/mdRecentOps';

/**
 * 选区浮动工具条（Android ActionMode 的自绘等价物）。
 *
 * 桌面端「选中文字 → 右键 → 格式菜单」在触屏上的替代：系统长按选字后，
 * 在选区上方浮出这条胶囊条——复制、宿主补的动作（源码编辑器的粘贴/全选）、
 * 上一次用过的格式化命令（一键重复）、以及「更多」打开与桌面同一份格式菜单。
 * 放在选区**上方**是为了不压住系统拖拽手柄（手柄挂在选区两端下沿）；
 * 上方放不下（选区贴着屏幕顶）才翻到下方。
 *
 * 只读预览（canEdit=false）只留「复制」。
 */

/** 选区的视口锚点（CSS px = dp） */
export interface SelectionAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** 宿主补充的动作（源码编辑器的「粘贴 / 全选」）：系统选区弹窗被屏蔽后，
    这些能力改由本条承担，不因为屏蔽而丢掉 */
export interface SelectionBarAction {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

/* 预留尺寸：命中区 ≥48dp。BAR_BASE_W 是「复制 + 更多」两条，
   每个带文字标签的按钮再加 BAR_STEP_W——横向夹紧按实际按钮数算才不会被推出屏幕 */
const BAR_BASE_W = 132;
const BAR_STEP_W = 92;
const BAR_H = 52;
const GAP = 10;

/* op → 菜单里的原条目（图标 + 短标签）：「一键重复」按钮直接复用菜单的呈现，
   菜单里加/减命令这里自动跟上，不另建一份映射 */
const OP_ITEMS = new Map<string, MdMenuOp>();
for (const section of MENU_SECTIONS) {
  for (const o of section.ops) OP_ITEMS.set(mdOpKey(o.op), o);
}

interface Props {
  anchor: SelectionAnchor;
  isDarkMode: boolean;
  canEdit: boolean;
  /** 上一次用过的格式化命令；null（从没用过）时不显示这个按钮。
      非 markdown 的编辑器没有格式命令，整个字段省略 */
  lastOp?: MdOp | null;
  onCopy: () => void;
  onApply?: (op: MdOp) => void;
  /** 打开与桌面同款的格式菜单；缺省时不显示「更多」按钮（代码编辑器没有格式菜单） */
  onMore?: () => void;
  extraActions?: SelectionBarAction[];
}

export const SelectionActionBar = React.memo<Props>(
  ({ anchor, isDarkMode, canEdit, lastOp, onCopy, onApply, onMore, extraActions }) => {
    const t = useT();
    /* 工具条是在选区形成那一刻才出现的，可能正好盖在手指下方；触屏长按抬手会
       合成一次 click，不拦住就会顺手复制/误套一条命令。只认「出现之后真实按下过」
       的点击（合成 click 不伴随 pointerdown，而真人点之前一定先按下） */
    const armedRef = useRef(!IS_TOUCH_PRIMARY);
    useEffect(() => {
      if (!IS_TOUCH_PRIMARY) return;
      const onDown = () => { armedRef.current = true; };
      document.addEventListener('pointerdown', onDown, true);
      return () => document.removeEventListener('pointerdown', onDown, true);
    }, []);

    const guard = (fn: () => void) => () => {
      if (!armedRef.current) return;
      fn();
    };

    const lastItem = canEdit && lastOp ? OP_ITEMS.get(mdOpKey(lastOp)) : undefined;
    /* JSX 里必须是大写标识符，属性访问不能直接当组件用 */
    const LastIcon = lastItem?.icon;
    const extraCount = (extraActions?.length ?? 0) + (lastItem ? 1 : 0);
    const above = anchor.top - BAR_H - GAP;
    const top = above >= 8 ? above : Math.min(anchor.bottom + GAP, window.innerHeight - BAR_H - 8);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - BAR_BASE_W - extraCount * BAR_STEP_W - 8));

    const btnCls = cn(
      'min-h-[48px] min-w-[48px] px-3 rounded-lg flex items-center gap-1.5 text-sm font-medium transition-colors',
      /* 触屏无 hover：按下态用 active: 变体，不依赖鼠标悬停 */
      isDarkMode ? 'text-zinc-100 active:bg-zinc-700' : 'text-zinc-700 active:bg-zinc-200'
    );

    return (
      <div
        className={cn(
          'fixed z-[96] flex items-center gap-0.5 rounded-xl border shadow-xl backdrop-blur-md select-none',
          /* 与桌面右键菜单同一套毛玻璃 */
          isDarkMode ? 'border-zinc-700/70 bg-zinc-800/70' : 'border-zinc-200/80 bg-white/70'
        )}
        style={{ left, top, height: BAR_H }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button className={btnCls} onClick={guard(onCopy)} title={t('ctx.copy')}>
          <Copy size={18} />
          <span>{t('ctx.copy')}</span>
        </button>
        {extraActions?.map(a => (
          <button key={a.label} className={btnCls} onClick={guard(a.onSelect)} title={a.label}>
            {a.icon}
            <span>{a.label}</span>
          </button>
        ))}
        {lastItem && lastOp && LastIcon && onApply && (
          <button className={btnCls} onClick={guard(() => onApply(lastOp))} title={t(lastItem.nameKey)}>
            <LastIcon size={18} />
            <span>{t(lastItem.textKey)}</span>
          </button>
        )}
        {canEdit && onMore && (
          <button className={cn(btnCls, 'px-2.5')} onClick={guard(onMore)} title={t('mobile.moreMenu')}>
            <MoreHorizontal size={18} />
          </button>
        )}
      </div>
    );
  }
);

SelectionActionBar.displayName = 'SelectionActionBar';
