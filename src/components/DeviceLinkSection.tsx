import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Copy, Loader2, QrCode, ShieldAlert, Smartphone, Usb, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { isTauri } from '../lib/fileIO';
import {
  DEFAULT_LINK_PORT, approvePair, connectTo, denyPair, deviceName, disconnectClient,
  fetchStatus, isUsablePort, loadPrefs, pairCode, pairQr, pairUri, pairingsList, reconnect,
  revokePairing, savePrefs, startServer, stopServer, subscribeLinkStatus, subscribePairRequests,
  type LinkPairReq, type LinkStatus, type PairInfo, type QrInfo,
} from '../lib/link';

/* 二维码只在桌面开配对窗时才用得到，懒加载独立 chunk（与「关于」里的 QrImage 同库同策略） */
const QrImage = lazy(() => import('./QrImage'));
/* 扫码器 + 解码库（jsqr）只在手机点「扫一扫」时才用得到，同样懒加载、不进主包 */
const QrScanner = lazy(() => import('./QrScanner'));

interface DeviceLinkSectionProps {
  dark: boolean;
  /** 与 SettingsDialog 同源的行样式，避免这里另写一份尺寸定义后与别处漂移 */
  rowCls: string;
  labelCls: string;
}

/**
 * 设置 →「设备互联」。桌面是服务端（开关 + 端口 + 配对二维码 + 已配对设备），
 * 手机是客户端（配对 / 免扫重连）—— 拓扑定死，两端各只出现自己那一半。
 *
 * 阶段 1：桌面生成 `hide-link://pair` 二维码 + 6 位短码兜底；手机用应用内「扫一扫」配对，
 * 配对后记住设备、启动免扫重连。粘贴配对码 / 短码是相机不可用时的等价入口，不是过渡方案。
 */
