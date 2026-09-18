/**
 * CSV 纯函数层（解析 / 序列化 / 分隔符检测 / 填充 / 列宽估算）：
 * 网格组件的数据管道——tab.content 字符串 ⇄ string[][] 的唯一转换点。
 * 解析按 RFC 4180（引号转义、字段内含分隔符/换行），并对 \r\n / \r 做防御性归一；
 * 序列化采用最小引号策略（仅必要时加引号），统一 \n 结尾（写盘换行由保存链路按 tab.eol 转换），
 * 并裁剪尾部整行/整列全空的区域——首笔序列化会规范化原文，之后幂等。
 */

export type CsvDelimiter = ',' | ';' | '\t';

export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];

/* 网格性能闸门：超过任一阈值默认以文本视图打开（工具栏仍可手动切网格） */
export const CSV_GRID_MAX_CHARS = 5_000_000;
export const CSV_GRID_MAX_ROWS = 50_000;

/** 分隔符显示名（状态栏用） */
export function delimiterLabel(d: CsvDelimiter): string {
  return d === '\t' ? 'Tab' : d;
}

/* ---- 解析 ---- */

export function parseCsv(text: string, delimiter: CsvDelimiter = ','): string[][] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < normalized.length) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    /* 字段起始处的引号开启引用；字段中间出现的引号按字面量（宽容处理） */
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  /* 行内已有字段（如 "a," 结尾）或残留字段都要成行；空文本不产出行 */
  if (field !== '' || row.length > 0) pushRow();
  /* 不规则行补齐到最宽行，保证网格恒为矩形（组件选区/索引依赖） */
  const width = Math.max(0, ...rows.map(r => r.length));
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

/* ---- 序列化 ---- */

function needsQuotes(field: string, delimiter: CsvDelimiter): boolean {
  return field.includes(delimiter) || field.includes('"') || field.includes('\n');
}

function quoteField(field: string, delimiter: CsvDelimiter): string {
  return needsQuotes(field, delimiter)
    ? '"' + field.replaceAll('"', '""') + '"'
    : field;
}

export function serializeCsv(grid: string[][], delimiter: CsvDelimiter = ','): string {
  const rows = grid.map(r => r.slice());
  /* 尾部整行全空的行整行丢弃 */
  while (rows.length > 0 && rows[rows.length - 1].every(f => f === '')) rows.pop();
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map(r => r.length));
  /* 尾部整列全空的列裁掉（至少保留 1 列）；行内其余空字段保留占位保列对齐 */
  let w = width;
  trim: while (w > 1) {
    for (const r of rows) if ((r[w - 1] ?? '') !== '') break trim;
    w--;
  }

  return rows
    .map(r => Array.from({ length: w }, (_, c) => quoteField(r[c] ?? '', delimiter)).join(delimiter))
    .map(line => line + '\n')
    .join('');
}

/* ---- 分隔符检测 ---- */

export function detectDelimiter(text: string): CsvDelimiter {
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<CsvDelimiter, number>;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === ';' || ch === '\t') counts[ch as CsvDelimiter]++;
  }
  const max = Math.max(counts[','], counts[';'], counts['\t']);
  if (max === 0) return ',';
  return counts[','] === max ? ',' : counts[';'] === max ? ';' : '\t';
}

/* ---- 填充（下拉手柄） ---- */

const NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/;

/** 浮点累加误差控制：1,2 拖出 3；0.1,0.2 拖出 0.3 而非 0.30000000000000004 */
function formatNumber(v: number): string {
  return String(Math.round(v * 1e10) / 1e10);
}

/**
 * 填充规则：把源选区内容按目标块尺寸铺出（目标块以源选区左上角为起点，含源区本身）。
 * - 单格 → 重复该值；
 * - 单行/单列且 ≥2 格全为纯数字、公差恒定 → 等差递增；
 * - 其余（含二维块、混合内容、公差跳动）→ 沿源区循环重复。
 */
export function computeFill(source: string[][], targetRows: number, targetCols: number): string[][] {
  return fillInto(source, 0, 0, 0, 0, targetRows, targetCols);
}

