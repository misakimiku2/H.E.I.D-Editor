/**
 * 设备互联的一级入口（v1.5 发版前用户点名）。内容仍是设置里那一整块
 * （`DeviceLinkSection`），这个文件只管「入口」本身长什么样、点开是什么。
 *
 * 两端形状不同，是他 2026-09-25 第二次点名后定的：
 *  - **桌面 / 平板**：菜单栏「菜单」按钮右侧一颗常驻按钮，点开是贴着按钮的浮层，
 *    浮层里就是那一整块（共享开关 / 配对二维码 / 已配对设备 / 离线队列）。
 *  - **手机**：顶栏那颗直接就是**「扫一扫」** —— 点下去开相机配对，不再先弹一层抽屉。
 *    其余入口（改用配对码、看桌面上正打开的文件、断开、离线队列）留在「设置 → 设备互联」里。
 *
 * 状态一律取 `useLinkStatus` 那一份订阅，与状态栏的 `LinkShareChip` 同源：
 * 入口与标记各算各的「连上了没有」是这条入口最容易写歪的地方。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { MonitorSmartphone, QrCode, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { useLinkStatus } from '../hooks/useLinkStatus';
import { linkBadge, linkDotCls, type LinkBadge } from '../lib/linkBadge';
import { linkStateText } from '../lib/linkStatusText';
import { appAlert } from '../lib/appAlert';
import { showNotification } from '../lib/notifications';
import { deviceName, loadPrefs, pairUri, rememberPeer } from '../lib/link';
import { DeviceLinkSection, type LinkOfflineInfo } from './DeviceLinkSection';
import { PANEL_LABEL_CLS, panelRowCls } from './panelRows';

/* 扫码器 + 解码库（jsqr）只在点「扫一扫」时才用得到，懒加载、不进主包 */
const QrScanner = lazy(() => import('./QrScanner'));

export interface DeviceLinkPanelProps {
  dark: boolean;
  /** 离线队列摘要；桌面（服务端）不传，那一行就不出现 */
  offline?: LinkOfflineInfo;
  onBrowseRemote?: (rootPath: string) => void;
  onOpenRemoteFile?: (path: string) => void;
}

export interface LinkEntryState {
  badge: LinkBadge | null;
  /** 悬停说明：状态那句话 + 待同步 / 需确认的数 */
  tip: string;
}

/**
 * 入口那颗点与其说明。桌面按钮与手机顶栏那颗「扫一扫」都走它 ——
 * 那颗「扫一扫」同时也就是连接状态的落点，两处亮同一档颜色才不会让人以为有两个连接状态。
 */
export function useLinkEntryBadge(offline?: LinkOfflineInfo): LinkEntryState {
  const t = useT();
  const status = useLinkStatus();
  const asClient = IS_ANDROID_APP;
  const badge = linkBadge(status, { asClient, pending: offline?.pending, conflicts: offline?.conflicts });
  const pending = offline?.pending ?? 0;
  const conflicts = offline?.conflicts ?? 0;
  const parts = [linkStateText(t, status, asClient, loadPrefs().peerName)];
  if (conflicts > 0) parts.push(t('offline.bannerConfirm', { n: conflicts }));
  else if (pending > 0) parts.push(t('offline.countTip', { pending, conflicts }));
  return { badge, tip: parts.join(' · ') };
}

/** 状态点本体。按钮各端长得不一样，这颗点的位置与配色只有一份 */
function LinkDot({ badge, dark, big }: { badge: LinkBadge; dark: boolean; big: boolean }) {
  return (
    <span
      data-testid="heid-link-dot"
      data-link-badge={badge}
      className={cn(
        'absolute rounded-full',
        big ? 'top-1.5 right-1.5 w-2 h-2' : 'top-0 right-0 w-1.5 h-1.5',
        linkDotCls(badge, dark),
      )}
    />
  );
}