export function DeviceLinkSection({ dark, rowCls, labelCls }: DeviceLinkSectionProps) {
  const t = useT();
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
  const [pairReq, setPairReq] = useState<LinkPairReq | null>(null);
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const paired = !!initial.current.keyId && !!initial.current.host;

  /* 预热扫码用的两个懒加载包：面板一开就把 QrScanner 与 jsQR 取回来（不挂相机、不申请权限）。
     资源在 APK 内、不走网络，所以提前解包是白赚的——省掉点「扫一扫」后那一段 Suspense 空窗。 */
  useEffect(() => {
    if (!IS_TOUCH_PRIMARY) return;
    void Promise.all([import('./QrScanner'), import('jsqr')]).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    fetchStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const off = subscribeLinkStatus((s) => { if (alive) setStatus(s); });
    const offPair = subscribePairRequests((r) => { if (alive) setPairReq(r); });
    return () => { alive = false; off(); offPair(); };
  }, []);

  const refreshDevices = useCallback(() => {
    pairingsList().then(setDevices).catch(() => {});
  }, []);

  const asClient = IS_ANDROID_APP;

  /** 配对/连接成功后，把手机记住的设备 keyId + 名字落进偏好，供下次免扫重连 */
  const persistPairedDevice = useCallback(async () => {
    const list = await pairingsList().catch(() => [] as PairInfo[]);
    setDevices(list);
    const newest = list[0];
    if (newest) savePrefs({ keyId: newest.keyId, peerName: newest.name, host: host.trim() || newest.name });
  }, [host]);

  const run = useCallback(async (fn: () => Promise<LinkStatus>) => {
    setBusy(true);
    setLocalError('');
    try {
      setStatus(await fn());
    } catch (e) {
      setLocalError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

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

  const onApprove = async () => { await approvePair().catch(() => {}); setPairReq(null); void refreshDevices(); };
  const onDeny = async () => { await denyPair().catch(() => {}); setPairReq(null); };

  const onRevoke = async (keyId: string) => {
    await revokePairing(keyId).catch(() => {});
    if (initial.current.keyId === keyId) savePrefs({ keyId: '', peerName: '' });
    refreshDevices();
  };

  // 手机：吃扫到/粘贴的 hide-link 配对码
  const doPairUri = (u: string) => {
    const s = u.trim();
    if (!s.startsWith('hide-link://pair')) return setLocalError(t('link.errUri'));
    setLocalError('');
    savePrefs({ port: Number(port) || DEFAULT_LINK_PORT });
    void run(() => pairUri(s, deviceName())).then(() => { void persistPairedDevice(); });
  };
  const onPairUri = () => doPairUri(uri);
  // 扫到一枚 hide-link 码：直接配对，并关掉扫码层
  const onScanned = (text: string) => {
    setScanning(false);
    setUri(text);
    doPairUri(text);
  };
  // 手机：手输 host + port + 6 位短码
  const onPairCode = () => {
    const n = Number(port);
    if (!host.trim()) return setLocalError(t('link.errHost'));
    if (!isUsablePort(n)) return setLocalError(t('link.errPort'));
    if (!/^\d{6}$/.test(code.trim())) return setLocalError(t('link.errCode'));
    setLocalError('');
    savePrefs({ host: host.trim(), port: n });
    void run(() => pairCode(host.trim(), n, code.trim(), deviceName())).then(() => { void persistPairedDevice(); });
  };
  // 手机：32 位配对码手填直连（调试通道，等价于无指纹的配对）
  const onConnectTicket = () => {
    const n = Number(port);
    if (!host.trim()) return setLocalError(t('link.errHost'));
    if (!isUsablePort(n)) return setLocalError(t('link.errPort'));
    setLocalError('');
    savePrefs({ host: host.trim(), port: n });
    void run(() => connectTo(host.trim(), n, ticket.trim().toLowerCase(), deviceName())).then(() => { void persistPairedDevice(); });
  };
  const onReconnect = () => {
    const p = initial.current;
    setLocalError('');
    void run(() => reconnect(p.host, p.port, p.keyId, deviceName()));
  };
  const onDisconnect = () => void run(disconnectClient);

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
  const enabled = asClient ? s?.role === 'client' : s?.listening === true;
  const stateText = !s || (!enabled && s.role === 'off')
    ? t('link.stateOff')
    : s.connected
      ? t('link.stateConnected', { device: s.peerDevice || initial.current.peerName || s.peerAddr })
      : asClient
        ? t('link.stateIdle')
        : t('link.stateListening', { port: s.port });
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
          {enabled ? (
            <>
              {/* 已连着：只给断开，不再摆一堆输入框占地方 */}
              <div className={cn(rowCls, 'justify-end gap-2')}>
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
              {/* 扫一扫是主入口；下面粘贴/短码/手填是它的等价兜底（相机不可用时） */}
              <div className={cn(rowCls, 'justify-end')}>
                <button type="button" onClick={() => setScanning(true)} className={btnPrimary}>
                  <Camera size={14} />
                  {t('link.scan')}
                </button>
              </div>
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
                <summary className="text-[10px] cursor-pointer opacity-60 pointer-coarse:text-xs">{t('link.advancedTicket')}</summary>
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

          {enabled && (
            <div className={cn(rowCls, 'justify-end gap-2')}>
              <button type="button" onClick={onShowQr} disabled={busy} className={btnPrimary}>
                <Smartphone size={13} />
                {t('link.showQr')}
              </button>
            </div>
          )}

          {/* 配对二维码面板：一次性票 2 分钟有效，点一次刷新一次 */}
          {qr && enabled && (
            <div className={cn(boxCls, 'heid-fade-in')}>
              <div className="bg-white rounded-lg p-1.5 shadow-sm">
                <Suspense fallback={<div style={{ width: 168, height: 168 }} aria-hidden />}>
                  <QrImage text={qr.uri} size={168} />
                </Suspense>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] opacity-70">{t('link.shortCode')}</span>
                <span className="font-mono text-lg tracking-[0.2em]">{qr.code}</span>
              </div>
              <p className="text-[10px] leading-relaxed opacity-60 break-all">
                {qr.host ? `${qr.host}:${qr.port}` : t('link.noLanIp')}
              </p>
              <button type="button" onClick={onShowQr} className={cn(btnGhost, 'text-[10px] min-h-0 px-2 py-1')}>
                {t('link.refreshCode')}
              </button>
              <div className={cn('flex items-center gap-1.5', IS_TOUCH_PRIMARY && 'min-h-[44px]')}>
                <span className="text-[10px] opacity-70">{t('link.ticket')}</span>
                <button type="button" onClick={onCopyTicket} className="font-mono text-[11px] truncate max-w-[150px] underline decoration-dotted">
                  {s?.ticket || '—'}
                </button>
                <Copy size={11} className="opacity-60" onClick={onCopyTicket} />
                {copied && <span className="text-[10px] opacity-70">{t('link.copied')}</span>}
              </div>
            </div>
          )}

          {/* TOFU 确认框：有持票设备来了才出现，允许才登记 */}
          {pairReq && (
            <div className={cn(boxCls, 'border-amber-500/60', dark ? 'bg-amber-500/10' : 'bg-amber-50')}>
              <div className="flex items-center gap-1.5 text-[11px] font-medium pointer-coarse:text-sm">
                <ShieldAlert size={13} className="text-amber-500" />
                {t('link.confirmTitle', { device: pairReq.device || t('link.unknownDevice') })}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onApprove} className={btnPrimary}>{t('link.allow')}</button>
                <button type="button" onClick={onDeny} className={cn(btnGhost, 'inline-flex items-center gap-1')}>
                  <X size={12} />
                  {t('link.deny')}
                </button>
              </div>
            </div>
          )}

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

      {scanning && (
        <Suspense fallback={null}>
          <QrScanner onResult={onScanned} onClose={() => setScanning(false)} dark={dark} />
        </Suspense>
      )}

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
