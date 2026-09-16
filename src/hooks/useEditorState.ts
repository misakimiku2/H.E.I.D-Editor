/**
 * 编辑器核心状态：标签页集合 + 激活标签 + 内容撤销历史。
 * recordContentChange 是枢纽——撤销历史与「软件内编辑」diff 时间线共用同一合并判定，
 * 内部时间线的落账经 options.onInternalEdit 由外层（useDiffTimelines）注入，避免双向依赖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InternalDiffEntry } from '../lib/diffTimeline';
import { applyInternalEdit } from '../lib/diffTimeline';
import {
  ensureHistory, recordStep, undoStep, redoStep, canUndoHistory, canRedoHistory,
  type TabHistory,
} from '../lib/tabHistory';
import type { FileTab, MdViewMode, CsvTabState, JsonViewMode } from '../lib/tabModel';

/** 内容变化来源：edit=软件内编辑（同步记内部 diff 时间线）；external=磁盘外部修改；revert=时间线撤销回写 */
export type ContentChangeSource = 'edit' | 'external' | 'revert';

export interface InternalEditRecord {
  path: string;
  before: string;
  after: string;
  newStep: boolean;
  now: number;
}

export interface EditorStateOptions {
  /** 每条时间线保留条数（供内部时间线落账时裁剪） */
  maxDiffEntries: number;
  /** 软件内编辑落入内部 diff 时间线（source='edit' 且标签有路径时回调） */
  onInternalEdit: (record: InternalEditRecord) => void;
  /** 初始标签（App 传入初始 welcome 页；会话恢复在挂载后叠加） */
  initialTabs?: FileTab[];
}

export function useEditorState({ maxDiffEntries, onInternalEdit, initialTabs }: EditorStateOptions) {
  const [tabs, setTabs] = useState<FileTab[]>(() => initialTabs ?? []);
  const [activeTabId, setActiveTabId] = useState<string>(() => '');

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const setActiveTabIdRef = useRef(setActiveTabId);
  setActiveTabIdRef.current = setActiveTabId;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  /* 每个标签页的内容历史（撤销/重做）：stack 存内容快照，index 指向当前态 */
  const historiesRef = useRef<Map<string, TabHistory>>(new Map());

  const ensureHistoryFor = useCallback((tabId: string, initialContent: string): TabHistory => {
    return ensureHistory(historiesRef.current, tabId, initialContent);
  }, []);

  const onInternalEditRef = useRef(onInternalEdit);
  onInternalEditRef.current = onInternalEdit;

  /* 记录一次内容变化；major（如右键格式化）强制独立成条，否则按时间间隔合并连击。
     source 为 edit 且标签页有路径时，按同样的合并判定把变化推进内部 diff 时间线
     （未命名标签无路径不记录；外部修改/时间线撤销不属于自己的时间线，跳过） */
  const recordContentChange = useCallback((tabId: string, prevContent: string, nextContent: string, major?: boolean, source: ContentChangeSource = 'external') => {
    if (prevContent === nextContent) return;
    const h = ensureHistoryFor(tabId, prevContent);
    const now = Date.now();
    const { recorded, newStep } = recordStep(h, prevContent, nextContent, major, now);
    if (!recorded) return;
    if (source === 'edit') {
      const path = tabsRef.current.find(tb => tb.id === tabId)?.path;
      if (path) {
        onInternalEditRef.current({ path, before: prevContent, after: nextContent, newStep, now });
      }
    }
  }, [ensureHistoryFor]);

  /* 关闭/切换标签后激活态失效时，兜底选中最后一个标签 */
  useEffect(() => {
    if (!tabs.find(t => t.id === activeTabId)) {
      setActiveTabId(tabs.length > 0 ? tabs[tabs.length - 1].id : '');
    }
  }, [tabs, activeTabId]);

  const activeTab = useMemo(
    () => tabs.find(t => t.id === activeTabId) || null,
    [tabs, activeTabId]
  );

  /* ---- 标签内容更新（编辑器 onChange / 还原到磁盘版本）---- */
  const updateTabContent = useCallback((tabId: string, content: string, opts?: { major?: boolean }) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab) recordContentChange(tabId, tab.content, content, opts?.major, 'edit');
    setTabs(prev => prev.map(t => {
      if (t.id !== tabId) return t;
      /* eol 与磁盘原值不同同样构成未保存状态（保存时才真正换行符转换） */
      return { ...t, content, isDirty: content !== t.originalContent || t.eol !== t.originalEol };
    }));
  }, [recordContentChange]);

  /* ---- 撤销 / 重做（作用于当前标签页内容历史）---- */
  const canUndo = !!activeTab && canUndoHistory(historiesRef.current.get(activeTab.id));
  const canRedo = !!activeTab && canRedoHistory(historiesRef.current.get(activeTab.id));

  const handleUndo = useCallback(() => {
    if (!activeTab) return;
    const content = undoStep(historiesRef.current.get(activeTab.id), Date.now());
    if (content === null) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id
      ? { ...t, content, isDirty: content !== t.originalContent || t.eol !== t.originalEol }
      : t
    ));
  }, [activeTab]);

  const handleRedo = useCallback(() => {
    if (!activeTab) return;
    const content = redoStep(historiesRef.current.get(activeTab.id), Date.now());
    if (content === null) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id
      ? { ...t, content, isDirty: content !== t.originalContent || t.eol !== t.originalEol }
      : t
    ));
  }, [activeTab]);

  /* 切换当前 markdown 标签页的视图模式 */
  const setMdView = useCallback((mode: MdViewMode) => {
    if (!activeTab) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, mdView: mode } : t));
  }, [activeTab]);

  /* 更新当前 csv 标签页的网格 UI 状态（视图/表头开关/手动列宽），其余字段不动 */
  const setCsvState = useCallback((patch: Partial<CsvTabState>) => {
    if (!activeTab) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, ...patch } : t));
  }, [activeTab]);

  /* 切换当前 json/yaml 标签页的结构树视图状态 */
  const setJsonView = useCallback((mode: JsonViewMode) => {
    if (!activeTab) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, jsonView: mode } : t));
  }, [activeTab]);

  /* 当前被标签页引用的真实文件路径（去重）——两条时间线的存活域（关最后一个标签页即丢弃）。
     大文件分块预览标签除外：watcher 基准读取会整读文件，正是要避免的路径 */
  const referencedPaths = useMemo(
    () => Array.from(new Set(tabs.flatMap(t => (t.path && !t.largePreview ? [t.path] : [])))),
    [tabs]
  );

  const deleteTab = useCallback((tabId: string) => {
    historiesRef.current.delete(tabId);
    setTabs(prev => prev.filter(t => t.id !== tabId));
  }, []);

  return {
    tabs, setTabs, tabsRef,
    activeTabId, setActiveTabId, setActiveTabIdRef, activeTabIdRef,
    activeTab,
    ensureHistoryFor,
    recordContentChange,
    updateTabContent,
    canUndo, canRedo, handleUndo, handleRedo,
    setMdView,
    setCsvState,
    setJsonView,
    referencedPaths,
    deleteTab,
  };
}

export type EditorState = ReturnType<typeof useEditorState>;
