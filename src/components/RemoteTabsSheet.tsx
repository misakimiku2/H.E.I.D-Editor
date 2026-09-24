/**
 * 手机端「电脑上正打开的」标签列表（v1.5 阶段 3，设计稿 §6.2）。
 *
 * 这里列的是**桌面的标签页**而不是磁盘文件：其中三类接管不了（桌面有未保存的修改 /
 * 还没保存到磁盘 / 现在读不到），一律置灰并把原因写成看得见的文字 —— 触屏没有 hover，
 * 原因不能藏在 tooltip 里。**脏标签不接管是产品硬规定**（§2 决策 5）：两端永远只有一份
 * 「正在改的内容」，手机要接手必须先在电脑上落盘。
 *
 * 挂载（App 侧的活，本组件不碰 App.tsx）：`DeviceLinkSection` 手机那一半在已连接时给一个
 * 入口并渲染本页；`onOpen` 走 App → SettingsDialog → DeviceLinkSection 的 `onOpenRemoteFile`
 * （与 `onBrowseRemote` 同一条道），App 把它接到自己那条「按路径打开标签」的入口即可
 * ——阶段 2 已让 `hide-remote://` 走通读写，App 侧不必再区分远程与否。
 * 安卓系统返回键要先把本页收掉而不是连带关掉设置页，得把它记进
 * `usePlatformIntegration` 的 overlay 栈 —— 那也在 App 侧。
 *
 * **必须 portal 到 body**：本页从设置弹窗里打开，而弹窗带 `backdrop-blur`，
 * 它会成为 `position: fixed` 的包含块，不 portal 出去在平板上就只占弹窗那一格
 * （与 `QrScanner` 同一条坑）。背景一律实底不透明，半透明会把底下的设置弹窗透出来。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, Files, Loader2, RefreshCw, Unlink, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import type { MessageKey } from '../lib/i18n';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { fetchStatus, loadPrefs, subscribeLinkStatus, subscribeRemoteEvents, type LinkStatus } from '../lib/link';
import { EVENT_TABS } from '../lib/remoteChanges';
import { isRemoteError, makeRemotePath, remoteTabs, type RemoteTabView } from '../lib/remote';

interface RemoteTabsSheetProps {
  dark: boolean;
  /** 收起本页（顶栏返回/关闭都走它；系统返回键由 App 侧的 overlay 栈接） */
  onClose: () => void;
  /**
   * 接管一个桌面标签。参数是已经拼好的 `makeRemotePath(status.peerKeyId, tab.rel)`，
   * 即 `hide-remote://<deviceId>/<相对路径>` 身份键。
   */
  onOpen: (path: string) => void;
}

/** 桌面 `reason` → 文案码；意外的第四种取值走兜底句，别在界面上什么都不说 */
const REASON_KEYS: Record<string, MessageKey> = {
  dirty: 'remoteTabs.reasonDirty',
  novirtual: 'remoteTabs.reasonNovirtual',
  missing: 'remoteTabs.reasonMissing',
};

/** mdView 只对 Markdown 有意义，别的语言报什么都不显示；前两个复用「编辑/预览」既有词 */
const MD_KEYS: Record<string, MessageKey> = {
  edit: 'common.edit',
  preview: 'common.preview',
  split: 'remoteTabs.mdSplit',
};

type Phase = 'loading' | 'ready' | 'failed';