const positiveMod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * computeFill 的负方向泛化（填充手柄向上/向左拖）：
 * 源选区锚定在 (originR, originC)，为起点 (startR, startC)、尺寸 rows×cols 的块取值。
 * 数字序列按 start + step*(距离源锚点的偏移) 延续，负方向自然回推；
 * 循环模式对偏移取正模，负方向同样成立。
 */
export function fillInto(
  source: string[][], originR: number, originC: number,
  startR: number, startC: number, rows: number, cols: number,
): string[][] {
  const sR = source.length;
  const sC = Math.max(0, ...source.map(r => r.length));
  if (sR === 0 || sC === 0) return Array.from({ length: rows }, () => blankRow(cols));

  /* 等差序列仅在单一延伸方向的一维源（≥2 格）上生效 */
  let seqStart = 0;
  let seqStep = 0;
  let numeric = false;
  let vertical = false;
  const checkVals = (vals: string[]) => {
    if (!vals.every(v => NUMERIC_RE.test(v))) return;
    const nums = vals.map(Number);
    seqStep = nums[1] - nums[0];
    if (nums.slice(2).every((n, k) => n - nums[k + 1] === seqStep)) {
      numeric = true;
      seqStart = nums[0];
    }
  };
  if (sC === 1 && sR >= 2) {
    vertical = true;
    checkVals(source.map(r => (r[0] ?? '').trim()));
  } else if (sR === 1 && sC >= 2) {
    checkVals(source[0].map(v => (v ?? '').trim()));
  }

  const out: string[][] = [];
  for (let r = startR; r < startR + rows; r++) {
    const row: string[] = [];
    for (let c = startC; c < startC + cols; c++) {
      if (numeric) {
        row.push(formatNumber(seqStart + seqStep * (vertical ? r - originR : c - originC)));
      } else {
        row.push(source[positiveMod(r - originR, sR)]?.[positiveMod(c - originC, sC)] ?? '');
      }
    }
    out.push(row);
  }
  return out;
}

/* ---- 选区与变更操作（组件事件分发的纯函数核心，全部不可变） ---- */

/** 选区矩形（行列下标含两端） */
export interface GridRect { r1: number; c1: number; r2: number; c2: number; }

const blankRow = (w: number) => Array<string>(w).fill('');

/** 把网格补齐为 rows × width 的矩形（只扩不缩：rows 小于现有行数时保留全部行） */
function ensureSize(grid: string[][], rows: number, width: number): string[][] {
  const w = Math.max(width, ...grid.map(r => r.length), 1);
  const out: string[][] = [];
  for (let r = 0; r < Math.max(rows, grid.length); r++) {
    const row = grid[r] ? grid[r].slice() : [];
    while (row.length < w) row.push('');
    out.push(row);
  }
  return out;
}

/** 把 values 块从 rect 左上角开始写入；网格不足时自动扩展行列 */
export function setCells(grid: string[][], rect: GridRect, values: string[][]): string[][] {
  const rows = Math.max(rect.r2 + 1, values.length, grid.length);
  const cols = Math.max(rect.c2 + 1, ...values.map(r => r.length));
  const out = ensureSize(grid, rows, cols);
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      out[rect.r1 + r][rect.c1 + c] = values[r][c] ?? '';
    }
  }
  return out;
}

export function clearCells(grid: string[][], rect: GridRect): string[][] {
  const values = Array.from({ length: rect.r2 - rect.r1 + 1 }, () => blankRow(rect.c2 - rect.c1 + 1));
  return setCells(grid, rect, values);
}

export function insertRowAbove(grid: string[][], at: number): string[][] {
  const width = Math.max(1, ...grid.map(r => r.length));
  const out = grid.map(r => r.slice());
  out.splice(Math.max(0, Math.min(at, out.length)), 0, blankRow(width));
  return out;
}

export const insertRowBelow = (grid: string[][], at: number): string[][] => insertRowAbove(grid, at + 1);

export function insertColBefore(grid: string[][], at: number): string[][] {
  const pos = Math.max(0, at);
  return grid.map(r => {
    const row = r.slice();
    row.splice(Math.min(pos, row.length), 0, '');
    return row;
  });
}

