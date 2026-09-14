/**
 * Diff 时间线状态（外部修改与软件内编辑两套相互独立的记录）：
 * 外部时间线由磁盘 watch 驱动（handleExternalChange 在 App 层组装，因需要接入
 * 标签页状态与撤销历史）；内部时间线经 recordInternalEdit 由 useEditorState 回调落账。
 * 时间线存活域 = 当前被标签页引用的路径集合（陈旧条目由 App 层的 prune 效果清除）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  appendEntry, removeEntry, revertEntry, trimTimeline, clampDiffEntries,
  applyInternalEdit, DEFAULT_DIFF_ENTRIES,
  type ExternalDiffEntry, type InternalDiffEntry,
} from '../lib/diffTimeline';
import type { InternalEditRecord } from './useEditorState';

const MAX_ENTRIES_KEY = 'heid-diff-max-entries';

function loadMaxEntries(): number {
  const raw = localStorage.getItem(MAX_ENTRIES_KEY);
  return raw === null ? DEFAULT_DIFF_ENTRIES : clampDiffEntries(raw);
}

export function useDiffTimelines() {
  const [diffTimelines, setDiffTimelines] = useState<Record<string, ExternalDiffEntry[]>>({});
  const [internalDiffTimelines, setInternalDiffTimelines] = useState<Record<string, InternalDiffEntry[]>>({});
  /* 时间线每文件保留条数（5~50，默认 30；localStorage 持久化，仅影响后续追加与即时裁剪） */
  const [maxDiffEntries, setMaxDiffEntries] = useState<number>(loadMaxEntries);

  /* 保留条数设置持久化 */
  useEffect(() => {
    localStorage.setItem(MAX_ENTRIES_KEY, String(maxDiffEntries));
  }, [maxDiffEntries]);

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

  /** 外部修改追加条目（App 层检测到磁盘变化时调用） */
  const appendExternalEntry = useCallback((path: string, before: string, after: string, now: number) => {
    setDiffTimelines(prev => ({ ...prev, [path]: appendEntry(prev[path] ?? [], before, after, now, maxDiffEntries) }));
  }, [maxDiffEntries]);

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
    recordInternalEdit,
    appendExternalEntry,
    handleAcceptDiff, handleAcceptInternalDiff,
    dropExternalFrom, dropInternalFrom,
  };
}

export type DiffTimelines = ReturnType<typeof useDiffTimelines>;
