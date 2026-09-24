/**
 * 文件操作：打开（选择器 / 指定路径 / SAF 多选）、新建、保存（含另存为 / 编码转换 /
 * 自动保存）、关闭（脏标签逐个确认）、编码与换行符切换、草稿捕获。
 * 状态注入：标签页集合与撤销历史来自 useEditorState，确认弹窗来自 useDiscardConfirm，
 * 已知磁盘内容由外部文件监听 hook 提供。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  pickAndReadFile, readLocalPath, saveFileToDisk, androidPickFiles, isTauri, READ_EXTENSIONS,
  openedFromBytes,
  type OpenedFile, type RemoteConflict,
} from '../lib/fileIO';
import {
  LARGE_FILE_CHARS, makeNewUntitled, makeLargePreviewTab, nextTabId,
  type FileTab,
} from '../lib/tabModel';
import {
  classifyBySize, fileSize, formatBytes, LARGE_FILE_MAX_BYTES,
} from '../lib/largeFile';
import { REMOTE_MAX_FILE_BYTES } from '../lib/remote';
import { detectLanguageFromPath } from '../lib/codemirror';
import { displayNameFromPath, IS_ANDROID_APP } from '../lib/platform';
import { applyLineEnding, type LineEnding } from '../lib/lineEndings';
import { encodingLabel } from '../lib/encoding';
import { addRecentFile, listRecentFiles, type RecentFile } from '../lib/recentFiles';
import { deleteDraft, draftKeyForTab, saveDraft, getDraft } from '../lib/drafts';
import { appAlert } from '../lib/appAlert';
import type { MessageKey } from '../lib/i18n';
import type { EditorState } from './useEditorState';
import type { DiscardDecision, PendingDiscardConfirm } from './useDiscardConfirm';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 跳转请求序号：区分同一标签的连续跳转（同位置二连跳也能触发 effect） */
let jumpSeq = 0;

export interface FileActionsOptions {
  editor: EditorState;
  askDiscardConfirm: (message: string, confirmText: string, saveText?: string) => Promise<DiscardDecision>;
  /* 自动保存的门：确认弹窗 / 退出流程进行中不落盘 */
  pendingDiscardRef: RefObject<PendingDiscardConfirm | null>;
  exitingRef: RefObject<boolean>;
  updateKnownDiskContent: (path: string, content: string) => void;
  /* 远程保存撞上「桌面期间也改过」：桌面那一份交给 diff 时间线由用户逐条采纳。
     不自动三方合并——两边都是有效修改，程序替用户选哪边都可能毁掉工作 */
  onRemoteConflict: (path: string, conflict: RemoteConflict) => void;
  /* 自动保存设置（App 层持有 settings 状态，只传相关字段） */
  autosaveEnabled: boolean;
  autosaveIntervalSec: number;
  t: Translate;
}

