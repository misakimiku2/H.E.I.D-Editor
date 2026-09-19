import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { ChevronRight, FoldVertical, ListTree, UnfoldVertical } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { useLongPress } from '../hooks/useLongPress';
import { activeHeadingOffset } from '../lib/markdownOutline';
import type { MdHeading } from '../lib/markdownOutline';

/**
 * Markdown 大纲：按层级缩进列出标题，点击回调交由 App 分流
 * （预览滚动 / 编辑器跳转）。activeOffset 为滚动跟随的当前标题
 * （MarkdownOutlineLive 监听预览滚动算出），高亮与悬停均按右键菜单项口径
 * （左右留间隔、圆角、同色底）。
 * 有子标题的条目带折叠钮（箭头指向：展开朝下、折叠朝右），折叠后隐藏
 * 全部更深层级、直到出现同级或更浅级标题；折叠状态保存在本组件内，
 * 面板收起再展开不丢失。
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
  const [folded, setFolded] = useState<ReadonlySet<number>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /* 触屏：长按行/空白区弹右键同款菜单（行上 bind 以吞掉长按后误跳转的 click） */
  const { bind: bindMenu } = useLongPress();
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
  /* 逐条扫描出可见性：hideLevel 记录最近一个被折叠标题的层级，
     后续更深层级隐藏，遇到同级/更浅级即收束；有子标题 ⇔ 紧邻下一条层级更深。
     隐藏条目不渲染，但保留原数组下标作为 testid/key 基准 */
  const rows: Array<{ h: MdHeading; hidden: boolean; hasChildren: boolean }> = [];
  let hideLevel: number | null = null;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (hideLevel !== null && h.level <= hideLevel) hideLevel = null;
    const hidden = hideLevel !== null;
    if (!hidden && folded.has(h.offset)) hideLevel = h.level;
    rows.push({ h, hidden, hasChildren: i + 1 < headings.length && headings[i + 1].level > h.level });
  }
  const toggleFold = (offset: number) => {
    setFolded(prev => {
      const next = new Set(prev);
      if (next.has(offset)) next.delete(offset);
      else next.add(offset);
      return next;
    });
  };
  /* 右键菜单：全部展开/折叠按「有子标题」的条目计（含当前被隐藏的深层小节，
     折叠全部后展开外层时内层保持折叠）。菜单项按当前状态置灰 */
  const foldableOffsets = rows.filter(r => r.hasChildren).map(r => r.h.offset);
  const menuItems: ContextMenuItem[] = [
    {
      icon: <UnfoldVertical size={13} />,
      label: t('md.outlineUnfoldAll'),
      disabled: folded.size === 0,
      onSelect: () => setFolded(new Set()),
    },
    {
      icon: <FoldVertical size={13} />,
      label: t('md.outlineFoldAll'),
      disabled: foldableOffsets.length === 0,
      onSelect: () => setFolded(new Set(foldableOffsets)),
    },
  ];
  return (
    <>
      <nav
        aria-label={t('md.outlineAria')}
        data-testid="md-outline"
        className="px-1.5 py-2"
        {...bindMenu({
          onLongPress: (pos) => setMenu({ x: pos.x, y: pos.y }),
          onContextMenu: (e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          },
        })}
      >
      {rows.map(({ h, hidden, hasChildren }, i) => {
        if (hidden) return null;
        const expanded = !folded.has(h.offset);
        const active = activeOffset != null && h.offset === activeOffset;
        return (
          <div
            key={`${h.offset}-${i}`}
            data-testid={`md-outline-item-${i}`}
            role="button"
            tabIndex={0}
            {...bindMenu({
              onClick: () => onJump(h),
              onLongPress: (pos) => setMenu({ x: pos.x, y: pos.y }),
              onContextMenu: (e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY });
              },
            })}
            className={cn(
              'mb-0.5 flex w-full items-center gap-0.5 rounded-lg pr-2.5 text-left text-xs leading-5 transition-colors select-none',
              IS_TOUCH_PRIMARY ? 'py-2.5' : 'py-1.5',
              levelColor(h.level),
              active
                ? (isDarkMode ? 'bg-zinc-600/70 text-zinc-100' : 'bg-zinc-200/70 text-zinc-900')
                : (isDarkMode
                  ? 'text-zinc-400 hover:bg-zinc-600/70 hover:text-zinc-200'
                  : 'text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700'),
            )}
            style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
            title={h.text || `H${h.level}`}
            onKeyDown={(e) => {
              /* 焦点在折叠钮上时的 Enter/空格由按钮自己处理，避免二次触发跳转 */
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onJump(h);
              }
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                aria-label={expanded ? t('md.outlineFold') : t('md.outlineUnfold')}
                title={expanded ? t('md.outlineFold') : t('md.outlineUnfold')}
                className={cn(
                  'flex shrink-0 items-center justify-center rounded-md transition-colors',
                  IS_TOUCH_PRIMARY ? 'h-7 w-7' : 'h-5 w-5',
                  isDarkMode ? 'hover:bg-zinc-600/70' : 'hover:bg-zinc-300/70',
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFold(h.offset);
                }}
              >
                <ChevronRight
                  size={12}
                  className={cn('transition-transform duration-150', expanded && 'rotate-90')}
                />
              </button>
            ) : (
              <span className={cn('shrink-0', IS_TOUCH_PRIMARY ? 'h-7 w-7' : 'h-5 w-5')} aria-hidden />
            )}
            <span className="truncate">{h.text || `H${h.level}`}</span>
          </div>
        );
      })}
      </nav>
      {menu && (
        <ContextMenu
          menu={{ x: menu.x, y: menu.y, items: menuItems }}
          isDarkMode={isDarkMode}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
});

