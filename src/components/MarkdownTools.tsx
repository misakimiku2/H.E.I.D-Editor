import React, { useEffect, useRef } from 'react';
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Pilcrow,
  Bold, Italic, Strikethrough, Code, TextQuote,
  List, ListOrdered, ListTodo, Braces, Link2,
  Minus, Undo2, Redo2,
  Layers, PanelTop, PanelBottom, Eraser,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useT, type MessageKey } from '../lib/i18nContext';

/* ---- markdown 快捷格式化：预览选区与源码编辑器选区共用的转换与菜单 ---- */

export type MdOp =
  | { kind: 'heading'; level: number }
  | { kind: 'paragraph' }
  | { kind: 'bold' } | { kind: 'italic' } | { kind: 'strike' } | { kind: 'inlineCode' }
  | { kind: 'link' } | { kind: 'image' }
  | { kind: 'quote' } | { kind: 'ul' } | { kind: 'ol' } | { kind: 'task' }
  | { kind: 'codeBlock' } | { kind: 'table' } | { kind: 'hr' }
  | { kind: 'tabGroup' } | { kind: 'tabStart' } | { kind: 'tabEnd' } | { kind: 'tabClear' };

/** tabGroup 逐段应用时携带段位：最后一段补页签结束标记 */
export interface SliceCtx {
  index: number;
  total: number;
}

