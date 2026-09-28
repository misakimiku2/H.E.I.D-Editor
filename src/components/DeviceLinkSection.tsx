import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Copy, Files, FolderTree, Loader2, QrCode, ScrollText, ShieldAlert } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { isTauri } from '../lib/fileIO';
import {
  DEFAULT_LINK_PORT, QR_POLL_MS, connectTo, deviceName, disconnectClient,
  fetchStatus, isUsablePort, linkRedialSnapshot, loadPrefs, markLinkUserClosed, pairCode,
  pairInfo, pairQr, pairUri, pairingsList, reconnect, revokePairing, savePrefs, startServer,
  stopServer, subscribeLinkRedial, subscribeLinkStatus,
  type LinkStatus, type PairInfo, type QrInfo,
} from '../lib/link';
import { linkLogSnapshot, subscribeLinkLog } from '../lib/linkLog';
import { makeRemotePath } from '../lib/remote';
import { isLinkEnabled, linkStateText } from '../lib/linkStatusText';
import type { BeginHandoff } from '../hooks/useLinkHandoff';
import { DeviceLinkRail, type RailPhase } from './DeviceLinkRail';
import {
  DL_BODY, DL_CAP, DL_DATA, DL_EYE, DL_GROUP, DL_GROUP_BODY, DL_GROUP_HEAD, DL_LABEL, DL_ROW, DL_TITLE,
  dlBtnGhost, dlBtnPrimary, dlBtnText, dlInput,
} from './panelRows';

/* 二维码只在桌面开配对窗时才用得到，懒加载独立 chunk（与「关于」里的 QrImage 同库同策略） */
const QrImage = lazy(() => import('./QrImage'));

/**
 * 手机侧离线队列（阶段 5）。桌面是服务端、没有队列，App 那边就不会传这一项。
 * 文案与配色与文件树顶部那条横幅同源 —— 同一件事在两个地方说法必须一样。
 */
export interface LinkOfflineInfo {
  /** 已配对但链路断了：此时「立即同步」点了也没用，只报数 */
  offline: boolean;
  pending: number;
  conflicts: number;
  progress: { done: number; total: number } | null;
  onSync: () => void;
  onCancel: () => void;
}

interface DeviceLinkSectionProps {
  dark: boolean;
  /** 离线队列摘要；只在手机侧、且真有欠账时占一行 */
  offline?: LinkOfflineInfo;
  /** 手机点「浏览这台电脑的文件」：把远程根交给 App 去开文件树抽屉 */
  onBrowseRemote?: (rootPath: string) => void;
  /**
   * 手机点「电脑上正打开的文件」：那一屏由 App 挂着唯一的 `RemoteTabsSheet`，
   * 这里只负责把它掀开。（连上之后自动落地不再走它 —— 那是 `onHandoff` 的交接。）
   */
  onShowRemoteTabs?: () => void;
  /** 点「互联日志」那一行：日志屏由 App 挂着唯一一份，这里只管把它掀开 */
  onShowLog?: () => void;
  /**
   * 「扫一扫」的去处。相机层与它的开合归宿主（手机顶栏、平板浮层各挂一份），
   * 这一块只负责把它摆成**状态卡上当前那一步的主操作** —— 三端都该在同一个位置看见它，
   * 而不是宿主各自在外面另加一颗（2026-09-28 平板那颗就是这么冒出来的）。
   * 不传（桌面那侧本来就没有扫码）时，配对方式那一组自己摊开，不给用户留死路。
   */
  onScan?: () => void;
  /**
   * 「这次连上了要交接」的起点：桌面上正看着的那一份摊到前台、其余桌面标签排进标签条、
   * 桌面那棵文件夹树换掉手机这棵。返回收回它的函数。
   * 扫一扫那条路（`ScanLinkEntry`）走的是同一个触发器，四条入口不该两种样子。
   */
  onHandoff: BeginHandoff;
}

