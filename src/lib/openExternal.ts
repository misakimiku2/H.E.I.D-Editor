/**
 * 外部链接交给系统打开，绝不在应用 WebView 内导航：
 * 安卓走 HeidBridge（Intent ACTION_VIEW），桌面 Tauri 走 Rust open_external
 * 命令（explorer / open / xdg-open），纯浏览器环境开新标签页。
 * 应用内一旦真实导航到外部网页，整个编辑器会被页面替换、会话被重载——
 * 这是「网址导入后点击预览内链接把应用变成网页」事故的根因，此处统一收口。
 */

import { IS_ANDROID_APP } from './platform';

/** 仅 http/https 允许交给系统；javascript: / data: / 相对路径一律不放行 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export async function openExternal(url: string): Promise<void> {
  if (!isHttpUrl(url)) return;
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      if (IS_ANDROID_APP) {
        const bridge = (window as unknown as { HeidBridge?: { openUrl?: (u: string) => void } }).HeidBridge;
        if (bridge?.openUrl) {
          bridge.openUrl(url);
          return;
        }
      } else {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_external', { url });
        return;
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    console.warn('[openExternal] 打开外部链接失败:', e);
  }
}
