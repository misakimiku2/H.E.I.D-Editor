import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Pilcrow,
  Bold, Italic, Strikethrough, Code, TextQuote,
  List, ListOrdered, ListTodo, Braces, Link2,
  Minus, Undo2, Redo2,
  Layers, PanelTop, PanelBottom, Eraser,
  Highlighter, Superscript, Subscript, Sigma, Footprints, Workflow,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useT, type MessageKey } from '../lib/i18nContext';
import { MARK_COLORS } from '../lib/remarkExt';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

/* ---- markdown 快捷格式化：预览/源码编辑器右键菜单共用的转换与菜单 ---- */

export type MdOp =
  | { kind: 'heading'; level: number }
  | { kind: 'paragraph' }
  | { kind: 'bold' } | { kind: 'italic' } | { kind: 'strike' } | { kind: 'inlineCode' }
  | { kind: 'link' } | { kind: 'image' }
  | { kind: 'mark'; color?: string } | { kind: 'sup' } | { kind: 'sub' } | { kind: 'math' }
  | { kind: 'quote' } | { kind: 'ul' } | { kind: 'ol' } | { kind: 'task' }
  | { kind: 'codeBlock' } | { kind: 'table' } | { kind: 'hr' } | { kind: 'footnote' }
  | { kind: 'mermaid' }
  | { kind: 'tabGroup' } | { kind: 'tabStart' } | { kind: 'tabEnd' } | { kind: 'tabClear' };

/* 行内标记 → 包裹符；链接/图片单独处理。
   mark/sup/sub/math 为预览扩展语法（==高亮==/^上标^/~下标~/$公式$）；
   mark 只用于「行内操作」判定，包裹/换色逻辑在 transformSlice 的专用分支 */