/**
 * 「设备互联」那一整块 —— 一块**状态卡 + 一组次级段**，不是一份设置清单。
 *
 * 为什么重做（2026-09-28 他点名「只是把对应的东西堆放在一起，并没有什么设计」）：
 * 以前每一行都长一个样（左标签右控件），字号从 10px 到 18px 随手写，于是
 * 「现在到底连没连上、连的是谁」这件唯一要紧的事，被埋在倒数几行一个小 USB 图标旁边。
 * 现在按状态组织：顶上那张卡只说当前状态与当前那一步，其余全部降级到第二段，
 * 中间一条发丝线分层；字阶收成四档（见 `panelRows.ts`），颜色只由状态决定。
 *
 * 拓扑定死，两端各只出现自己那一半：桌面是服务端（开关 + 配对二维码 + 共享范围 + 已配对设备），
 * 安卓是客户端（扫一扫 / 免扫重连 / 配对码 / 离线队列）。
 *
 * 摆在哪：安卓整屏（`DeviceLinkPage`）、桌面与平板菜单栏按钮点开的浮层（`DeviceLinkPanel`）。
 * 2026-09-28 从设置里剥离出来，两端都不再藏在设置最后一格。
 */
/**
 * 离线队列那一行：待同步 / 需确认 / 正在写回。
 * 与文件树顶部那条横幅同一套文案与颜色，只是换了个说它的地方。
 */