export const insertColAfter = (grid: string[][], at: number): string[][] => insertColBefore(grid, at + 1);

/** 删除 [from, to] 区间的行；全删时保留一格空网格 */
export function deleteRows(grid: string[][], from: number, to: number): string[][] {
  const out = grid.filter((_, i) => i < from || i > to).map(r => r.slice());
  return out.length > 0 ? out : [blankRow(1)];
}

export function deleteCols(grid: string[][], from: number, to: number): string[][] {
  const out = grid.map(r => r.filter((_, c) => c < from || c > to));
  return out.some(r => r.length > 0) ? out : [blankRow(1)];
}

/** a、b 两列逐行互换（列标拖拽互换的纯函数核心）；目标列超出网格宽度时扩齐矩形 */
export function swapCols(grid: string[][], a: number, b: number): string[][] {
  if (a === b || a < 0 || b < 0 || grid.length === 0) return grid;
  const out = ensureSize(grid, grid.length, Math.max(a, b) + 1);
  for (const row of out) {
    const t = row[a];
    row[a] = row[b];
    row[b] = t;
  }
  return out;
}

/** a、b 两行互换（行号拖拽互换）；目标行超出网格行数时以空行扩齐（= 把该行拖入空白区）。
    向上拖时 b < a，扩齐目标必须含全部现有行，否则会把尾部行裁掉（数据丢失事故） */
export function swapRows(grid: string[][], a: number, b: number): string[][] {
  if (a === b || a < 0 || b < 0 || grid.length === 0) return grid;
  const out = ensureSize(grid, Math.max(grid.length, Math.max(a, b) + 1), 1);
  const t = out[a];
  out[a] = out[b];
  out[b] = t;
  return out;
}

/** 把 from 列移动插入到边界 to（原列下标口径，0..列数，其余列顺移）。
    to 为 from 或 from+1 时即原位，原网格原样返回 */
export function moveCol(grid: string[][], from: number, to: number): string[][] {
  if (grid.length === 0 || from < 0 || to < 0 || to === from || to === from + 1) return grid;
  const out = ensureSize(grid, grid.length, Math.max(to, from + 1, ...grid.map(r => r.length)))
    .map(row => {
      const copy = row.slice();
      const [v] = copy.splice(from, 1);
      copy.splice(to > from ? to - 1 : to, 0, v ?? '');
      return copy;
    });
  return out;
}

/** 把 from 行移动插入到边界 to（原行下标口径，0..行数，其余行顺移）；边界超出网格时以空行扩齐 */
export function moveRow(grid: string[][], from: number, to: number): string[][] {
  if (grid.length === 0 || from < 0 || to < 0 || to === from || to === from + 1) return grid;
  const out = ensureSize(grid, Math.max(grid.length, to), 1).map(r => r.slice());
  const [row] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, row);
  return out;
}

