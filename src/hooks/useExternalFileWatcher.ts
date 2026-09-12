import { useCallback, useEffect, useRef } from 'react';
import { detectExternalChange } from '../lib/diffTimeline';

/**
 * 外部文件修改监听（仅 Tauri 桌面端启用，浏览器模式整个功能不启用）：
 * - 依据 paths 同步 watch 生命周期：打开建立（同路径多标签页共享一份）、
 *   关闭最后一个引用时拆除并清理状态；
 * - 连发事件由插件原生 debouncer 以 300ms 窗口合并，事件到达后重读文件；
 * - 与「最后已知磁盘内容」比对：相同忽略（自身写入），不同回调通知 App。
 */

export interface UseExternalFileWatcherOptions {
  /** 当前被打开标签页引用的文件路径（去重；仅 Tauri 真实路径） */
  paths: string[];
  /** 仅 Tauri 桌面端为 true */
  enabled: boolean;
  /** 检测到真实外部修改时回调（before 为旧已知内容，after 为新磁盘内容） */
  onExternalChange: (path: string, before: string, after: string) => void;
}

export interface ExternalFileWatcherApi {
  /** 自身写入磁盘（保存 / 撤销写回）后更新已知内容，使后续 watch 事件比对无差异 */
  updateKnownDiskContent: (path: string, content: string) => void;
}

/** watch 事件去抖窗口：合并外部程序的连发写入事件 */
const WATCH_DEBOUNCE_MS = 300;

/** 桌面端解码读文件（走 read_text_file 命令，编码感知），统一 LF 归一后返回 */
async function readDecoded(path: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  const r = await invoke<{ text: string }>('read_text_file', { path, force: null });
  return r.text.replace(/\r\n?/g, '\n');
}

export function useExternalFileWatcher({
  paths,
  enabled,
  onExternalChange,
}: UseExternalFileWatcherOptions): ExternalFileWatcherApi {
  const unwatchersRef = useRef<Map<string, () => void>>(new Map());
  const diskContentsRef = useRef<Map<string, string>>(new Map());
  /* 每路径串行化重读，避免连发事件下异步读文件交错 */
  const pendingReadsRef = useRef<Map<string, Promise<void>>>(new Map());
  /* watcher 建立中标记，防止 effect 快速重跑时重复建立 */
  const creatingRef = useRef<Set<string>>(new Set());
  /* 最新一次同步计算出的期望路径集合，供异步建立完成时校验 */
  const desiredPathsRef = useRef<ReadonlySet<string>>(new Set());

  const onExternalChangeRef = useRef(onExternalChange);
  onExternalChangeRef.current = onExternalChange;

  /* 重读并做真实变更判定（越过的读取失败由调用链吞掉并告警）。
     桌面端经 read_text_file 命令解码（编码与打开时一致），文本统一 LF 归一后比对，
     与编辑器内容空间保持同构，避免 GBK 等编码文件产生假 diff */
  const recheckFile = useCallback(async (path: string): Promise<void> => {
    const content = await readDecoded(path);
    const known = diskContentsRef.current.get(path);
    if (known === undefined) {
      // 无基准（异常场景）：静默落下基准，不产生条目
      diskContentsRef.current.set(path, content);
      return;
    }
    const change = detectExternalChange(known, content);
    if (!change) return;
    diskContentsRef.current.set(path, content);
    onExternalChangeRef.current(path, change.before, change.after);
  }, []);

  const handleWatchEvent = useCallback((path: string) => {
    const prev = pendingReadsRef.current.get(path) ?? Promise.resolve();
    const next = prev.then(() => recheckFile(path)).catch(e => {
      // 外部删除/重命名导致重读失败：忽略本次事件，不做删除场景处理
      console.warn(`[external-diff] 重读文件失败，忽略本次事件: ${path}`, e);
    });
    pendingReadsRef.current.set(path, next);
  }, [recheckFile]);

  const createWatcher = useCallback(async (path: string): Promise<void> => {
    try {
      const { watch } = await import('@tauri-apps/plugin-fs');
      // 建立监听时读到磁盘内容作为基准（首条 diff 的 before 即此内容）
      const content = await readDecoded(path);
      const unwatch = await watch(path, () => handleWatchEvent(path), {
        delayMs: WATCH_DEBOUNCE_MS,
      });
      if (!desiredPathsRef.current.has(path)) {
        // 建立期间该路径已不被任何标签页引用：立即拆除，不落基准
        unwatch();
        return;
      }
      diskContentsRef.current.set(path, content);
      unwatchersRef.current.set(path, unwatch);
    } catch (e) {
      // 权限/路径失效：该文件静默降级为无外部检测，不影响其他功能
      console.warn(`[external-diff] 建立监听失败，该文件降级为无外部检测: ${path}`, e);
      diskContentsRef.current.delete(path);
    }
  }, [handleWatchEvent]);

  const pathsKey = paths.join('\n');

  useEffect(() => {
    const wanted = new Set(pathsKey.split('\n').filter(Boolean));
    desiredPathsRef.current = wanted;
    if (!enabled) return;

    // 拆除不再被任何标签页引用的监听，并清理对应状态
    for (const [path, unwatch] of unwatchersRef.current) {
      if (wanted.has(path)) continue;
      unwatch();
      unwatchersRef.current.delete(path);
      diskContentsRef.current.delete(path);
      pendingReadsRef.current.delete(path);
    }
    // 为新出现的路径建立监听
    for (const path of wanted) {
      if (unwatchersRef.current.has(path) || creatingRef.current.has(path)) continue;
      creatingRef.current.add(path);
      void createWatcher(path).finally(() => creatingRef.current.delete(path));
    }
  }, [pathsKey, enabled, createWatcher]);

  /* 卸载时拆除全部监听（正常场景随窗口销毁，此处兜底） */
  useEffect(() => {
    return () => {
      for (const unwatch of unwatchersRef.current.values()) {
        try { unwatch(); } catch { /* watcher 已失效 */ }
      }
      unwatchersRef.current.clear();
      diskContentsRef.current.clear();
      pendingReadsRef.current.clear();
    };
  }, []);

  const updateKnownDiskContent = useCallback((path: string, content: string) => {
    diskContentsRef.current.set(path, content);
  }, []);

  return { updateKnownDiskContent };
}
