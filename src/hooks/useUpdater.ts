/**
 * 应用更新（v1.0 发布链路）：
 * - 桌面：tauri-plugin-updater 签名校验 + 下载安装，完成后经 plugin-process 重启；
 * - 安卓（侧载）：无原生更新器，经既有 http_get 抓取 latest.json 比较版本，
 *   有新版则提示前往 Releases 页面手动下载（roadmap「安卓只做版本检查提示」）；
 * - 浏览器模式：无更新通道，一切检查直接跳过。
 * 启动后延迟静默检查一次，24h 节流（lib/update.ts）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { IS_ANDROID_APP } from '../lib/platform';
import { isTauri } from '../lib/fileIO';
import { openExternal } from '../lib/openExternal';
import {
  LATEST_JSON_URL, RELEASES_PAGE, isNewerVersion, markAutoChecked, parseLatestJson, shouldAutoCheck,
} from '../lib/update';

export type UpdatePhase =
  | 'idle'          /* 无进行中的检查/安装 */
  | 'checking'      /* 检查中 */
  | 'upToDate'      /* 已是最新（手动检查后短暂展示） */
  | 'available'     /* 发现新版本 */
  | 'downloading'   /* 桌面下载安装中 */
  | 'installed'     /* 安装完成（即将重启） */
  | 'error';        /* 失败（errorMessage 可用） */

export type UpdateSource = 'auto' | 'manual';

interface UpdaterState {
  phase: UpdatePhase;
  source: UpdateSource;
  latestVersion: string | null;
  notes: string | null;
  errorMessage: string | null;
}

const INITIAL_STATE: UpdaterState = {
  phase: 'idle',
  source: 'auto',
  latestVersion: null,
  notes: null,
  errorMessage: null,
};

/** 启动自动检查的延迟：避开启动瞬间的 I/O 高峰 */
const AUTO_CHECK_DELAY_MS = 4000;

export function useUpdater() {
  const [state, setState] = useState<UpdaterState>(INITIAL_STATE);
  const busyRef = useRef(false);
  /* 桌面：check() 返回的 Update 对象（含下载方法），安装阶段复用 */
  const updateRef = useRef<{ downloadAndInstall: () => Promise<void> } | null>(null);

  const check = useCallback(async (opts?: { source?: UpdateSource }) => {
    const source = opts?.source ?? 'manual';
    if (!isTauri || busyRef.current) return;
    busyRef.current = true;
    setState(s => ({ ...s, phase: 'checking', source, errorMessage: null }));
    try {
      if (IS_ANDROID_APP) {
        /* 安卓：版本检查提示（复用 http_get：原生无 CORS，超时/5MB 上限齐备） */
        const { invoke } = await import('@tauri-apps/api/core');
        const res = await invoke<{ text: string }>('http_get', { url: LATEST_JSON_URL });
        const info = parseLatestJson(res.text);
        if (!info) throw new Error('invalid latest.json');
        const { getVersion } = await import('@tauri-apps/api/app');
        const current = await getVersion();
        markAutoChecked(Date.now());
        if (isNewerVersion(info.version, current)) {
          setState(s => ({ ...s, phase: 'available', latestVersion: info.version, notes: info.notes ?? null }));
        } else {
          setState(s => ({ ...s, phase: source === 'manual' ? 'upToDate' : 'idle', latestVersion: current }));
        }
        return;
      }
      const { check: checkUpdater } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdater();
      markAutoChecked(Date.now());
      if (update) {
        updateRef.current = update;
        setState(s => ({
          ...s,
          phase: 'available',
          latestVersion: update.version,
          notes: update.body ?? null,
        }));
      } else {
        updateRef.current = null;
        setState(s => ({ ...s, phase: source === 'manual' ? 'upToDate' : 'idle', latestVersion: null }));
      }
    } catch (e) {
      /* 启动自动检查失败静默不打扰；手动检查失败展示错误 */
      if (source === 'manual') {
        setState(s => ({ ...s, phase: 'error', errorMessage: e instanceof Error ? e.message : String(e) }));
      } else {
        setState(s => ({ ...s, phase: 'idle' }));
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** 桌面：下载并安装更新，完成后重启应用 */
  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update || busyRef.current) return;
    busyRef.current = true;
    setState(s => ({ ...s, phase: 'downloading', errorMessage: null }));
    try {
      await update.downloadAndInstall();
      setState(s => ({ ...s, phase: 'installed' }));
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      setState(s => ({
        ...s,
        phase: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** 安卓：前往 Releases 页面手动下载 APK */
  const goDownload = useCallback(() => {
    void openExternal(RELEASES_PAGE);
    setState(s => ({ ...s, phase: 'idle' }));
  }, []);

  /** 关闭更新提示（不改变任何安装状态） */
  const dismiss = useCallback(() => {
    setState(s => ({ ...s, phase: 'idle' }));
  }, []);

  /* 启动自动检查（仅 Tauri；24h 节流，失败静默） */
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!isTauri) return;
    const timer = setTimeout(() => {
      if (shouldAutoCheck(Date.now())) void checkRef.current({ source: 'auto' });
    }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return {
    ...state,
    check,
    install,
    goDownload,
    dismiss,
    /** 手动「检查更新」入口（安卓同样可用） */
    checkManually: () => void check({ source: 'manual' }),
  };
}
