import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Filter, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { clipboardReadPermissionState } from '../lib/fileOps';
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from './ContextMenu';
import {
  clearCells, computeRowOrder, deleteCols, deleteRows, estimateColumnWidths, fillInto,
  insertColAfter, insertColBefore, insertRowAbove, insertRowBelow, parseClipboardTable,
  parseCsv, selectionToTsv, serializeCsv, setCells,
  type CsvDelimiter, type CsvSortState, type GridRect,
} from '../lib/csv';

/**
 * CSV 网格编辑器：tab.content 字符串的"工作视图"。
 * 组件不拥有数据——解析出 string[][] 渲染，任何编辑都经纯函数变换后
 * serializeCsv 回传 onChange（对接 updateTabContent，撤销/脏标记/diff 时间线自动生效）。
 * 行虚拟滚动（只渲染可视区±缓冲），列标/行号 CSS sticky；列不虚拟化。
 */

const ROW_H = 28;
const ROW_NUM_W = 48;
const HEADER_H = ROW_H;
const GHOST_ROWS = 30;
const GHOST_COLS = 8;
const OVERSCAN = 10;
/** 列宽单位（约 1 字符显示宽）对应像素；单位语义见 csv.ts estimateColumnWidths */
const PX_PER_UNIT = 8;
const CELL_PAD_X = 8;
const MIN_COL_UNITS = 3;
/** 手动列宽哨兵：恢复自适应 */
const AUTO_W = -1;

export interface CsvGridEditorProps {
  content: string;
  delimiter: CsvDelimiter;
  isDarkMode: boolean;
  headerOn: boolean;
  readOnly?: boolean;
  /** 手动列宽（显示宽单位，tab.csvColWidths；AUTO_W=恢复自适应）；未提供的列用自适应值 */
  manualWidths?: number[];
  onChange: (content: string) => void;
  onHeaderToggle: (on: boolean) => void;
  onWidthsChange: (w: number[]) => void;
  /** 数据区行列数（供状态栏展示）；第三参为排序/筛选下的可见行数（缺省同 rows） */
  onShape?: (rows: number, cols: number, visibleRows?: number) => void;
}

