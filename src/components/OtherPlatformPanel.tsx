/**
 * 「获取另一版」面板（v1.4.2）：桌面与安卓互相引流，装在「关于」弹窗里同一块区域。
 * 装了桌面的人不知道有安卓版、反之亦然，而 v1.5 的「扫码连接电脑」将来也长在这块位置。
 * 桌面侧给 APK 二维码（指向 Gitee 镜像直链，国内扫码能直接下动）+ 门槛说明；
 * 安卓侧不需要扫码 UI，给下载页地址 + 复制 / 打开。
 */
import { lazy, Suspense, useState } from 'react';
import { Copy, Monitor, Smartphone } from 'lucide-react';
import { cn } from '../lib/utils';
import { IS_ANDROID_APP } from '../lib/platform';
import { apkMirrorDownloadUrl } from '../lib/update';
import { writeClipboardText } from '../lib/fileOps';
import { openExternal } from '../lib/openExternal';
import { useT } from '../lib/i18nContext';

/* 二维码库只在桌面侧用到，拆独立 chunk（主包体积是一等约束） */
const QrImage = lazy(() => import('./QrImage'));

export interface OtherPlatformPanelProps {
  /** 二维码指向的 APK 版本：检查到更新时用更新后的版本号，否则用当前版本 */
  version: string;
  /** 下载页地址（跟随更新检查命中的源，GitHub 或镜像） */
  downloadPage: string;
  isDarkMode: boolean;
}

export function OtherPlatformPanel({ version, downloadPage, isDarkMode }: OtherPlatformPanelProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  /* 安卓要的是桌面版所在的下载页；桌面要的是能扫码直接装上的 APK 直链 */
  const link = IS_ANDROID_APP ? downloadPage : apkMirrorDownloadUrl(version);
  const boxCls = cn(
    'mt-4 w-full rounded-xl border p-3 flex flex-col items-center gap-2 text-center',
    isDarkMode ? 'border-zinc-700/70 bg-zinc-900/30' : 'border-zinc-200 bg-zinc-50/70'
  );
  const titleCls = cn('text-[10px] font-medium flex items-center gap-1.5 pointer-coarse:text-xs',
    isDarkMode ? 'text-zinc-300' : 'text-zinc-600');
  const hintCls = cn('text-[9px] leading-relaxed pointer-coarse:text-[11px]',
    isDarkMode ? 'text-zinc-500' : 'text-zinc-500');
  const btnCls = cn(
    'px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors flex items-center gap-1',
    'pointer-coarse:text-sm pointer-coarse:px-4 pointer-coarse:min-h-[48px] pointer-coarse:gap-2',
    isDarkMode ? 'border-zinc-600 text-zinc-400 hover:bg-zinc-700' : 'border-zinc-300 text-zinc-500 hover:bg-zinc-100'
  );
  const copy = () => {
    void writeClipboardText(link)
      .then(() => setCopied(true))
      .catch(() => { /* 剪贴板被系统拒绝：按钮保持原样，地址仍在界面上可手动选中 */ });
  };

  return (
    <div className={boxCls}>
      <div className={titleCls}>
        {IS_ANDROID_APP ? <Monitor size={11} className="pointer-coarse:w-3.5 pointer-coarse:h-3.5" />
          : <Smartphone size={11} className="pointer-coarse:w-3.5 pointer-coarse:h-3.5" />}
        {t(IS_ANDROID_APP ? 'about.desktopTitle' : 'about.mobileTitle')}
      </div>
      {IS_ANDROID_APP ? (
        <p className={cn(hintCls, 'break-all select-text')}>{downloadPage}</p>
      ) : (
        <Suspense fallback={<div style={{ width: 140, height: 140 }} aria-hidden />}>
          {/* 二维码必须是深底浅码之外的黑白对：扫码器靠明暗对比定位，故固定白底 */}
          <div className="bg-white rounded-lg p-1.5 shadow-sm">
            <QrImage text={link} />
          </div>
        </Suspense>
      )}
      <div className="flex items-center gap-1.5 pointer-coarse:gap-2.5">
        {/* 安卓只给「打开」：地址已经整行可见可长按选中，而「关于」里更新检查失败时
            本来就有一个复制下载链接按钮，再放一个是重复 */}
        {IS_ANDROID_APP ? (
          <button onClick={() => void openExternal(downloadPage)} className={btnCls}>
            {t('about.openDownloadPage')}
          </button>
        ) : (
          <button onClick={copy} className={btnCls}>
            <Copy size={10} className="pointer-coarse:w-3.5 pointer-coarse:h-3.5" />
            {copied ? t('update.copied') : t('update.copyLink')}
          </button>
        )}
      </div>
      <p className={hintCls}>{t(IS_ANDROID_APP ? 'about.desktopHint' : 'about.mobileHint')}</p>
    </div>
  );
}
