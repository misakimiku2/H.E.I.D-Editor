import { diffLines } from 'diff';

/**
 * Diff 时间线纯函数模块（外部修改与软件内编辑两套时间线共用）：
 * 追加与合并、上限裁剪、接受移除、撤销级联移除、软件内编辑记录、
 * 变更判定、增删统计、双栏对比行模型与 hunk 折叠。
 * 每条时间线为链式结构：第 N 条的 before 等于第 N-1 条的 after；
 * 期间发生外源内容跳变（外部修改覆盖、撤销回退）时允许链断裂，条目自含快照不依赖链条。
 *
 * 一条条目 = 一次「待审阅的变更」，不是一次写入：外部程序（尤其是 AI 工具）
 * 连改一个文件十几次时，这十几次并进同一条，before 停在基线、after 跟到最新，
 * 中间的每一次写入留在 steps 里供下钻查看。用户要回答的问题始终是
 * 「相对我上次处理的时候，这个文件总共变了什么」，而不是「磁盘被写了几次」。
 */

/** 合并条目里的一次写入（过程子列表的一项） */
export interface DiffStep {
  /** 这次写入后的完整内容快照；它同时是下一步的对比基准 */
  content: string;
  detectedAt: number;
}

/** 单文件外部修改时间线条目 */
export interface ExternalDiffEntry {
  id: string;
  /** 修改前内容快照（合并过的条目里这是基线，即上次处理时的内容） */
  before: string;
  /** 修改后内容快照（合并过的条目里这是最新一次写入的结果） */
  after: string;
  /** 检测到的时间戳（合并过的条目里这是最后一次写入的时刻） */
  detectedAt: number;
  /**
   * 合并进来的各次写入，含最后一次（即 after）；只写过一次的条目没有这一项。
   * 第 i 步的对比基准是 steps[i-1].content，i 为 0 时是 before。
   */
  steps?: DiffStep[];
  /** steps 触到上限后最旧那几步被并成一步的次数；只影响「共 N 次」的计数展示 */
  mergedSteps?: number;
}

/**
 * 软件内编辑时间线条目：结构与外部条目一致（before/after 为编辑器内容快照），
 * 但时间线独立存储、动作语义不同（撤销只回退编辑器内容，不写磁盘）。
 */
export type InternalDiffEntry = ExternalDiffEntry;

/** 时间线保留条数的可调范围与默认值（用户可在 Diff 弹窗中设置） */
export const MIN_DIFF_ENTRIES = 5;
export const MAX_DIFF_ENTRIES = 50;
export const DEFAULT_DIFF_ENTRIES = 30;

/** 单条合并条目里最多留存的过程步数；超出即把最旧的边界并掉，快照数量因此有上界 */
export const MAX_DIFF_STEPS = 20;

/** 分批间隔档位（分钟）：0 = 不分批，未处理期间一律合并成一条 */
export const COALESCE_WINDOW_CHOICES = [0, 5, 15, 30, 60] as const;
export type CoalesceWindow = typeof COALESCE_WINDOW_CHOICES[number];
export const DEFAULT_COALESCE_WINDOW: CoalesceWindow = 0;

/** 把任意输入归到合法档位；认不出的一律回默认（不分批） */
export function normalizeCoalesceWindow(value: unknown): CoalesceWindow {
  const n = Number(value);
  return (COALESCE_WINDOW_CHOICES as readonly number[]).includes(n)
    ? (n as CoalesceWindow)
    : DEFAULT_COALESCE_WINDOW;
}

/** 把任意输入钳制为合法的保留条数（整数，5~50）；无法解析为数字时回退默认值 */
export function clampDiffEntries(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_DIFF_ENTRIES;
  return Math.min(MAX_DIFF_ENTRIES, Math.max(MIN_DIFF_ENTRIES, n));
}

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter += 1;
  return `diff-${Date.now()}-${entryCounter}`;
}

/**
 * 追加一条外部修改记录。before 应为调用方最后已知的磁盘内容
 * （即上一条的 after；首条为建立监听时读到的磁盘内容），链式衔接由此保证。
 * 超出 maxEntries 即丢弃最旧。
 */
