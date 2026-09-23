import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2, Usb } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { isTauri } from '../lib/fileIO';
import {
  DEFAULT_LINK_PORT, connectTo, deviceName, disconnectClient, fetchStatus, isTicket,
  isUsablePort, loadPrefs, savePrefs, startServer, stopServer, subscribeLinkStatus,
  type LinkStatus,
} from '../lib/link';

interface DeviceLinkSectionProps {
  dark: boolean;
  /** 与 SettingsDialog 同源的行样式，避免这里另写一份尺寸定义后与别处漂移 */
  rowCls: string;
  labelCls: string;
}

/**
 * 设置 →「设备互联」。桌面是服务端（开关 + 端口 + 配对码），
 * 手机是客户端（手填地址与配对码）—— 拓扑定死，两端各只出现自己那一半。
 *
 * 阶段 0 只有手填这一条通道；扫码与 6 位短码在阶段 1（设计稿 §7）。
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

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    fetchStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const off = subscribeLinkStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);

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
    void run(on ? () => startServer(Number(port) || DEFAULT_LINK_PORT) : stopServer);
  };

  const onPortChange = (v: string) => {
    setPort(v);
    const n = Number(v);
    if (isUsablePort(n)) savePrefs({ port: n });
  };

  const onConnect = () => {
    const n = Number(port);
    if (!host.trim()) return setLocalError(t('link.errHost'));
    if (!isUsablePort(n)) return setLocalError(t('link.errPort'));
    if (!isTicket(ticket.trim())) return setLocalError(t('link.errTicket'));
    setLocalError('');
    savePrefs({ host: host.trim(), port: n, ticket: ticket.trim().toLowerCase() });
    void run(() => connectTo(host.trim(), n, ticket.trim().toLowerCase(), deviceName()));
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

  if (!isTauri) {
    return (
      <p className={cn("px-5 py-2 text-[10px] pointer-coarse:text-xs", dark ? "text-zinc-500" : "text-zinc-400")}>
        {t('link.unavailable')}
      </p>
    );
  }

  const asClient = IS_ANDROID_APP;
  const s = status;
  const enabled = asClient ? s?.role === 'client' : s?.listening === true;
  const stateText = !s || (!enabled && s.role === 'off')
    ? t('link.stateOff')
    : s.connected
      ? t('link.stateConnected', { device: s.peerDevice || s.peerAddr })
      : asClient
        ? t('link.stateIdle')
        : t('link.stateListening', { port: s.port });
  const errorText = localError || s?.lastError || '';

  return (
    <>
      {asClient ? (
        <>
          <div className={rowCls}>
            <span className={labelCls}>{t('link.host')}</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t('link.hostPlaceholder')}
              spellCheck={false}
              className={cn(
                'w-[46%] min-w-0 rounded-md px-2 py-1 text-xs outline-none border',
                IS_TOUCH_PRIMARY && 'min-h-[48px] text-sm',
                dark ? 'bg-zinc-900/60 border-zinc-600 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800',
              )}
            />
          </div>
          <div className={rowCls}>
            <span className={labelCls}>{t('link.ticket')}</span>
            <input
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="0000…"
              spellCheck={false}
              className={cn(
                'w-[46%] min-w-0 rounded-md px-2 py-1 font-mono text-xs outline-none border',
                IS_TOUCH_PRIMARY && 'min-h-[48px]',
                dark ? 'bg-zinc-900/60 border-zinc-600 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800',
              )}
            />
          </div>
          <div className={rowCls}>
            <span className={labelCls}>{t('link.port')}</span>
            <input
              value={port}
              onChange={(e) => onPortChange(e.target.value)}
              inputMode="numeric"
              className={cn(
                'w-24 rounded-md px-2 py-1 text-xs outline-none border',
                IS_TOUCH_PRIMARY && 'min-h-[48px]',
                dark ? 'bg-zinc-900/60 border-zinc-600 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800',
              )}
            />
          </div>
          <div className={cn(rowCls, 'justify-end gap-2')}>
            {enabled ? (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={busy}
                className={cn(
                  'rounded-lg px-3 text-xs font-medium disabled:opacity-50',
                  IS_TOUCH_PRIMARY && 'min-h-[48px] min-w-[96px] text-sm',
                  dark ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700',
                )}
              >
                {t('link.disconnect')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onConnect}
                disabled={busy}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 disabled:opacity-50',
                  IS_TOUCH_PRIMARY && 'min-h-[48px] min-w-[96px] text-sm',
                )}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t('link.connect')}
              </button>
            )}
          </div>
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
            <div className={cn(rowCls, 'heid-fade-in')}>
              <span className={labelCls}>{t('link.ticket')}</span>
              <button
                type="button"
                onClick={onCopyTicket}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs',
                  IS_TOUCH_PRIMARY && 'min-h-[48px]',
                  dark ? 'bg-zinc-900/60 text-zinc-200 hover:bg-zinc-700' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200',
                )}
              >
                <span className="truncate max-w-[150px]">{s?.ticket || '—'}</span>
                <Copy size={12} className="shrink-0 opacity-60" />
                {copied && <span className="text-[10px] opacity-70">{t('link.copied')}</span>}
              </button>
            </div>
          )}
        </>
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
      {/* 版本不匹配在握手期就被对端拒了（Refused.code = version），
          错误会走 lastError 那条线，这里不再另设一套提示 */}
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