export function OfflineQueueRow({ dark, info }: { dark: boolean; info: LinkOfflineInfo }) {
  const t = useT();
  if (!info.progress && info.pending === 0 && info.conflicts === 0) return null;
  const line = 'flex items-center gap-2 min-h-[28px] pointer-coarse:min-h-[40px]';
  const dot = 'w-1.5 h-1.5 rounded-full shrink-0';
  const btn = cn(
    'shrink-0 rounded-lg font-medium transition-colors',
    IS_TOUCH_PRIMARY ? 'min-h-[48px] min-w-[80px] px-3 text-sm' : 'px-2 py-0.5 text-[11px]',
    dark ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700',
  );
  return (
    <div
      role="status"
      className={cn(
        'mx-3 mt-3 flex flex-col gap-1 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs pointer-coarse:text-sm',
      )}
    >
      {info.progress ? (
        <div className={line}>
          <Loader2 size={13} className="shrink-0 animate-spin" />
          <span className="min-w-0 flex-1">
            {t('offline.bannerSyncing', { done: info.progress.done, total: info.progress.total })}
          </span>
          <button type="button" onClick={info.onCancel} className={btn}>{t('common.cancel')}</button>
        </div>
      ) : (
        <>
          {info.conflicts > 0 && (
            <div className={line}>
              <span className={cn(dot, 'bg-red-500')} />
              <span className="min-w-0 flex-1">{t('offline.bannerConfirm', { n: info.conflicts })}</span>
            </div>
          )}
          {info.pending > 0 && (
            <div className={line}>
              <span className={cn(dot, 'bg-amber-500')} />
              <span className="min-w-0 flex-1">
                {info.offline
                  ? t('offline.banner', { n: info.pending })
                  : t('offline.countTip', { pending: info.pending, conflicts: info.conflicts })}
              </span>
              {/* 断开时不给「立即同步」：那一下必然失败，能做的只有免扫重连 */}
              {!info.offline && (
                <button type="button" onClick={info.onSync} className={btn}>{t('offline.syncNow')}</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 两级之间那条发丝线：整块只出现一次，靠它分层，不靠每行铺一层底色 */
function TierRule({ dark }: { dark: boolean }) {
  return <div className={cn('mx-4 h-px', dark ? 'bg-zinc-700/70' : 'bg-zinc-200')} />;
}

/** 次级段里的一行：左标签右值/控件 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={DL_ROW}>
      <span className={cn(DL_LABEL, 'opacity-90')}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** 次级段的小节：小节名靠"小 + 淡"分层，不靠加粗与分割线堆 */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={DL_GROUP}>
      {title && <h3 className={DL_GROUP_HEAD}>{title}</h3>}
      <div className={DL_GROUP_BODY}>{children}</div>
    </section>
  );
}

/** 标签在字段上方的一栏：360px 的浮层里，"左标签右控件"会把输入框挤成一条缝 */
function Stacked({ label, cls, children }: { label: string; cls?: string; children: ReactNode }) {
  return (
    <label className={cn('flex flex-col gap-1', cls)}>
      <span className={DL_EYE}>{label}</span>
      {children}
    </label>
  );
}

export function DeviceLinkSection({
  dark, offline, onBrowseRemote, onShowRemoteTabs, onShowLog, onScan, onHandoff,
}: DeviceLinkSectionProps) {
  const t = useT();
  /* 条数取自日志环那一份订阅：入口摆的数与点进去看见的数必须同源 */
  const logLines = useSyncExternalStore(subscribeLinkLog, linkLogSnapshot);
  const logCount = logLines.reduce((n, l) => n + l.n, 0);
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const initial = useRef(loadPrefs());
  const [port, setPort] = useState(String(initial.current.port || DEFAULT_LINK_PORT));
  const [host, setHost] = useState(initial.current.host);
  const [ticket, setTicket] = useState(initial.current.ticket);
  const [localError, setLocalError] = useState('');
  const [qr, setQr] = useState<QrInfo | null>(null);
  const [devices, setDevices] = useState<PairInfo[]>([]);
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const paired = !!initial.current.keyId && !!initial.current.host;

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    fetchStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const off = subscribeLinkStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);

  const refreshDevices = useCallback(() => {
    pairingsList().then(setDevices).catch(() => {});
  }, []);

  const asClient = IS_ANDROID_APP;
  const connected = status?.connected === true;

  /* 共享开着就把二维码摆在这里，并按时问一句「该摆哪张」（`QR_POLL_MS`）—— 配对票 120 秒就过期，
     不该让用户为了「码过期了」回电脑前点一下。**换不换由服务端判**：这里每问一次就换一张的话，
     两个面板各自的定时器会抢着换，屏幕上摆的那张很快就不是当前那张了 ——
     手机照屏幕上那张算密钥，两边派生出不同的密钥，报出来的却是「帧解密失败」这种看不出
     谁做错了什么的串（2026-09-27 他点「刷新配对码」后重配撞上的正是这个）。
     拿回来的 URI 没变就不重设 state：二维码不该每 15 秒重画一次。
     有设备连着时不再问：第二台本来就收 busy。 */
  const listening = !asClient && status?.listening === true;
  const serving = listening && connected;
  useEffect(() => {
    if (!listening || serving) return;
    let alive = true;
    const show = () => {
      pairInfo()
        .then((info) => { if (alive && info) setQr((prev) => (prev && prev.uri === info.uri ? prev : info)); })
        .catch(() => {});
    };
    show();
    const timer = setInterval(show, QR_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [listening, serving]);

  const run = useCallback(async (fn: () => Promise<LinkStatus>) => {
    setBusy(true);
    setLocalError('');
    try {
      const st = await fn();
      setStatus(st);
      // 「记下了哪台设备」不在这里做 —— 见 App 里那个状态订阅：命令返回的快照里 peerKeyId 还是空的
      return true;
    } catch (e) {
      setLocalError(String((e as { message?: string })?.message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 手机上「我主动要连那台电脑」的四个动作（粘贴配对码 / 6 位短码 / 手填 32 位 / 免扫重连）。
   * 发起之后就交给交接（`onHandoff`）：连上了把桌面上正看着的那一份摊开，
   * 桌面拒了把它的原话说出来。发起成功不等于连上 —— 握手还在连接线程里跑，
   * 而命令本身没过（地址为空那类）的话连拨号都没发生，把交接收回，别等它报一句无关的超时。
   */
  const connect = (fn: () => Promise<LinkStatus>) => {
    const cancel = onHandoff();
    void run(fn).then((ok) => { if (!ok) cancel(); });
  };

  const onToggle = (on: boolean) => {
    savePrefs({ enabled: on });
    setQr(null);
    void run(on ? () => startServer(Number(port) || DEFAULT_LINK_PORT) : stopServer);
  };

  const onPortChange = (v: string) => {
    setPort(v);
    const n = Number(v);
    if (isUsablePort(n)) savePrefs({ port: n });
  };

  const onShowQr = () => {
    pairQr().then((info) => { if (info) setQr(info); }).catch((e) => setLocalError(String(e?.message ?? e)));
  };

  const onRevoke = async (keyId: string) => {
    await revokePairing(keyId).catch(() => {});
    if (initial.current.keyId === keyId) savePrefs({ keyId: '', peerName: '' });
    refreshDevices();
  };

  // 手机：吃粘贴进来的 hide-link 配对码（相机不可用时的等价入口，「扫一扫」走的是同一条配对）
  const doPairUri = (u: string) => {
    const s = u.trim();
    if (!s.startsWith('hide-link://pair')) return setLocalError(t('link.errUri'));
    setLocalError('');
    connect(() => pairUri(s, deviceName()));
  };
  const onPairUri = () => doPairUri(uri);
  // 手机：手输 host + port + 6 位短码
  const onPairCode = () => {
    const n = Number(port);
    if (!host.trim()) return setLocalError(t('link.errHost'));
    if (!isUsablePort(n)) return setLocalError(t('link.errPort'));
    if (!/^\d{6}$/.test(code.trim())) return setLocalError(t('link.errCode'));
    setLocalError('');
    savePrefs({ host: host.trim(), port: n });
    connect(() => pairCode(host.trim(), n, code.trim(), deviceName()));
  };
  // 手机：32 位配对码手填直连（调试通道，等价于无指纹的配对）
  const onConnectTicket = () => {
    const n = Number(port);
    if (!host.trim()) return setLocalError(t('link.errHost'));
    if (!isUsablePort(n)) return setLocalError(t('link.errPort'));
    setLocalError('');
    savePrefs({ host: host.trim(), port: n });
    connect(() => connectTo(host.trim(), n, ticket.trim().toLowerCase(), deviceName()));
  };
  const onReconnect = () => {
    const p = initial.current;
    setLocalError('');
    connect(() => reconnect(p.host, p.port, p.keyId, deviceName()));
  };
  /* 主动断开记一笔：亮屏自动重连不该把这个决定覆盖掉 */
  const onDisconnect = () => { markLinkUserClosed(true); void run(disconnectClient); };

  const onCopyTicket = () => {
    const v = status?.ticket ?? '';
    if (!v) return;
    void navigator.clipboard?.writeText(v).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  useEffect(() => { if (isTauri) refreshDevices(); }, [refreshDevices]);

  /* ---- 状态：轨道的形状、标题那句话、当前那一步是哪一颗钮 ---- */

  /* 「正在自己接回来」：亮屏之后的退避重连在跑，或那一次拨号还在路上。
     这一档不摆「扫一扫」—— 把"等一等"说成"你来动手"是 2026-09-27 他点名的。 */
  const redial = useSyncExternalStore(subscribeLinkRedial, linkRedialSnapshot);
  const dialing = !connected && status?.role === 'client' && !!status?.peerAddr;
  const redialing = asClient && !connected && (dialing || redial.spinning);

  const enabled = isLinkEnabled(status, asClient);
  /* 端口开着却没有设备来连过：这是「包进不来」的半死状态，比直接报错难查，
     所以由它自己占一档轨道形状（断口）与一句标题，而不是缩成角落里一行琥珀小字 */
  const hurt = listening && !connected && !!status?.firewallHint;

  const phase: RailPhase = connected ? 'connected'
    : hurt ? 'broken'
    : redialing ? 'connecting'
    : listening ? 'waiting'
    : 'off';

  const title = hurt ? t('link.card.stalled')
    : redialing ? t('link.redialing')
    : asClient && !connected
      ? (paired ? t('link.stateIdle') : t('link.card.notPaired'))
      : linkStateText(t, status, asClient, initial.current.peerName);

  /* 标题底下那行只放**具体**的东西（对面是谁、哪个地址）；解释性的话一律沉到第二段 */
  const peerLine = connected
    ? (status?.peerAddr ?? '')
    : asClient && !connected && paired
      ? `${initial.current.host}:${initial.current.port}`
      : '';

  const errorText = localError || status?.lastError || '';
  /* 没有扫码这条路时（没传 onScan），配对方式那一组就是唯一的路，不许收起来 */
  const pairingOpen = !paired || manualOpen || !onScan;
  const ghost = dark ? 'border-zinc-600 text-zinc-200' : 'border-zinc-300 text-zinc-700';

  /* 状态卡顶上那点色：跟着状态走，让人不用读字也先感到"这一屏换了档" */
  const tint = phase === 'connected'
    ? 'bg-emerald-500/[0.07]'
    : phase === 'broken'
      ? 'bg-amber-500/[0.07]'
      : phase === 'waiting' || phase === 'connecting'
        ? 'bg-indigo-500/[0.06]'
        : '';

  if (!isTauri) {
    return (
      <p className={cn('px-4 py-2 text-[11px] pointer-coarse:text-xs', dark ? 'text-zinc-500' : 'text-zinc-400')}>
        {t('link.unavailable')}
      </p>
    );
  }

  return (
    <div className="flex flex-col pb-1">
      {/* 离线队列那一档排在最前：它是「还有事没办完」，比"连接"这个动作更该先看见 */}
      {asClient && offline && <OfflineQueueRow dark={dark} info={offline} />}

      {/* =========================== 第一段：状态卡 =========================== */}
      <div className={cn('px-4 pb-4 pt-3.5', tint)}>
        <DeviceLinkRail phase={phase} dark={dark} asClient={asClient} label={title} />

        <p className={cn(
          'mt-2.5 truncate',
          DL_TITLE,
          phase === 'connected' && (dark ? 'text-emerald-300' : 'text-emerald-700'),
          phase === 'broken' && (dark ? 'text-amber-300' : 'text-amber-600'),
        )}>
          {title}
        </p>
        {peerLine && <p className={cn(DL_CAP, DL_DATA, 'truncate')}>{peerLine}</p>}

        {/* 服务端：这一屏的总闸。整行都是触控目标（标签也在这颗按钮里），
            不是以前那颗 36×20 的小滑块 —— 触屏上按不中是它以前真实的毛病 */}
        {!asClient && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => onToggle(!enabled)}
            disabled={busy}
            className={cn(
              'mt-2.5 flex w-full items-center justify-between gap-3 rounded-xl text-left transition-colors disabled:opacity-50',
              IS_TOUCH_PRIMARY ? 'min-h-[52px] px-3 py-1' : 'min-h-[36px] px-2.5 py-0.5',
              dark ? 'hover:bg-zinc-700/40 active:bg-zinc-700/60' : 'hover:bg-zinc-200/60 active:bg-zinc-200',
            )}
          >
            <span className={cn(DL_BODY, 'opacity-95')}>
              {t('link.switchLabel')}
            </span>
            <span
              aria-hidden
              className={cn(
                'relative block shrink-0 rounded-full transition-colors',
                IS_TOUCH_PRIMARY ? 'h-[26px] w-[44px]' : 'h-5 w-9',
                enabled ? 'bg-indigo-500' : (dark ? 'bg-zinc-600' : 'bg-zinc-300'),
              )}
            >
              <span
                className={cn(
                  'absolute rounded-full bg-white shadow transition-all',
                  IS_TOUCH_PRIMARY ? 'left-[3px] top-[3px] h-5 w-5' : 'left-0.5 top-0.5 h-4 w-4',
                  enabled && (IS_TOUCH_PRIMARY ? 'left-[21px]' : 'left-[18px]'),
                )}
              />
            </span>
          </button>
        )}

        {/* 安卓：当前那一步的主操作。三副壳都摆在这一个位置，宿主不再各自另加一颗。
            一屏只许有一颗主操作：记住过设备的时候主操作是「接回去」，
            扫一扫退成旁边那颗 —— 两条一样重的路等于没有路 */}
        {asClient && !connected && (
          <div className="mt-3 flex flex-col gap-2">
            {redialing ? null : paired ? (
              <button type="button" onClick={onReconnect} disabled={busy} className={dlBtnPrimary}>
                {busy && <Loader2 size={15} className="animate-spin" />}
                {t('link.reconnect', { device: initial.current.peerName || t('link.desktopFallback') })}
              </button>
            ) : onScan ? (
              <button type="button" onClick={onScan} className={dlBtnPrimary}>
                <QrCode size={16} />
                {t('link.scan')}
              </button>
            ) : null}
            {paired && !redialing && onScan && (
              <button type="button" onClick={onScan} className={cn(dlBtnGhost, 'w-full', ghost)}>
                <QrCode size={15} />
                {t('link.scan')}
              </button>
            )}
            {/* 接回途中不给扫码，但得留一条"不等了，我自己填"的路 */}
            {paired && (
              <button
                type="button"
                onClick={() => setManualOpen((v) => !v)}
                className={cn(dlBtnText, 'self-center', dark ? 'text-zinc-300' : 'text-zinc-600')}
              >
                {t('link.orRebind')}
              </button>
            )}
          </div>
        )}

        {/* 连着的时候：三件事按"下一步最可能做什么"排，打开文件在最前 */}
        {asClient && connected && (
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              disabled={!status?.peerKeyId}
              onClick={() => onShowRemoteTabs?.()}
              className={dlBtnPrimary}
            >
              <Files size={16} />
              {t('link.openTabs')}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!status?.peerKeyId}
                onClick={() => status?.peerKeyId && onBrowseRemote?.(makeRemotePath(status.peerKeyId, ''))}
                className={cn(dlBtnGhost, ghost)}
              >
                <FolderTree size={14} />
                {t('link.browseRemote')}
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                disabled={busy}
                className={cn(dlBtnGhost, 'flex-none px-4', ghost)}
              >
                {t('link.disconnect')}
              </button>
            </div>
          </div>
        )}

        {/* 服务端在等：配对二维码就在这张卡里 —— 开关一拨开自己就出来，不再多要一次点击 */}
        {qr && listening && !connected && (
          <div className="heid-fade-in mt-3.5 flex flex-col items-center gap-1.5">
            <div className={cn(DL_EYE, 'self-start')}>{t('link.qrTitle')}</div>
            <div className={cn('rounded-xl bg-white p-2 shadow-sm', dark && 'ring-1 ring-zinc-700/70')}>
              <Suspense fallback={<div style={{ width: 152, height: 152 }} aria-hidden />}>
                <QrImage text={qr.uri} size={IS_TOUCH_PRIMARY ? 152 : 140} />
              </Suspense>
            </div>
            {/* 短码是扫码失败时的等价入口，本身就该占最显眼的那一行 */}
            <div className={cn(DL_DATA, 'mt-0.5 text-[19px] font-medium tracking-[0.22em]')}>{qr.code}</div>
            <div className={cn(DL_CAP, DL_DATA, 'text-center')}>
              {qr.host ? `${qr.host}:${qr.port}` : t('link.noLanIp')}
            </div>
            <button
              type="button"
              onClick={onShowQr}
              className={cn(dlBtnText, 'mt-0.5', dark ? 'text-zinc-300' : 'text-zinc-600')}
            >
              {t('link.refreshCode')}
            </button>
          </div>
        )}


        {/* 半死状态的解法写在该说它的地方：断口 + 一句怎么办，不藏进第二段 */}
        {hurt && (
          <p className={cn(
            'mt-2.5 flex gap-1.5 rounded-xl bg-amber-500/10 p-2.5 text-[11px] leading-relaxed pointer-coarse:text-xs',
            dark ? 'text-amber-200/90' : 'text-amber-700',
          )}>
            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
            <span>{t('link.firewallHint')}</span>
          </p>
        )}

        {/* 失败的原因就写在状态底下：它说的是"这次为什么没成"，不是另一件事 */}
        {errorText && (
          <p className="mt-2 text-[11px] leading-relaxed text-red-500 pointer-coarse:text-xs">
            {t('link.lastError', { msg: errorText })}
          </p>
        )}
      </div>

      <TierRule dark={dark} />

      {/* ====================== 第二段：不常碰，但必须在 ====================== */}
      {asClient ? (
        <>
          {!connected && pairingOpen && (
            <Group title={t('link.grp.pairing')}>
              {/* 三个入口都是"不需要相机的那条路"，所以留标签；但标签挪到字段上方 ——
                  左标签右控件那种排法在 360px 的浮层里会把输入框挤成一条缝 */}
              <div className="flex items-center gap-2">
                <input
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  placeholder="hide-link://pair?…"
                  spellCheck={false}
                  aria-label={t('link.pasteCode')}
                  className={cn(dlInput(dark), 'min-w-0 flex-1', DL_DATA)}
                />
                <button
                  type="button"
                  onClick={onPairUri}
                  disabled={busy || !uri.trim()}
                  className={cn(dlBtnPrimary, 'w-auto flex-none px-3.5')}
                >
                  {t('link.pairByCode')}
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <Stacked label={t('link.host')} cls="min-w-0 flex-1">
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder={t('link.hostPlaceholder')}
                    spellCheck={false}
                    className={cn(dlInput(dark), 'w-full')}
                  />
                </Stacked>
                <Stacked label={t('link.port')} cls="w-[92px] flex-none">
                  <input
                    value={port}
                    onChange={(e) => onPortChange(e.target.value)}
                    inputMode="numeric"
                    className={cn(dlInput(dark), 'w-full text-center', DL_DATA)}
                  />
                </Stacked>
              </div>
              <div className="mt-2 flex items-end gap-2">
                <Stacked label={t('link.shortCode')} cls="min-w-0 flex-1">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="123456"
                    className={cn(dlInput(dark), 'w-full text-center', DL_DATA)}
                  />
                </Stacked>
                <button
                  type="button"
                  onClick={onPairCode}
                  disabled={busy}
                  className={cn(dlBtnGhost, 'w-auto flex-none px-3', ghost)}
                >
                  {t('link.pairByShort')}
                </button>
              </div>
              <details className="group pt-2">
                <summary className={cn(
                  DL_EYE, 'flex cursor-pointer list-none select-none items-center gap-1 pointer-coarse:min-h-[48px]',
                )}>
                  <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
                  {t('link.advancedTicket')}
                </summary>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    value={ticket}
                    onChange={(e) => setTicket(e.target.value)}
                    placeholder="0000…"
                    spellCheck={false}
                    aria-label={t('link.ticket')}
                    className={cn(dlInput(dark), 'min-w-0 flex-1', DL_DATA)}
                  />
                  <button
                    type="button"
                    onClick={onConnectTicket}
                    disabled={busy}
                    className={cn(dlBtnGhost, 'w-auto flex-none px-3', ghost)}
                  >
                    {t('link.connect')}
                  </button>
                </div>
              </details>
            </Group>
          )}

          {/* 共享范围明示（设计稿 §5.2）：开着共享时用户必须看得见手机端能读到哪些文件 */}
          {enabled && !!status?.rootDisplay && (
            <Group>
              <Field label={t('link.shareScope')}>
                <span title={status.rootDisplay} className={cn(DL_CAP, 'min-w-0 flex-1 truncate text-right !opacity-85')}>
                  {status.rootDisplay}
                </span>
              </Field>
            </Group>
          )}
        </>
      ) : (
        <>
          {enabled && (
            <Group>
              <Field label={t('link.shareScope')}>
                <span
                  title={status?.rootDisplay || undefined}
                  className={cn(DL_CAP, 'min-w-0 flex-1 truncate text-right', !status?.rootDisplay && '!opacity-50')}
                >
                  {status?.rootDisplay || t('link.shareScopeNone')}
                </span>
              </Field>
            </Group>
          )}
          <Group>
            <Field label={t('link.port')}>
              <input
                value={port}
                onChange={(e) => onPortChange(e.target.value)}
                inputMode="numeric"
                disabled={enabled}
                className={cn(dlInput(dark), 'w-[96px] flex-none text-right disabled:opacity-50', DL_DATA)}
              />
            </Field>
            {/* 32 位配对码：不用相机那条路里，桌面只负责把它给出去，所以收在第二段 */}
            {enabled && !!status?.ticket && (
              <Field label={t('link.ticket')}>
                <button
                  type="button"
                  onClick={onCopyTicket}
                  title={t('link.copyTicket')}
                  className={cn('flex min-w-0 items-center gap-1.5 rounded-lg px-1', DL_EYE, 'opacity-90 hover:opacity-100')}
                >
                  <span className={cn(DL_DATA, 'max-w-[150px] truncate text-[11px] underline decoration-dotted pointer-coarse:text-xs')}>
                    {status.ticket}
                  </span>
                  <Copy size={11} className="shrink-0 opacity-60" />
                  {copied && <span>{t('link.copied')}</span>}
                </button>
              </Field>
            )}
          </Group>

          {/* 已配对设备：多台并存，同一时刻只服务一台；撤销后需重新扫码 */}
          {devices.length > 0 && (
            <Group title={t('link.pairedDevices')}>
              {devices.map((d) => (
                <div key={d.keyId} className={DL_ROW}>
                  <span
                    title={d.keyId}
                    className={cn(DL_LABEL, 'min-w-0 flex-1 truncate opacity-90')}
                  >
                    {d.name || d.keyId}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRevoke(d.keyId)}
                    className={cn(dlBtnText, DL_EYE, dark ? 'text-zinc-400' : 'text-zinc-500')}
                  >
                    {t('link.revoke')}
                  </button>
                </div>
              ))}
            </Group>
          )}
        </>
      )}

      {/* 互联日志：两端都在，点开的屏由 App 挂着唯一一份，这里只管把它掀开 */}
      {onShowLog && (
        <Group>
          <button
            type="button"
            onClick={onShowLog}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg transition-colors',
              IS_TOUCH_PRIMARY ? '-mx-1 min-h-[52px] px-1' : 'min-h-[30px]',
              dark ? 'hover:bg-zinc-700/40' : 'hover:bg-zinc-200/60',
            )}
          >
            <ScrollText size={13} className="shrink-0 opacity-60" />
            <span className={cn(DL_LABEL, 'min-w-0 flex-1 text-left opacity-90')}>
              {t('link.logTitle')}
            </span>
            {logCount > 0 && <span className={DL_EYE}>{t('link.logCount', { n: logCount })}</span>}
            <ChevronRight size={14} className="shrink-0 opacity-40" />
          </button>
        </Group>
      )}

      <p className={cn(DL_CAP, 'px-4 pt-3')}>{t('link.hint')}</p>
    </div>
  );
}