export function appendEntry(
  timeline: ExternalDiffEntry[],
  before: string,
  after: string,
  detectedAt: number = Date.now(),
  maxEntries: number = DEFAULT_DIFF_ENTRIES
): ExternalDiffEntry[] {
  const next = [...timeline, { id: nextEntryId(), before, after, detectedAt }];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

export interface ExternalChangeOptions {
  maxEntries?: number;
  /** 分批间隔（分钟）；0 或不传 = 不分批，未处理期间一律合并 */
  windowMinutes?: number;
}

/**
 * 这次写入能否并进已有的最后一条：
 * - 链条必须衔接得上（last.after === before），否则说明期间发生过撤销回退或外源覆盖，
 *   并进去会把两件事混成一份对比；
 * - 分批间隔为 0 时不看时间，未处理期间一律合并；
 * - 有间隔时，距上次写入超过该间隔就另起一条（把「AI 这一轮」和几小时后自己改的分开）。
 */
function canCoalesce(
  last: ExternalDiffEntry,
  before: string,
  detectedAt: number,
  windowMinutes: number
): boolean {
  if (last.after !== before) return false;
  if (!windowMinutes) return true;
  return detectedAt - last.detectedAt <= windowMinutes * 60_000;
}

/**
 * 记一次外部修改：默认并进最后一条未处理条目（before 保持基线、after 前移到最新、
 * 这次写入落进 steps），只有链条断了或超出分批间隔才新开一条。
 * 首次合并时把这条自己那次写入补成第 0 步，过程子列表才接得上 before。
 */
export function appendExternalChange(
  timeline: ExternalDiffEntry[],
  before: string,
  after: string,
  detectedAt: number = Date.now(),
  opts: ExternalChangeOptions = {}
): ExternalDiffEntry[] {
  const maxEntries = opts.maxEntries ?? DEFAULT_DIFF_ENTRIES;
  const last = timeline[timeline.length - 1];
  if (!last || !canCoalesce(last, before, detectedAt, opts.windowMinutes ?? 0)) {
    return appendEntry(timeline, before, after, detectedAt, maxEntries);
  }

  const prevSteps = last.steps ?? [{ content: last.after, detectedAt: last.detectedAt }];
  const total = prevSteps.length + 1;
  let steps = [...prevSteps, { content: after, detectedAt }];
  let mergedSteps = last.mergedSteps ?? 0;
  if (steps.length > MAX_DIFF_STEPS) {
    steps = steps.slice(steps.length - MAX_DIFF_STEPS);
    mergedSteps += total - steps.length;
  }
  /* id 沿用旧条目：它代表的是同一件待处理的事，React key 与弹窗选中态因此不会跳 */
  const merged: ExternalDiffEntry = { ...last, after, detectedAt, steps, mergedSteps };
  return [...timeline.slice(0, -1), merged];
}

/** 这条条目一共合了几次写入（含被并掉边界的那些） */
export function stepCountOf(entry: ExternalDiffEntry): number {
  return (entry.steps?.length ?? 1) + (entry.mergedSteps ?? 0);
}

/** 裁剪到 maxEntries 条（保留最新）；未超限时返回原数组引用 */
export function trimTimeline(timeline: ExternalDiffEntry[], maxEntries: number): ExternalDiffEntry[] {
  return timeline.length > maxEntries ? timeline.slice(timeline.length - maxEntries) : timeline;
}

/**
 * 记录一次软件内编辑。newStep 由调用方的撤销历史合并判定给出
 * （major 动作或超出连击间隔），条目边界与 Ctrl+Z 步骤同拍推进：
 * 新步骤追加条目；连击合并进最后一条的 after（条目代表一段连续输入）。
 * 连击但最后一条的 after 与当前步骤基准（before）衔接不上时——
 * 期间发生过外部修改覆盖、Ctrl+Z 回退分支或最后一条已被清理——退化为追加，
 * 避免把外源跳变混进旧条目的对比里。
 */
export function applyInternalEdit(
  timeline: InternalDiffEntry[],
  before: string,
  after: string,
  newStep: boolean,
  maxEntries: number = DEFAULT_DIFF_ENTRIES,
  now: number = Date.now(),
): InternalDiffEntry[] {
  const last = timeline[timeline.length - 1];
  if (!newStep && last && last.after === before) {
    return [...timeline.slice(0, -1), { ...last, after, detectedAt: now }];
  }
  return appendEntry(timeline, before, after, now, maxEntries);
}

/** 接受：仅移除该条目，其余不动 */
export function removeEntry(timeline: ExternalDiffEntry[], id: string): ExternalDiffEntry[] {
  return timeline.filter(e => e.id !== id);
}

/** 撤销：移除该条及其后所有条目（链条已断），之前的保留 */
export function revertEntry(timeline: ExternalDiffEntry[], id: string): ExternalDiffEntry[] {
  const idx = timeline.findIndex(e => e.id === id);
  return idx === -1 ? timeline : timeline.slice(0, idx);
}

/**
 * 变更判定（供监听重读后调用）：
 * - 无基准（undefined）→ null，由调用方静默落下基准；
 * - 内容相同 → null（自身写入或无实质变化的触碰）；
 * - 内容不同 → 产出条目载荷。
 */
export function detectExternalChange(
  known: string | undefined,
  current: string
): { before: string; after: string } | null {
  if (known === undefined || known === current) return null;
  return { before: known, after: current };
}

/** 把 diffLines 的片段值（含换行的整行文本）拆成行，去掉末尾换行产生的空元素 */
function partLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 增删行统计（+N -M） */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += partLines(part.value).length;
    else if (part.removed) removed += partLines(part.value).length;
  }
  return { added, removed };
}

