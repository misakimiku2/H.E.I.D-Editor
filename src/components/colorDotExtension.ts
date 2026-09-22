/**
 * 颜色圆点扩展：在可见视口内的颜色字面量前内联插入一个色样圆点（Widget 装饰），
 * 点击圆点回调 onOpen({from, to})（取色器浮层由 React 层渲染，见 ColorPickerPopover）。
 * 扫描只覆盖可见视口，成本与文档大小无关；文档/视口变化经 rAF 去重后重扫。
 */
import { EditorView, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { type EditorState, type Extension, type Range } from '@codemirror/state';
import { findColorLiterals } from '../lib/colorLiteral';
import { cssColor, type Rgba } from '../lib/colorMath';

const DOT_CLASS = 'cm-colorDot';

class ColorDotWidget extends WidgetType {
  constructor(
    private readonly color: Rgba,
    /** 圆点对应的颜色字面量区间；eq 参与比较，编辑导致位置移动时会重建 DOM（dataset 保持最新） */
    private readonly from: number,
    private readonly to: number,
  ) { super(); }

  eq(other: ColorDotWidget): boolean {
    return other.from === this.from && other.to === this.to
      && other.color.r === this.color.r && other.color.g === this.color.g
      && other.color.b === this.color.b && other.color.a === this.color.a;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = DOT_CLASS;
    el.dataset.colorFrom = String(this.from);
    el.dataset.colorTo = String(this.to);
    el.title = cssColor(this.color);
    Object.assign(el.style, {
      display: 'inline-block',
      width: '0.85em',
      height: '0.85em',
      boxSizing: 'border-box',
      borderRadius: '50%',
      backgroundColor: cssColor(this.color),
      border: '1px solid rgba(128, 128, 128, 0.6)',
      marginRight: '0.2em',
      verticalAlign: '-0.08em',
      cursor: 'pointer',
    });
    return el;
  }

  ignoreEvent(): boolean { return false; }
}

export interface ColorDotOptions {
  /** 点击圆点时回调（只读模式下接线层自行决定是否响应） */
  onOpen: (view: EditorView, range: { from: number; to: number }) => void;
}

export function colorDotExtension(options: ColorDotOptions): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;

    constructor(private readonly view: EditorView) {
      this.scan();
    }

    update(update: ViewUpdate) {
      /* 必须在 update 周期内同步重扫：decorations 字段在周期外变更不会触发 CM 重绘 */
      if (update.docChanged || update.viewportChanged) this.scan();
    }

    private scan() {
      const view = this.view;
      const widgets: Range<Decoration>[] = [];
      for (const range of view.visibleRanges) {
        const text = view.state.sliceDoc(range.from, range.to);
        for (const lit of findColorLiterals(text)) {
          const from = range.from + lit.from;
          const to = range.from + lit.to;
          widgets.push(Decoration.widget({ widget: new ColorDotWidget(lit.rgba, from, to), side: -1 }).range(from));
        }
      }
      this.decorations = widgets.length ? Decoration.set(widgets, true) : Decoration.none;
    }
  }, {
    decorations: v => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        const dot = target?.closest?.(`.${DOT_CLASS}`) as HTMLElement | null;
        if (!dot) return false;
        const from = Number(dot.dataset.colorFrom);
        const to = Number(dot.dataset.colorTo);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
        event.preventDefault();
        options.onOpen(view, { from, to });
        return true;
      },
    },
  });
  return plugin;
}

/**
 * 选区 [from,to) 压在哪个颜色字面量上，就返回**整条**字面量的区间。
 * 触屏长按只会选中 `ff6a00` 这样的词（不含 `#`），所以按重叠找、按整条回——
 * 取色器要改写的是完整字面量，不是选中的那截。
 */
export function colorLiteralCovering(
  state: EditorState, from: number, to: number,
): { from: number; to: number } | null {
  const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let n = state.doc.lineAt(from).number; n <= lastLine; n++) {
    const ln = state.doc.line(n);
    for (const lit of findColorLiterals(ln.text)) {
      const l = ln.from + lit.from;
      const r = ln.from + lit.to;
      if (l < to && r > from) return { from: l, to: r };
    }
  }
  return null;
}