/** 选区导出为系统剪贴板 TSV（与 Google Sheets/Excel 互通；末行带换行） */
export function selectionToTsv(grid: string[][], rect: GridRect): string {
  const lines: string[] = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    const cells: string[] = [];
    for (let c = rect.c1; c <= rect.c2; c++) {
      cells.push(quoteField(grid[r]?.[c] ?? '', '\t'));
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** 系统剪贴板粘贴内容 → 表格块：按制表符解析（引号内多行/制表符照常支持） */
export function parseClipboardTable(text: string): string[][] {
  return parseCsv(text, '\t');
}

/**
 * 下拉填充应用：以选区为源，铺满 (targetRows × targetCols) 的目标块后写回。
 * 目标不大于选区时原网格原样返回。
 */
export function applyFill(grid: string[][], sel: GridRect, targetRows: number, targetCols: number): string[][] {
  const selRows = sel.r2 - sel.r1 + 1;
  const selCols = sel.c2 - sel.c1 + 1;
  if (targetRows <= selRows && targetCols <= selCols) return grid;
  const source: string[][] = [];
  for (let r = sel.r1; r <= sel.r2; r++) {
    const row: string[] = [];
    for (let c = sel.c1; c <= sel.c2; c++) row.push(grid[r]?.[c] ?? '');
    source.push(row);
  }
  const values = computeFill(source, targetRows, targetCols);
  return setCells(grid, sel, values);
}

/* ---- 只读态排序 / 筛选（视图变换：不改写数据，仅产出显示行 → 原始行的映射） ---- */

export interface CsvSortState {
  col: number;
  dir: 'asc' | 'desc';
}

/** 单元格比较：数值（NUMERIC_RE 口径）按数值比较，其余 localeCompare 数字感知；空串恒排最后 */
export function compareCells(a: string, b: string): number {
  const at = a.trim();
  const bt = b.trim();
  if (at === '' && bt === '') return 0;
  if (at === '') return 1;
  if (bt === '') return -1;
  if (NUMERIC_RE.test(at) && NUMERIC_RE.test(bt)) {
    const an = Number(at);
    const bn = Number(bt);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  return at.localeCompare(bt, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * 计算「显示行 → 原始数据行」映射：
 * - filter 非空：子串匹配（大小写不敏感）任一列命中即保留；
 * - sort 指定列与方向：稳定排序（等值保持原序），数值 / 文本按 compareCells；
 * - headerOn：第 0 行（表头）恒在最前，不参与筛选与排序；
 * - 幽灵行列（编辑余量）不在数据 grid 内，天然不参与。
 */
export function computeRowOrder(
  grid: string[][],
  opts: { sort?: CsvSortState | null; filter?: string; headerOn?: boolean } = {},
): number[] {
  const { sort, filter, headerOn } = opts;
  const start = headerOn ? 1 : 0;
  const rows: number[] = [];
  for (let r = start; r < grid.length; r++) rows.push(r);
  const filtered = filter && filter.trim() !== ''
    ? rows.filter(r => grid[r].some(cell => cell.toLowerCase().includes(filter.toLowerCase())))
    : rows;
  if (!sort) return start > 0 ? [0, ...filtered] : filtered;
  const { col, dir } = sort;
  const sign = dir === 'desc' ? -1 : 1;
  /* 空值恒排最后（升降序一致，表格软件口径）；其余按 compareCells 翻转 */
  const isBlank = (v: string) => v.trim() === '';
  const sorted = filtered.slice().sort((r1, r2) => {
    const a = grid[r1]?.[col] ?? '';
    const b = grid[r2]?.[col] ?? '';
    const ab = isBlank(a);
    const bb = isBlank(b);
    if (ab !== bb) return ab ? 1 : -1;
    return sign * compareCells(a, b);
  });
  return start > 0 ? [0, ...sorted] : sorted;
}

/* ---- 列宽估算 ---- */

/** 显示宽度：CJK/全角区按 2，其余按 1；多行单元格取最长行 */
function textDisplayWidth(text: string): number {
  let max = 0;
  let cur = 0;
  for (const ch of text) {
    if (ch === '\n') {
      max = Math.max(max, cur);
      cur = 0;
      continue;
    }
    cur += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  }
  return Math.max(max, cur);
}

/** 每列取最长内容宽度并钳制到 [min, max]；宽度供网格渲染一次算好、内容不变不重算 */
export function estimateColumnWidths(grid: string[][], min = 6, max = 40): number[] {
  const widths: number[] = [];
  for (const row of grid) {
    for (let c = 0; c < row.length; c++) {
      const w = Math.min(max, Math.max(min, textDisplayWidth(row[c] ?? '')));
      if (w > (widths[c] ?? 0)) widths[c] = w;
    }
  }
  return widths;
}

/** 文本在给定列宽（显示宽单位）下需要的折行数：按硬换行分行，每行按显示宽除以
    可用宽度进位（近似：CJK 可任意断行；长单词按宽度切分估算）。
    「自适应表格大小」的行高估算核心 */
export function estimateWrappedLines(text: string, widthUnits: number): number {
  const usable = Math.max(1, widthUnits - 2); // 扣除单元格左右 padding
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += Math.max(1, Math.ceil(textDisplayWidth(line) / usable));
  }
  return Math.max(1, lines);
}