/* ---------- 双栏对比行模型 ---------- */

export type DiffCellType = 'same' | 'del' | 'add';

export interface DiffCell {
  type: DiffCellType;
  text: string;
  /** 该行在原文件（左）或新文件（右）中的行号，1-based */
  lineNo: number;
}

/** 一行对比：左列 before / 右列 after，较短一侧以 null 填充对齐 */
export interface DiffRow {
  left: DiffCell | null;
  right: DiffCell | null;
}

/**
 * 构建左右双栏对比行：删除行只占左列（红），新增行只占右列（绿），
 * 修改处两侧逐行对齐、空位填充；相同行两侧同号同文。
 */
export function buildDiffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  let removedRun: string[] = [];
  let addedRun: string[] = [];

  /* 连续的删除/新增行组成一个变更块，按行配对（修改 = 删除行配新增行） */
  const flushRun = () => {
    const height = Math.max(removedRun.length, addedRun.length);
    for (let i = 0; i < height; i++) {
      rows.push({
        left: removedRun[i] !== undefined
          ? { type: 'del', text: removedRun[i], lineNo: ++leftNo }
          : null,
        right: addedRun[i] !== undefined
          ? { type: 'add', text: addedRun[i], lineNo: ++rightNo }
          : null,
      });
    }
    removedRun = [];
    addedRun = [];
  };

  for (const part of diffLines(before, after)) {
    if (part.added) {
      addedRun.push(...partLines(part.value));
    } else if (part.removed) {
      removedRun.push(...partLines(part.value));
    } else {
      flushRun();
      for (const line of partLines(part.value)) {
        rows.push({
          left: { type: 'same', text: line, lineNo: ++leftNo },
          right: { type: 'same', text: line, lineNo: ++rightNo },
        });
      }
    }
  }
  flushRun();
  return rows;
}

/* ---------- hunk 折叠：只留变更块 ± 上下文 ---------- */

/** 变更块上下各保留的未变更行数（与 git 默认一致） */
export const DEFAULT_DIFF_CONTEXT = 3;

/** 一段被折叠起来的未变更区域 */
export interface DiffFold {
  kind: 'fold';
  /** 折叠掉的行数 */
  hidden: number;
  /** 折叠段在 buildDiffRows 行数组里的闭区间，就地展开时按它取回原始行 */
  from: number;
  to: number;
  /** 折叠段首尾在原文件（左）中的行号，1-based */
  leftFrom: number;
  leftTo: number;
  /** 折叠段首尾在新文件（右）中的行号，1-based */
  rightFrom: number;
  rightTo: number;
}

