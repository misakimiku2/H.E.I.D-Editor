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
