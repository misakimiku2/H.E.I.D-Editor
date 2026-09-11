import React, { useEffect, useRef } from 'react';
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Pilcrow,
  Bold, Italic, Strikethrough, Code, TextQuote,
  List, ListOrdered, ListTodo, Braces, Link2,
  Minus, Undo2, Redo2,
} from 'lucide-react';
import { cn } from '../lib/utils';

/* ---- markdown 快捷格式化：预览选区与源码编辑器选区共用的转换与菜单 ---- */

export type MdOp =
  | { kind: 'heading'; level: number }
  | { kind: 'paragraph' }
  | { kind: 'bold' } | { kind: 'italic' } | { kind: 'strike' } | { kind: 'inlineCode' }
  | { kind: 'link' } | { kind: 'image' }
  | { kind: 'quote' } | { kind: 'ul' } | { kind: 'ol' } | { kind: 'task' }
  | { kind: 'codeBlock' } | { kind: 'table' } | { kind: 'hr' };

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

const TABLE_TEMPLATE = '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |';

/* 对单个源码片段套用操作，返回替换后的文本 */
export function transformSlice(op: MdOp, slice: string, selectedText: string): string {
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
      return slice.trimEnd() + '\n\n' + TABLE_TEMPLATE;
    case 'hr':
      return slice.trimEnd() + '\n\n---';
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

export const MENU_SECTIONS: Array<{ label: string; ops: Array<{ op: MdOp; icon: React.ElementType; title: string; text: string }> }> = [
  {
    label: '标题',
    ops: [
      { op: { kind: 'heading', level: 1 }, icon: Heading1, title: '一级标题', text: 'H1' },
      { op: { kind: 'heading', level: 2 }, icon: Heading2, title: '二级标题', text: 'H2' },
      { op: { kind: 'heading', level: 3 }, icon: Heading3, title: '三级标题', text: 'H3' },
      { op: { kind: 'heading', level: 4 }, icon: Heading4, title: '四级标题', text: 'H4' },
      { op: { kind: 'heading', level: 5 }, icon: Heading5, title: '五级标题', text: 'H5' },
      { op: { kind: 'heading', level: 6 }, icon: Heading6, title: '六级标题', text: 'H6' },
      { op: { kind: 'paragraph' }, icon: Pilcrow, title: '正文段落', text: '正文' },
    ],
  },
  {
    label: '行内格式',
    ops: [
      { op: { kind: 'bold' }, icon: Bold, title: '粗体 **', text: '粗体' },
      { op: { kind: 'italic' }, icon: Italic, title: '斜体 *', text: '斜体' },
      { op: { kind: 'strike' }, icon: Strikethrough, title: '删除线 ~~', text: '删除线' },
      { op: { kind: 'inlineCode' }, icon: Code, title: '行内代码 `', text: '行内码' },
    ],
  },
  {
    label: '块级格式',
    ops: [
      { op: { kind: 'quote' }, icon: TextQuote, title: '引用 >', text: '引用' },
      { op: { kind: 'ul' }, icon: List, title: '无序列表 -', text: '无序' },
      { op: { kind: 'ol' }, icon: ListOrdered, title: '有序列表 1.', text: '有序' },
      { op: { kind: 'task' }, icon: ListTodo, title: '任务列表 - [ ]', text: '任务' },
      { op: { kind: 'codeBlock' }, icon: Braces, title: '代码块 ```', text: '代码块' },
    ],
  },
  {
    label: '插入',
    ops: [
      { op: { kind: 'link' }, icon: Link2, title: '链接 []()', text: '链接' },
      { op: { kind: 'hr' }, icon: Minus, title: '分割线 ---', text: '分割线' },
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
  const MENU_H = 395;
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_W - 8));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - MENU_H - 8));

  const itemBase = "flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors";
  const itemTone = isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600";

  return (
    <div
      ref={ref}
      className={cn(
        "fixed z-[90] rounded-xl border shadow-xl p-2 flex flex-col gap-1.5 select-none overflow-y-auto",
        isDarkMode ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-white"
      )}
      style={{ left, top, width: MENU_W, maxHeight: 'calc(100dvh - 8px)' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {(onUndo || onRedo) && (
        <>
          <div className={cn("text-[9px] font-semibold tracking-wider px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            编辑
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              title="撤销 (Ctrl+Z)"
              className={cn(itemBase, itemTone, !canUndo && "opacity-40 pointer-events-none")}
            >
              <Undo2 size={14} />
              <span className="text-[9px] leading-none whitespace-nowrap">撤销</span>
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              title="重做 (Ctrl+Y)"
              className={cn(itemBase, itemTone, !canRedo && "opacity-40 pointer-events-none")}
            >
              <Redo2 size={14} />
              <span className="text-[9px] leading-none whitespace-nowrap">重做</span>
            </button>
          </div>
          <div className={cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
        </>
      )}
      {MENU_SECTIONS.map((section, si) => (
        <React.Fragment key={section.label}>
          {si > 0 && <div className={cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />}
          <div className={cn("text-[9px] font-semibold tracking-wider px-0.5", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            {section.label}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {section.ops.map(({ op, icon: Icon, title, text }) => (
              <button
                key={title}
                onClick={() => onApply(op)}
                title={title}
                className={cn(
                  itemBase,
                  itemTone
                )}
              >
                <Icon size={14} />
                <span className="text-[9px] leading-none whitespace-nowrap">{text}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
});

FormatMenu.displayName = 'FormatMenu';
