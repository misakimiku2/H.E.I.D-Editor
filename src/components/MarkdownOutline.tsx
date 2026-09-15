import React from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { ListTree } from 'lucide-react';
import type { MdHeading } from '../lib/markdownOutline';

/**
 * Markdown 大纲侧栏：按层级缩进列出标题，点击回调交由 App 分流
 * （预览滚动 / 编辑器跳转）。纯展示组件，标题提取在父级完成。
 */
export const MarkdownOutline = React.memo(function MarkdownOutline({
  headings, isDarkMode, onJump,
}: {
  headings: MdHeading[];
  isDarkMode: boolean;
  onJump: (h: MdHeading) => void;
}) {
  const t = useT();
  if (headings.length === 0) {
    return (
      <div className={cn(
        'h-full flex flex-col items-center justify-center gap-2 text-xs px-4 text-center',
        isDarkMode ? 'text-zinc-600' : 'text-zinc-400',
      )}>
        <ListTree size={20} />
        {t('md.outlineEmpty')}
      </div>
    );
  }
  const levelColor = (level: number) => {
    if (level === 1) return isDarkMode ? 'text-zinc-100 font-semibold' : 'text-zinc-900 font-semibold';
    if (level === 2) return isDarkMode ? 'text-zinc-300 font-medium' : 'text-zinc-700 font-medium';
    return isDarkMode ? 'text-zinc-400' : 'text-zinc-500';
  };
  return (
    <nav aria-label={t('md.outlineAria')} data-testid="md-outline" className="h-full overflow-auto py-2">
      {headings.map((h, i) => (
        <button
          key={`${h.offset}-${i}`}
          data-testid={`md-outline-item-${i}`}
          className={cn(
            'block w-full text-left text-xs leading-6 truncate px-3 hover:bg-zinc-500/10 transition-colors',
            levelColor(h.level),
          )}
          style={{ paddingLeft: 12 + (h.level - 1) * 14 }}
          title={h.text || `H${h.level}`}
          onClick={() => onJump(h)}
        >
          {h.text || `H${h.level}`}
        </button>
      ))}
    </nav>
  );
});