/* 行内标记 → 包裹符；链接/图片单独处理 */
export const INLINE_WRAPS: Partial<Record<MdOp['kind'], [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  inlineCode: ['`', '`'],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 去掉行首的块级标记（标题/引用/列表），方便转换成其他块级语法 */
const stripBlockPrefix = (line: string): string =>
  line.replace(/^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '$1');

/* 在源码片段里定位选中文本；渲染文本与源码空白不一致时按空白归一匹配 */
function findInSlice(slice: string, text: string): { index: number; length: number } | null {
  if (!text) return null;
  const direct = slice.indexOf(text);
  if (direct >= 0) return { index: direct, length: text.length };
  const parts = text.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (parts.length > 0) {
    const m = new RegExp(parts.join('\\s+')).exec(slice);
    if (m) return { index: m.index, length: m[0].length };
  }
  return null;
}

/* 块级操作：给每行加前缀；若所有行已带该前缀则视为取消（还原为普通段落） */
function prefixLines(slice: string, toggleTest: RegExp, make: (lineIndex: number) => string): string {
  const lines = slice.split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  const toggled = nonEmpty.length > 0 && nonEmpty.every(l => toggleTest.test(l));
  return lines.map((l, i) => {
    if (!l.trim()) return l;
    if (toggled) return stripBlockPrefix(l);
    return make(i) + stripBlockPrefix(l);
  }).join('\n');
}

const TABLE_TEMPLATE_ZH = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |';

/* 对单个源码片段套用操作，返回替换后的文本；tableTemplate 供 i18n 覆盖（缺省中文表头）；
   ctx 供 tabGroup 逐段应用（index 从 0 起，total 为段总数） */
export function transformSlice(op: MdOp, slice: string, selectedText: string, tableTemplate = TABLE_TEMPLATE_ZH, ctx: SliceCtx = { index: 0, total: 1 }): string {
  switch (op.kind) {
    case 'heading':
      return prefixLines(slice, new RegExp(`^${'#'.repeat(op.level)} `), () => `${'#'.repeat(op.level)} `);
    case 'paragraph':
      return slice.split('\n').map(l => stripBlockPrefix(l)).join('\n');
    case 'quote':
      return prefixLines(slice, /^>\s?/, () => '> ');
    case 'ul':
      return prefixLines(slice, /^[-*+]\s+/, () => '- ');
    case 'ol':
      return prefixLines(slice, /^\d+[.)]\s+/, i => `${i + 1}. `);
    case 'task':
      return prefixLines(slice, /^[-*+]\s+\[[ xX]\]\s+/, () => '- [ ] ');
    case 'codeBlock': {
      const trimmed = slice.trim();
      /* 已是围栏代码块则拆除围栏 */
      if (trimmed.startsWith('```')) {
        const body = trimmed.replace(/^```.*\n/, '').replace(/\n?```$/, '');
        return body;
      }
      return '```\n' + slice.replace(/^\n+|\n+$/g, '') + '\n```';
    }
    case 'table':
      return slice.trimEnd() + '\n\n' + tableTemplate;
    case 'hr':
      return slice.trimEnd() + '\n\n---';
    case 'tabGroup': {
      const trimmed = slice.replace(/^\n+|\n+$/g, '');
      if (!trimmed) return slice;
      /* 标签取首个短文本行（纯文本，非图片/表格/标记行），并从内容中移除；
         没有就用序号兜底（提取失败人工重建页签时图片组多为此情况） */
      const lines = trimmed.split('\n');
      const first = (lines[0] || '').trim();
      const plain = first.length >= 1 && first.length <= 16
        && !/^(!\[|\||<!--)/.test(first) && !/^[\s#*_-]+$/.test(first);
      const label = plain
        ? first.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim() || `页签${ctx.index + 1}`
        : `页签${ctx.index + 1}`;
      const body = plain ? lines.slice(1).join('\n').replace(/^\n+/, '') : trimmed;
      const open = `<!-- tab:${label} -->\n\n`;
      const close = ctx.index === ctx.total - 1 ? '\n\n<!-- /tab -->' : '';
      return open + (body || trimmed) + close;
    }
    case 'tabStart':
      return `<!-- tab:标签 -->\n\n` + slice.replace(/^\n+/, '');
    case 'tabEnd':
      return slice.replace(/\n+$/, '') + '\n\n<!-- /tab -->';
    case 'tabClear':
      return slice
        .split('\n')
        .filter(l => !/^\s*<!--\s*\/?\s*(?:tab|lang)\b/i.test(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+|\n+$/g, '');
    case 'link':
    case 'image':
    case 'bold':
    case 'italic':
    case 'strike':
    case 'inlineCode': {
      const found = findInSlice(slice, selectedText);
      const index = found ? found.index : 0;
      const length = found ? found.length : slice.replace(/^\n+|\n+$/g, '').length;
      const target = slice.slice(index, index + length);
      if (op.kind === 'link') {
        return slice.slice(0, index) + `[${target}](https://)` + slice.slice(index + length);
      }
      if (op.kind === 'image') {
        return slice.slice(0, index) + `![${target}](https://)` + slice.slice(index + length);
      }
      const [open, close] = INLINE_WRAPS[op.kind]!;
      /* 选区已被同样标记包裹则拆掉（切换） */
      const wrapped = open + target + close;
      const wIndex = slice.indexOf(wrapped);
      if (wIndex >= 0 && wIndex <= index && index + length <= wIndex + wrapped.length) {
        return slice.slice(0, wIndex) + target + slice.slice(wIndex + wrapped.length);
      }
      return slice.slice(0, index) + open + target + close + slice.slice(index + length);
    }
  }
}

/* ---- 右键格式菜单 ---- */

export interface MdMenuOp {
  op: MdOp;
  icon: React.ElementType;
  /** 按钮小字标签 */
  textKey: MessageKey;
  /** 悬停完整名称 */
  nameKey: MessageKey;
  /** 悬停标题附带的语法提示（如 ** / >） */
  syntax?: string;
}

export const MENU_SECTIONS: Array<{ labelKey: MessageKey; hint?: MessageKey; ops: MdMenuOp[] }> = [
  {
    labelKey: 'md.sectionHeading',
    ops: [
      { op: { kind: 'heading', level: 1 }, icon: Heading1, textKey: 'md.h1', nameKey: 'md.heading1' },
      { op: { kind: 'heading', level: 2 }, icon: Heading2, textKey: 'md.h2', nameKey: 'md.heading2' },
      { op: { kind: 'heading', level: 3 }, icon: Heading3, textKey: 'md.h3', nameKey: 'md.heading3' },
      { op: { kind: 'heading', level: 4 }, icon: Heading4, textKey: 'md.h4', nameKey: 'md.heading4' },
      { op: { kind: 'heading', level: 5 }, icon: Heading5, textKey: 'md.h5', nameKey: 'md.heading5' },
      { op: { kind: 'heading', level: 6 }, icon: Heading6, textKey: 'md.h6', nameKey: 'md.heading6' },
      { op: { kind: 'paragraph' }, icon: Pilcrow, textKey: 'md.bodyText', nameKey: 'md.paragraph' },
    ],
  },
  {
    labelKey: 'md.sectionInline',
    ops: [
      { op: { kind: 'bold' }, icon: Bold, textKey: 'md.bold', nameKey: 'md.bold', syntax: '**' },
      { op: { kind: 'italic' }, icon: Italic, textKey: 'md.italic', nameKey: 'md.italic', syntax: '*' },
      { op: { kind: 'strike' }, icon: Strikethrough, textKey: 'md.strike', nameKey: 'md.strike', syntax: '~~' },
      { op: { kind: 'inlineCode' }, icon: Code, textKey: 'md.inlineCode', nameKey: 'md.inlineCode', syntax: '`' },
    ],
  },
  {
    labelKey: 'md.sectionBlock',
    ops: [
      { op: { kind: 'quote' }, icon: TextQuote, textKey: 'md.quote', nameKey: 'md.quote', syntax: '>' },
      { op: { kind: 'ul' }, icon: List, textKey: 'md.ul', nameKey: 'md.ul', syntax: '-' },
      { op: { kind: 'ol' }, icon: ListOrdered, textKey: 'md.ol', nameKey: 'md.ol', syntax: '1.' },
      { op: { kind: 'task' }, icon: ListTodo, textKey: 'md.task', nameKey: 'md.task', syntax: '- [ ]' },
      { op: { kind: 'codeBlock' }, icon: Braces, textKey: 'md.codeBlock', nameKey: 'md.codeBlock', syntax: '```' },
    ],
  },
  {
    labelKey: 'md.sectionInsert',
    ops: [
      { op: { kind: 'link' }, icon: Link2, textKey: 'md.link', nameKey: 'md.link', syntax: '[]()' },
      { op: { kind: 'hr' }, icon: Minus, textKey: 'md.hr', nameKey: 'md.hr', syntax: '---' },
    ],
  },
  {
    labelKey: 'md.sectionTabs',
    hint: 'md.sectionTabsHint',
    ops: [
      { op: { kind: 'tabGroup' }, icon: Layers, textKey: 'md.tabGroup', nameKey: 'md.tabGroupName' },
      { op: { kind: 'tabStart' }, icon: PanelTop, textKey: 'md.tabStart', nameKey: 'md.tabStartName', syntax: '<!-- tab: -->' },
      { op: { kind: 'tabEnd' }, icon: PanelBottom, textKey: 'md.tabEnd', nameKey: 'md.tabEndName', syntax: '<!-- /tab -->' },
      { op: { kind: 'tabClear' }, icon: Eraser, textKey: 'md.tabClear', nameKey: 'md.tabClearName' },
    ],
  },
];

export interface MenuState {
  x: number;
  y: number;
  text: string;
}

export const FormatMenu = React.memo<{
  menu: MenuState;
  isDarkMode: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onApply: (op: MdOp) => void;
  onClose: () => void;
}>(({ menu, isDarkMode, canUndo, canRedo, onUndo, onRedo, onApply, onClose }) => {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);

  /* 点击外部（pointerdown 覆盖触屏）/ Esc / 滚动 / 调整窗口时关闭 */
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

  /* 视口内夹紧，避免菜单溢出屏幕；小屏（横屏手机）允许内部滚动 */
  const MENU_W = 272;
  const MENU_H = 500;
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_W - 8));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - MENU_H - 8));

  const itemBase = "flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors";
  const itemTone = isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600";

  return (
    <div
      ref={ref}
      className={cn(
        "fixed z-[90] rounded-xl border shadow-xl backdrop-blur-md p-2 flex flex-col gap-1.5 select-none overflow-y-auto",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
      )}
      style={{ left, top, width: MENU_W, maxHeight: 'calc(100dvh - 8px)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {(onUndo || onRedo) && (
        <>
          <div className={cn("text-[9px] font-semibold tracking-wider px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            {t('md.sectionEdit')}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              title={`${t('menu.undo')} (Ctrl+Z)`}
              className={cn(itemBase, itemTone, !canUndo && "opacity-40 pointer-events-none")}
            >
              <Undo2 size={14} />
              <span className="text-[9px] leading-none whitespace-nowrap">{t('menu.undo')}</span>
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              title={`${t('menu.redo')} (Ctrl+Y)`}
              className={cn(itemBase, itemTone, !canRedo && "opacity-40 pointer-events-none")}
            >
              <Redo2 size={14} />
              <span className="text-[9px] leading-none whitespace-nowrap">{t('menu.redo')}</span>
            </button>
          </div>
          <div className={cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
        </>
      )}
      {MENU_SECTIONS.map((section, si) => (
        <React.Fragment key={section.labelKey}>
          {si > 0 && <div className={cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />}
          <div className={cn("text-[9px] font-semibold tracking-wider px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            {t(section.labelKey)}
          </div>
          {section.hint && (
            <div className={cn("text-[9px] leading-snug px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
              {t(section.hint)}
            </div>
          )}
          <div className="grid grid-cols-7 gap-0.5">
            {section.ops.map(({ op, icon: Icon, textKey, nameKey, syntax }) => (
              <button
                key={nameKey}
                onClick={() => onApply(op)}
                title={`${t(nameKey)}${syntax ? ` ${syntax}` : ''}`}
                className={cn(
                  itemBase,
                  itemTone
                )}
              >
                <Icon size={14} />
                <span className="text-[9px] leading-none whitespace-nowrap">{t(textKey)}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
});

FormatMenu.displayName = 'FormatMenu';