export function RemoteTabsSheet({ dark, onClose, onOpen }: RemoteTabsSheetProps) {
  const t = useT();
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [tabs, setTabs] = useState<RemoteTabView[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<{ code: string; msg: string } | null>(null);
  const prefs = useRef(loadPrefs());
  /** 桌面的推送与手动刷新会交叠，只有最后发出去的那次结果算数 */
  const seq = useRef(0);
  const alive = useRef(true);

  const deviceId = status?.peerKeyId ?? '';
  const online = status?.connected === true && !!deviceId;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let on = true;
    fetchStatus().then((s) => { if (on) setStatus(s); }).catch(() => {});
    const off = subscribeLinkStatus((s) => { if (on) setStatus(s); });
    return () => { on = false; off(); };
  }, []);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    const latest = (fn: () => void) => { if (alive.current && mine === seq.current) fn(); };
    setPhase('loading');
    setError(null);
    remoteTabs()
      .then((list) => latest(() => { setTabs(list); setPhase('ready'); }))
      .catch((e: unknown) => latest(() => {
        const re = isRemoteError(e) ? e : null;
        setError({ code: re?.code ?? 'unknown', msg: re?.message ?? String(e) });
        setPhase('failed');
      }));
  }, []);

  /* 连着桌面才拉得动（列表要靠 peerKeyId 拼身份键）。进页面拉一次，
     此后桌面每次开关标签/切聚焦窗口都会推 {type:'tabs'}，收到就重拉。 */
  useEffect(() => {
    if (!online) return;
    refresh();
    return subscribeRemoteEvents((type) => {
      if (type === EVENT_TABS) refresh();
    });
  }, [online, refresh]);

  const openTab = (rel: string) => {
    /* 先收页：本页是盖在编辑器上方的全屏层，不收就看不见刚打开的那个标签。 */
    onClose();
    onOpen(makeRemotePath(deviceId, rel));
  };

  const device = status?.peerDevice || prefs.current.peerName;
  const metaOf = (tab: RemoteTabView) => [
    tab.language,
    tab.language === 'markdown' ? t(MD_KEYS[tab.mdView] ?? 'common.edit') : '',
    tab.readOnly ? t('remoteTabs.readOnly') : '',
  ].filter(Boolean).join(' · ');

  const shellCls = cn(
    'fixed inset-0 z-[150] flex flex-col overflow-hidden',
    dark ? 'bg-zinc-900 text-zinc-100' : 'bg-zinc-50 text-zinc-800',
  );
  const iconBtn = cn(
    'flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full disabled:opacity-40',
    IS_TOUCH_PRIMARY && 'min-h-[52px] min-w-[52px]',
    dark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-200/70',
  );
  const rowCls = cn(
    'flex w-full min-h-[48px] items-center gap-3 rounded-xl px-4 py-3 text-left',
    IS_TOUCH_PRIMARY && 'min-h-[56px]',
  );
  const titleCls = cn('block truncate', IS_TOUCH_PRIMARY ? 'text-base' : 'text-sm');
  const metaCls = 'text-xs opacity-60 pointer-coarse:text-sm';
  const wideBtn = cn(iconBtn, 'w-auto min-w-0 gap-1.5 rounded-lg px-5 text-sm');

  /** 居中一条状态说明（未连接 / 空列表）；触屏字号按 14sp 起 */
  const statusBlock = (icon: ReactNode, text: string, action?: ReactNode) => (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      {icon}
      <p className="text-sm leading-relaxed opacity-75 pointer-coarse:text-base">{text}</p>
      {action}
    </div>
  );

  let content: ReactNode;
  if (!online) {
    content = statusBlock(<Unlink size={22} className="opacity-40" />, t('remoteTabs.offline'),
      <button type="button" onClick={onClose} className={wideBtn}>{t('common.back')}</button>);
  } else if (phase === 'failed' && error) {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium">{t('remoteTabs.failed')}</p>
        {/* 原因串是桌面给的（Rust 侧已是人话），原样显示；错误码留着排查 */}
        <p className="text-xs leading-relaxed opacity-70 pointer-coarse:text-sm">{error.msg}</p>
        <p className="font-mono text-[10px] opacity-45">{t('remoteTabs.errCode', { code: error.code })}</p>
        <button type="button" onClick={refresh} className={cn(wideBtn, 'mt-1 bg-indigo-600 text-white hover:bg-indigo-500')}>
          <RefreshCw size={14} />
          {t('remoteTabs.retry')}
        </button>
      </div>
    );
  } else if (phase === 'loading' && tabs.length === 0) {
    content = (
      <p className="flex flex-1 items-center justify-center gap-2 text-sm opacity-70">
        <Loader2 size={14} className="animate-spin" />
        {t('remoteTabs.loading')}
      </p>
    );
  } else if (tabs.length === 0) {
    content = statusBlock(<Files size={22} className="opacity-40" />, t('remoteTabs.empty'));
  } else {
    content = (
      <ul className="heid-scroll min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-2 py-2">
        {tabs.map((tab, i) => tab.rel && !tab.reason ? (
          <li key={tab.rel}>
            <button
              type="button"
              onClick={() => openTab(tab.rel)}
              className={cn(rowCls, 'transition-colors',
                dark ? 'hover:bg-zinc-800/80 active:bg-zinc-700' : 'hover:bg-white active:bg-zinc-200/80')}
            >
              <Files size={16} className="shrink-0 opacity-55" />
              <span className="min-w-0 flex-1">
                <span className={titleCls}>{tab.title}</span>
                <span className={cn(metaCls, 'block truncate')}>{metaOf(tab) || ' '}</span>
                <span className="mt-0.5 block truncate font-mono text-[11px] opacity-45 pointer-coarse:text-xs">{tab.rel}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 opacity-35" />
            </button>
          </li>
        ) : (
          /* 打不开的行根本不做成按钮：一个点不动的按钮比一行说明更让人以为是自己没点到。
             原因写成行内文字（触屏没有 hover，tooltip 等于没说） */
          <li key={tab.rel || `x${i}`}>
            <div className={cn(rowCls, 'cursor-default opacity-50')}>
              <Files size={16} className="shrink-0 opacity-45" />
              <span className="min-w-0 flex-1">
                <span className={titleCls}>{tab.title}</span>
                <span className={cn(metaCls, 'block truncate')}>{metaOf(tab) || ' '}</span>
                <span className={cn(metaCls, 'mt-0.5 block leading-snug')}>
                  {t(REASON_KEYS[tab.reason] ?? 'remoteTabs.reasonUnknown')}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  // 必须 portal 到 body：设置弹窗的 backdrop-blur 会成了 fixed 的包含块（见文件头注释）
  return createPortal(
    <div className={shellCls} role="dialog" aria-label={t('remoteTabs.title')}>
      <header className={cn(
        // 相邻触点留 8dp（Android 规范）：图标按钮本身 48dp，挨太近就会误触旁边那个
        'safe-top flex shrink-0 items-center gap-2 border-b px-2 py-1.5',
        dark ? 'border-zinc-700/70' : 'border-zinc-200',
      )}>
        <button type="button" onClick={onClose} aria-label={t('common.back')} className={iconBtn}>
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 truncate text-base font-semibold">
            {t('remoteTabs.title')}
            {online && phase === 'loading' && <Loader2 size={13} className="animate-spin opacity-60" />}
          </h2>
          {device && <p className={cn(metaCls, 'truncate')}>{t('remoteTabs.onDevice', { device })}</p>}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={!online || phase === 'loading'}
          aria-label={t('remoteTabs.refresh')}
          className={iconBtn}
        >
          <RefreshCw size={18} />
        </button>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className={iconBtn}>
          <X size={20} />
        </button>
      </header>

      {content}

      {online && tabs.length > 0 && (
        <p className="safe-bottom shrink-0 px-5 pb-2 pt-1 text-xs leading-relaxed opacity-55 pointer-coarse:text-sm">
          {t('remoteTabs.hint')}
        </p>
      )}
    </div>,
    document.body,
  );
}
