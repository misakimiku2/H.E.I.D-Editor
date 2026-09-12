import { diffLines } from 'diff';

/**
 * 外部 Diff 时间线纯函数模块：
 * 追加、上限裁剪、接受移除、撤销级联移除、变更判定、增删统计与双栏对比行模型。
 * 时间线为链式结构：第 N 条的 before 等于第 N-1 条的 after。
 */

/** 单文件外部修改时间线条目 */
export interface ExternalDiffEntry {
  id: string;
  /** 修改前磁盘内容快照 */
  before: string;
  /** 修改后磁盘内容快照 */
  after: string;
  /** 检测到的时间戳 */
  detectedAt: number;
}

/** 时间线保留条数的可调范围与默认值（用户可在 Diff 弹窗中设置） */
export const MIN_DIFF_ENTRIES = 5;
export const MAX_DIFF_ENTRIES = 50;
export const DEFAULT_DIFF_ENTRIES = 30;

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

/** 裁剪到 maxEntries 条（保留最新）；未超限时返回原数组引用 */
export function trimTimeline(timeline: ExternalDiffEntry[], maxEntries: number): ExternalDiffEntry[] {
  return timeline.length > maxEntries ? timeline.slice(timeline.length - maxEntries) : timeline;
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
