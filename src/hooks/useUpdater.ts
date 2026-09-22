/**
 * 应用更新（v1.0 发布链路）：
 * - 桌面：tauri-plugin-updater 签名校验 + 下载安装，完成后经 plugin-process 重启；
 * - 安卓（侧载）：无原生更新器，经既有 http_get 抓取 latest.json 比较版本，
 *   有新版则提示前往 Releases 页面手动下载（roadmap「安卓只做版本检查提示」）；
 * - 浏览器模式：无更新通道，一切检查直接跳过。
 * 启动后延迟静默检查一次（无节流，每次启动都检查——节流曾导致发版后收不到提示）；
 * 发现新版本的通知展示由 useUpdateNotifications（左下角通用通知）编排。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { IS_ANDROID_APP } from '../lib/platform';
import { isTauri } from '../lib/fileIO';
import { openExternal } from '../lib/openExternal';
import {
  downloadPageFor, fetchLatestJson, isNewerVersion, tauriHttpGetText, UpdateSourceUnavailableError,
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
  /** 错误归类：'unreachable' = 所有更新源都没通（国内不挂代理就是这个），UI 据此换文案 */
  errorKind: 'unreachable' | 'generic' | null;
  /** 后台自动检查是否失败过：失败不该无声——用户会一直停在旧版而毫不知情，故在「关于」里留痕 */
  autoCheckFailed: boolean;
  /** 本次检查实际命中的 latest.json 地址；桌面走插件多源、拿不到，故可能为 null */
  sourceUrl: string | null;
}

const INITIAL_STATE: UpdaterState = {
  phase: 'idle',
  source: 'auto',
  latestVersion: null,
  notes: null,
  errorMessage: null,
  errorKind: null,
  autoCheckFailed: false,
  sourceUrl: null,
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
    setState(s => ({ ...s, phase: 'checking', source, errorMessage: null, errorKind: null, sourceUrl: null }));
    try {
      if (IS_ANDROID_APP) {
        /* 安卓：版本检查提示（复用 http_get：原生无 CORS，超时/5MB 上限齐备）；
           多个候选源按序回退，见 LATEST_JSON_URLS */
        const info = await fetchLatestJson(tauriHttpGetText);
        const { getVersion } = await import('@tauri-apps/api/app');
        const current = await getVersion();
        if (isNewerVersion(info.version, current)) {
          setState(s => ({ ...s, phase: 'available', autoCheckFailed: false, sourceUrl: info.sourceUrl, latestVersion: info.version, notes: info.notes ?? null }));
        } else {
          setState(s => ({ ...s, phase: source === 'manual' ? 'upToDate' : 'idle', autoCheckFailed: false, sourceUrl: info.sourceUrl, latestVersion: current }));
        }
        return;
      }
      const { check: checkUpdater } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdater();
      if (update) {
        updateRef.current = update;
        setState(s => ({
          ...s,
          phase: 'available',
          autoCheckFailed: false,
          latestVersion: update.version,
          notes: update.body ?? null,
        }));
      } else {
        updateRef.current = null;
        setState(s => ({ ...s, phase: source === 'manual' ? 'upToDate' : 'idle', autoCheckFailed: false, latestVersion: null }));
      }
    } catch (e) {
      /* 启动自动检查失败不弹窗打扰，但要在「关于」里留痕（见 autoCheckFailed）；手动检查直接展示 */
      const errorKind = e instanceof UpdateSourceUnavailableError ? 'unreachable' as const : 'generic' as const;
      if (source === 'manual') {
        setState(s => ({
          ...s,
          phase: 'error',
          errorKind,
          errorMessage: e instanceof Error ? e.message : String(e),
        }));
      } else {
        setState(s => ({ ...s, phase: 'idle', autoCheckFailed: true, errorKind }));
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
        errorKind: 'generic',
        errorMessage: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** 手动下载入口该指向哪个页面（检查更新命中镜像就用镜像页） */
  const downloadPage = downloadPageFor(state.sourceUrl);

  /** 安卓：前往下载页手动安装 APK */
  const goDownload = useCallback(() => {
    void openExternal(downloadPageFor(state.sourceUrl));
    setState(s => ({ ...s, phase: 'idle' }));
  }, [state.sourceUrl]);

  /** 关闭更新提示（不改变任何安装状态） */
  const dismiss = useCallback(() => {
    setState(s => ({ ...s, phase: 'idle' }));
  }, []);

  /* 启动自动检查（仅 Tauri；每次启动都检查，失败静默） */
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (!isTauri) return;
    const timer = setTimeout(() => {
      void checkRef.current({ source: 'auto' });
    }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return {
    ...state,
    check,
    install,
    goDownload,
    dismiss,
    /** 手动下载入口的落地页（GitHub 或镜像） */
    downloadPage,
    /** 手动「检查更新」入口（安卓同样可用） */
    checkManually: () => void check({ source: 'manual' }),
  };
}
