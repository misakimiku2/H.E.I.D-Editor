import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Copy, Files, FolderTree, Loader2, QrCode, ScrollText, ShieldAlert, Usb } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { isTauri } from '../lib/fileIO';
import {
  DEFAULT_LINK_PORT, QR_POLL_MS, connectTo, deviceName, disconnectClient,
  fetchStatus, isUsablePort, loadPrefs, pairCode, pairInfo, pairQr, pairUri, pairingsList, reconnect,
  markLinkUserClosed, revokePairing, savePrefs, startServer, stopServer, subscribeLinkStatus,
  type LinkStatus, type PairInfo, type QrInfo,
} from '../lib/link';
import { linkLogSnapshot, subscribeLinkLog } from '../lib/linkLog';
import { makeRemotePath } from '../lib/remote';
import { isLinkEnabled, linkStateText } from '../lib/linkStatusText';
import type { BeginHandoff } from '../hooks/useLinkHandoff';

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
  /** 与 SettingsDialog 同源的行样式，避免这里另写一份尺寸定义后与别处漂移 */
  rowCls: string;
  labelCls: string;
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
   * 「这次连上了要交接」的起点：桌面上正看着的那一份摊到前台、其余桌面标签排进标签条、
   * 桌面那棵文件夹树换掉手机这棵。返回收回它的函数。
   * 顶栏扫一扫那条路（`ScanLinkEntry`）走的是同一个触发器，四条入口不该两种样子。
   */
  onHandoff: BeginHandoff;
}

/**
 * 「设备互联」那一整块。桌面是服务端（开关 + 端口 + 配对二维码 + 已配对设备），
 * 手机是客户端（免扫重连 / 改用配对码 / 离线队列）—— 拓扑定死，两端各只出现自己那一半。
 *
 * 它摆在哪：手机端是「设备互联」那一屏（`DeviceLinkPage`），桌面/平板是菜单栏按钮点开的浮层
 * （`DeviceLinkPanel`）。2026-09-28 从设置里剥离出来，两端都不再藏在设置最后一格。
 *
 * 手机的「扫一扫」不在这块里：它在顶栏那颗入口上，点下去直接开相机
 * （见 `DeviceLinkPanel.tsx` 的 `ScanLinkEntry`）。这一块留的是不需要相机的等价入口。
 */
/**
 * 离线队列那一行：待同步 / 需确认 / 正在写回。
 * 与文件树顶部那条横幅同一套文案与颜色，只是换了个说它的地方。
 */
