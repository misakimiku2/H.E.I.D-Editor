import { ShieldAlert, Smartphone } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { IS_ANDROID_APP } from '../lib/platform';
import { useLinkStatus } from '../hooks/useLinkStatus';

/**
 * 状态栏上的「手机可访问」常驻标记（v1.5 阶段 1 定稿第 1 条的硬要求：
 * 开启共享必须有一个**不只在设置页里**看得见的位置 —— 用户关掉设置窗口之后，
 * 这扇门仍然开着的这件事不能只留在记忆里）。
 *
 * 测试配对模式开着时整条标记转成警示色并换文案：那一档下「谁都能连、不用我点允许」，
 * 需要比「共享中」更高一级的存在感，也正是他一贯的口径 —— 便利换来的风险用可见状态补回来。
 *
 * 手机端不渲染：手机是那棵树的读方，它没暴露任何文件，占状态栏一格只会让人以为自己也开着共享。
 */
export function LinkShareChip({ dark }: { dark: boolean }) {
  const t = useT();
  const s = useLinkStatus();

  if (IS_ANDROID_APP || s.role !== 'server' || !s.listening) return null;

  const tip = [
    s.rootDisplay || t('link.shareScopeNone'),
    s.openShared > 0 ? t('link.openSharedFiles', { n: s.openShared }) : '',
    s.testPair ? t('link.chipTestTip') : '',
    s.firewallHint ? t('link.firewallHint') : '',
  ].filter(Boolean).join('\n');

  return (
    <span
      data-testid="heid-link-chip"
      title={tip}
      className={cn(
        'heid-link-chip shrink-0 flex items-center gap-1 font-medium',
        s.testPair ? 'text-amber-500' : 'text-emerald-500',
        dark && !s.testPair && 'text-emerald-400',
      )}
    >
      {s.testPair ? <ShieldAlert size={11} className="shrink-0" /> : <Smartphone size={11} className="shrink-0" />}
      <span className="truncate max-w-[220px]">{s.testPair ? t('link.chipTest') : t('link.chipSharing')}</span>
      {/* 「谁连着」也在这条上：只报设备名，具体共享了什么仍由 tooltip 与设置页说清 */}
      {s.connected && <span className="opacity-80">· {s.peerDevice || t('link.chipConnected')}</span>}
    </span>
  );
}
