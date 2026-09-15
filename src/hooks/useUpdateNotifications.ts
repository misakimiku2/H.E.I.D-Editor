/**
 * 更新通知编排：把 useUpdater 的阶段变化映射为左下角通用通知卡片（通知系统的首个消费者）。
 * - 自动检查发现新版本 → 卡片：点击卡片 / 「下载并安装」直接开始下载（安卓为前往 Releases），
 *   「忽略此版本」持久化跳过后续同版本提示，X 仅本次关闭；
 * - 下载中 / 安装完成 → 同 id 卡片原地替换为进度状态（不可关闭，保证状态可见）；
 * - 失败 → 仅当更新卡片在场时替换为错误卡（手动检查的失败已在「关于」弹窗内展示，不重复打扰）；
 * - 手动检查发现新版本不弹卡片（结果在「关于」弹窗内展示）。
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  dismissNotification, listNotifications, showNotification,
} from '../lib/notifications';
import {
  getIgnoredVersion, saveReleaseNotes, setIgnoredVersion, shouldNotifyUpdate, summarizeNotes,
} from '../lib/update';
import { IS_ANDROID_APP } from '../lib/platform';
import type { UpdatePhase, UpdateSource } from './useUpdater';
import type { MessageKey } from '../lib/i18n';

/** 更新卡片固定 id：available → downloading → installed 全程复用同一张卡 */
export const UPDATE_NOTIFICATION_ID = 'update';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface UpdateNotifierSource {
  phase: UpdatePhase;
  source: UpdateSource;
  latestVersion: string | null;
  notes: string | null;
  errorMessage: string | null;
  install: () => Promise<void>;
  goDownload: () => void;
}

export function useUpdateNotifications(updater: UpdateNotifierSource, t: Translate): void {
  /* 同一版本只弹一次卡（X 关闭后不立刻复弹，下次启动重新检查时再弹） */
  const notifiedVersionRef = useRef<string | null>(null);
  /* 上一阶段：错误卡仅在「下载安装中」转出时替换，手动检查失败不打扰已有卡片 */
  const prevPhaseRef = useRef<UpdatePhase>('idle');

  const ignoreThisVersion = useCallback((version: string) => {
    setIgnoredVersion(version);
    dismissNotification(UPDATE_NOTIFICATION_ID);
  }, []);

  const {
    phase, source, latestVersion, notes, errorMessage, install, goDownload,
  } = updater;
  const stateRef = useRef({ updater, t, ignoreThisVersion });
  stateRef.current = { updater, t, ignoreThisVersion };

  useEffect(() => {
    const { updater: u, t: translate, ignoreThisVersion: ignore } = stateRef.current;
    const version = u.latestVersion ?? '';
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = u.phase;

    if (u.phase === 'available') {
      if (u.source !== 'auto') return;
      if (!version || notifiedVersionRef.current === version) return;
      notifiedVersionRef.current = version;
      if (!shouldNotifyUpdate(version, getIgnoredVersion())) return;
      saveReleaseNotes({ version, notes: u.notes ?? undefined });
      const onDownload = IS_ANDROID_APP ? u.goDownload : () => void u.install();
      showNotification({
        id: UPDATE_NOTIFICATION_ID,
        kind: 'update',
        title: translate('update.newVersion', { v: version }),
        message: summarizeNotes(u.notes ?? undefined)
          ?? (IS_ANDROID_APP ? translate('update.androidHint') : undefined),
        actions: [
          { id: 'ignore', label: translate('update.ignoreVersion'), onSelect: () => ignore(version), emphasis: 'plain' },
          { id: 'download', label: IS_ANDROID_APP ? translate('update.goDownload') : translate('update.installNow'), onSelect: onDownload },
        ],
        onCardClick: onDownload,
      });
      return;
    }

    if (u.phase === 'downloading') {
      showNotification({
        id: UPDATE_NOTIFICATION_ID,
        kind: 'update',
        title: translate('update.downloading'),
        closable: false,
      });
      return;
    }

    if (u.phase === 'installed') {
      showNotification({
        id: UPDATE_NOTIFICATION_ID,
        kind: 'success',
        title: translate('update.installed'),
        message: translate('update.restarting'),
        closable: false,
      });
      return;
    }

    if (u.phase === 'error') {
      /* 仅下载安装失败时原地替换为错误卡；检查失败由「关于」弹窗展示，不重复打扰 */
      if (prevPhase !== 'downloading') return;
      if (!listNotifications().some(n => n.id === UPDATE_NOTIFICATION_ID)) return;
      showNotification({
        id: UPDATE_NOTIFICATION_ID,
        kind: 'error',
        title: translate('update.downloadFailed'),
        message: summarizeNotes(u.errorMessage ?? undefined) ?? undefined,
      });
    }
  }, [phase, source, latestVersion, notes, errorMessage]);
}
