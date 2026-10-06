/**
 * Diff 时间线状态（外部修改与软件内编辑两套相互独立的记录）：
 * 外部时间线由磁盘 watch 驱动（handleExternalChange 在 App 层组装，因需要接入
 * 标签页状态与撤销历史）；内部时间线经 recordInternalEdit 由 useEditorState 回调落账。
 * 时间线存活域 = 当前被标签页引用的路径集合（陈旧条目由 App 层的 prune 效果清除）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  appendExternalChange, removeEntry, revertEntry, trimTimeline, clampDiffEntries,
  applyInternalEdit, normalizeCoalesceWindow, DEFAULT_DIFF_ENTRIES, DEFAULT_COALESCE_WINDOW,
  type CoalesceWindow, type ExternalDiffEntry, type InternalDiffEntry,
} from '../lib/diffTimeline';
import type { InternalEditRecord } from './useEditorState';

const MAX_ENTRIES_KEY = 'heid-diff-max-entries';
const COALESCE_WINDOW_KEY = 'heid-diff-coalesce-window';

function loadMaxEntries(): number {
  const raw = localStorage.getItem(MAX_ENTRIES_KEY);
  return raw === null ? DEFAULT_DIFF_ENTRIES : clampDiffEntries(raw);
}

function loadCoalesceWindow(): CoalesceWindow {
  const raw = localStorage.getItem(COALESCE_WINDOW_KEY);
  return raw === null ? DEFAULT_COALESCE_WINDOW : normalizeCoalesceWindow(raw);
}

export function useDiffTimelines() {
  const [diffTimelines, setDiffTimelines] = useState<Record<string, ExternalDiffEntry[]>>({});
  const [internalDiffTimelines, setInternalDiffTimelines] = useState<Record<string, InternalDiffEntry[]>>({});
  /* 时间线每文件保留条数（5~50，默认 30；localStorage 持久化，仅影响后续追加与即时裁剪） */
  const [maxDiffEntries, setMaxDiffEntries] = useState<number>(loadMaxEntries);
  /* 外部修改的分批间隔（分钟，0 = 不分批）：只决定后续写入怎么归条，不回改已有条目 */
  const [coalesceWindow, setCoalesceWindow] = useState<CoalesceWindow>(loadCoalesceWindow);

  /* 保留条数设置持久化 */
  useEffect(() => {
    localStorage.setItem(MAX_ENTRIES_KEY, String(maxDiffEntries));
  }, [maxDiffEntries]);

  useEffect(() => {
    localStorage.setItem(COALESCE_WINDOW_KEY, String(coalesceWindow));
  }, [coalesceWindow]);

  /* 调低保留条数时立即裁剪所有时间线（丢弃最旧） */
  useEffect(() => {
    setDiffTimelines(prev => {
      let changed = false;
      const next: Record<string, ExternalDiffEntry[]> = {};
      for (const [p, entries] of Object.entries(prev)) {
        const trimmed = trimTimeline(entries, maxDiffEntries);
        if (trimmed !== entries) changed = true;
        next[p] = trimmed;
      }
      return changed ? next : prev;
    });
    setInternalDiffTimelines(prev => {
      let changed = false;
      const next: Record<string, InternalDiffEntry[]> = {};
      for (const [p, entries] of Object.entries(prev)) {
        const trimmed = trimTimeline(entries, maxDiffEntries);
        if (trimmed !== entries) changed = true;
        next[p] = trimmed;
      }
      return changed ? next : prev;
    });
  }, [maxDiffEntries]);

  /** 软件内编辑落账（useEditorState 检测到 source='edit' 且标签有路径时回调） */
  const recordInternalEdit = useCallback((record: InternalEditRecord) => {
    setInternalDiffTimelines(prev => ({
      ...prev,
      [record.path]: applyInternalEdit(prev[record.path] ?? [], record.before, record.after, record.newStep, maxDiffEntries, record.now),
    }));
  }, [maxDiffEntries]);

  /**
   * 外部修改落账（App 层检测到磁盘变化时调用）：默认并进该文件最后一条未处理变更，
   * 所以 AI 连改十几次在时间线上仍是一条待审阅的变更，中间过程留在它的 steps 里。
   */
  const appendExternalEntry = useCallback((path: string, before: string, after: string, now: number) => {
    setDiffTimelines(prev => ({
      ...prev,
      [path]: appendExternalChange(prev[path] ?? [], before, after, now, {
        maxEntries: maxDiffEntries,
        windowMinutes: coalesceWindow,
      }),
    }));
  }, [maxDiffEntries, coalesceWindow]);

  /* 接受：经确认后仅移除该条目，磁盘与编辑器均不动 */
  const handleAcceptDiff = useCallback((path: string, entryId: string) => {
    setDiffTimelines(prev => {
      const next = { ...prev, [path]: removeEntry(prev[path] ?? [], entryId) };
      if (next[path].length === 0) delete next[path];
      return next;
    });
  }, []);

  /* 接受（内部）：仅移除该条目，编辑器内容不动 */
  const handleAcceptInternalDiff = useCallback((path: string, entryId: string) => {
    setInternalDiffTimelines(prev => {
      const next = { ...prev, [path]: removeEntry(prev[path] ?? [], entryId) };
      if (next[path].length === 0) delete next[path];
      return next;
    });
  }, []);

  /* 全部接受（外部）：清空所有文件的外部时间线。接受本身只移除条目、
     磁盘与编辑器均不动，所以批量接受没有副作用，不需要逐条写回 */
  const handleAcceptAllExternal = useCallback(() => {
    setDiffTimelines(prev => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  /* 全部接受（内部）：同上，只清记录 */
  const handleAcceptAllInternal = useCallback(() => {
    setInternalDiffTimelines(prev => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  /** 撤销外部修改：写回成功后移除该条及其后所有条目（写盘与标签同步由 App 层完成后的收尾） */
  const dropExternalFrom = useCallback((path: string, entryId: string) => {
    setDiffTimelines(prev => {
      const kept = revertEntry(prev[path] ?? [], entryId);
      const next = { ...prev };
      if (kept.length > 0) next[path] = kept;
      else delete next[path];
      return next;
    });
  }, []);

  /** 撤销内部修改：移除该条及其后所有条目 */
  const dropInternalFrom = useCallback((path: string, entryId: string) => {
    setInternalDiffTimelines(prev => {
      const kept = revertEntry(prev[path] ?? [], entryId);
      const next = { ...prev };
      if (kept.length > 0) next[path] = kept;
      else delete next[path];
      return next;
    });
  }, []);

  return {
    diffTimelines, setDiffTimelines,
    internalDiffTimelines, setInternalDiffTimelines,
    maxDiffEntries, setMaxDiffEntries,
    coalesceWindow, setCoalesceWindow,
    recordInternalEdit,
    appendExternalEntry,
    handleAcceptDiff, handleAcceptInternalDiff,
    handleAcceptAllExternal, handleAcceptAllInternal,
    dropExternalFrom, dropInternalFrom,
  };
}

export type DiffTimelines = ReturnType<typeof useDiffTimelines>;
