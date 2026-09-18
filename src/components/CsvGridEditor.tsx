import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Filter, StretchHorizontal, WrapText, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { clipboardReadPermissionState } from '../lib/fileOps';
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from './ContextMenu';
import {
  clearCells, computeRowOrder, deleteCols, deleteRows, estimateColumnWidths, estimateWrappedLines, fillInto,
  insertColAfter, insertColBefore, insertRowAbove, insertRowBelow, moveCol, moveRow,
  parseClipboardTable, parseCsv, selectionToTsv, serializeCsv, setCells, swapCols, swapRows,
  type CsvDelimiter, type CsvSortState, type GridRect,
} from '../lib/csv';

/**
 * CSV 网格编辑器：tab.content 字符串的"工作视图"。
 * 组件不拥有数据——解析出 string[][] 渲染，任何编辑都经纯函数变换后
 * serializeCsv 回传 onChange（对接 updateTabContent，撤销/脏标记/diff 时间线自动生效）。
 * 行虚拟滚动（只渲染可视区±缓冲），列标/行号 CSS sticky；列不虚拟化。
 */

/** 缺省数据行行高；列标行（HEADER_H）固定不随行高缩放 */
const DEFAULT_ROW_H = 28;
const ROW_NUM_W = 48;
const HEADER_H = 28;
/** 行高拖拽的上下限（px） */
const MIN_ROW_H = 16;
const MAX_ROW_H = 400;
/** 「自适应表格大小」的内容宽度封顶（显示宽单位）：默认自适应首开时封顶 40 防
    超宽首屏，按钮是显式请求，给到能包住长文本的量级 */
const FIT_WIDTH_MAX = 200;
/** 换行文本的每行像素高（text-xs 口径），自适应行高与换行单元格行距共用 */
const FIT_LINE_H = 20;
const GHOST_ROWS = 30;
const GHOST_COLS = 8;
const OVERSCAN = 10;
/** 列宽单位（约 1 字符显示宽）对应像素；单位语义见 csv.ts estimateColumnWidths */
const PX_PER_UNIT = 8;
const CELL_PAD_X = 8;
const MIN_COL_UNITS = 3;
/** 手动列宽哨兵：恢复自适应 */
const AUTO_W = -1;
/** 拖拽落点热区：距列间/行间网格线 N px 内 = 插入式移动，否则 = 与该列/行互换。
    行高仅 28px，行向热区取小值给互换留出中部空间 */
const COL_LINE_EDGE = 8;
const ROW_LINE_EDGE = 5;

export interface CsvGridEditorProps {
  content: string;
  delimiter: CsvDelimiter;
  isDarkMode: boolean;
  headerOn: boolean;
  readOnly?: boolean;
  /** 手动列宽（显示宽单位，tab.csvColWidths；AUTO_W=恢复自适应）；未提供的列用自适应值 */
  manualWidths?: number[];
  /** 手动行高（按显示行下标，px；tab.csvRowHeights；缺省/0=用默认 rowH） */
  manualRowHeights?: number[];
  /** 数据行行高（px）；缺省 28（tab.csvRowH） */
  rowH?: number;
  /** 单元格内容自动换行（tab.csvWrap）；换行时行内多行按 FIT_LINE_H 排布 */
  wrap?: boolean;
  onChange: (content: string) => void;
  onHeaderToggle: (on: boolean) => void;
  onWidthsChange: (w: number[]) => void;
  onRowHChange?: (h: number) => void;
  onRowHeightsChange?: (hs: number[]) => void;
  onWrapChange?: (on: boolean) => void;
  /** 数据区行列数（供状态栏展示）；第三参为排序/筛选下的可见行数（缺省同 rows） */
  onShape?: (rows: number, cols: number, visibleRows?: number) => void;
}

