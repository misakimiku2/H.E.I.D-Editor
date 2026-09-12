import { useEffect, useMemo, useState } from 'react';
import { X, Check, RotateCcw, FileText, GitCompare, Minus, Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  buildDiffRows,
  diffStats,
  MAX_DIFF_ENTRIES,
  MIN_DIFF_ENTRIES,
  type DiffRow,
  type ExternalDiffEntry,
} from '../lib/diffTimeline';
import { ConfirmDialog } from './ConfirmDialog';

/* ---------- entry 级结果缓存：条目对象不可变且跨渲染稳定，避免大文件重复计算 ---------- */

const statsCache = new WeakMap<ExternalDiffEntry, { added: number; removed: number }>();
function statsOf(entry: ExternalDiffEntry): { added: number; removed: number } {
  let s = statsCache.get(entry);
  if (!s) {
    s = diffStats(entry.before, entry.after);
    statsCache.set(entry, s);
  }
  return s;
}

const rowsCache = new WeakMap<ExternalDiffEntry, DiffRow[]>();
function rowsOf(entry: ExternalDiffEntry): DiffRow[] {
  let r = rowsCache.get(entry);
  if (!r) {
    r = buildDiffRows(entry.before, entry.after);
    rowsCache.set(entry, r);
  }
  return r;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

interface Selection {
  path: string;
  id: string;
}

interface PendingConfirm {
  kind: 'accept' | 'revert';
  path: string;
  id: string;
}

export interface DiffModalProps {
  /** 文件路径 → 该文件的未处理时间线（空时间线的文件不展示） */
  timelines: Record<string, ExternalDiffEntry[]>;
  isDarkMode: boolean;
  /** 打开弹窗时优先展示该文件（当前激活标签页）的最新条目 */
  focusPath?: string | null;
  /** 时间线每文件保留条数（5~50），页脚可调 */
  maxEntries: number;
  onChangeMaxEntries: (n: number) => void;
  onClose: () => void;
  onAccept: (path: string, entryId: string) => void;
  onRevert: (path: string, entryId: string) => void;
}

/** 外部修改 Diff 弹窗：左侧按文件分组的时间线 + 右侧选中条目的左右双栏对比 */
export function DiffModal({
  timelines,
  isDarkMode,
  focusPath,
  maxEntries,
  onChangeMaxEntries,
  onClose,
  onAccept,
  onRevert,
}: DiffModalProps) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);

  /* 按文件分组（含未处理条目的文件才出现），组内时间倒序 */
  const groups = useMemo(() => {
    return Object.entries(timelines)
      .filter(([, entries]) => entries.length > 0)
      .map(([path, entries]) => ({ path, name: basename(path), entries: [...entries].reverse() }));
  }, [timelines]);

  /* 默认选中：优先 focusPath（激活标签页对应文件）的最新条目，否则取第一个文件的最新条目 */
  const preferredSelection = useMemo<Selection | null>(() => {
    const group = focusPath ? groups.find(g => g.path === focusPath) : undefined;
    const first = group ?? groups[0];
    return first ? { path: first.path, id: first.entries[0].id } : null;
  }, [focusPath, groups]);

  /* 选中条目失效（被接受/撤销移除）时，自动回落到默认选中 */
  const effectiveSelection = useMemo<Selection | null>(() => {
    if (selected && groups.some(g => g.path === selected.path && g.entries.some(e => e.id === selected.id))) {
      return selected;
    }
    return preferredSelection;
  }, [selected, groups, preferredSelection]);

  const selectedEntry = useMemo<ExternalDiffEntry | null>(() => {
    if (!effectiveSelection) return null;
    const group = groups.find(g => g.path === effectiveSelection.path);
    return group?.entries.find(e => e.id === effectiveSelection.id) ?? null;
  }, [effectiveSelection, groups]);

  const totalPending = useMemo(
    () => groups.reduce((sum, g) => sum + g.entries.length, 0),
    [groups]
  );

  /* Esc 关闭（确认弹窗打开时交给它处理） */
  useEffect(() => {
    if (confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, onClose]);

  const panel = isDarkMode
    ? "border-zinc-700 bg-zinc-800 text-zinc-100"
    : "border-zinc-200 bg-white text-zinc-800";
  const softBorder = isDarkMode ? "border-zinc-700" : "border-zinc-200";

  const runConfirm = () => {
    if (!confirming) return;
    const c = confirming;
    setConfirming(null);
    if (c.kind === 'accept') onAccept(c.path, c.id);
    else onRevert(c.path, c.id);
  };

  const confirmMeta = confirming
    ? confirming.kind === 'accept'
      ? {
          title: '接受外部修改',
          message: '确认接受这次外部修改？该 diff 条目将从时间线移除。',
        }
      : {
          title: '撤销外部修改',
          message: '确认撤销这次外部修改？磁盘文件将被恢复到此修改之前的内容。',
        }
    : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-zinc-950/30 backdrop-blur-sm"
        onClick={() => { if (!confirming) onClose(); }}
      />
      <div className={cn(
        "relative w-[min(960px,92vw)] h-[min(620px,88vh)] rounded-xl border shadow-2xl flex flex-col overflow-hidden",
        panel
      )}>
        {/* header */}
        <div className={cn("h-11 border-b flex items-center px-4 gap-2 shrink-0", softBorder)}>
          <GitCompare size={15} className="shrink-0 opacity-70" />
          <span className="text-sm font-semibold">外部修改 Diff</span>
          <span className={cn(
            "px-2 py-0.5 rounded-full text-[10px] font-medium border",
            isDarkMode ? "border-zinc-600 text-zinc-400" : "border-zinc-300 text-zinc-500"
          )}>
            {totalPending} 条未处理
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-100 text-zinc-500"
            )}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* body：时间线 + 对比区 */}
        <div className="flex-1 flex min-h-0">
          {/* 左侧时间线 */}
          <div className={cn("w-60 border-r overflow-y-auto shrink-0 py-2", softBorder)}>
            {groups.length === 0 ? (
              <div className={cn("px-4 py-8 text-center text-xs", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                暂无未处理的外部修改
              </div>
            ) : groups.map(group => (
              <div key={group.path} className="mb-2">
                <div className={cn(
                  "px-3 py-1 flex items-center gap-1.5 text-[11px] font-semibold sticky top-0",
                  isDarkMode ? "bg-zinc-800 text-zinc-400" : "bg-white text-zinc-500"
                )}>
                  <FileText size={11} className="shrink-0 opacity-60" />
                  <span className="truncate" title={group.path}>{group.name}</span>
                  <span className="ml-auto opacity-60">{group.entries.length}</span>
                </div>
                {group.entries.map(entry => {
                  const stats = statsOf(entry);
                  const isSel = effectiveSelection?.path === group.path && effectiveSelection?.id === entry.id;
                  return (
                    <button
                      key={entry.id}
                      onClick={() => setSelected({ path: group.path, id: entry.id })}
                      className={cn(
                        "w-full px-3 py-1.5 flex items-center gap-2 text-[11px] transition-colors text-left border-l-2",
                        isSel
                          ? cn("border-blue-500", isDarkMode ? "bg-zinc-700/70" : "bg-zinc-100")
                          : cn("border-transparent", isDarkMode ? "hover:bg-zinc-700/40" : "hover:bg-zinc-50")
                      )}
                    >
                      <span className={cn("shrink-0 tabular-nums", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                        {formatTime(entry.detectedAt)}
                      </span>
                      <span className="ml-auto shrink-0 font-medium tabular-nums">
                        <span className="text-emerald-500">+{stats.added}</span>{' '}
                        <span className="text-red-500">-{stats.removed}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 右侧双栏对比 */}
          {selectedEntry ? (
            <div className="flex-1 min-w-0 flex flex-col">
              {/* 栏头：与下方两半列宽对齐 */}
              <div className={cn("h-9 border-b flex items-center shrink-0 text-[11px] font-medium", softBorder)}>
                <div className={cn("w-1/2 px-3 truncate", isDarkMode ? "text-zinc-400" : "text-zinc-500")} title={selectedEntry.before}>
                  修改前
                </div>
                <div className={cn("w-1/2 px-3 truncate border-l", softBorder, isDarkMode ? "text-zinc-400" : "text-zinc-500")} title={selectedEntry.after}>
                  修改后
                </div>
              </div>
              <div className="flex-1 overflow-auto font-mono text-[11px] leading-5">
                {rowsOf(selectedEntry).map((row, i) => (
                  <div key={i} className="flex">
                    <DiffHalf cell={row.left} isDarkMode={isDarkMode} />
                    <DiffHalf cell={row.right} isDarkMode={isDarkMode} borderl />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2">
              <GitCompare size={28} className={isDarkMode ? "text-zinc-600" : "text-zinc-300"} />
              <p className={cn("text-xs", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                选择左侧时间线条目查看对比
              </p>
            </div>
          )}
        </div>

        {/* footer：左侧保留条数设置 + 右侧操作按钮（作用于选中条目） */}
        <div className={cn("h-12 border-t flex items-center justify-end px-4 gap-2 shrink-0", softBorder)}>
          {/* 时间线保留条数设置：每文件保留的最大条数，超出丢弃最旧 */}
          <div className="mr-auto flex items-center gap-2 text-[11px]">
            <span className={isDarkMode ? "text-zinc-500" : "text-zinc-400"}>保留条数</span>
            <div className={cn(
              "flex items-center rounded-md border overflow-hidden shrink-0",
              isDarkMode ? "border-zinc-700" : "border-zinc-200"
            )}>
              <button
                onClick={() => onChangeMaxEntries(maxEntries - 1)}
                disabled={maxEntries <= MIN_DIFF_ENTRIES}
                title={`减少保留条数（最小 ${MIN_DIFF_ENTRIES}）`}
                className={cn(
                  "w-6 h-6 flex items-center justify-center transition-colors disabled:opacity-30",
                  isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
                )}
              >
                <Minus size={11} />
              </button>
              <span
                className="w-8 text-center tabular-nums font-medium"
                title={`时间线每文件保留的最大条数，超出丢弃最旧（${MIN_DIFF_ENTRIES} ~ ${MAX_DIFF_ENTRIES}）`}
              >
                {maxEntries}
              </span>
              <button
                onClick={() => onChangeMaxEntries(maxEntries + 1)}
                disabled={maxEntries >= MAX_DIFF_ENTRIES}
                title={`增加保留条数（最大 ${MAX_DIFF_ENTRIES}）`}
                className={cn(
                  "w-6 h-6 flex items-center justify-center transition-colors disabled:opacity-30",
                  isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
                )}
              >
                <Plus size={11} />
              </button>
            </div>
          </div>
          <button
            onClick={() => effectiveSelection && setConfirming({ kind: 'accept', ...effectiveSelection })}
            disabled={!effectiveSelection}
            className={cn(
              "px-3 h-7 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40",
              isDarkMode
                ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
                : "bg-zinc-200 hover:bg-zinc-300 text-zinc-700"
            )}
            title="接受该修改：仅移除此条目，磁盘与编辑器均不动"
          >
            <Check size={13} /> 接受
          </button>
          <button
            onClick={() => effectiveSelection && setConfirming({ kind: 'revert', ...effectiveSelection })}
            disabled={!effectiveSelection}
            className={cn(
              "px-3 h-7 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 text-white",
              "bg-red-600 hover:bg-red-500"
            )}
            title="撤销该修改：把此条目的修改前内容写回磁盘，并移除该条及其后所有条目"
          >
            <RotateCcw size={13} /> 撤销修改
          </button>
        </div>

        {/* 二次确认（叠加在本弹窗上层） */}
        {confirming && confirmMeta && (
          <ConfirmDialog
            title={confirmMeta.title}
            message={confirmMeta.message}
            isDarkMode={isDarkMode}
            danger={confirming.kind === 'revert'}
            onConfirm={runConfirm}
            onCancel={() => setConfirming(null)}
          />
        )}
      </div>
    </div>
  );
}

/* 双栏对比的单侧单元格：行号 + 文本，删除红底 / 新增绿底 / 空位淡填充 */
function DiffHalf({ cell, isDarkMode, borderl }: { cell: DiffRow['left']; isDarkMode: boolean; borderl?: boolean }) {
  return (
    <div className={cn(
      "w-1/2 flex min-w-0",
      borderl && (isDarkMode ? "border-l border-zinc-700" : "border-l border-zinc-200"),
      cell?.type === 'del' && "bg-red-500/15",
      cell?.type === 'add' && "bg-emerald-500/15",
      cell === null && "bg-zinc-500/5"
    )}>
      {cell && (
        <span className="w-9 shrink-0 text-right pr-2 select-none tabular-nums opacity-40">
          {cell.lineNo}
        </span>
      )}
      <span className="whitespace-pre-wrap break-all pr-2 min-w-0">
        {cell?.text ?? ''}
      </span>
    </div>
  );
}
