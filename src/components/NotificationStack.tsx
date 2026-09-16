/**
 * 通用通知渲染宿主（lib/notifications 的唯一视图层）：
 * - 桌面固定在窗口左下角（状态栏上方）；窄屏（手机）移到顶部右侧，避让拇指工具栏；
 * - 毛玻璃卡片与应用弹窗同源视觉；自动消失计时在渲染层做（store 保持无定时器）；
 * - 纯展示组件，不持有通知状态（useSyncExternalStore 直连 store）。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Download, X } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  dismissNotification, listNotifications, subscribeNotifications,
  type AppNotification, type NotificationKind,
} from '../lib/notifications';

const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  info: Bell,
  success: CheckCircle2,
  error: AlertTriangle,
  update: Download,
};

const KIND_ACCENT: Record<NotificationKind, string> = {
  info: 'text-sky-500',
  success: 'text-emerald-500',
  error: 'text-red-500',
  update: 'text-blue-500',
};

/** 失败明细里展示短名（URL 最后一段，去查询参数），完整地址放悬停 title */
function failureLabel(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    return url;
  }
}

function NotificationCard({ notification, isDarkMode }: {
  notification: AppNotification;
  isDarkMode: boolean;
}) {
  const { kind, title, message, progress, failures, actions, onCardClick, closable = true, timeoutMs } = notification;
  const Icon = KIND_ICON[kind];

  /* 自动消失：条目对象身份变化（同 id 替换）时重置计时 */
  useEffect(() => {
    if (!timeoutMs || timeoutMs <= 0) return;
    const timer = setTimeout(() => dismissNotification(notification.id), timeoutMs);
    return () => clearTimeout(timer);
  }, [notification, timeoutMs]);

  return (
    <div
      onClick={onCardClick}
      className={cn(
        "pointer-events-auto w-72 max-w-[calc(100vw-1.5rem)] max-md:w-full rounded-xl border shadow-2xl backdrop-blur-md p-3",
        onCardClick && "cursor-pointer",
        isDarkMode ? "border-zinc-700/70 bg-zinc-800/80 text-zinc-100" : "border-zinc-200/80 bg-white/85 text-zinc-800",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon size={15} className={cn("mt-0.5 shrink-0", KIND_ACCENT[kind])} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold leading-5 break-words">{title}</p>
          {message && (
            <p className={cn(
              "mt-1 text-[11px] leading-relaxed break-words line-clamp-4",
              isDarkMode ? "text-zinc-400" : "text-zinc-500",
            )}>
              {message}
            </p>
          )}
          {progress && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className={cn("h-1 flex-1 rounded-full overflow-hidden", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")}>
                <div
                  className="h-full rounded-full bg-blue-500 transition-[width] duration-200"
                  style={{ width: progress.total > 0 ? `${Math.round((progress.done / progress.total) * 100)}%` : '0%' }}
                />
              </div>
              <span className={cn("text-[10px] tabular-nums shrink-0", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                {progress.done}/{progress.total}
              </span>
            </div>
          )}
          {failures && failures.length > 0 && (
            <div className={cn(
              "mt-1.5 flex flex-col gap-1 rounded-lg p-2 max-h-24 overflow-auto heid-scroll text-[10px] leading-4",
              isDarkMode ? "bg-zinc-900/60" : "bg-zinc-100/90",
            )}>
              {failures.map((f, i) => (
                <div key={i} className="flex items-baseline gap-1.5 min-w-0" title={`${f.url} —— ${f.reason}`}>
                  <span className="truncate min-w-0">{failureLabel(f.url)}</span>
                  <span className="shrink-0 text-red-400">{f.reason}</span>
                </div>
              ))}
            </div>
          )}
          {actions && actions.length > 0 && (
            <div className="mt-2 flex justify-end gap-1.5 flex-wrap">
              {actions.map(action => (
                <button
                  key={action.id}
                  onClick={e => { e.stopPropagation(); action.onSelect(); }}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors",
                    action.emphasis === 'plain'
                      ? isDarkMode
                        ? "border border-zinc-600 text-zinc-300 hover:bg-zinc-700"
                        : "border border-zinc-300 text-zinc-500 hover:bg-zinc-100"
                      : "text-white bg-blue-600 hover:bg-blue-500",
                  )}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {closable && (
          <button
            onClick={e => { e.stopPropagation(); dismissNotification(notification.id); }}
            className={cn(
              "shrink-0 p-0.5 rounded-md transition-colors",
              isDarkMode ? "text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300" : "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600",
            )}
            aria-label="close"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

export function NotificationStack({ isDarkMode }: { isDarkMode: boolean }) {
  const items = useSyncExternalStore(subscribeNotifications, listNotifications);
  if (items.length === 0) return null;
  return (
    /* 手机端顶部弹层避让 TopAppBar（safe-top），桌面悬浮在状态栏（1.5rem + safe-bottom）上方 */
    <div className="fixed z-[85] flex flex-col gap-2 pointer-events-none
      left-3 bottom-[calc(2rem+var(--heid-safe-bottom,env(safe-area-inset-bottom,0px)))]
      max-md:right-3 max-md:left-3 max-md:bottom-auto
      max-md:top-[calc(3.75rem+var(--heid-safe-top,env(safe-area-inset-top,0px)))]
      max-md:items-stretch md:items-start"
    >
      {items.map(item => (
        <NotificationCard key={item.id} notification={item} isDarkMode={isDarkMode} />
      ))}
    </div>
  );
}