export function OfflineQueueRow({ dark, info }: { dark: boolean; info: LinkOfflineInfo }) {
  const t = useT();
  if (!info.progress && info.pending === 0 && info.conflicts === 0) return null;
  const line = 'flex items-center gap-1.5 min-h-[28px] pointer-coarse:min-h-[40px]';
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
        'mx-2.5 my-1 flex flex-col gap-1 rounded-xl border px-3 py-2 text-xs pointer-coarse:text-sm',
        dark ? 'border-zinc-700/70 bg-zinc-900/30' : 'border-zinc-200 bg-zinc-50/70',
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
              {/* 断开时不给「立即同步」：那一下必然失败，能做的只有下面的免扫重连 */}
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

export function DeviceLinkSection({
  dark, rowCls, labelCls, offline, onBrowseRemote, onShowRemoteTabs, onShowLog, onHandoff,
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

  /* 共享开着就把二维码摆在这里，并按时问一句「该摆哪张」（`QR_POLL_MS`）—— 配对票 120 秒就过期，
     不该让用户为了「码过期了」回电脑前点一下。**换不换由服务端判**：这里每问一次就换一张的话，
     设置弹窗与浮层两个面板各自的定时器会抢着换，屏幕上摆的那张很快就不是当前那张了 ——
     手机照屏幕上那张算密钥，两边派生出不同的密钥，报出来的却是「帧解密失败」这种看不出
     谁做错了什么的串（2026-09-27 他点「刷新配对码」后重配撞上的正是这个）。
     拿回来的 URI 没变就不重设 state：二维码不该每 15 秒重画一次。
     有设备连着时不再问：第二台本来就收 busy。 */
  const listening = !asClient && status?.listening === true;
  const serving = listening && status?.connected === true;
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

  // 手机：吃粘贴进来的 hide-link 配对码（相机不可用时的等价入口，顶栏那颗「扫一扫」走的是同一条配对）
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

  if (!isTauri) {
    return (
      <p className={cn("px-5 py-2 text-[10px] pointer-coarse:text-xs", dark ? "text-zinc-500" : "text-zinc-400")}>
        {t('link.unavailable')}
      </p>
    );
  }

  const s = status;
  const enabled = isLinkEnabled(s, asClient);
  const stateText = linkStateText(t, s, asClient, initial.current.peerName);
  const errorText = localError || s?.lastError || '';

  const inputCls = cn(
    'w-[46%] min-w-0 rounded-md px-2 py-1 text-xs outline-none border',
    IS_TOUCH_PRIMARY && 'min-h-[48px] text-sm',
    dark ? 'bg-zinc-900/60 border-zinc-600 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800',
  );
  const btnGhost = cn(
    'rounded-lg px-3 text-xs font-medium disabled:opacity-50',
    IS_TOUCH_PRIMARY && 'min-h-[48px] min-w-[96px] text-sm',
    dark ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700',
  );
  const btnPrimary = cn(
    'flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 disabled:opacity-50',
    IS_TOUCH_PRIMARY && 'min-h-[48px] min-w-[96px] text-sm',
  );
  const boxCls = cn(
    'my-1 mx-5 rounded-xl border p-3 flex flex-col items-center gap-2 text-center',
    dark ? 'border-zinc-700/70 bg-zinc-900/30' : 'border-zinc-200 bg-zinc-50/70',
  );

  return (
    <>
      {asClient ? (
        <>
          {/* 离线队列那一档排在最前：它是「还有事没办完」，比下面的连接操作更该先看见 */}
          {offline && <OfflineQueueRow dark={dark} info={offline} />}
          {enabled ? (
            <>
              {/* 已连着：看桌面上正开着的标签（阶段 3）+ 进远程文件树 + 断开，
                  不再摆一堆输入框占地方 */}
              <div className={cn(rowCls, 'justify-end')}>
                <button
                  type="button"
                  disabled={!s?.peerKeyId}
                  onClick={() => onShowRemoteTabs?.()}
                  className={btnPrimary}
                >
                  <Files size={14} />
                  {t('link.openTabs')}
                </button>
              </div>
              <div className={cn(rowCls, 'justify-end gap-2')}>
                <button
                  type="button"
                  disabled={!s?.peerKeyId}
                  onClick={() => s?.peerKeyId && onBrowseRemote?.(makeRemotePath(s.peerKeyId, ''))}
                  className={btnPrimary}
                >
                  <FolderTree size={14} />
                  {t('link.browseRemote')}
                </button>
                <button type="button" onClick={onDisconnect} disabled={busy} className={btnGhost}>
                  {t('link.disconnect')}
                </button>
              </div>
            </>
          ) : paired ? (
            <>
              {/* 记住过设备：一键免扫重连，旁边留「改用配对码」入口 */}
              <div className={cn(rowCls, 'justify-end gap-2')}>
                <button type="button" onClick={onReconnect} disabled={busy} className={btnPrimary}>
                  {busy && <Loader2 size={13} className="animate-spin" />}
                  {t('link.reconnect', { device: initial.current.peerName || t('link.desktopFallback') })}
                </button>
              </div>
              <p className="px-5 pb-1 text-[10px] pointer-coarse:text-xs opacity-60">{t('link.orRebind')}</p>
            </>
          ) : null}

          {!enabled && (
            <>
              {/* 顶栏那颗「扫一扫」是主入口；这一格留的是不需要相机的等价入口
                  （相机被占用、码在另一台机器上、或对方直接把配对码发过来时） */}
              <div className={rowCls}>
                <span className={labelCls}>{t('link.pasteCode')}</span>
                <input
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  placeholder="hide-link://pair?…"
                  spellCheck={false}
                  className={cn(inputCls, 'w-[58%] font-mono')}
                />
              </div>
              <div className={cn(rowCls, 'justify-end')}>
                <button type="button" onClick={onPairUri} disabled={busy || !uri.trim()} className={btnPrimary}>
                  <QrCode size={13} />
                  {t('link.pairByCode')}
                </button>
              </div>

              {/* 兜底：6 位短码 + 地址（相机/反光/被拒时用），或调试期直接手填 32 位配对码 */}
              <div className={rowCls}>
                <span className={labelCls}>{t('link.host')}</span>
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={t('link.hostPlaceholder')}
                  spellCheck={false}
                  className={inputCls}
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('link.port')}</span>
                <input
                  value={port}
                  onChange={(e) => onPortChange(e.target.value)}
                  inputMode="numeric"
                  className={cn('w-24 rounded-md px-2 py-1 text-xs outline-none border',
                    IS_TOUCH_PRIMARY && 'min-h-[48px]',
                    dark ? 'bg-zinc-900/60 border-zinc-600 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800')}
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('link.shortCode')}</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  className={cn(inputCls, 'w-24 font-mono')}
                />
              </div>
              <div className={cn(rowCls, 'justify-end')}>
                <button type="button" onClick={onPairCode} disabled={busy} className={btnGhost}>
                  {t('link.pairByShort')}
                </button>
              </div>
              <details className="px-5 py-1">
                <summary className="text-[10px] cursor-pointer opacity-60 pointer-coarse:flex pointer-coarse:min-h-[48px] pointer-coarse:items-center pointer-coarse:text-sm">{t('link.advancedTicket')}</summary>
                <div className={rowCls}>
                  <span className={labelCls}>{t('link.ticket')}</span>
                  <input
                    value={ticket}
                    onChange={(e) => setTicket(e.target.value)}
                    placeholder="0000…"
                    spellCheck={false}
                    className={cn(inputCls, 'w-[58%] font-mono')}
                  />
                </div>
                <div className={cn(rowCls, 'justify-end')}>
                  <button type="button" onClick={onConnectTicket} disabled={busy} className={btnGhost}>
                    {t('link.connect')}
                  </button>
                </div>
              </details>
            </>
          )}
        </>
      ) : (
        <>
          <div className={rowCls}>
            <span className={labelCls}>{t('link.switchLabel')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => onToggle(!enabled)}
              disabled={busy}
              className={cn(
                'relative block w-9 h-5 rounded-full transition-all shrink-0 disabled:opacity-50',
                enabled ? 'bg-[#A3B3FF]' : 'bg-zinc-400/50',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
                  enabled ? 'left-[18px]' : 'left-0.5',
                )}
              />
            </button>
          </div>
          {/* 配对二维码：开关一拨开就摆在这里，并且自己续码（见上面那个 listening 副作用）——
              既不再多要一次点击，也不用人在两分钟之后回电脑前按一下「换一个码」。
              有设备连着时**不再摆码**（第二台收 busy，一张扫不动的码是误操作入口），
              并且把面板里留着的那一张一起收掉：它说的已经是不再成立的那件事。 */}
          {qr && enabled && !s?.connected && (
            <div className={cn(boxCls, 'heid-fade-in')}>
              <div className="text-[11px] font-medium opacity-80">{t('link.qrTitle')}</div>
              <div className="bg-white rounded-lg p-1.5 shadow-sm">
                <Suspense fallback={<div style={{ width: 168, height: 168 }} aria-hidden />}>
                  <QrImage text={qr.uri} size={168} />
                </Suspense>
              </div>
              {/* 短码是扫码失败时的等价入口，本身就该占最显眼的那一行 */}
              <div className="font-mono text-lg tracking-[0.2em]">{qr.code}</div>
              <p className="text-[10px] leading-relaxed opacity-60 break-all">
                {qr.host ? `${qr.host}:${qr.port}` : t('link.noLanIp')}
              </p>
              <button type="button" onClick={onShowQr} className={cn(btnGhost, 'text-[10px] min-h-0 px-2 py-1')}>
                {t('link.refreshCode')}
              </button>
              <div className={cn('flex items-center gap-1.5', IS_TOUCH_PRIMARY && 'min-h-[48px]')}>
                <span className="text-[10px] opacity-70">{t('link.ticket')}</span>
                <button type="button" onClick={onCopyTicket} className="font-mono text-[11px] truncate max-w-[150px] underline decoration-dotted">
                  {s?.ticket || '—'}
                </button>
                <Copy size={11} className="opacity-60" onClick={onCopyTicket} />
                {copied && <span className="text-[10px] opacity-70">{t('link.copied')}</span>}
              </div>
            </div>
          )}
          {/* 连着的时候那一格只说这一句（2026-09-27 他点名：其他不需要那么多说明）。
              要断开、要浏览那台电脑的文件，都在下面那两颗钮上。 */}
          {enabled && s?.connected && (
            <div className={cn(boxCls, 'py-3 text-xs font-medium opacity-80')}>{t('link.deviceConnected')}</div>
          )}
          {/* 共享范围明示（设计稿 §5.2）：开着共享时用户必须看得见手机端能读到哪些文件 */}
          {enabled && (
            <div className={rowCls}>
              <span className={labelCls}>{t('link.shareScope')}</span>
              <span
                title={status?.rootDisplay || undefined}
                className={cn('min-w-0 flex-1 truncate text-xs', !status?.rootDisplay && 'opacity-60')}
              >
                {status?.rootDisplay || t('link.shareScopeNone')}
              </span>
            </div>
          )}
          {/* 根外白名单（阶段 3 §6.3）不在这里占一行（2026-09-25 他说多余）：
              它说的是同一件事的第二遍，份数留在状态栏那条标记的悬停说明里可查。 */}
          {/* bind 成功但没人来连：这是「端口开着、包进不来」的半死状态，比直接报错难查，
              所以由桌面自己提，而不是等用户来回猜是哪台设备的问题 */}
          {enabled && status?.firewallHint && (
            <p className="mx-5 my-1 flex gap-1.5 rounded-lg bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-600 pointer-coarse:text-xs">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>{t('link.firewallHint')}</span>
            </p>
          )}
          <div className={rowCls}>
            <span className={labelCls}>{t('link.port')}</span>
            <input
              value={port}
              onChange={(e) => onPortChange(e.target.value)}
              inputMode="numeric"
              disabled={enabled}
              className={cn(
                'w-24 rounded-md px-2 py-1 text-xs outline-none border disabled:opacity-50',
                IS_TOUCH_PRIMARY && 'min-h-[48px]',
                dark ? 'bg-zinc-900/60 border-zinc-600 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800',
              )}
            />
          </div>

          {/* 已配对设备：多台并存，同一时刻只服务一台；撤销后需重新扫码 */}
          {devices.length > 0 && (
            <div className="px-5 py-1">
              <div className="text-[10px] opacity-70 pointer-coarse:text-xs mb-1">{t('link.pairedDevices')}</div>
              {devices.map((d) => (
                <div key={d.keyId} className="flex items-center justify-between py-0.5 text-xs pointer-coarse:text-sm">
                  <span className="truncate">{d.name || d.keyId}</span>
                  <button type="button" onClick={() => onRevoke(d.keyId)} className="opacity-60 hover:opacity-100 underline decoration-dotted">
                    {t('link.revoke')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 「电脑上正打开的文件」那一屏由 App 挂着唯一一份（扫完码自动落地也落到它），
          这里那颗钮只负责掀开它 */}

      <div className={cn(rowCls, 'items-start')}>
        <span className={cn(labelCls, 'flex items-center gap-1.5')}>
          <Usb size={12} className={enabled ? 'text-emerald-500' : 'opacity-50'} />
          {stateText}
        </span>
      </div>
      {errorText && (
        <p className="px-5 pb-1 text-[10px] leading-relaxed text-red-500 pointer-coarse:text-xs">
          {t('link.lastError', { msg: errorText })}
        </p>
      )}
      {/* 互联日志：这一行两端都在（桌面浮层与手机那一屏用的是同一块内容），
          点开的屏由 App 挂着唯一一份，与「电脑上正打开的文件」同一套挂法 */}
      {onShowLog && (
        <button
          type="button"
          onClick={onShowLog}
          className={cn(
            'mx-2.5 my-0.5 flex items-center gap-1.5 rounded-lg text-xs font-medium transition-colors pointer-coarse:text-sm',
            IS_TOUCH_PRIMARY ? 'min-h-[48px] px-3 py-2' : 'px-2.5 py-1',
            dark ? 'hover:bg-zinc-700/30' : 'hover:bg-zinc-100/70',
          )}
        >
          <ScrollText size={12} className="opacity-70" />
          <span className="min-w-0 flex-1 text-left">{t('link.logTitle')}</span>
          {logCount > 0 && <span className="shrink-0 opacity-60">{t('link.logCount', { n: logCount })}</span>}
          <ChevronRight size={14} className="shrink-0 opacity-40" />
        </button>
      )}
      <p
        className={cn(
          'px-5 pb-2 text-[10px] leading-relaxed pointer-coarse:text-xs',
          dark ? 'text-zinc-500' : 'text-zinc-400',
        )}
      >
        {t('link.hint')}
      </p>
    </>
  );
}