/** 桌面 / 平板菜单栏上的互联按钮 + 贴着按钮的浮层 */
export function DeviceLinkMenuButton(props: DeviceLinkPanelProps) {
  const t = useT();
  const { badge, tip } = useLinkEntryBadge(props.offline);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={t('settings.section.deviceLink')}
        title={tip}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative rounded-md transition-colors flex items-center justify-center shrink-0',
          IS_TOUCH_PRIMARY ? 'w-12 h-12' : 'p-1.5',
          open
            ? (props.dark ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700')
            : (props.dark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500'),
        )}
      >
        <MonitorSmartphone size={IS_TOUCH_PRIMARY ? 20 : 15} />
        {badge && <LinkDot badge={badge} dark={props.dark} big={false} />}
      </button>

      {open && (
        <div
          data-testid="heid-link-panel"
          className={cn(
            'heid-pop-in absolute left-0 top-full mt-1 z-50 flex flex-col w-[min(360px,92vw)] pointer-coarse:w-[min(420px,94vw)]',
            'max-h-[min(72vh,560px)] rounded-xl border shadow-xl backdrop-blur-md overflow-hidden',
            props.dark ? 'border-zinc-700/70 bg-zinc-800/85 text-zinc-100' : 'border-zinc-200/80 bg-white/85 text-zinc-800',
          )}
        >
          <div className={cn(
            'flex shrink-0 items-center gap-2 px-4 py-2 border-b',
            props.dark ? 'border-zinc-700/70' : 'border-zinc-200',
          )}>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t('settings.section.deviceLink')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('common.close')}
              title={t('common.close')}
              className={cn(
                'shrink-0 rounded-md transition-colors flex items-center justify-center',
                IS_TOUCH_PRIMARY ? 'w-12 h-12' : 'w-6 h-6',
                props.dark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-200 text-zinc-500',
              )}
            >
              <X size={IS_TOUCH_PRIMARY ? 18 : 13} />
            </button>
          </div>
          <div className="heid-scroll heid-scroll-none min-h-0 overflow-y-auto pb-1">
            <DeviceLinkSection
              dark={props.dark}
              rowCls={panelRowCls(props.dark)}
              labelCls={PANEL_LABEL_CLS}
              offline={props.offline}
              onBrowseRemote={props.onBrowseRemote}
              onOpenRemoteFile={props.onOpenRemoteFile}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 手机顶栏那颗「扫一扫」（App 把它交给 `TopAppBar` 的 linkSlot，位置与间距仍由顶栏管）。
 * 点下去直接开相机，扫到 `hide-link://pair` 就配对；结果与失败都走全局提示 ——
 * 这条路上没有面板可以落那行错误文字。钮上那颗点仍是连接状态。
 */
export function ScanLinkEntry({
  dark, offline, open, onOpenChange,
}: { dark: boolean; offline?: LinkOfflineInfo; open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const { badge, tip } = useLinkEntryBadge(offline);

  /* 预热扫码用的两个懒加载包：顶栏一挂出来就把 QrScanner 与 jsQR 取回来（不挂相机、不申请权限）。
     资源在 APK 内、不走网络，提前解包是白赚的——省掉点「扫一扫」后那一段空窗。 */
  useEffect(() => {
    void Promise.all([import('./QrScanner'), import('jsqr')]).catch(() => {});
  }, []);

  const onResult = (text: string) => {
    onOpenChange(false);
    const s = text.trim();
    if (!s.startsWith('hide-link://pair')) {
      appAlert(t('link.errUri'));
      return;
    }
    void pairUri(s, deviceName())
      .then((st) => {
        rememberPeer(st);
        /* 说的还是那一句状态话（「等待电脑上确认」/「已连接：X」），不在这儿另编一套措辞 */
        showNotification({
          kind: 'success',
          title: t('settings.section.deviceLink'),
          message: linkStateText(t, st, true),
          timeoutMs: 4000,
        });
      })
      .catch((e: unknown) => appAlert(String((e as { message?: string })?.message ?? e)));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label={t('link.scan')}
        title={`${t('link.scan')} · ${tip}`}
        className={cn(
          'relative w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors',
          dark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500',
        )}
      >
        <QrCode size={20} />
        {badge && <LinkDot badge={badge} dark={dark} big />}
      </button>
      {open && (
        <Suspense fallback={null}>
          <QrScanner onResult={onResult} onClose={() => onOpenChange(false)} dark={dark} />
        </Suspense>
      )}
    </>
  );
}