type CellPos = { r: number; c: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sameRect = (a: GridRect, b: GridRect) =>
  a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;

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
  manualWidths, onChange, onHeaderToggle, onWidthsChange, onShape,
}) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const proxyRef = useRef<HTMLTextAreaElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
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
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [fillDrag, setFillDrag] = useState<GridRect | null>(null);
  const [widthDrag, setWidthDrag] = useState<{ c: number; units: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  const rect: GridRect = useMemo(() => ({
    r1: Math.min(anchor.r, focus.r), c1: Math.min(anchor.c, focus.c),
    r2: Math.max(anchor.r, focus.r), c2: Math.max(anchor.c, focus.c),
  }), [anchor, focus]);
  const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
  /* 剪贴板/清除/增删行列等操作经 ref 读选区：右键菜单先收拢选区再弹菜单，
     回调触发时（点击菜单项）读到的已是新选区，而不是菜单创建时的闭包旧值 */
  const rectRef = useRef(rect);
  rectRef.current = rect;

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
    const overlay = HEADER_H + (headerOn ? ROW_H : 0);
    const top = HEADER_H + p.r * ROW_H;
    const bottom = top + ROW_H;
    if (top - vp.scrollTop < overlay) vp.scrollTop = Math.max(0, top - overlay);
    else if (bottom - vp.scrollTop > vp.clientHeight) vp.scrollTop = bottom - vp.clientHeight;
    const left = colLeft[p.c];
    const right = colLeft[p.c + 1];
    if (left - vp.scrollLeft < ROW_NUM_W) vp.scrollLeft = Math.max(0, left - ROW_NUM_W);
    else if (right - vp.scrollLeft > vp.clientWidth) vp.scrollLeft = right - vp.clientWidth;
  }, [colLeft, headerOn]);

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
    setEditing({ r, c, value: initial ?? grid[r]?.[c] ?? '' });
    setAnchor({ r, c });
    setFocus({ r, c });
  }, [readOnly, grid]);

  const commitEdit = useCallback((move: 'down' | 'right' | 'none') => {
    if (!editing) return;
    setCell(editing.r, editing.c, editing.value);
    setEditing(null);
    if (move === 'down') moveFocus(1, 0);
    if (move === 'right') moveFocus(0, 1);
    requestAnimationFrame(() => wrapperRef.current?.focus());
  }, [editing, setCell, moveFocus]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    requestAnimationFrame(() => wrapperRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing?.r, editing?.c]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const doCopy = useCallback(() => writeClipboard(selectionToTsv(grid, rectRef.current)), [writeClipboard, grid]);

  const doCut = useCallback(() => {
    if (readOnly || viewTransformed) return;
    writeClipboard(selectionToTsv(grid, rectRef.current));
    commitGrid(clearCells(grid, rectRef.current));
  }, [readOnly, viewTransformed, writeClipboard, grid, commitGrid]);

  const applyPasteText = useCallback((text: string) => {
    if (readOnly || viewTransformed || !text) return;
    const block = parseClipboardTable(text.replace(/\r\n?/g, '\n'));
    commitGrid(setCells(grid, rectRef.current, block));
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

  /* ---- 清空选区 / Ctrl+Enter 铺满 ---- */
  const clearSelection = useCallback(() => {
    if (viewTransformed) return; // 排序/筛选态禁用结构操作（单元格内容编辑仍可用）
    const cur = rectRef.current;
    if (cur.r1 === cur.r2 && cur.c1 === cur.c2) { setCell(cur.r1, cur.c1, ''); return; }
    commitGrid(clearCells(grid, cur));
  }, [viewTransformed, grid, commitGrid, setCell]);

  const fillSelectionWithValue = useCallback((value: string) => {
    if (viewTransformed) return;
    const rows = rect.r2 - rect.r1 + 1;
    const cols = rect.c2 - rect.c1 + 1;
    commitGrid(setCells(grid, rect, Array.from({ length: rows }, () => Array<string>(cols).fill(value))));
  }, [viewTransformed, rect, grid, commitGrid]);

  /* ---- 填充手柄（向下/向上/向右/向左均可；fillInto 支持负方向） ---- */
  const cellFromPoint = useCallback((clientX: number, clientY: number): CellPos => {
    const vp = viewportRef.current;
    if (!vp) return { r: 0, c: 0 };
    const box = vp.getBoundingClientRect();
    const x = clientX - box.left + vp.scrollLeft - ROW_NUM_W;
    const y = clientY - box.top + vp.scrollTop - HEADER_H;
    const r = clamp(Math.floor(y / ROW_H), 0, totalRows - 1);
    let c = totalCols - 1;
    for (let i = 0; i < totalCols; i++) {
      if (x < colLeft[i + 1]) { c = i; break; }
    }
    return { r, c };
  }, [colLeft, headerOn, totalRows, totalCols]);

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
      requestAnimationFrame(() => wrapperRef.current?.focus());
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [readOnly, viewTransformed, rect, grid, cellFromPoint, commitGrid]);

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
      requestAnimationFrame(() => wrapperRef.current?.focus());
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [cellFromPoint]);

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
      requestAnimationFrame(() => wrapperRef.current?.focus());
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [colUnits, manualWidths, onWidthsChange]);

  const resetColWidth = useCallback((c: number) => {
    const next = [...(manualWidths ?? [])];
    next[c] = AUTO_W;
    onWidthsChange(next);
  }, [manualWidths, onWidthsChange]);

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

  const openRowMenu = useCallback((r: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAnchor({ r, c: 0 });
    setFocus({ r, c: Math.max(dataCols - 1, 0) });
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: t('csv.insertRowAbove'), disabled: readOnly || viewTransformed, onSelect: () => rowOp('above', r) },
        { label: t('csv.insertRowBelow'), disabled: readOnly || viewTransformed, onSelect: () => rowOp('below', r) },
        { label: t('csv.deleteRows'), danger: true, disabled: readOnly || viewTransformed, separatorBefore: true, onSelect: () => rowOp('delete', r) },
      ],
    });
  }, [t, rowOp, readOnly, viewTransformed, dataCols]);

  const openColMenu = useCallback((c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
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
    const inSel = r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2;
    if (!inSel) {
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
  }, [t, editing, rect, commitEdit, readOnly, viewTransformed, doCut, doCopy, doPaste, clearSelection, rowOp, colOp]);

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
      const rows = Math.max(1, Math.floor(viewH / ROW_H) - 1);
      moveFocus(e.key === 'PageDown' ? rows : -rows, 0, e.shiftKey);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); moveFocus(0, -focus.c, e.shiftKey); return; }
    if (e.key === 'End') { e.preventDefault(); moveFocus(0, totalCols - 1 - focus.c, e.shiftKey); return; }
    if (meta && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
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
    if (e.key === 'Escape') { setFocus(anchor); return; }
    /* 可打印字符直接进入编辑 */
    if (!meta && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      startEdit(focus.r, focus.c, e.key);
    }
  }, [editing, moveFocus, viewH, focus, anchor, totalCols, dataRows, dataCols,
    doCopy, doCut, clearSelection, startEdit]);

  const onEditInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      fillSelectionWithValue(editing.value);
      setEditing(null);
      requestAnimationFrame(() => wrapperRef.current?.focus());
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); return; }
    if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? 'none' : 'right'); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }, [editing, commitEdit, cancelEdit, fillSelectionWithValue]);

  /* ---- 虚拟滚动窗口 ---- */
  /* 绝对行定位基准：只有列标行在流外留白；表头行（headerOn）是流内 sticky，
     自然占据 HEADER_H..2*HEADER_H，行 r 的内容位 = HEADER_H + r*ROW_H */
  const bodyTop = HEADER_H;
  const contentH = HEADER_H * (headerOn ? 2 : 1) + totalRows * ROW_H;
  const first = clamp(Math.floor(scrollTop / ROW_H) - OVERSCAN, 0, totalRows - 1);
  const last = clamp(first + Math.ceil(viewH / ROW_H) + OVERSCAN * 2, 0, totalRows - 1);
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
  const previewRect = fillDrag;

  const rowNumCls = cn(
    'csv-rownum sticky left-0 shrink-0 border-b border-r flex items-center justify-center text-[10px] tabular-nums',
    dark ? 'bg-zinc-800 border-zinc-700 text-zinc-500' : 'bg-zinc-100 border-zinc-200 text-zinc-400',
  );

  const renderCell = (r: number, c: number, header = false) => {
    const v = cellValue(r, c);
    const isActive = r === focus.r && c === focus.c;
    const inSel = r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2;
    const inPreview = !!previewRect && r >= previewRect.r1 && r <= previewRect.r2 && c >= previewRect.c1 && c <= previewRect.c2;
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
          'csv-cell relative truncate border-b border-r px-2 text-xs leading-[26px] shrink-0',
          dark ? 'border-zinc-700/60' : 'border-zinc-200',
          bg,
          header && 'font-semibold',
        )}
        style={{ width: px(c) }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if (editing) commitEdit('none');
          beginDragSelect({ r, c }, e.shiftKey);
        }}
        onDoubleClick={() => startEdit(r, c)}
        onContextMenu={(e) => openCellMenu(r, c, e)}
      >
        <span className={cn('block', NUMERIC_CELL_RE.test(v.trim()) && 'text-right tabular-nums')}>
          {displayText(v)}
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
        <input
          data-testid="csv-formula-input"
          className={cn('flex-1 min-w-0 px-2 py-1.5 bg-transparent outline-none',
            dark ? 'text-zinc-200 placeholder:text-zinc-600' : 'text-zinc-800 placeholder:text-zinc-400')}
          value={editing ? editing.value : displayText(cellValue(focus.r, focus.c))}
          placeholder={t('csv.formulaPlaceholder')}
          readOnly={readOnly}
          onChange={(e) => setEditing({ r: focus.r, c: focus.c, value: e.target.value })}
          onKeyDown={onEditInputKeyDown}
          onBlur={() => { if (editing && editing.r === focus.r && editing.c === focus.c) commitEdit('none'); }}
        />
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
              className={cn(rowNumCls, 'z-40')}
              style={{ width: ROW_NUM_W, height: HEADER_H }}
            >
              #
            </div>
            {Array.from({ length: totalCols }, (_, c) => (
              <div
                key={c}
                data-testid={`csv-colhead-${c}`}
                className={cn('csv-colhead relative shrink-0 border-b border-r flex items-center justify-center text-[11px] font-medium',
                  dark ? 'bg-zinc-800 border-zinc-700 text-zinc-400' : 'bg-zinc-100 border-zinc-200 text-zinc-500')}
                style={{ width: px(c), height: HEADER_H }}
                onMouseDown={(e) => {
                  if (e.button === 0 && !(e.target as HTMLElement).classList.contains('cursor-col-resize')) {
                    setAnchor({ r: 0, c });
                    setFocus({ r: Math.max(totalRows - 1, 0), c });
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
              style={{ top: HEADER_H, height: ROW_H }}
            >
              <div
                className={rowNumCls}
                style={{ width: ROW_NUM_W, height: ROW_H }}
                onMouseDown={(e) => {
                  if (e.button === 0) { setAnchor({ r: 0, c: 0 }); setFocus({ r: 0, c: Math.max(dataCols - 1, 0) }); wrapperRef.current?.focus(); }
                }}
                onContextMenu={(e) => openRowMenu(0, e)}
              >
                1
              </div>
              {Array.from({ length: totalCols }, (_, c) => renderCell(0, c, true))}
            </div>
          )}

          {/* 数据行（虚拟滚动，仅渲染可视窗口） */}
          {rowsToRender.map(r => (
            <div key={r} className="csv-row absolute flex" style={{ top: bodyTop + r * ROW_H, height: ROW_H }}>
              <div
                className={rowNumCls}
                style={{ width: ROW_NUM_W, height: ROW_H }}
                onMouseDown={(e) => {
                  if (e.button === 0) { setAnchor({ r, c: 0 }); setFocus({ r, c: Math.max(dataCols - 1, 0) }); }
                }}
                onContextMenu={(e) => openRowMenu(origRow(r), e)}
                title={viewTransformed ? t('csv.filteredShape', { shown: viewOrder.length - (headerOn ? 1 : 0), total: dataRows - (headerOn ? 1 : 0) }) : undefined}
              >
                {origRow(r) + 1}
              </div>
              {Array.from({ length: totalCols }, (_, c) => renderCell(r, c))}
            </div>
          ))}

          {/* 单元格内编辑输入框 */}
          {editing && (
            <input
              ref={editInputRef}
              data-testid="csv-edit-input"
              className={cn('absolute z-[25] px-2 text-xs outline-none border-2 box-border',
                dark ? 'bg-zinc-800 border-blue-400 text-zinc-100' : 'bg-white border-blue-500 text-zinc-900')}
              style={{ left: ROW_NUM_W + colLeft[editing.c], top: bodyTop + editing.r * ROW_H, width: px(editing.c), height: ROW_H }}
              value={editing.value}
              onChange={(e) => setEditing(ed => ed ? { ...ed, value: e.target.value } : ed)}
              onKeyDown={onEditInputKeyDown}
              onBlur={() => commitEdit('none')}
              onContextMenu={(e) => editing && openCellMenu(editing.r, editing.c, e)}
            />
          )}

          {/* 填充手柄：选区右下角（视觉 8px 方块，外层 14px 透明命中区方便抓取）；排序/筛选态隐藏 */}
          {!readOnly && !viewTransformed && (
            <span
              data-testid="csv-fill-handle"
              className="absolute z-[26] cursor-crosshair"
              style={{
                left: ROW_NUM_W + colLeft[rect.c2 + 1] - 8,
                top: bodyTop + (rect.r2 + 1) * ROW_H - 8,
                width: 14,
                height: 14,
              }}
              onMouseDown={beginFillDrag}
            >
              <span className={cn('absolute bottom-[3px] right-[3px] h-2 w-2', dark ? 'bg-blue-400' : 'bg-blue-500')} />
            </span>
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
