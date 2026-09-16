import React from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { ListTree } from 'lucide-react';
import type { MdHeading } from '../lib/markdownOutline';

/**
 * Markdown 大纲：按层级缩进列出标题，点击回调交由 App 分流
 * （预览滚动 / 编辑器跳转）。activeOffset 为滚动跟随的当前标题
 * （App 侧监听预览滚动算出），高亮与悬停均按右键菜单项口径
 * （左右留间隔、圆角、同色底）。
 */
export const MarkdownOutline = React.memo(function MarkdownOutline({
  headings, isDarkMode, activeOffset, onJump,
}: {
  headings: MdHeading[];
  isDarkMode: boolean;
  activeOffset?: number | null;
  onJump: (h: MdHeading) => void;
}) {
  const t = useT();
  if (headings.length === 0) {
    return (
      <div className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs',
        isDarkMode ? 'text-zinc-600' : 'text-zinc-400',
      )}>
        <ListTree size={20} />
        {t('md.outlineEmpty')}
      </div>
    );
  }
  const levelColor = (level: number) => {
    if (level === 1) return 'font-semibold';
    if (level === 2) return 'font-medium';
    return '';
  };
  return (
    <nav aria-label={t('md.outlineAria')} data-testid="md-outline" className="px-1.5">
      {headings.map((h, i) => {
        const active = activeOffset != null && h.offset === activeOffset;
        return (
          <button
            key={`${h.offset}-${i}`}
            data-testid={`md-outline-item-${i}`}
            className={cn(
              'mb-0.5 block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs leading-5 transition-colors',
              levelColor(h.level),
              active
                ? (isDarkMode ? 'bg-zinc-600/70 text-zinc-100' : 'bg-zinc-200/70 text-zinc-900')
                : (isDarkMode
                  ? 'text-zinc-400 hover:bg-zinc-600/70 hover:text-zinc-200'
                  : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700'),
            )}
            style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
            title={h.text || `H${h.level}`}
            onClick={() => onJump(h)}
          >
            {h.text || `H${h.level}`}
          </button>
        );
      })}
    </nav>
  );
});
