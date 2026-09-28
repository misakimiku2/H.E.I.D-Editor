/**
 * 设备互联的一级入口（v1.5 发版前用户点名）。内容仍是设置里那一整块
 * （`DeviceLinkSection`），这个文件只管「入口」本身长什么样、点开是什么。
 *
 * 两端形状不同，是他 2026-09-25 第二次点名后定的：
 *  - **桌面 / 平板**：菜单栏「菜单」按钮右侧一颗常驻按钮，点开是贴着按钮的浮层，
 *    浮层里就是那一整块（共享开关 / 配对二维码 / 已配对设备 / 离线队列 / 互联日志）。
 *    安卓平板在这一整块的最上面多一颗「扫一扫」（2026-09-28 他实测点名平板没有扫码）：
 *    平板顶栏走的是桌面布局，没有手机那颗顶栏按钮位，扫码只能从这一层进。
 *  - **手机**：顶栏那颗直接就是**「扫一扫」** —— 点下去开相机配对，不再先弹一层抽屉。
 *    其余入口（改用配对码、看桌面上正打开的文件、断开、离线队列、日志）在「设备互联」那一屏里
 *    （`DeviceLinkPage`，2026-09-28 他从设置里把它剥离出来了），连着时顶栏那颗换成状态按钮，
 *    点下去就是那一屏，见下面 `ScanLinkEntry` 的注释。
 *
 * 状态一律取 `useLinkStatus` 那一份订阅，与状态栏的 `LinkShareChip` 同源：
 * 入口与标记各算各的「连上了没有」是这条入口最容易写歪的地方。
 */
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, MonitorSmartphone, QrCode, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT, type Translate } from '../lib/i18nContext';
import { IS_ANDROID_APP, IS_TOUCH_PRIMARY } from '../lib/platform';
import { useLinkStatus } from '../hooks/useLinkStatus';
import { linkBadge, linkDotCls, type LinkBadge } from '../lib/linkBadge';
import { linkStateText } from '../lib/linkStatusText';
import { appAlert } from '../lib/appAlert';
import { deviceName, linkRedialSnapshot, loadPrefs, pairUri, subscribeLinkRedial } from '../lib/link';
import type { BeginHandoff } from '../hooks/useLinkHandoff';
import { DeviceLinkSection, type LinkOfflineInfo } from './DeviceLinkSection';

/* 扫码器 + 解码库（jsqr）只在点「扫一扫」时才用得到，懒加载、不进主包 */
const QrScanner = lazy(() => import('./QrScanner'));

export interface DeviceLinkPanelProps {
  dark: boolean;
  /** 离线队列摘要；桌面（服务端）不传，那一行就不出现 */
  offline?: LinkOfflineInfo;
  onBrowseRemote?: (rootPath: string) => void;
  /** 掀开 App 那份唯一的「电脑上正打开的文件」 */
  onShowRemoteTabs?: () => void;
  /** 掀开 App 那份唯一的「互联日志」 */
  onShowLog?: () => void;
  /** 手机那四个「我主动要连」的动作共用的交接触发器（桌面那一侧用不到，但仍要传进来） */
  onHandoff: BeginHandoff;
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

/**
 * 懒加载包预热：手机顶栏与平板浮层各挂一次，谁先出现谁预热。
 * 资源在 APK 内、不走网络，提前解包是白赚的 —— 省掉点「扫一扫」后那一段空窗。
 */
function useScanPreload() {
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    void Promise.all([import('./QrScanner'), import('jsqr')]).catch(() => {});
  }, []);
}

/**
 * 扫到码之后那一条路径（手机顶栏与平板浮层共用，两处别各写一套）：
 * 校验 URI → 立起交接 → 发配对。命令本身没过（地址为空、URI 不对）的话那次拨号没发生，
 * 把交接收回，别等它超时报一句无关的话。
 */