export const INLINE_WRAPS: Partial<Record<MdOp['kind'], [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  inlineCode: ['`', '`'],
  mark: ['==', '=='],
  sup: ['^', '^'],
  sub: ['~', '~'],
  math: ['$', '$'],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 去掉行首的块级标记（标题/引用/列表），方便转换成其他块级语法 */
const stripBlockPrefix = (line: string): string =>
  line.replace(/^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '$1');

/* 在源码片段里定位选中文本；渲染文本与源码空白不一致时按空白归一匹配 */
export function findInSlice(slice: string, text: string): { index: number; length: number } | null {
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

const MERMAID_TEMPLATE_ZH = '```mermaid\nflowchart TD\n    A[开始] --> B{判断?}\n    B -->|是| C[处理]\n    B -->|否| D[结束]\n```';

/* 对单个源码片段套用操作，返回替换后的文本；tableTemplate/mermaidTemplate 供 i18n
   覆盖（缺省中文默认）。tabGroup 不在此处理：整段选区→一个页签的变换见 lib/markdownTabs */
export function transformSlice(op: MdOp, slice: string, selectedText: string, tableTemplate = TABLE_TEMPLATE_ZH, mermaidTemplate = MERMAID_TEMPLATE_ZH): string {
  switch (op.kind) {
    case 'tabGroup':
    case 'footnote':
      /* tabGroup：调用方（预览/编辑器）改走 lib/markdownTabs 的整段选区→一个页签变换；
         footnote：调用方用 footnoteEdit 插标记并在文末生成定义。均不应到达这里 */
      return slice;
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
    case 'mermaid':
      return slice.trimEnd() + '\n\n' + mermaidTemplate;
    case 'hr':
      return slice.trimEnd() + '\n\n---';
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
    case 'mark': {
      /* 高亮：==文字== / ==色:文字==。紧贴选区的旧高亮（可带颜色前缀）整体吞掉——
         换不同色直接换色，同色再点一次取消高亮 */
      const color = op.color && (MARK_COLORS as readonly string[]).includes(op.color) ? op.color : '';
      const prefix = color ? `${color}:` : '';
      const found = findInSlice(slice, selectedText);
      const start = found ? found.index : 0;
      const end = start + (found ? found.length : slice.replace(/^\n+|\n+$/g, '').length);
      const target = slice.slice(start, end);
      if (!target.trim()) return slice;
      const before = slice.slice(0, start);
      const after = slice.slice(end);
      const mb = /==(?:[a-z]+:)?$/.exec(before);
      const ma = /^(?:[a-z]+:)?==/.exec(after);
      if (mb && ma) {
        const oldPrefix = mb[0].slice(2);
        const head = before.slice(0, mb.index);
        const tail = after.slice(ma[0].length);
        return oldPrefix === prefix
          ? head + target + tail
          : head + `==${prefix}${target}==` + tail;
      }
      return before + `==${prefix}${target}==` + after;
    }
    case 'link':
    case 'image':
    case 'bold':
    case 'italic':
    case 'strike':
    case 'inlineCode':
    case 'sup':
    case 'sub':
    case 'math': {
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

/** 脚注：在选中文本之后插入 [^n] 标记，并在文末追加定义行。
 *  返回两处插入点（全文坐标，defAt ≥ markerAt）与内容，调用方自行拼接/分发 */
export function footnoteEdit(
  content: string,
  range: { start: number; end: number },
  selectedText: string,
): { markerAt: number; marker: string; def: string; defAt: number } {
  const num = (content.match(/\[\^\d+\]:/g) || []).length + 1;
  const found = findInSlice(content.slice(range.start, range.end), selectedText);
  const marker = `[^${num}]`;
  /* 文末定义追去掉尾随空行后追加，标记插入点不越过它 */
  const tail = content.replace(/\n+$/, '');
  return {
    markerAt: Math.min(found ? range.start + found.index + found.length : range.end, tail.length),
    marker,
    def: `\n\n[^${num}]: `,
    defAt: tail.length,
  };
}

export interface MdMenuOp {
  op: MdOp;
  icon: React.ElementType;
  /** 按钮小字标签 */
  textKey: MessageKey;
  /** 悬停完整名称 */
  nameKey: MessageKey;
  /** 悬停标题附带的语法提示（如 ** / >） */
  syntax?: string;
  /** 色块按钮：有值时用色点替代图标（高亮色板） */
  swatch?: string;
}

export const MENU_SECTIONS: Array<{ labelKey: MessageKey; ops: MdMenuOp[] }> = [
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
      { op: { kind: 'sup' }, icon: Superscript, textKey: 'md.sup', nameKey: 'md.supName', syntax: '^' },
      { op: { kind: 'sub' }, icon: Subscript, textKey: 'md.sub', nameKey: 'md.subName', syntax: '~' },
    ],
  },
  {
    labelKey: 'md.sectionMark',
    ops: [
      { op: { kind: 'mark' }, icon: Highlighter, swatch: '#fde047', textKey: 'md.markYellow', nameKey: 'md.markYellowName', syntax: '==' },
      { op: { kind: 'mark', color: 'red' }, icon: Highlighter, swatch: '#f87171', textKey: 'md.markRed', nameKey: 'md.markRedName', syntax: '==red:' },
      { op: { kind: 'mark', color: 'orange' }, icon: Highlighter, swatch: '#fb923c', textKey: 'md.markOrange', nameKey: 'md.markOrangeName', syntax: '==orange:' },
      { op: { kind: 'mark', color: 'green' }, icon: Highlighter, swatch: '#4ade80', textKey: 'md.markGreen', nameKey: 'md.markGreenName', syntax: '==green:' },
      { op: { kind: 'mark', color: 'blue' }, icon: Highlighter, swatch: '#60a5fa', textKey: 'md.markBlue', nameKey: 'md.markBlueName', syntax: '==blue:' },
      { op: { kind: 'mark', color: 'purple' }, icon: Highlighter, swatch: '#c084fc', textKey: 'md.markPurple', nameKey: 'md.markPurpleName', syntax: '==purple:' },
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
      { op: { kind: 'math' }, icon: Sigma, textKey: 'md.math', nameKey: 'md.mathName', syntax: '$' },
      { op: { kind: 'footnote' }, icon: Footprints, textKey: 'md.footnote', nameKey: 'md.footnoteName' },
      { op: { kind: 'mermaid' }, icon: Workflow, textKey: 'md.mermaid', nameKey: 'md.mermaidName', syntax: '```mermaid' },
    ],
  },
  {
    labelKey: 'md.sectionTabs',
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

/* 触屏变体：与桌面同一份弹层（跟随选区定位、同样的分区与命令），只把格子从
   40×47 放大到 ≥56dp、列数按视口收窄；桌面分支的类名与尺寸保持原样 */
const TOUCH = IS_TOUCH_PRIMARY;

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
  /* 菜单由选区工具条「更多」弹出时，抬手可能正好合成一次 click 落在刚出现的格子上
     （弹层锚在选区旁，手指就在那儿）。只认「挂载之后真实按下过」的点击，否则会顺手
     误执行一个格式化操作。按时间窗口（如 300ms）挡不住：按住 900ms 时合成点击落在
     挂载后 400ms。桌面 !TOUCH 直接视为已就绪，行为零变化 */
  const armedRef = useRef(!TOUCH);
  useEffect(() => {
    if (!TOUCH) return;
    const onDown = () => { armedRef.current = true; };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  const run = (fn?: () => void) => () => {
    if (!armedRef.current) return;
    fn?.();
  };

  /* 触屏：面板加宽、5~6 列、格子 ≥56dp；桌面维持 320px / 7 列原样。
     列数用内联样式给（Tailwind 无法生成动态类名） */
  const PANEL_W = TOUCH ? Math.min(468, window.innerWidth - 16) : 320;
  const COLS = TOUCH ? (window.innerWidth >= 560 ? 6 : 5) : 7;
  const gridCls = TOUCH ? "grid gap-1.5" : "grid grid-cols-7 gap-1";
  const gridStyle = TOUCH ? { gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` } : undefined;
  const itemBase = TOUCH
    ? "flex flex-col items-center justify-center gap-1.5 min-h-[56px] rounded-xl py-2 transition-colors"
    : "flex flex-col items-center justify-center gap-1 rounded-md py-2 transition-colors";
  const itemTone = isDarkMode ? "hover:bg-zinc-700 text-zinc-200" : "hover:bg-zinc-100 text-zinc-600";
  const sectionLabelCls = TOUCH
    ? "text-[11px] font-semibold tracking-wider px-1 mt-1"
    : "text-[10px] font-semibold tracking-wider px-0.5";
  const labelCls = TOUCH
    ? "text-[13px] leading-tight text-center"
    : "text-[11px] leading-none whitespace-nowrap";
  const iconSize = TOUCH ? 22 : 16;
  const swatchCls = TOUCH ? "w-6 h-6 rounded-full shrink-0" : "w-4 h-4 rounded-full shrink-0";
  const sectionTone = isDarkMode ? "text-zinc-400" : "text-zinc-500";
  /* 触屏靠分区标题本身分隔、并省掉分隔线，压缩总高让 35 个命令尽量一屏放完 */
  const sepCls = cn("h-px mx-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200");

  const sections = (
    <>
      {(onUndo || onRedo) && (
        <>
          <div className={cn(sectionLabelCls, sectionTone)}>{t('md.sectionEdit')}</div>
          <div className={gridCls} style={gridStyle}>
            <button
              onClick={run(onUndo)}
              disabled={!canUndo}
              title={`${t('menu.undo')} (Ctrl+Z)`}
              className={cn(itemBase, itemTone, !canUndo && "opacity-40 pointer-events-none")}
            >
              <Undo2 size={iconSize} />
              <span className={labelCls}>{t('menu.undo')}</span>
            </button>
            <button
              onClick={run(onRedo)}
              disabled={!canRedo}
              title={`${t('menu.redo')} (Ctrl+Y)`}
              className={cn(itemBase, itemTone, !canRedo && "opacity-40 pointer-events-none")}
            >
              <Redo2 size={iconSize} />
              <span className={labelCls}>{t('menu.redo')}</span>
            </button>
          </div>
          {!TOUCH && <div className={sepCls} />}
        </>
      )}
      {MENU_SECTIONS.map((section, si) => (
        <React.Fragment key={section.labelKey}>
          {!TOUCH && si > 0 && <div className={sepCls} />}
          <div className={cn(sectionLabelCls, sectionTone)}>{t(section.labelKey)}</div>
          <div className={gridCls} style={gridStyle}>
            {section.ops.map(({ op, icon: Icon, textKey, nameKey, syntax, swatch }) => (
              <button
                key={nameKey}
                onClick={run(() => onApply(op))}
                title={`${t(nameKey)}${syntax ? ` ${syntax}` : ''}`}
                className={cn(itemBase, itemTone)}
              >
                {swatch ? (
                  <span
                    className={swatchCls}
                    style={{
                      backgroundColor: swatch,
                      boxShadow: isDarkMode
                        ? 'inset 0 0 0 1px rgba(255,255,255,0.22)'
                        : 'inset 0 0 0 1px rgba(0,0,0,0.14)',
                    }}
                  />
                ) : (
                  <Icon size={iconSize} />
                )}
                <span className={labelCls}>{t(textKey)}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </>
  );

  /* 视口内夹紧。桌面沿用原有的固定估算（560），行为不变。
     触屏不行：格子高度随系统字号变化（实测同一份内容 1.0 时面板 730、1.3 时 792），
     任何固定估算都会估小，把底部几行顶到屏幕外——面板自身 maxHeight 只到
     视口高减 8（.heid-panel-fit），超出部分连内部滚动都滚不到。所以先按触发点放，再用真实渲染
     尺寸在 layout 阶段校正一次（useLayoutEffect 在绘制前跑，不会闪）。 */
  const [touchPos, setTouchPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!TOUCH) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nextTop = Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 8));
    const nextLeft = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 8));
    setTouchPos(p => (p && p.top === nextTop && p.left === nextLeft ? p : { top: nextTop, left: nextLeft }));
  }, [menu.x, menu.y]);

  const left = touchPos?.left ?? Math.max(4, Math.min(menu.x, window.innerWidth - PANEL_W - 8));
  const top = touchPos?.top ?? Math.max(4, Math.min(menu.y, window.innerHeight - 560 - 8));

  return (
    <div
      ref={ref}
      className={cn(
        "fixed z-[90] rounded-xl border shadow-xl backdrop-blur-md p-2 flex flex-col gap-1.5 select-none overflow-y-auto heid-panel-fit",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/70" : "border-zinc-200/80 bg-white/70"
      )}
      style={{ left, top, width: PANEL_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sections}
    </div>
  );
});

FormatMenu.displayName = 'FormatMenu';