export function useFileActions({
  editor, askDiscardConfirm, pendingDiscardRef, exitingRef, updateKnownDiskContent, onRemoteConflict,
  autosaveEnabled, autosaveIntervalSec, t,
}: FileActionsOptions) {
  const { tabsRef, setTabs, activeTab, setActiveTabId, setActiveTabIdRef, recordContentChange, updateTabContent, deleteTab } = editor;
  const [saving, setSaving] = useState(false);
  /* 最近打开文件（菜单数据源；addRecentFile 后同步刷新） */
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => listRecentFiles());
  /* 保存进行中标记（含等待原生对话框期间），防止重复触发导致连续弹出对话框 */
  const savingRef = useRef(false);

  const addRecent = useCallback((path: string, name: string) => {
    addRecentFile(path, name);
    setRecentFiles(listRecentFiles());
  }, []);

  /* ---- 打开 ---- */

  /** 按路径打开（最近打开 / 文件树 / 拖拽 / argv / 选择器路径共用）；
      桌面端先按字节数分层：>512MB 拒绝、32~512MB 只读分块预览、其余整体读入。
      jump：打开后跳转到指定行列（跨文件搜索结果点击），编辑器挂载后消费一次 */
  const openPathIntoTab = useCallback(async (path: string, jump?: { line: number; col: number }) => {
    const jumpRequest = jump
      ? { line: jump.line, col: jump.col, seq: ++jumpSeq }
      : undefined;
    try {
      const size = await fileSize(path);
      /* 远程文件超上限是个死角（没有分块预览协议，桌面那套是 desktop-only 的），
         既不能编辑也不能只读浏览——直接说清楚比读一半再降级诚实 */
      if (size != null && path.startsWith('hide-remote://') && size > REMOTE_MAX_FILE_BYTES) {
        appAlert(t('remote.errTooLarge', {
          size: formatBytes(size),
          max: formatBytes(REMOTE_MAX_FILE_BYTES),
        }));
        return;
      }
      if (size != null) {
        const cls = classifyBySize(size);
        if (cls === 'reject') {
          appAlert(t('open.errTooLarge', {
            size: formatBytes(size),
            max: formatBytes(LARGE_FILE_MAX_BYTES),
          }));
          return;
        }
        if (cls === 'preview') {
          const existing = tabsRef.current.find(t => t.path === path);
          if (existing) {
            setActiveTabIdRef.current(existing.id);
            return;
          }
          const name = displayNameFromPath(path);
          const newTab = makeLargePreviewTab(path, name, detectLanguageFromPath(name));
          setTabs(prev => [...prev, newTab]);
          setActiveTabIdRef.current(newTab.id);
          addRecent(path, name);
          return;
        }
      }
      const file = await readLocalPath(path);
      const language = detectLanguageFromPath(file.name);
      const existing = tabsRef.current.find(t => t.path === path && !t.largePreview);
      if (existing) {
        if (jumpRequest) {
          /* 跳转请求：文件已在标签中，直接定位——不重读磁盘覆盖未保存内容 */
          setTabs(prev => prev.map(t => t.id === existing.id ? { ...t, jumpRequest } : t));
          setActiveTabIdRef.current(existing.id);
          return;
        }
        setTabs(prev => prev.map(t => t.id === existing.id
          ? { ...t, content: file.content, originalContent: file.content, isDirty: false, encoding: file.encoding, bom: file.bom, eol: file.eol, originalEol: file.eol, remoteBaseHash: file.remoteBaseHash }
          : t
        ));
        setActiveTabIdRef.current(existing.id);
        addRecent(path, file.name);
        return;
      }
      const newTab: FileTab = {
        id: nextTabId(),
        title: file.name,
        path,
        handle: null,
        content: file.content,
        originalContent: file.content,
        language,
        isDirty: false,
        readOnly: !!file.binary,
        /* 跳转场景用编辑视图：编辑器必然挂载，跳转定位才能生效 */
        mdView: jumpRequest ? 'edit' : language === 'markdown' ? 'preview' : 'edit',
        encoding: file.encoding,
        bom: file.bom,
        eol: file.eol,
        originalEol: file.eol,
        binary: file.binary,
        large: file.content.length > LARGE_FILE_CHARS,
        remoteBaseHash: file.remoteBaseHash,
        jumpRequest,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabIdRef.current(newTab.id);
      addRecent(path, file.name);
    } catch (e) {
      console.error('Failed to open file:', path, e);
      appAlert(t('open.errPath', { path }));
    }
  }, [addRecent, setTabs, t]);

  /** 外部应用交来的文件（安卓「打开方式」/「分享」）：同一文件已在标签里且有未保存改动时
      只把它切到前台，不用磁盘内容盖掉用户的改动；干净的标签照常重读磁盘 */
  const openPathFromExternal = useCallback(async (path: string) => {
    const dirty = tabsRef.current.find(t => t.path === path && t.isDirty);
    if (dirty) {
      setActiveTabIdRef.current(dirty.id);
      return;
    }
    await openPathIntoTab(path);
  }, [openPathIntoTab, setActiveTabIdRef, tabsRef]);

  /** 其他应用「分享 → H.I.D.E」送来的纯文本：落成一个新的未命名草稿标签，
      与 Ctrl+N 同一条路（内容进草稿、退出走未保存确认），不假装没收到 */
  const openSharedText = useCallback((text: string) => {
    const newTab = makeNewUntitled(text);
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [setActiveTabId, setTabs]);

  /** 打开文件选择器（安卓 = 系统文档选择器，支持多选；桌面 = 先取路径再统一走分层路由） */
  const handleOpenFile = useCallback(async () => {
    /* 安卓：系统文档选择器（支持多选），逐个复用 openPathIntoTab */
    if (IS_ANDROID_APP) {
      const picked = await androidPickFiles();
      if (!picked) return;
      for (const f of picked) await openPathIntoTab(f.uri);
      return;
    }
    /* 桌面 Tauri：只拿路径，内容读入交给 openPathIntoTab 的分层路由
       （先查尺寸再决定整读 / 分块预览 / 拒绝，避免选中超大文件先被整读） */
    if (isTauri) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: t('file.filterName'), extensions: READ_EXTENSIONS.map(e => e.slice(1)) }],
      });
      if (typeof selected !== 'string') return;
      await openPathIntoTab(selected);
      return;
    }
    let result: OpenedFile | null = null;
    try {
      result = await pickAndReadFile();
    } catch (e: any) {
      console.error('打开文件失败:', e);
      appAlert(t('open.errGeneric', { msg: e?.message ?? e }));
      return;
    }
    if (!result) return;
    const { content, name, path, handle, encoding, bom, eol, binary } = result;
    const language = detectLanguageFromPath(name);
    const newTab: FileTab = {
      id: nextTabId(),
      title: name,
      path,
      handle,
      content,
      originalContent: content,
      language,
      isDirty: false,
      readOnly: !!binary,
      mdView: language === 'markdown' ? 'preview' : 'edit',
      encoding,
      bom,
      eol,
      originalEol: eol,
      binary,
      large: content.length > LARGE_FILE_CHARS,
    };
    // if same file is already open, focus it
    const existing = tabsRef.current.find(t => t.path === path && !t.isDirty);
    if (existing) {
      setTabs(prev => prev.map(t => t.id === existing.id
        ? { ...t, content, originalContent: content, handle, encoding, bom, eol, originalEol: eol }
        : t
      ));
      setActiveTabIdRef.current(existing.id);
      return;
    }
    setTabs(prev => [...prev, newTab]);
    setActiveTabIdRef.current(newTab.id);
    if (path) addRecent(path, name);
  }, [addRecent, openPathIntoTab, setTabs, t]);

  /** 拖放的 File 对象打开为无路径标签(保存走另存为;超大文件提示拒绝) */
  const openDroppedFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (file.size > LARGE_FILE_MAX_BYTES) {
        appAlert(t('open.errTooLarge', { size: formatBytes(file.size), max: formatBytes(LARGE_FILE_MAX_BYTES) }));
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const opened = openedFromBytes(bytes, { name: file.name, path: null, handle: null });
        const language = detectLanguageFromPath(file.name);
        const newTab: FileTab = {
          id: nextTabId(),
          title: file.name,
          path: null,
          handle: null,
          content: opened.content,
          originalContent: opened.content,
          language,
          isDirty: false,
          readOnly: !!opened.binary,
          mdView: language === 'markdown' ? 'preview' : 'edit',
          encoding: opened.encoding,
          bom: opened.bom,
          eol: opened.eol,
          originalEol: opened.eol,
          binary: opened.binary,
          large: opened.content.length > LARGE_FILE_CHARS,
        };
        setTabs(prev => [...prev, newTab]);
        setActiveTabIdRef.current(newTab.id);
      } catch (e) {
        console.error('打开拖放文件失败:', file.name, e);
        appAlert(t('open.errGeneric', { msg: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, [setTabs, setActiveTabIdRef, t]);
  const handleNewFile = useCallback(() => {
    const newTab = makeNewUntitled();
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [setActiveTabId, setTabs]);

  /* ---- 保存 ---- */

  const persistTab = useCallback(async (tab: FileTab, saveAs: boolean, opts?: { silent?: boolean }): Promise<boolean> => {
    if (tab.readOnly || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await saveFileToDisk(tab, tab.content, saveAs, opts?.silent ?? false);
      const conflict = result.remoteConflict;
      if (conflict) {
        /* 桌面一个字都没写。基线换成桌面当前那份：用户采纳完再存，不会撞上同一次冲突 */
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, remoteBaseHash: conflict.serverHash } : t));
        if (tab.path) onRemoteConflict(tab.path, conflict);
        return false;
      }
      if (result.ok) {
        const savedPath = result.savedPath ?? tab.path;
        const savedTitle = savedPath ? displayNameFromPath(savedPath) : tab.title;
        /* 保存会改变文件名（untitled.txt → xx.md）：按新扩展名重判语言，
           否则新建文本存成 .md 后仍是 plaintext，永远没有预览/分屏入口；
           首次成为 markdown 时切到分屏，编辑内容与预览同屏可见 */
        const savedLang = detectLanguageFromPath(savedTitle);
        const becameMarkdown = savedLang === 'markdown' && tab.language !== 'markdown';
        /* encoding/bom 从传入的 tab（可能已带新编码）回写，编码转换保存后状态栏即时生效 */
        setTabs(prev => prev.map(t => t.id === tab.id
          ? {
              ...t,
              originalContent: t.content, isDirty: false, path: savedPath, title: savedTitle,
              originalEol: t.eol, encoding: tab.encoding, bom: tab.bom,
              remoteBaseHash: result.remoteBaseHash ?? t.remoteBaseHash,
              language: savedLang,
              mdView: becameMarkdown ? 'split' : t.mdView,
            }
          : t
        ));
        // 自写识别：更新已知磁盘内容，后续 watch 事件比对无差异，不产生 diff
        if (savedPath) {
          updateKnownDiskContent(savedPath, tab.content);
          addRecent(savedPath, savedTitle);
        }
      }
      return result.ok;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [addRecent, setTabs, updateKnownDiskContent]);

  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    await persistTab(activeTab, false);
  }, [activeTab, persistTab]);

  /* 另存为：无论是否已有路径，总是弹出保存对话框选择新位置 */
  const handleSaveAs = useCallback(async () => {
    if (!activeTab) return;
    await persistTab(activeTab, true);
  }, [activeTab, persistTab]);

  const handleRevert = useCallback(() => {
    if (!activeTab) return;
    /* major：恢复到磁盘版本是离散动作，独立成撤销步骤与内部 diff 条目 */
    updateTabContent(activeTab.id, activeTab.originalContent, { major: true });
  }, [activeTab, updateTabContent]);

  /* ---- 关闭（脏标签先确认；「关闭并保存」先落盘，取消/失败则不关闭）---- */

  const confirmDiscardTab = useCallback(async (tab: FileTab): Promise<boolean> => {
    const decision = await askDiscardConfirm(
      t('confirm.closeDirtyTitle', { name: tab.title }),
      t('confirm.closeNoSave'),
      t('confirm.closeAndSave'),
    );
    if (decision === 'cancel') return false;
    if (decision === 'discard') {
      /* 用户明确放弃：清除该标签的草稿，避免崩溃恢复时"复活" */
      deleteDraft(draftKeyForTab(tab));
      return true;
    }
    return await persistTab(tab, !tab.path);
  }, [askDiscardConfirm, persistTab, t]);

  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.isDirty && !(await confirmDiscardTab(tab))) return;
    deleteTab(tabId);
  }, [confirmDiscardTab, deleteTab, tabsRef]);

  /* ---- 标签栏右键菜单：批量关闭（脏标签逐个走确认弹窗，取消即中断余项） ---- */
  const closeOtherTabs = useCallback(async (keepId: string) => {
    for (const t of [...tabsRef.current]) {
      if (t.id === keepId) continue;
      await closeTab(t.id);
    }
  }, [closeTab, tabsRef]);

  const closeAllTabs = useCallback(async () => {
    for (const t of [...tabsRef.current]) {
      await closeTab(t.id);
    }
  }, [closeTab, tabsRef]);

  /* ---- 编码 / 换行符（状态栏入口）---- */

  /** 以指定编码重新打开当前文件（重读磁盘并重新解码；脏标签先确认丢弃） */
  const reopenWithEncoding = useCallback(async (tab: FileTab, encoding: string) => {
    if (!tab.path) {
      // 无路径标签：仅记录偏好，供另存时生效
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, encoding } : t));
      return;
    }
    if (tab.isDirty) {
      const decision = await askDiscardConfirm(
        t('confirm.reopenDirtyTitle', { name: tab.title }),
        t('confirm.reopenNoSave'),
      );
      if (decision !== 'discard') return;
    }
    try {
      const file = await readLocalPath(tab.path, encoding);
      setTabs(prev => prev.map(t => t.id === tab.id
        ? {
          ...t,
          content: file.content,
          originalContent: file.content,
          isDirty: false,
          encoding,
          bom: file.bom,
          eol: file.eol,
          originalEol: file.eol,
        }
        : t
      ));
      if (file.encoding !== encoding) {
        // 引擎不支持该编码时 readLocalPath 可能回退，同步真实值
        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, encoding: file.encoding } : t));
      }
    } catch (e) {
      console.error('以指定编码重新打开失败:', e);
      appAlert(t('open.errReopen', { enc: encodingLabel(encoding) }));
    }
  }, [askDiscardConfirm, setTabs, t]);

  /** 转换编码并立即保存（有路径时）；无路径仅记录，另存时生效 */
  const convertEncoding = useCallback(async (tab: FileTab, encoding: string) => {
    if (!tab.path || tab.readOnly) {
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, encoding } : t));
      return;
    }
    const ok = await persistTab({ ...tab, encoding }, false);
    if (!ok) appAlert(t('save.errConvert'));
  }, [persistTab, setTabs, t]);

  /** 切换换行符（保存时生效；与磁盘原值不同即标记未保存） */
  const setTabEol = useCallback((tab: FileTab, eol: LineEnding) => {
    setTabs(prev => prev.map(t => t.id === tab.id
      ? { ...t, eol, isDirty: t.content !== t.originalContent || eol !== t.originalEol }
      : t
    ));
  }, [setTabs]);

  /* ---- 自动保存：按设置间隔把「有路径且脏」的文件静默落盘（无路径标签由草稿兜底） ---- */
  useEffect(() => {
    if (!autosaveEnabled) return;
    const ms = Math.max(5, autosaveIntervalSec) * 1000;
    const id = setInterval(() => {
      /* 确认弹窗 / 退出流程 / 保存进行中：不自动保存，避免和用户「不保存」的决策打架 */
      if (pendingDiscardRef.current || exitingRef.current || savingRef.current) return;
      const targets = tabsRef.current.filter(t => t.isDirty && t.path && !t.readOnly);
      if (targets.length === 0) return;
      void (async () => {
        for (const tab of targets) {
          if (!tabsRef.current.includes(tab)) continue; /* 期间被关闭 */
          await persistTab(tab, false, { silent: true });
        }
      })();
    }, ms);
    return () => clearInterval(id);
  }, [autosaveEnabled, autosaveIntervalSec, pendingDiscardRef, persistTab, exitingRef, tabsRef]);

  /* ---- 草稿捕获（崩溃保护，始终开启）：脏标签内容防抖 3s 写入本地草稿；
     干净标签的既有草稿即时清除。保存成功后 isDirty 变 false，同机制自动清草稿 ---- */
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const tab of editor.tabs) {
        const key = draftKeyForTab(tab);
        if (tab.isDirty && !tab.readOnly) {
          saveDraft(key, tab.content);
        } else if (getDraft(key) !== null) {
          deleteDraft(key);
        }
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [editor.tabs]);

  return {
    saving, savingRef,
    recentFiles, setRecentFiles,
    openPathIntoTab,
    openPathFromExternal,
    openSharedText,
    openDroppedFiles,
    handleOpenFile, handleNewFile,
    persistTab,
    handleSave, handleSaveAs, handleRevert,
    confirmDiscardTab, closeTab, closeOtherTabs, closeAllTabs,
    reopenWithEncoding, convertEncoding, setTabEol,
  };
}