type CellPos = { r: number; c: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sameRect = (a: GridRect, b: GridRect) =>
  a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
const inRect = (rg: GridRect, r: number, c: number) =>
  r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2;

/** 列号 → 表格软件记法（0→A, 25→Z, 26→AA） */
export function colLabel(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}
export const cellAddr = (p: CellPos) => `${colLabel(p.c)}${p.r + 1}`;

const NUMERIC_CELL_RE = /^[+-]?\d+(?:\.\d+)?$/;

export const CsvGridEditor = React.memo<CsvGridEditorProps>(function CsvGridEditor({
  content, delimiter, isDarkMode, headerOn, readOnly = false,
  manualWidths, manualRowHeights, rowH = 28, wrap = false, onChange, onHeaderToggle,
  onWidthsChange, onRowHChange, onRowHeightsChange, onWrapChange, onShape,
}) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const proxyRef = useRef<HTMLTextAreaElement | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const formulaInputRef = useRef<HTMLTextAreaElement | null>(null);
  /* 填充拖拽中的目标块：ref 供 mouseup 读取，避免在 setState 更新器里做提交副作用 */
  const fillRectRef = useRef<GridRect | null>(null);
  /* 拖拽框选进行中标记（window 级 mousemove 扩展选区） */
  const dragSelectingRef = useRef(false);

  /* ---- 数据派生 ---- */
  const grid = useMemo(() => parseCsv(content, delimiter), [content, delimiter]);
  const dataRows = grid.length;
  const dataCols = useMemo(() => grid.reduce((m, r) => Math.max(m, r.length), 0), [grid]);

  /* ---- 只读态排序 / 筛选（视图变换，不改写数据） ---- */
  const [sort, setSort] = useState<CsvSortState | null>(null);
  const [filter, setFilter] = useState('');
  const viewOrder = useMemo(
    () => computeRowOrder(grid, { sort, filter, headerOn }),
    [grid, sort, filter, headerOn],
  );
  const viewTransformed = !!sort || filter.trim() !== '';
  /* 显示行 → 原始行（未变换时恒等） */
  const origRow = useCallback((r: number): number =>
    viewTransformed ? (viewOrder[r] ?? r) : r, [viewTransformed, viewOrder]);

  const totalRows = viewTransformed ? viewOrder.length : Math.max(dataRows + 1, GHOST_ROWS);
  const totalCols = Math.max(dataCols + 1, GHOST_COLS);

  useEffect(() => {
    onShape?.(dataRows, dataCols, viewTransformed ? viewOrder.length - (headerOn ? 1 : 0) : dataRows);
  }, [dataRows, dataCols, viewTransformed, viewOrder, headerOn, onShape]);

  const autoUnits = useMemo(() => estimateColumnWidths(grid), [grid]);
  const colUnits = useMemo(
    () => Array.from({ length: totalCols }, (_, c) => {
      const manual = manualWidths?.[c];
      return manual && manual > 0 ? manual : autoUnits[c] ?? 6;
    }),
    [autoUnits, manualWidths, totalCols],
  );
  const colLeft = useMemo(() => {
    const acc = [0];
    for (let c = 0; c < totalCols; c++) acc.push(acc[c] + colUnits[c] * PX_PER_UNIT + CELL_PAD_X * 2);
    return acc;
  }, [colUnits]);
  const gridWidth = colLeft[totalCols];

  /* ---- 选区与编辑状态 ---- */
  const [anchor, setAnchor] = useState<CellPos>({ r: 0, c: 0 });
  const [focus, setFocus] = useState<CellPos>({ r: 0, c: 0 });
  /* src 记录编辑从哪发起：cell=单元格内输入框，bar=顶部编辑栏。
     两处入口共用同一份编辑值；焦点接管/blur 提交语义都靠它区分 */
  const [editing, setEditing] = useState<{ r: number; c: number; value: string; src: 'cell' | 'bar' } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [fillDrag, setFillDrag] = useState<GridRect | null>(null);
  /* 列/行拖拽进行中：kind 维度、mode 落在列/行上（swap 互换）还是网格线上（insert 插入）、
     from 源下标、to 目标（swap=目标下标，insert=插入边界下标） */
  const [swapDrag, setSwapDrag] = useState<{
    kind: 'row' | 'col'; mode: 'swap' | 'insert'; from: number; to: number;
  } | null>(null);
  const [widthDrag, setWidthDrag] = useState<{ c: number; units: number } | null>(null);
  /* 行高拖拽中的本地预览（松手提交 onRowHeightsChange） */
  const [rowHeightDrag, setRowHeightDrag] = useState<{ r: number; h: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  const rect: GridRect = useMemo(() => ({
    r1: Math.min(anchor.r, focus.r), c1: Math.min(anchor.c, focus.c),
    r2: Math.max(anchor.r, focus.r), c2: Math.max(anchor.c, focus.c),
  }), [anchor, focus]);
  /* ---- Ctrl 多选：rect 是主选区（anchor/focus 派生，承接键盘导航与编辑），
     extraRanges 是 Ctrl 点选/拖出的附加选区；高亮、复制、清除作用于全部选区 ---- */
  const [extraRanges, setExtraRanges] = useState<GridRect[]>([]);
  const allRanges = useMemo(
    () => [rect, ...extraRanges.filter(rg => !sameRect(rg, rect))],
    [rect, extraRanges],
  );
  const allRangesRef = useRef(allRanges);
  allRangesRef.current = allRanges;
  const single = allRanges.length === 1 && rect.r1 === rect.r2 && rect.c1 === rect.c2;
  /* 剪贴板/清除/增删行列等操作经 ref 读选区：右键菜单先收拢选区再弹菜单，
     回调触发时（点击菜单项）读到的已是新选区，而不是菜单创建时的闭包旧值 */
  const rectRef = useRef(rect);
  rectRef.current = rect;
  /* editing 镜像：拖拽收尾的 rAF 与 blur 回调触发时读最新编辑态（闭包里是旧值） */
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** 网格收回键盘焦点。双击的第二下 mouseup 先于 dblclick 注册 rAF，而浏览器把
      mousedown/mouseup/click/dblclick 同批派发——rAF 会在编辑框拿到焦点之后才跑，
      此刻若编辑已开启必须让位，否则 wrapper.focus() 抢走焦点 → blur → 编辑框闪现即关 */
  const refocusGridSoon = useCallback(() => {
    requestAnimationFrame(() => { if (!editingRef.current) wrapperRef.current?.focus(); });
  }, []);

  /* ---- 行高基础：逐行高度（manualRowHeights，0/缺省=默认 rowH；拖拽中优先取预览值）
     与行顶位置前缀和（虚拟滚动、命中、拖拽指示都以此为基准） ---- */
  const rowHeightOf = useCallback((r: number) => {
    if (rowHeightDrag && rowHeightDrag.r === r) return rowHeightDrag.h;
    const h = manualRowHeights?.[r];
    return h && h > 0 ? h : rowH;
  }, [manualRowHeights, rowH, rowHeightDrag]);
  const rowTops = useMemo(() => {
    const tops: number[] = new Array(totalRows + 1).fill(0);
    for (let r = 0; r < totalRows; r++) tops[r + 1] = tops[r] + rowHeightOf(r);
    return tops;
  }, [totalRows, rowHeightOf]);
  /** y（网格内容坐标）→ 所在行：最大的 r 使 rowTops[r] <= y */
  const rowAtY = useCallback((y: number) => {
    let lo = 0, hi = totalRows - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rowTops[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }, [rowTops, totalRows]);

  /* ---- 提交管道：网格变换 → 序列化 → onChange ---- */
  const commitGrid = useCallback((next: string[][]) => {
    onChange(serializeCsv(next, delimiter));
  }, [onChange, delimiter]);

  const setCell = useCallback((r: number, c: number, value: string) => {
    const or = origRow(r); // 排序/筛选态：显示行 → 原始行
    if ((grid[or]?.[c] ?? '') === value) return;
    commitGrid(setCells(grid, { r1: or, c1: c, r2: or, c2: c }, [[value]]));
  }, [grid, commitGrid, origRow]);

  const ensureVisible = useCallback((p: CellPos) => {
    const vp = viewportRef.current;
    if (!vp) return;
    /* 顶部 sticky 覆盖高度：列标 + （可选）表头行 */
    const overlay = HEADER_H + (headerOn ? rowTops[1] : 0);
    const top = HEADER_H + rowTops[p.r];
    const bottom = rowTops[p.r + 1];
    if (top - vp.scrollTop < overlay) vp.scrollTop = Math.max(0, top - overlay);
    else if (bottom - vp.scrollTop > vp.clientHeight) vp.scrollTop = bottom - vp.clientHeight;
    const left = colLeft[p.c];
    const right = colLeft[p.c + 1];
    if (left - vp.scrollLeft < ROW_NUM_W) vp.scrollLeft = Math.max(0, left - ROW_NUM_W);
    else if (right - vp.scrollLeft > vp.clientWidth) vp.scrollLeft = right - vp.clientWidth;
  }, [colLeft, headerOn, rowTops]);

  const moveFocus = useCallback((dr: number, dc: number, extend = false) => {
    const target = {
      r: clamp(focus.r + dr, 0, totalRows - 1),
      c: clamp(focus.c + dc, 0, totalCols - 1),
    };
    setFocus(target);
    if (!extend) setAnchor(target);
    ensureVisible(target);
  }, [focus, totalRows, totalCols, ensureVisible]);

  /* ---- 单元格编辑（单元格内输入框与编辑栏共用同一 editing 状态） ---- */
  const startEdit = useCallback((r: number, c: number, initial?: string) => {
    if (readOnly) return;
    /* src='cell'：布局副作用据此把焦点交给单元格输入框；
       值经 origRow 读原始行，排序/筛选态下双击表头行才不会取错 */
    setEditing({ r, c, value: initial ?? grid[origRow(r)]?.[c] ?? '', src: 'cell' });
    setAnchor({ r, c });
    setFocus({ r, c });
  }, [readOnly, grid, origRow]);

  /* refocusWrapper=false：blur 路径的提交不抢焦点，焦点去哪由用户的点击决定；
     只有焦点落空（点到不可聚焦处）时才由 blur 回调收回网格 */
  const commitEdit = useCallback((move: 'down' | 'right' | 'none', refocusWrapper = true) => {
    if (!editing) return;
    setCell(editing.r, editing.c, editing.value);
    setEditing(null);
    if (move === 'down') moveFocus(1, 0);
    if (move === 'right') moveFocus(0, 1);
    if (refocusWrapper) requestAnimationFrame(() => wrapperRef.current?.focus());
  }, [editing, setCell, moveFocus]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    requestAnimationFrame(() => wrapperRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    /* 只接管单元格内发起的编辑；编辑栏发起的（src='bar'）焦点本就在栏里，
       抢走会触发编辑栏 blur → 误提交并关框（打一个字就被提交、退格清空整格的根因） */
    if (editing && editing.src === 'cell') editInputRef.current?.focus();
  }, [editing?.r, editing?.c, editing?.src]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 剪贴板 ---- */
  const writeClipboard = useCallback((text: string) => {
    const proxy = proxyRef.current;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        if (proxy) {
          proxy.value = text;
          proxy.select();
          document.execCommand('copy');
          proxy.value = '';
        }
      });
    } else if (proxy) {
      proxy.value = text;
      proxy.select();
      document.execCommand('copy');
      proxy.value = '';
    }
  }, []);

  /* 多选区复制：各选区 TSV 块顺序拼接（与 Excel 多区复制口径一致） */
  const doCopy = useCallback(
    () => writeClipboard(allRangesRef.current.map(rg => selectionToTsv(grid, rg)).join('')),
    [writeClipboard, grid],
  );

  const doCut = useCallback(() => {
    if (readOnly || viewTransformed) return;
    writeClipboard(allRangesRef.current.map(rg => selectionToTsv(grid, rg)).join(''));
    commitGrid(allRangesRef.current.reduce((g, rg) => clearCells(g, rg), grid));
  }, [readOnly, viewTransformed, writeClipboard, grid, commitGrid]);

  const applyPasteText = useCallback((text: string) => {
    if (readOnly || viewTransformed || !text) return;
    const block = parseClipboardTable(text.replace(/\r\n?/g, '\n'));
    commitGrid(setCells(grid, rectRef.current, block));
    setExtraRanges([]); // 粘贴后选区收拢到主选区
  }, [readOnly, viewTransformed, grid, commitGrid]);

  /* 键盘 Ctrl+V 不在此拦截（那要走 readText，浏览器必弹授权框）：
     放行给原生 paste 事件，由 onWrapperPaste 免权限接住 */
  const doPaste = useCallback(() => {
    if (readOnly) return;
    const viaProxy = () => proxyRef.current?.focus();
    clipboardReadPermissionState().then((state) => {
      if (state === 'granted') navigator.clipboard.readText().then(applyPasteText).catch(viaProxy);
      else viaProxy();
    });
  }, [readOnly, viewTransformed, applyPasteText]);

  /* 原生 paste 事件（Ctrl+V 落在网格上时浏览器派发，clipboardData 免权限） */
  const onWrapperPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    /* 编辑态：粘贴交给单元格输入框/编辑栏的默认行为 */
    if (editing || readOnly) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    applyPasteText(text);
  }, [editing, readOnly, applyPasteText]);

  const onProxyPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    applyPasteText(e.clipboardData.getData('text/plain'));
    requestAnimationFrame(() => wrapperRef.current?.focus());
  }, [applyPasteText]);

  /* ---- 清空选区（Delete/Backspace/右键菜单；多选区逐一清空）/ Ctrl+Enter 铺满 ---- */
  const clearSelection = useCallback(() => {
    if (viewTransformed) return; // 排序/筛选态禁用结构操作（单元格内容编辑仍可用）
    const ranges = allRangesRef.current;
    if (ranges.length === 1 && ranges[0].r1 === ranges[0].r2 && ranges[0].c1 === ranges[0].c2) {
      setCell(ranges[0].r1, ranges[0].c1, '');
      return;
    }
    commitGrid(ranges.reduce((g, rg) => clearCells(g, rg), grid));
  }, [viewTransformed, grid, commitGrid, setCell]);

  const fillSelectionWithValue = useCallback((value: string) => {
    if (viewTransformed) return;
    const fill = (g: string[][], rg: GridRect) => {
      const rows = rg.r2 - rg.r1 + 1;
      const cols = rg.c2 - rg.c1 + 1;
      return setCells(g, rg, Array.from({ length: rows }, () => Array<string>(cols).fill(value)));
    };
    commitGrid(allRangesRef.current.reduce(fill, grid));
  }, [viewTransformed, grid, commitGrid]);

  /* ---- 填充手柄（向下/向上/向右/向左均可；fillInto 支持负方向） ---- */
  /** 指针位置 → 网格内容坐标（原点在行号列右缘、列标行下缘） */
  const gridPoint = useCallback((clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return { x: 0, y: 0 };
    const box = vp.getBoundingClientRect();
    return {
      x: clientX - box.left + vp.scrollLeft - ROW_NUM_W,
      y: clientY - box.top + vp.scrollTop - HEADER_H,
    };
  }, []);

  const cellFromPoint = useCallback((clientX: number, clientY: number): CellPos => {
    const vp = viewportRef.current;
    if (!vp) return { r: 0, c: 0 };
    const { x, y } = gridPoint(clientX, clientY);
    const r = rowAtY(y);
    let c = totalCols - 1;
    for (let i = 0; i < totalCols; i++) {
      if (x < colLeft[i + 1]) { c = i; break; }
    }
    return { r, c };
  }, [gridPoint, rowAtY, colLeft, totalCols]);

  const beginFillDrag = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (readOnly || viewTransformed) return;
    const sourceRect = rect;
    fillRectRef.current = sourceRect;
    setFillDrag(sourceRect);
    const onMove = (ev: MouseEvent) => {
      const p = cellFromPoint(ev.clientX, ev.clientY);
      const target: GridRect = {
        r1: Math.min(sourceRect.r1, p.r), r2: Math.max(sourceRect.r2, p.r),
        c1: Math.min(sourceRect.c1, p.c), c2: Math.max(sourceRect.c2, p.c),
      };
      fillRectRef.current = target;
      setFillDrag(target);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const target = fillRectRef.current;
      fillRectRef.current = null;
      setFillDrag(null);
      if (target && !sameRect(target, sourceRect)) {
        const source: string[][] = [];
        for (let r = sourceRect.r1; r <= sourceRect.r2; r++) {
          const row: string[] = [];
          for (let c = sourceRect.c1; c <= sourceRect.c2; c++) row.push(grid[r]?.[c] ?? '');
          source.push(row);
        }
        const values = fillInto(source, sourceRect.r1, sourceRect.c1,
          target.r1, target.c1, target.r2 - target.r1 + 1, target.c2 - target.c1 + 1);
        commitGrid(setCells(grid, target, values));
      }
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [readOnly, viewTransformed, rect, grid, cellFromPoint, commitGrid, refocusGridSoon]);

  /* ---- 拖拽框选：单元格上按下后按住移动扩展选区（Excel 习惯） ---- */
  const beginDragSelect = useCallback((start: CellPos, extend: boolean) => {
    if (extend) {
      setFocus(start);
      requestAnimationFrame(() => wrapperRef.current?.focus());
      return;
    }
    setAnchor(start);
    setFocus(start);
    dragSelectingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragSelectingRef.current) return;
      setFocus(cellFromPoint(ev.clientX, ev.clientY));
    };
    const onUp = () => {
      dragSelectingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [cellFromPoint, refocusGridSoon]);

  /* ---- Ctrl+点选/拖拽：向附加选区追加（最后一个元素是正在拖的区） ---- */
  const beginExtraDrag = useCallback((start: CellPos) => {
    setExtraRanges(ers => [...ers, { r1: start.r, c1: start.c, r2: start.r, c2: start.c }]);
    const onMove = (ev: MouseEvent) => {
      const p = cellFromPoint(ev.clientX, ev.clientY);
      const next: GridRect = {
        r1: Math.min(start.r, p.r), c1: Math.min(start.c, p.c),
        r2: Math.max(start.r, p.r), c2: Math.max(start.c, p.c),
      };
      setExtraRanges(ers => {
        if (ers.length === 0) return ers;
        const lastRg = ers[ers.length - 1];
        return sameRect(lastRg, next) ? ers : [...ers.slice(0, -1), next];
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [cellFromPoint, refocusGridSoon]);

  /* ---- 列/行拖拽重排：列标/行号按下后拖动，松手按落点二选一 ----
     落在列/行中部 = 与该列/行互换；落在列间/行间网格线热区内 = 插入式移动（源位抽走、
     其余顺移，目标线高亮）。移动阈值 4px 区分「点击选择」（mousedown 已完成）与「拖拽」；
     排序/筛选态禁用（结构操作）。落点记在闭包局部（onMove/onUp 是不同原生事件，
     不依赖渲染刷新）；手调列宽跟随内容走 */
  const beginColSwapDrag = useCallback((c: number, e: React.MouseEvent) => {
    if (readOnly || viewTransformed) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let target: { mode: 'swap' | 'insert'; to: number } | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
        active = true;
        document.body.style.cursor = 'grabbing';
      }
      const { x } = gridPoint(ev.clientX, ev.clientY);
      const cur = cellFromPoint(ev.clientX, ev.clientY).c;
      let mode: 'swap' | 'insert' = 'swap';
      let to = cur;
      if (x - colLeft[cur] <= COL_LINE_EDGE) { mode = 'insert'; to = cur; }
      else if (colLeft[cur + 1] - x <= COL_LINE_EDGE) { mode = 'insert'; to = cur + 1; }
      if (mode === 'insert') to = Math.min(to, dataCols); // 插入边界钳在数据列内
      target = { mode, to };
      setSwapDrag(d => (d && d.kind === 'col' && d.mode === mode && d.to === to ? d : { kind: 'col', mode, from: c, to }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      setSwapDrag(null);
      const drop = target;
      if (active && drop) {
        if (editingRef.current) commitEdit('none'); // 结构变化前先落盘未完编辑
        if (drop.mode === 'swap' && drop.to !== c) {
          commitGrid(swapCols(grid, c, drop.to));
          if (manualWidths) {
            const widths = manualWidths.slice();
            while (widths.length <= Math.max(c, drop.to)) widths.push(AUTO_W);
            const t = widths[c];
            widths[c] = widths[drop.to];
            widths[drop.to] = t;
            onWidthsChange(widths);
          }
          setAnchor({ r: 0, c: drop.to }); // 选区跟随：拖动的内容已在此
          setFocus({ r: Math.max(totalRows - 1, 0), c: drop.to });
        } else if (drop.mode === 'insert') {
          const dest = drop.to > c ? drop.to - 1 : drop.to; // 源列抽走后的实际落位
          const moved = moveCol(grid, c, drop.to);
          if (dest !== c && moved !== grid) {
            commitGrid(moved);
            if (manualWidths) {
              const widths = manualWidths.slice();
              while (widths.length <= Math.max(c, dest)) widths.push(AUTO_W);
              const [w] = widths.splice(c, 1);
              widths.splice(dest, 0, w);
              onWidthsChange(widths);
            }
            setAnchor({ r: 0, c: dest });
            setFocus({ r: Math.max(totalRows - 1, 0), c: dest });
          }
        }
      }
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [readOnly, viewTransformed, gridPoint, cellFromPoint, colLeft, dataCols, grid, commitGrid,
    manualWidths, onWidthsChange, totalRows, editingRef, commitEdit, refocusGridSoon]);

  const beginRowSwapDrag = useCallback((r: number, e: React.MouseEvent) => {
    if (readOnly || viewTransformed) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let target: { mode: 'swap' | 'insert'; to: number } | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
        active = true;
        document.body.style.cursor = 'grabbing';
      }
      const { y } = gridPoint(ev.clientX, ev.clientY);
      const cur = cellFromPoint(ev.clientX, ev.clientY).r;
      let mode: 'swap' | 'insert' = 'swap';
      let to = cur;
      if (y - rowTops[cur] <= ROW_LINE_EDGE) { mode = 'insert'; to = cur; }
      else if (rowTops[cur + 1] - y <= ROW_LINE_EDGE) { mode = 'insert'; to = cur + 1; }
      if (mode === 'insert') to = Math.min(to, dataRows); // 插入边界钳在数据行内
      target = { mode, to };
      setSwapDrag(d => (d && d.kind === 'row' && d.mode === mode && d.to === to ? d : { kind: 'row', mode, from: r, to }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      setSwapDrag(null);
      const drop = target;
      if (active && drop) {
        if (editingRef.current) commitEdit('none');
        if (drop.mode === 'swap' && drop.to !== r) {
          commitGrid(swapRows(grid, r, drop.to));
          setAnchor({ r: drop.to, c: 0 });
          setFocus({ r: drop.to, c: Math.max(dataCols - 1, 0) });
        } else if (drop.mode === 'insert') {
          const dest = drop.to > r ? drop.to - 1 : drop.to;
          const moved = moveRow(grid, r, drop.to);
          if (dest !== r && moved !== grid) {
            commitGrid(moved);
            setAnchor({ r: dest, c: 0 });
            setFocus({ r: dest, c: Math.max(dataCols - 1, 0) });
          }
        }
      }
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [readOnly, viewTransformed, gridPoint, cellFromPoint, dataRows, dataCols, grid, commitGrid,
    editingRef, commitEdit, refocusGridSoon]);

  /* ---- 列宽拖拽（拖动中本地预览，松手提交 onWidthsChange） ---- */
  const beginColResize = useCallback((c: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startUnits = colUnits[c];
    const calc = (ev: MouseEvent) => Math.max(MIN_COL_UNITS, Math.round(startUnits + (ev.clientX - startX) / PX_PER_UNIT));
    const onMove = (ev: MouseEvent) => setWidthDrag({ c, units: calc(ev) });
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const units = calc(ev);
      setWidthDrag(null);
      if (units !== startUnits) {
        const next = [...(manualWidths ?? colUnits)];
        next[c] = units;
        onWidthsChange(next);
      }
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [colUnits, manualWidths, onWidthsChange, refocusGridSoon]);

  const resetColWidth = useCallback((c: number) => {
    const next = [...(manualWidths ?? [])];
    next[c] = AUTO_W;
    onWidthsChange(next);
  }, [manualWidths, onWidthsChange]);

  /* ---- 行高拖拽（行号底部边缘，与列宽拖拽同一套交互）；拖动中本地预览，松手提交 ---- */
  const beginRowResize = useCallback((r: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!onRowHeightsChange) return;
    const startY = e.clientY;
    const startH = rowHeightOf(r);
    const calc = (ev: MouseEvent) =>
      Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, Math.round(startH + (ev.clientY - startY))));
    const onMove = (ev: MouseEvent) => setRowHeightDrag({ r, h: calc(ev) });
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const h = calc(ev);
      setRowHeightDrag(null);
      if (h !== startH) {
        const next = [...(manualRowHeights ?? [])];
        while (next.length <= r) next.push(0);
        next[r] = h;
        onRowHeightsChange(next);
      }
      refocusGridSoon();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onRowHeightsChange, rowHeightOf, manualRowHeights, refocusGridSoon]);

  const resetRowHeight = useCallback((r: number) => {
    if (!onRowHeightsChange) return;
    const next = [...(manualRowHeights ?? [])];
    while (next.length <= r) next.push(0);
    next[r] = 0;
    onRowHeightsChange(next);
  }, [onRowHeightsChange, manualRowHeights]);

  /* ---- 行列操作（右键行号/列标/单元格） ---- */
  const rowOp = useCallback((kind: 'above' | 'below' | 'delete', r: number) => {
    if (readOnly || viewTransformed) return;
    if (kind === 'above') commitGrid(insertRowAbove(grid, r));
    else if (kind === 'below') commitGrid(insertRowBelow(grid, r));
    else commitGrid(deleteRows(grid, Math.min(rectRef.current.r1, r), Math.max(rectRef.current.r2, r)));
  }, [readOnly, viewTransformed, grid, commitGrid]);

  const colOp = useCallback((kind: 'left' | 'right' | 'delete', c: number) => {
    if (readOnly || viewTransformed) return;
    if (kind === 'left') commitGrid(insertColBefore(grid, c));
    else if (kind === 'right') commitGrid(insertColAfter(grid, c));
    else commitGrid(deleteCols(grid, Math.min(rectRef.current.c1, c), Math.max(rectRef.current.c2, c)));
  }, [readOnly, viewTransformed, grid, commitGrid]);

  const ROW_H_PRESETS = [
    { h: 22, key: 'csv.rowHeightCompact' },
    { h: 28, key: 'csv.rowHeightStandard' },
    { h: 40, key: 'csv.rowHeightRelaxed' },
  ] as const;

  const openRowMenu = useCallback((r: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExtraRanges([]); // 菜单操作以整行为主选区
    setAnchor({ r, c: 0 });
    setFocus({ r, c: Math.max(dataCols - 1, 0) });
    const orig = origRow(r); // 行结构操作落在原始行；行高按显示行记忆
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: t('csv.insertRowAbove'), disabled: readOnly || viewTransformed, onSelect: () => rowOp('above', orig) },
        { label: t('csv.insertRowBelow'), disabled: readOnly || viewTransformed, onSelect: () => rowOp('below', orig) },
        { label: t('csv.deleteRows'), danger: true, disabled: readOnly || viewTransformed, separatorBefore: true, onSelect: () => rowOp('delete', orig) },
        ...(onRowHChange ? ROW_H_PRESETS.map((p, i) => ({
          label: `${t(p.key)}${rowH === p.h ? ' ✓' : ''}`,
          separatorBefore: i === 0,
          onSelect: () => onRowHChange(p.h),
        })) : []),
        { label: t('csv.resetRowHeight'), disabled: !(manualRowHeights && manualRowHeights[r] > 0), onSelect: () => resetRowHeight(r) },
      ],
    });
  }, [t, rowOp, readOnly, viewTransformed, dataCols, rowH, onRowHChange, origRow, manualRowHeights, resetRowHeight]);

  const openColMenu = useCallback((c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExtraRanges([]); // 菜单操作以整列为主选区
    setAnchor({ r: 0, c });
    setFocus({ r: Math.max(dataRows - 1, 0), c });
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: sort?.col === c && sort.dir === 'asc' ? t('csv.sortAsc') + ' ✓' : t('csv.sortAsc'), onSelect: () => setSort({ col: c, dir: 'asc' }) },
        { label: sort?.col === c && sort.dir === 'desc' ? t('csv.sortDesc') + ' ✓' : t('csv.sortDesc'), onSelect: () => setSort({ col: c, dir: 'desc' }) },
        { label: t('csv.sortClear'), disabled: !sort, onSelect: () => setSort(null) },
        { label: t('csv.insertColLeft'), separatorBefore: true, disabled: readOnly || viewTransformed, onSelect: () => colOp('left', c) },
        { label: t('csv.insertColRight'), disabled: readOnly || viewTransformed, onSelect: () => colOp('right', c) },
        { label: t('csv.resetColWidth'), disabled: !(manualWidths && manualWidths[c] > 0), onSelect: () => resetColWidth(c) },
        { label: t('csv.deleteCols'), danger: true, disabled: readOnly || viewTransformed, onSelect: () => colOp('delete', c) },
      ],
    });
  }, [t, colOp, readOnly, viewTransformed, dataRows, manualWidths, resetColWidth, sort]);

  /* 单元格右键：剪贴板 + 清空 + 行列操作；点在选区外先把选区收拢到该格 */
  const openCellMenu = useCallback((r: number, c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (editing) commitEdit('none');
    const inSel = allRanges.some(rg => inRect(rg, r, c));
    if (!inSel) {
      setExtraRanges([]);
      setAnchor({ r, c });
      setFocus({ r, c });
    }
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: t('csv.menuCut'), disabled: readOnly || viewTransformed, onSelect: () => doCut() },
        { label: t('csv.menuCopy'), onSelect: () => doCopy() },
        { label: t('csv.menuPaste'), disabled: readOnly || viewTransformed, onSelect: () => doPaste() },
        { label: t('csv.menuClear'), disabled: readOnly || viewTransformed, separatorBefore: true, onSelect: () => clearSelection() },
        { label: t('csv.insertRowAbove'), separatorBefore: true, disabled: readOnly || viewTransformed, onSelect: () => rowOp('above', r) },
        { label: t('csv.insertRowBelow'), disabled: readOnly || viewTransformed, onSelect: () => rowOp('below', r) },
        { label: t('csv.deleteRows'), danger: true, disabled: readOnly || viewTransformed, onSelect: () => rowOp('delete', r) },
        { label: t('csv.insertColLeft'), separatorBefore: true, disabled: readOnly || viewTransformed, onSelect: () => colOp('left', c) },
        { label: t('csv.insertColRight'), disabled: readOnly || viewTransformed, onSelect: () => colOp('right', c) },
        { label: t('csv.deleteCols'), danger: true, disabled: readOnly || viewTransformed, onSelect: () => colOp('delete', c) },
      ],
    });
  }, [t, editing, allRanges, commitEdit, readOnly, viewTransformed, doCut, doCopy, doPaste, clearSelection, rowOp, colOp]);

  /* ---- 键盘 ---- */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editing) return; // 编辑态由输入框自己处理
    const meta = e.ctrlKey || e.metaKey;
    const nav: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    };
    if (nav[e.key]) {
      e.preventDefault();
      moveFocus(nav[e.key][0], nav[e.key][1], e.shiftKey);
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const rows = Math.max(1, Math.floor(viewH / rowH) - 1);
      moveFocus(e.key === 'PageDown' ? rows : -rows, 0, e.shiftKey);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); moveFocus(0, -focus.c, e.shiftKey); return; }
    if (e.key === 'End') { e.preventDefault(); moveFocus(0, totalCols - 1 - focus.c, e.shiftKey); return; }
    if (meta && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setExtraRanges([]);
      setAnchor({ r: 0, c: 0 });
      setFocus({ r: Math.max(totalRows - 1, 0), c: Math.max(dataCols - 1, 0) });
      return;
    }
    if (meta && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); doCopy(); return; }
    if (meta && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); doCut(); return; }
    /* Ctrl+V 不拦截：交给原生 paste 事件 → onWrapperPaste（readText 会弹授权框） */
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSelection(); return; }
    if (e.key === 'Enter') { e.preventDefault(); moveFocus(1, 0); return; }
    if (e.key === 'Tab') { e.preventDefault(); moveFocus(0, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F2') { e.preventDefault(); startEdit(focus.r, focus.c); return; }
    if (e.key === 'Escape') { setExtraRanges([]); setFocus(anchor); return; }
    /* 可打印字符直接进入编辑 */
    if (!meta && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      startEdit(focus.r, focus.c, e.key);
    }
  }, [editing, moveFocus, viewH, focus, anchor, totalCols, dataRows, dataCols,
    doCopy, doCut, clearSelection, startEdit]);

  const onEditInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!editing) return;
    /* 输入法组词中的 Enter/Tab/Escape 属于 IME（选词、取消组词），不是编辑器命令 */
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      fillSelectionWithValue(editing.value);
      setEditing(null);
      requestAnimationFrame(() => wrapperRef.current?.focus());
      return;
    }
    if (e.key === 'Enter' && e.altKey) {
      /* Alt+Enter：单元格内换行。优先 execCommand（保住输入框撤销栈），
         不可用时手动拼接并在重渲后恢复光标 */
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, '\n')) return;
      const nextV = el.value.slice(0, start) + '\n' + el.value.slice(end);
      setEditing(ed => (ed ? { ...ed, value: nextV } : ed));
      requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); return; }
    if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? 'none' : 'right'); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }, [editing, commitEdit, cancelEdit, fillSelectionWithValue]);

  /* ---- 虚拟滚动窗口 ---- */
  /* 绝对行定位基准：只有列标行在流外留白；表头行（headerOn）是流内 sticky。
     行高逐行可调（manualRowHeights，0/缺省=默认 rowH），rowTops 为行顶位置前缀和，
     行 r 的内容位 = HEADER_H + rowTops[r] */
  const bodyTop = HEADER_H;
  const contentH = HEADER_H + rowTops[totalRows];
  const first = useMemo(() => {
    let lo = 0, hi = totalRows - 1, ans = 0; // 最大的 r 使 rowTops[r] <= scrollTop
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rowTops[mid] <= scrollTop) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return clamp(ans - OVERSCAN, 0, Math.max(totalRows - 1, 0));
  }, [rowTops, scrollTop, totalRows]);
  const last = useMemo(() => {
    const bottom = scrollTop + viewH;
    let lo = 0, hi = totalRows - 1, ans = totalRows - 1; // 最小的 r 使 rowTops[r+1] >= bottom
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rowTops[mid + 1] >= bottom) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return clamp(ans + OVERSCAN, 0, Math.max(totalRows - 1, 0));
  }, [rowTops, viewH, scrollTop, totalRows]);
  const rowsToRender = useMemo(() => {
    const arr: number[] = [];
    if (totalRows === 0) return arr; // 筛选零命中：无表头行也无数据行
    for (let r = first; r <= last; r++) {
      if (headerOn && r === 0) continue;
      arr.push(r);
    }
    return arr;
  }, [first, last, headerOn, totalRows]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => setViewH(vp.clientHeight));
    ro.observe(vp);
    setViewH(vp.clientHeight);
    return () => ro.disconnect();
  }, []);

  /* ---- 渲染 ---- */
  const dark = isDarkMode;
  const cellValue = (r: number, c: number) => grid[origRow(r)]?.[c] ?? '';
  const displayText = (v: string) => v.replaceAll('\n', '⏎');
  const px = (c: number) => (widthDrag?.c === c ? widthDrag.units : colUnits[c]) * PX_PER_UNIT + CELL_PAD_X * 2;
  /* 拖拽预览：填充拖拽优先；互换模式的整列/行高亮走 renderCell 的 inPreview 通道，
     插入模式不高亮目标块、只亮网格线（见下方指示线） */
  const swapPreviewRect: GridRect | null = swapDrag?.mode === 'swap'
    ? (swapDrag.kind === 'col'
      ? { r1: 0, r2: totalRows - 1, c1: swapDrag.to, c2: swapDrag.to }
      : { r1: swapDrag.to, r2: swapDrag.to, c1: 0, c2: totalCols - 1 })
    : null;
  const previewRect = fillDrag ?? swapPreviewRect;

  /* 行号样式：互换拖拽中源行号减淡、目标行号蓝底高亮（bg 走单类三元，避免同类工具类冲突） */
  const rowNumBase = 'csv-rownum sticky left-0 shrink-0 border-b border-r flex items-center justify-center text-[10px] tabular-nums';
  const rowNumBg = dark ? 'bg-zinc-800 border-zinc-700 text-zinc-500' : 'bg-zinc-100 border-zinc-200 text-zinc-400';
  const rowNumClsFor = (r: number) => {
    const dragRow = swapDrag?.kind === 'row' ? swapDrag : null;
    return cn(rowNumBase,
      dragRow && dragRow.mode === 'swap' && dragRow.to === r && dragRow.from !== r
        ? (dark ? 'bg-blue-500/30 border-zinc-700 text-blue-200' : 'bg-blue-500/25 border-zinc-200 text-blue-700')
        : rowNumBg,
      dragRow && dragRow.from === r && 'opacity-40');
  };

  const renderCell = (r: number, c: number, header = false) => {
    const v = cellValue(r, c);
    const isActive = r === focus.r && c === focus.c;
    const inSel = allRanges.some(rg => inRect(rg, r, c));
    const inPreview = !!previewRect && r >= previewRect.r1 && r <= previewRect.r2 && c >= previewRect.c1 && c <= previewRect.c2;
    /* 换行模式下按本列宽度估折行数：>1 行的格子用固定行距排版，单行格子仍随行高垂直居中 */
    const wrappedLines = wrap ? estimateWrappedLines(v, colUnits[c]) : 1;
    const lineHeight = wrap && wrappedLines > 1 ? FIT_LINE_H : rowHeightOf(r) - 2;
    const bg = inPreview
      ? (dark ? 'bg-blue-500/30' : 'bg-blue-500/25')
      : inSel
        ? (dark ? 'bg-blue-500/20' : 'bg-blue-500/15')
        : header
          ? (dark ? 'bg-zinc-800' : 'bg-zinc-100')
          : (dark ? (r % 2 ? 'bg-zinc-900' : 'bg-zinc-900/60') : (r % 2 ? 'bg-white' : 'bg-zinc-50/60'));
    return (
      <div
        key={c}
        data-testid={`csv-cell-${r}-${c}`}
        className={cn(
          'csv-cell relative truncate border-b border-r px-2 text-xs shrink-0',
          dark ? 'border-zinc-700/60' : 'border-zinc-200',
          bg,
          header && 'font-semibold',
        )}
        style={{ width: px(c), lineHeight: `${lineHeight}px` }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if (editing) commitEdit('none');
          if (e.ctrlKey || e.metaKey) {
            /* Ctrl：已选中的格子 → 收拢为该格重新开始；未选中 → 追加选区（可拖成片） */
            if (allRanges.some(rg => inRect(rg, r, c))) {
              setExtraRanges([]);
              setAnchor({ r, c });
              setFocus({ r, c });
            } else {
              beginExtraDrag({ r, c });
            }
            return;
          }
          if (extraRanges.length) setExtraRanges([]); // 普通点击重新开始选区
          beginDragSelect({ r, c }, e.shiftKey);
        }}
        onDoubleClick={() => startEdit(r, c)}
        onContextMenu={(e) => openCellMenu(r, c, e)}
      >
        <span
          className={cn('block', wrap && 'whitespace-pre-wrap break-words', NUMERIC_CELL_RE.test(v.trim()) && 'text-right tabular-nums')}
        >
          {wrap ? v : displayText(v)}
        </span>
        {isActive && !editing && (
          <span className={cn('pointer-events-none absolute inset-0 border-2', dark ? 'border-blue-400' : 'border-blue-500')} />
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* 编辑栏：地址框 + 内容输入 + 表头开关 */}
      <div className={cn('flex items-stretch border-b shrink-0 text-xs', dark ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-zinc-100')}>
        <div
          className={cn('w-14 flex items-center justify-center border-r shrink-0 tabular-nums',
            dark ? 'border-zinc-700 text-zinc-400' : 'border-zinc-200 text-zinc-500')}
          title={t('csv.formulaAria')}
        >
          {single ? cellAddr(focus) : `${cellAddr({ r: rect.r1, c: rect.c1 })}:${cellAddr({ r: rect.r2, c: rect.c2 })}`}
        </div>
        {/* 编辑栏：textarea 承载多行内容（换行编辑时可见、可改），行数多时向下长高（最多 5 行） */}
        <textarea
          ref={formulaInputRef}
          data-testid="csv-formula-input"
          rows={Math.min(5, Math.max(1, (editing ? editing.value : '').split('\n').length))}
          className={cn('flex-1 min-w-0 px-2 py-1.5 bg-transparent outline-none resize-none leading-[20px]',
            dark ? 'text-zinc-200 placeholder:text-zinc-600' : 'text-zinc-800 placeholder:text-zinc-400')}
          value={editing ? editing.value : displayText(cellValue(focus.r, focus.c))}
          placeholder={t('csv.formulaPlaceholder')}
          readOnly={readOnly}
          /* 点入编辑栏即开启该格编辑（值原样代入，光标位置保留）；他格未完编辑先提交。
             原始值（非 displayText）代入，避免换行显示符 ⏎ 被当真写进数据 */
          onFocus={() => {
            if (readOnly) return;
            const ed = editingRef.current;
            if (ed && (ed.r !== focus.r || ed.c !== focus.c)) commitEdit('none');
            if (!editingRef.current) {
              setEditing({ r: focus.r, c: focus.c, value: cellValue(focus.r, focus.c), src: 'bar' });
            }
          }}
          onChange={(e) => setEditing({ r: focus.r, c: focus.c, value: e.target.value, src: 'bar' })}
          onKeyDown={onEditInputKeyDown}
          onBlur={(e) => {
            /* 焦点移入单元格编辑框＝同一次编辑的两处入口，不提交不关框；
               点去别处才提交，且仅当焦点落空时才把键盘焦点收回网格 */
            if (e.relatedTarget === editInputRef.current) return;
            if (editingRef.current) commitEdit('none', !e.relatedTarget);
          }}
        />
        {/* 自适应表格大小：列宽按内容实测、行高按换行模式下的折行数、并自动开启换行 */}
        <button
          data-testid="csv-autofit-widths"
          className={cn('px-2.5 shrink-0 border-l cursor-pointer transition-colors',
            dark ? 'border-zinc-700 text-zinc-400 hover:text-blue-200' : 'border-zinc-200 text-zinc-500 hover:text-blue-700')}
          title={t('csv.autoFitTable')}
          onClick={() => {
            const widths = estimateColumnWidths(grid, 6, FIT_WIDTH_MAX);
            onWidthsChange(widths);
            if (onRowHeightsChange) {
              onRowHeightsChange(grid.map(row => {
                let lines = 1;
                for (let c = 0; c < row.length; c++) {
                  const v = row[c] ?? '';
                  if (v) lines = Math.max(lines, estimateWrappedLines(v, widths[c] ?? 6));
                }
                return lines <= 1 ? rowH : Math.min(MAX_ROW_H, lines * FIT_LINE_H + 4);
              }));
            }
            onWrapChange?.(true);
          }}
        >
          <StretchHorizontal size={13} />
        </button>
        {/* 换行开关：开启后单元格内容按列宽折行（配合自适应行高） */}
        <button
          data-testid="csv-wrap-toggle"
          className={cn('px-2.5 shrink-0 border-l text-[11px] transition-colors',
            dark ? 'border-zinc-700' : 'border-zinc-200',
            wrap
              ? (dark ? 'bg-zinc-700/60 text-blue-300' : 'bg-blue-100 text-blue-700')
              : (dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'))}
          title={t('csv.wrapToggle')}
          onClick={() => onWrapChange?.(!wrap)}
        >
          <WrapText size={13} />
        </button>
        {/* 行筛选（视图态，不改数据；生效期间结构操作降级为禁用） */}
        <div
          className={cn('flex items-center gap-1 pl-2 pr-1 shrink-0 border-l',
            dark ? 'border-zinc-700' : 'border-zinc-200')}
          title={viewTransformed ? t('csv.sortFilterLockTip') : undefined}
        >
          <Filter size={11} className={filter ? 'text-blue-400' : (dark ? 'text-zinc-500' : 'text-zinc-400')} />
          <input
            data-testid="csv-filter-input"
            aria-label={t('csv.filterAria')}
            className={cn('w-24 bg-transparent outline-none text-[11px]',
              dark ? 'placeholder:text-zinc-600' : 'placeholder:text-zinc-400')}
            value={filter}
            placeholder={t('csv.filterPlaceholder')}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('');
              e.stopPropagation(); // 不进网格键盘导航（方向键留在输入框内）
            }}
          />
          {(filter || sort) && (
            <button
              data-testid="csv-view-reset"
              className={cn('p-0.5 rounded', dark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500')}
              title={t('csv.sortClear')}
              onClick={() => { setFilter(''); setSort(null); }}
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          className={cn('px-2.5 shrink-0 border-l text-[11px] transition-colors',
            headerOn
              ? (dark ? 'border-zinc-700 bg-zinc-700/60 text-blue-300' : 'border-zinc-200 bg-blue-100 text-blue-700')
              : (dark ? 'border-zinc-700 text-zinc-500 hover:text-zinc-300' : 'border-zinc-200 text-zinc-500 hover:text-zinc-700'))}
          title={t('csv.headerToggle')}
          onClick={() => onHeaderToggle(!headerOn)}
        >
          {t('csv.headerShort')}
        </button>
      </div>

      {/* 滚动视口 */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-auto relative select-none"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div
          ref={wrapperRef}
          tabIndex={0}
          role="grid"
          aria-label={t('csv.viewAria')}
          className={cn('relative outline-none', dark ? 'bg-zinc-900 text-zinc-200' : 'bg-white text-zinc-800')}
          style={{ width: Math.max(gridWidth + ROW_NUM_W, 200), height: contentH }}
          onKeyDown={onKeyDown}
          onPaste={onWrapperPaste}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* 列标行（sticky 顶） */}
          <div className="sticky top-0 z-30 flex" style={{ height: HEADER_H }}>
            <div
              className={cn(rowNumBase, rowNumBg, 'z-40')}
              style={{ width: ROW_NUM_W, height: HEADER_H }}
            >
              #
            </div>
            {Array.from({ length: totalCols }, (_, c) => (
              <div
                key={c}
                data-testid={`csv-colhead-${c}`}
                className={cn('csv-colhead relative shrink-0 border-b border-r flex items-center justify-center text-[11px] font-medium',
                  dark ? 'border-zinc-700' : 'border-zinc-200',
                  swapDrag?.kind === 'col' && swapDrag.mode === 'swap' && swapDrag.to === c && swapDrag.from !== c
                    ? (dark ? 'bg-blue-500/30 text-blue-200' : 'bg-blue-500/25 text-blue-800')
                    : (dark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500'),
                  swapDrag?.kind === 'col' && swapDrag.from === c && 'opacity-40')}
                title={!readOnly && !viewTransformed ? t('csv.swapColTip') : undefined}
                style={{ width: px(c), height: HEADER_H }}
                onMouseDown={(e) => {
                  if (e.button === 0 && !(e.target as HTMLElement).classList.contains('cursor-col-resize')) {
                    setAnchor({ r: 0, c });
                    setFocus({ r: Math.max(totalRows - 1, 0), c });
                    beginColSwapDrag(c, e);
                  }
                }}
                onContextMenu={(e) => openColMenu(c, e)}
              >
                {colLabel(c)}
                {sort?.col === c && (
                  <span className="ml-0.5 text-[8px] leading-none">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                )}
                <span
                  className={cn('absolute right-0 top-0 h-full w-[5px] cursor-col-resize',
                    dark ? 'hover:bg-blue-500/50' : 'hover:bg-blue-500/40')}
                  onMouseDown={(e) => beginColResize(c, e)}
                  onDoubleClick={(e) => { e.stopPropagation(); resetColWidth(c); }}
                />
              </div>
            ))}
          </div>

          {/* 数据首行作表头（sticky 第二层，特殊高亮行：底色区分 + 加粗，可选中/编辑/右键） */}
          {headerOn && (
            <div
              className={cn('sticky z-20 flex', dark ? 'bg-zinc-800' : 'bg-zinc-100')}
              style={{ top: HEADER_H, height: rowHeightOf(0) }}
            >
              <div
                className={rowNumClsFor(0)}
                style={{ width: ROW_NUM_W, height: rowHeightOf(0) }}
                title={!readOnly && !viewTransformed ? t('csv.swapRowTip') : undefined}
                onMouseDown={(e) => {
                  if (e.button === 0) { setAnchor({ r: 0, c: 0 }); setFocus({ r: 0, c: Math.max(dataCols - 1, 0) }); wrapperRef.current?.focus(); beginRowSwapDrag(0, e); }
                }}
                onContextMenu={(e) => openRowMenu(0, e)}
              >
                1
                <span
                  className={cn('absolute bottom-0 left-0 right-0 h-[5px] cursor-row-resize',
                    dark ? 'hover:bg-blue-500/50' : 'hover:bg-blue-500/40')}
                  onMouseDown={(e) => beginRowResize(0, e)}
                  onDoubleClick={(e) => { e.stopPropagation(); resetRowHeight(0); }}
                />
              </div>
              {Array.from({ length: totalCols }, (_, c) => renderCell(0, c, true))}
            </div>
          )}

          {/* 数据行（虚拟滚动，仅渲染可视窗口） */}
          {rowsToRender.map(r => (
            <div key={r} className="csv-row absolute flex" style={{ top: bodyTop + rowTops[r], height: rowHeightOf(r) }}>
              <div
                className={rowNumClsFor(r)}
                style={{ width: ROW_NUM_W, height: rowHeightOf(r) }}
                onMouseDown={(e) => {
                  if (e.button === 0) { setAnchor({ r, c: 0 }); setFocus({ r, c: Math.max(dataCols - 1, 0) }); beginRowSwapDrag(r, e); }
                }}
                onContextMenu={(e) => openRowMenu(r, e)}
                title={viewTransformed
                  ? t('csv.filteredShape', { shown: viewOrder.length - (headerOn ? 1 : 0), total: dataRows - (headerOn ? 1 : 0) })
                  : (!readOnly ? t('csv.swapRowTip') : undefined)}
              >
                {origRow(r) + 1}
                <span
                  className={cn('absolute bottom-0 left-0 right-0 h-[5px] cursor-row-resize',
                    dark ? 'hover:bg-blue-500/50' : 'hover:bg-blue-500/40')}
                  onMouseDown={(e) => beginRowResize(r, e)}
                  onDoubleClick={(e) => { e.stopPropagation(); resetRowHeight(r); }}
                />
              </div>
              {Array.from({ length: totalCols }, (_, c) => renderCell(r, c))}
            </div>
          ))}

          {/* 单元格内编辑输入框：textarea 支持 Alt+Enter 换行，行数多时向下增高 */}
          {editing && (
            <textarea
              ref={editInputRef}
              data-testid="csv-edit-input"
              className={cn('absolute z-[25] px-2 text-xs outline-none border-2 box-border resize-none leading-[20px]',
                dark ? 'bg-zinc-800 border-blue-400 text-zinc-100' : 'bg-white border-blue-500 text-zinc-900')}
              style={{
                left: ROW_NUM_W + colLeft[editing.c], top: bodyTop + rowTops[editing.r],
                width: px(editing.c),
                height: Math.max(rowHeightOf(editing.r), editing.value.split('\n').length * FIT_LINE_H + 6),
              }}
              value={editing.value}
              onChange={(e) => setEditing(ed => ed ? { ...ed, value: e.target.value } : ed)}
              onKeyDown={onEditInputKeyDown}
              onBlur={(e) => {
                if (e.relatedTarget === formulaInputRef.current) return; // 转到编辑栏＝同一编辑
                if (editingRef.current) commitEdit('none', !e.relatedTarget);
              }}
              onContextMenu={(e) => editing && openCellMenu(editing.r, editing.c, e)}
            />
          )}

          {/* 填充手柄：主选区右下角（视觉 8px 方块，外层 14px 透明命中区方便抓取）；
              排序/筛选态与 Ctrl 多选态隐藏（多区填充语义不明确） */}
          {!readOnly && !viewTransformed && extraRanges.length === 0 && (
            <span
              data-testid="csv-fill-handle"
              className="absolute z-[26] cursor-crosshair"
              style={{
                left: ROW_NUM_W + colLeft[rect.c2 + 1] - 8,
                top: bodyTop + rowTops[rect.r2 + 1] - 8,
                width: 14,
                height: 14,
              }}
              onMouseDown={beginFillDrag}
            >
              <span className={cn('absolute bottom-[3px] right-[3px] h-2 w-2', dark ? 'bg-blue-400' : 'bg-blue-500')} />
            </span>
          )}

          {/* 插入式移动指示线：悬停列间/行间网格线热区时出现，松手在该线处插入 */}
          {swapDrag?.mode === 'insert' && swapDrag.kind === 'col' && (
            <div
              data-testid="csv-insert-line-col"
              className={cn('absolute z-[35] pointer-events-none w-[2px]', dark ? 'bg-blue-400' : 'bg-blue-500')}
              style={{ left: ROW_NUM_W + colLeft[swapDrag.to] - 1, top: 0, height: contentH }}
            />
          )}
          {swapDrag?.mode === 'insert' && swapDrag.kind === 'row' && (
            <div
              data-testid="csv-insert-line-row"
              className={cn('absolute z-[35] pointer-events-none h-[2px]', dark ? 'bg-blue-400' : 'bg-blue-500')}
              style={{ left: 0, top: bodyTop + rowTops[swapDrag.to] - 1, width: gridWidth + ROW_NUM_W }}
            />
          )}
        </div>
      </div>

      {/* 剪贴板代理：右键菜单粘贴在未授权时聚焦它，下一次原生 Ctrl+V 免权限落进来 */}
      <textarea
        ref={proxyRef}
        data-testid="csv-clipboard-proxy"
        className="fixed opacity-0"
        style={{ left: -9999, top: 0, width: 1, height: 1 }}
        tabIndex={-1}
        aria-hidden
        onPaste={onProxyPaste}
        onKeyDown={(e) => {
          /* 误聚焦时任何非粘贴键都交还焦点，避免键入黑洞 */
          if (!((e.ctrlKey || e.metaKey) && e.key === 'v')) wrapperRef.current?.focus();
        }}
        onChange={() => {}}
      />

      {menu && <ContextMenu menu={menu} isDarkMode={isDarkMode} onClose={() => setMenu(null)} />}
    </div>
  );
});