export interface DiffRowItem {
  kind: 'row';
  row: DiffRow;
}

export type DiffItem = DiffRowItem | DiffFold;

export interface FoldedDiff {
  items: DiffItem[];
  /** 每处变更块首行（不含上下文）在 items 中的下标，供「上一处 / 下一处」跳转 */
  hunkAnchors: number[];
}

function isChangedRow(row: DiffRow): boolean {
  return row.left?.type !== 'same' || row.right?.type !== 'same';
}

function foldOf(rows: DiffRow[], from: number, to: number): DiffFold {
  const first = rows[from];
  const last = rows[to];
  return {
    kind: 'fold',
    hidden: to - from + 1,
    from,
    to,
    leftFrom: first.left?.lineNo ?? 0,
    leftTo: last.left?.lineNo ?? 0,
    rightFrom: first.right?.lineNo ?? 0,
    rightTo: last.right?.lineNo ?? 0,
  };
}

/**
 * 把整份行模型折成「变更块 ± context 行」：连续的未变更区域换成一条可展开的折叠段。
 * 两处变更之间的未变更行数不超过 2*context 时并成同一块——否则中间会夹一条
 * 只有一两行的折叠条，比不折还难读。整份内容没有变更时折成单独一段。
 */
export function foldDiffRows(rows: DiffRow[], context: number = DEFAULT_DIFF_CONTEXT): FoldedDiff {
  const ctx = Math.max(0, Math.floor(context));
  const changed: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (isChangedRow(rows[i])) changed.push(i);
  }

  const items: DiffItem[] = [];
  const hunkAnchors: number[] = [];
  if (changed.length === 0) {
    if (rows.length > 0) items.push(foldOf(rows, 0, rows.length - 1));
    return { items, hunkAnchors };
  }

  /* 变更块分组 */
  const groups: [number, number][] = [];
  let start = changed[0];
  let end = changed[0];
  for (const idx of changed.slice(1)) {
    if (idx - end - 1 <= 2 * ctx) {
      end = idx;
      continue;
    }
    groups.push([start, end]);
    start = idx;
    end = idx;
  }
  groups.push([start, end]);

  let cursor = 0;
  for (const [a, b] of groups) {
    const from = Math.max(cursor, a - ctx);
    const to = Math.min(rows.length - 1, b + ctx);
    if (from > cursor) items.push(foldOf(rows, cursor, from - 1));
    /* 此刻 items.length 就是本块第一行可见行（下标 from）将落到的位置 */
    hunkAnchors.push(items.length + (a - from));
    for (let i = from; i <= to; i++) items.push({ kind: 'row', row: rows[i] });
    cursor = to + 1;
  }
  if (cursor < rows.length) items.push(foldOf(rows, cursor, rows.length - 1));
  return { items, hunkAnchors };
}

/* ---------- 单栏（unified）行模型：窄壳用 ---------- */

export interface UnifiedLine {
  type: DiffCellType;
  text: string;
  /** 该行在自己那一侧的行号：删除取左、新增取右、相同行两侧同号 */
  lineNo: number;
}

/**
 * 把双栏行摊成单栏：相同行一行；修改处先 − 旧行再 + 新行（与 unified diff 一致）。
 * 窄壳上双栏每侧只剩几十像素、一行折成碎片，单栏是唯一读得了的铺法。
 */
export function buildUnifiedLines(rows: DiffRow[]): UnifiedLine[] {
  const out: UnifiedLine[] = [];
  for (const row of rows) {
    if (row.left?.type === 'same' && row.right?.type === 'same') {
      out.push({ type: 'same', text: row.left.text, lineNo: row.left.lineNo });
      continue;
    }
    if (row.left) out.push({ type: row.left.type, text: row.left.text, lineNo: row.left.lineNo });
    if (row.right) out.push({ type: row.right.type, text: row.right.text, lineNo: row.right.lineNo });
  }
  return out;
}
