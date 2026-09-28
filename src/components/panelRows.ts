import { cn } from '../lib/utils';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

/**
 * 设置弹窗与「设备互联」一级面板共用的行/标签样式。
 * 互联面板既在设置里出现、也在一级入口的浮层与抽屉里出现，尺寸定义只能有一份，
 * 否则改了一边、另一边在触屏上悄悄掉回 44dp 以下。
 */
export const panelRowCls = (dark: boolean) => cn(
  'flex items-center justify-between gap-3 mx-2.5 rounded-lg transition-colors',
  IS_TOUCH_PRIMARY ? 'px-3 py-2 min-h-[56px]' : 'px-2.5 py-2',
  dark ? 'hover:bg-zinc-700/30' : 'hover:bg-zinc-100/70',
);

export const PANEL_LABEL_CLS = 'text-xs font-medium pointer-coarse:text-sm';

/* ============================================================================
 * 「设备互联」这块面板自己的排版档位
 *
 * 这一屏以前把 `text-[10px]` / `text-[11px]` / `text-xs` / `text-sm` / `text-lg`
 * 混在一起用，结果是**没有一处像是标题** —— 用户说的"只是把东西堆在一起"，病根就在这：
 * 字号没有主次，眼睛就找不到落点。这里收敛成四档，并且把"哪一档说什么"定死：
 *
 *   TITLE  这块面板现在是什么状态        —— 一屏里最大的一处字，只给状态
 *   BODY   一行里的标签与控件上的字      —— 数量最多，所以最克制
 *   CAP    补充说明、地址、失败原因      —— 永远比它说明的那行小一档
 *   EYE    小节名（配对方式 / 已配对设备）—— 靠"小 + 淡"分层，不靠加粗和分割线堆
 *
 * 触屏比桌面大一档，走 `pointer-coarse`（这块面板三端共用一份，尺寸只能这样分）。
 * 设置弹窗那一列另有它自己的密度（上面那两条），不跟着改。
 * ========================================================================== */

export const DL_TITLE = 'text-[14px] font-semibold leading-tight pointer-coarse:text-[17px]';
export const DL_BODY = 'text-xs font-medium pointer-coarse:text-sm';
export const DL_CAP = 'text-[11px] leading-relaxed pointer-coarse:text-xs opacity-60';
/* 小节名靠"小"分层就够了，不靠往死里淡：淡到 45% 的 11px 在毛玻璃上已经掉出
   WCAG 正文对比度了，读屏之外的人也会把它看成不可点的注脚 */
export const DL_EYE = 'text-[10px] font-medium pointer-coarse:text-[11px] opacity-70';
/** 次级段里一行的标签：与主操作同字号，靠不加粗与不染色退到第二层 */
export const DL_LABEL = 'text-xs pointer-coarse:text-sm';

/** 数字与代码：等宽 + 表格数字，短码再放宽字距，让人一眼读成"六位"而不是一串糊字 */
export const DL_DATA = 'font-mono tabular-nums';

/** 主操作：一屏只给一颗，颜色只由"当前这一步"决定 */
export const dlBtnPrimary = cn(
  'flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 font-medium text-white',
  'transition-colors active:bg-indigo-500 disabled:opacity-45',
  IS_TOUCH_PRIMARY ? 'min-h-[52px] px-4 text-sm' : 'min-h-[34px] px-3 text-xs',
);

/** 次操作：同一行最多两颗，描边档，不与主操作抢 */
export const dlBtnGhost = cn(
  'flex flex-1 items-center justify-center gap-1.5 rounded-xl border font-medium transition-colors disabled:opacity-45',
  IS_TOUCH_PRIMARY ? 'min-h-[52px] px-3 text-sm' : 'min-h-[32px] px-2.5 text-xs',
);

/** 降级动作（换一个码 / 改用配对码）：文字档，不占按钮的视觉重量 */
export const dlBtnText = cn(
  'rounded-lg font-medium underline decoration-dotted underline-offset-4 transition-opacity',
  'disabled:opacity-45',
  IS_TOUCH_PRIMARY ? 'min-h-[48px] px-1 text-sm' : 'min-h-[26px] px-1 text-xs',
);

/** 输入框：与次操作同高，圆角同档 */
export const dlInput = (dark: boolean) => cn(
  'min-w-0 rounded-lg border px-2.5 outline-none transition-colors',
  IS_TOUCH_PRIMARY ? 'min-h-[52px] text-sm' : 'min-h-[32px] text-xs',
  dark
    ? 'border-zinc-600 bg-zinc-900/50 text-zinc-100 placeholder:text-zinc-500'
    : 'border-zinc-300 bg-white text-zinc-800 placeholder:text-zinc-400',
);

/** 次级段里的一行：左标签右值/控件，靠留白分行，不再每行铺一层 hover 底色 */
export const DL_ROW = cn(
  'flex items-center justify-between gap-3 py-1',
  IS_TOUCH_PRIMARY ? 'min-h-[52px]' : 'min-h-[30px]',
);

/** 小节：标题 + 内容，组与组之间只留一次呼吸的间距 */
export const DL_GROUP = 'pt-3';
export const DL_GROUP_HEAD = cn(DL_EYE, 'px-4 pb-0.5');
export const DL_GROUP_BODY = 'px-4';