function pairFromScan(text: string, t: Translate, onHandoff: BeginHandoff) {
  const s = text.trim();
  if (!s.startsWith('hide-link://pair')) {
    appAlert(t('link.errUri'));
    return;
  }
  const cancel = onHandoff();
  void pairUri(s, deviceName())
    .catch((e: unknown) => {
      cancel();
      appAlert(String((e as { message?: string })?.message ?? e));
    });
}

/** 桌面 / 平板菜单栏上的互联按钮 + 贴着按钮的浮层 */
export function DeviceLinkMenuButton(props: DeviceLinkPanelProps) {
  const t = useT();
  const { badge, tip } = useLinkEntryBadge(props.offline);
  const status = useLinkStatus();
  const connected = status.connected === true;
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useScanPreload();

  /* 相机开着的时候链路被后台接回来（免扫重连 / 退避重试成功）：把开合一起收掉。
     不收的话 `scanOpen` 停在 true，下次断开时相机自己弹出来（与手机那颗同一条理由） */
  useEffect(() => {
    if (connected && scanOpen) setScanOpen(false);
  }, [connected, scanOpen]);

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

  /* 状态卡里那颗「扫一扫」点下去：浮层自己收掉，相机层是全屏幕（z-150）的那一层 */
  const startScan = () => { setOpen(false); setScanOpen(true); };

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
            {/* 掀开「电脑上正打开的文件」、进远程树、或打开日志屏的那一刻，本浮层就该收掉：
                它们都是整屏的去处，浮层留在上面只是挡编辑器（平板壳实测到的一次残留） */}
            <DeviceLinkSection
              dark={props.dark}
              offline={props.offline}
              onHandoff={props.onHandoff}
              onScan={IS_ANDROID_APP ? startScan : undefined}
              onBrowseRemote={(p) => { setOpen(false); props.onBrowseRemote?.(p); }}
              onShowRemoteTabs={() => { setOpen(false); props.onShowRemoteTabs?.(); }}
              onShowLog={() => { setOpen(false); props.onShowLog?.(); }}
            />
          </div>
        </div>
      )}

      {/* 相机层压在浮层之上（z-150 vs z-50）。浮层已经自己收掉了，
          相机里那颗「改用配对码」再把浮层掀回来，两条路是同一格的两个入口 */}
      {scanOpen && !connected && (
        <Suspense fallback={null}>
          <QrScanner
            dark={props.dark}
            onResult={(text) => {
              setScanOpen(false);
              pairFromScan(text, t, props.onHandoff);
            }}
            onClose={() => setScanOpen(false)}
            onUseCode={() => { setScanOpen(false); setOpen(true); }}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * 手机顶栏那颗互联入口（App 把它交给 `TopAppBar` 的 linkSlot，位置与间距仍由顶栏管）。
 * 它有三副样子，按**连没连上那台电脑、以及没连上时是不是正在自己接回来**分：
 *
 *  - **没连着、也没在接**：就是「扫一扫」，点下去直接开相机，扫到 `hide-link://pair` 就配对。
 *    配对发起成功之后不弹一句"连上了"：`onHandoff` 立起的交接会把桌面上正看着的那一份
 *    直接摊开（其余桌面标签排在后面补进标签条），失败就把桌面的原话摆在同一处 ——
 *    一句话报告完还要用户自己去找东西在哪，是白多一步。
 *  - **没连着、但正在自己接回来**（亮屏之后退避重连在跑，或那一次拨号还在路上）：转圈，
 *    点下去与连着时同一格。这时候摆一颗扫码是把"等一等"说成"你来动手"（2026-09-27 他点名）。
 *  - **已经连着**：换成连接状态按钮，点下去是「设备互联」那一屏（断开、
 *    浏览那台电脑的文件、互联日志都在里面）。**扫码入口就此收起**：手机端同时只服务一台电脑，
 *    连着的时候再摆一颗扫码，扫了也只会把当前这条顶掉，那是误操作而不是功能。
 *    要换一台，先在那一屏里断开，那颗「扫一扫」自己就回来了。
 *
 * 三副样子用的是同一颗按钮位、同一份状态点（`useLinkEntryBadge`），所以切换时
 * 顶栏不会抖一下 —— 变的只有图标与它点下去去处。
 */
export function ScanLinkEntry({
  dark, offline, open, onOpenChange, onHandoff, onStatus,
}: {
  dark: boolean;
  offline?: LinkOfflineInfo;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 记一笔「这次连上了要交接」，返回收回它的函数（配对命令本身没过时收回，别等超时） */
  onHandoff: BeginHandoff;
  /** 已连接那副样子点下去的去处 */
  onStatus: () => void;
}) {
  const t = useT();
  const { badge, tip } = useLinkEntryBadge(offline);
  const status = useLinkStatus();
  const connected = status.connected === true;
  const redial = useSyncExternalStore(subscribeLinkRedial, linkRedialSnapshot);
  /* 自动接回途中（含刚拨出去那一次）转圈，不摆「扫一扫」：亮屏之后手机正在自己接回来，
     这时候摆一颗扫码是把"等一等"说成"你来动手"。整套退避跑完（约一分四十七秒）转圈自己收掉，
     因为那时它已经不再预告任何结果 —— 后台仍在按 60 秒一档试下去，图标变回去不等于放弃。
     点下去与连着时同一去处（设置 · 设备互联），那里有断开，也有那台电脑的文件。 */
  const dialing = !connected && status.role === 'client' && !!status.peerAddr;
  const redialing = !connected && (dialing || redial.spinning);

  /* 相机开着的时候链路被后台接回来（免扫重连 / 退避重试成功）：把开合状态一起收掉。
     不收的话 `open` 会一直停在 true，等他下次断开时相机自己弹出来。 */
  useEffect(() => {
    if (connected && open) onOpenChange(false);
  }, [connected, open, onOpenChange]);

  /* 预热扫码用的两个懒加载包：顶栏一挂出来就把 QrScanner 与 jsQR 取回来（不挂相机、不申请权限） */
  useScanPreload();

  const onResult = (text: string) => {
    onOpenChange(false);
    pairFromScan(text, t, onHandoff);
  };

  const btnCls = cn(
    'relative w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors',
    dark ? 'hover:bg-zinc-700 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500',
  );

  return (
    <>
      {connected ? (
        <button
          type="button"
          onClick={onStatus}
          aria-label={t('settings.section.deviceLink')}
          title={tip}
          className={btnCls}
        >
          <MonitorSmartphone size={20} />
          {badge && <LinkDot badge={badge} dark={dark} big />}
        </button>
      ) : redialing ? (
        <button
          type="button"
          onClick={onStatus}
          aria-label={t('link.redialing')}
          title={t('link.redialing')}
          className={btnCls}
        >
          <Loader2 size={20} className="animate-spin" />
          {badge && <LinkDot badge={badge} dark={dark} big />}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-label={t('link.scan')}
          title={`${t('link.scan')} · ${tip}`}
          className={btnCls}
        >
          <QrCode size={20} />
          {badge && <LinkDot badge={badge} dark={dark} big />}
        </button>
      )}
      {/* 相机层只在「没连着」这一侧挂：连着那一下该把它收掉（见上面那个 effect），
          而它挂在按钮外面，所以底下这颗是扫一扫还是在转圈都不影响这一层 */}
      {!connected && open && (
        <Suspense fallback={null}>
          <QrScanner
            onResult={onResult}
            onClose={() => onOpenChange(false)}
            dark={dark}
            /* 「改用粘贴 / 短码」收掉相机、进同一去处（连着时那颗按钮点开的就是这一屏） */
            onUseCode={() => { onOpenChange(false); onStatus(); }}
          />
        </Suspense>
      )}
    </>
  );
}