/**
 * 大纲滚动跟随容器：自带预览滚动监听与当前标题状态。enabled=false（面板收起）
 * 时只卸掉滚动监听、组件保持挂载——高亮与折叠状态都不丢，重新展开即恢复。
 * 独立成组件是性能考量——预览每帧都可能滚动，高亮变化若放在 App 级 setState
 * 会全量重渲染 App，进而击穿预览 memo 触发全篇 markdown 重解析，分屏快速
 * 滚动时表现为明显掉帧。
 * version 为文档内容：变化后重新查询标题元素（缓存策略与原 App 实现一致）。
 */
export function MarkdownOutlineLive({ enabled, getScroller, version, headings, isDarkMode, onJump }: {
  /** 大纲面板是否展开；收起时暂停滚动跟随（组件保持挂载以保留折叠状态） */
  enabled: boolean;
  getScroller: () => HTMLElement | null;
  version: string;
  headings: MdHeading[];
  isDarkMode: boolean;
  onJump: (h: MdHeading) => void;
}) {
  const [activeOffset, setActiveOffset] = useState<number | null>(null);
  const elsRef = useRef<Array<{ offset: number; top: number }> | null>(null);
  const versionRef = useRef('');

  useEffect(() => {
    if (!enabled) return;
    const el = getScroller();
    if (!el) return;
    if (!elsRef.current || versionRef.current !== version) {
      elsRef.current = Array.from(
        el.querySelectorAll<HTMLElement>(
          'h1[data-md-start],h2[data-md-start],h3[data-md-start],h4[data-md-start],h5[data-md-start],h6[data-md-start]',
        ),
      )
        .map(node => ({ offset: Number(node.dataset.mdStart), top: node.offsetTop }))
        .sort((a, b) => a.top - b.top);
      versionRef.current = version;
    }
    const els = elsRef.current;
    const update = () => {
      const active = activeHeadingOffset(els, el.scrollTop);
      setActiveOffset(prev => (prev === active ? prev : active));
    };
    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => el.removeEventListener('scroll', update);
  }, [enabled, getScroller, version]);

  return (
    <MarkdownOutline
      headings={headings}
      isDarkMode={isDarkMode}
      activeOffset={activeOffset}
      onJump={onJump}
    />
  );
}
