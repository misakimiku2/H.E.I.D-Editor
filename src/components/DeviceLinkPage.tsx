/**
 * 手机端「设备互联」整屏（他从设置里剥离出来那一条）。
 *
 * 里面装的还是那一块（`DeviceLinkSection`：连接状态、断开、浏览那台电脑的文件、
 * 不需要相机的三条配对入口、离线队列），只是不再藏在设置最后一格 —— 连着谁、要断开、
 * 想换一台，都是同一个决定的一串动作，摆在一屏里少来回翻。
 *
 * 入口有两颗，都是原来就有的那颗按钮位与那颗状态点：
 *  - 顶栏连着时那副样子点进来（`ScanLinkEntry` 的 `onStatus`）；
 *  - 顶栏「更多」菜单里的「设备互联」（没连的时候也从这儿进，扫一扫仍在那颗顶栏按钮上）。
 *
 * 桌面/平板不用这一屏：那边的一级入口是菜单栏按钮点开的浮层（见 `DeviceLinkPanel`）。
 *
 * **必须 portal 到 body**：与 `RemoteTabsSheet` 同一条坑 —— 底下的设置弹窗带 `backdrop-blur`，
 * 会成为 `position: fixed` 的包含块。层级压在相机（z-150）之下、设置（z-100）之上，
 * 所以在这屏里按下扫一扫，相机是盖在这一屏上面的，而不是藏在它底下。
 */
import { createPortal } from 'react-dom';
import { ArrowLeft, QrCode } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
import { useLinkStatus } from '../hooks/useLinkStatus';
import type { BeginHandoff } from '../hooks/useLinkHandoff';
import { DeviceLinkSection, type LinkOfflineInfo } from './DeviceLinkSection';
import { PANEL_LABEL_CLS, panelRowCls } from './panelRows';

interface DeviceLinkPageProps {
  dark: boolean;
  onClose: () => void;
  offline?: LinkOfflineInfo;
  onBrowseRemote: (rootPath: string) => void;
  onShowRemoteTabs: () => void;
  onShowLog: () => void;
  onHandoff: BeginHandoff;
  /** 顶栏那颗「扫一扫」的同一个开合状态：这一屏里再给一颗入口，不必先退回去 */
  onScan?: () => void;
}

export function DeviceLinkPage({
  dark, onClose, offline, onBrowseRemote, onShowRemoteTabs, onShowLog, onHandoff, onScan,
}: DeviceLinkPageProps) {
  const t = useT();
  const status = useLinkStatus();
  /* 连着的时候不摆「扫一扫」：手机同时只服务一台电脑，扫了只会把当前这条顶掉，
     那是误操作而不是功能（与顶栏那颗按钮同一套判法） */
  const connected = status.connected === true;

  const btn = cn(
    'flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white transition-colors active:bg-indigo-500',
    IS_TOUCH_PRIMARY ? 'min-h-[52px]' : 'min-h-[40px]',
  );

  return createPortal(
    <div
      className={cn('fixed inset-0 z-[145] flex flex-col overflow-hidden', dark ? 'bg-zinc-900 text-zinc-100' : 'bg-zinc-50 text-zinc-800')}
      role="dialog"
      aria-label={t('settings.section.deviceLink')}
    >
      <header className={cn(
        'safe-top flex shrink-0 items-center gap-1 border-b px-2 py-1.5',
        dark ? 'border-zinc-700/70' : 'border-zinc-200',
      )}>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.back')}
          className={cn(
            'flex items-center justify-center rounded-md transition-colors shrink-0',
            IS_TOUCH_PRIMARY ? 'w-12 h-12' : 'w-7 h-7',
            dark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-200/70',
          )}
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{t('settings.section.deviceLink')}</h2>
      </header>

      <div className="heid-scroll heid-scroll-none min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        {onScan && !connected && (
          <div className="px-3 pb-1 pt-2">
            <button type="button" onClick={onScan} className={btn}>
              <QrCode size={17} />
              {t('link.scan')}
            </button>
          </div>
        )}
        <DeviceLinkSection
          dark={dark}
          rowCls={panelRowCls(dark)}
          labelCls={PANEL_LABEL_CLS}
          offline={offline}
          onBrowseRemote={onBrowseRemote}
          onShowRemoteTabs={onShowRemoteTabs}
          onShowLog={onShowLog}
          onHandoff={onHandoff}
        />
      </div>
    </div>,
    document.body,
  );
}
