/**
 * 网址导入第二层兜底：静态抓取结果过薄（SPA 空壳 / 前端渲染站点）时，
 * 用隐藏 WebView 渲染页面后取回渲染完成的 HTML，交回同一转换管线。
 * 桌面走 Tauri render_page 命令（Rust 侧隐藏窗口 + 页面内 settle 检测）；
 * 安卓走 HeidBridge.renderPage（离屏 WebView，结果经 heid-render 事件回传）。
 * 任何失败都静默返回 null——调用方回退静态结果，导入永不因兜底失败而中断。
 */

import { IS_ANDROID_APP } from './platform';

/** 平台渲染结果 */
export interface RenderedPage {
  html: string;
  finalUrl: string;
  /** 渲染页面用户实际可见的文本（body.innerText），供覆盖率核算 */
  visibleText?: string;
}

export interface RenderFetchDeps {
  /** 平台分流注入点：默认按运行环境选择 Tauri / 安卓桥 */
  fetchVia?: (url: string, timeoutMs: number) => Promise<RenderedPage | null>;
}

/**
 * 静态 HTML 薄度启发式：剥除 script/style 后的可见文本是否少到可疑。
 * 阈值取 1500 字符：正常文章页远高于此；SPA 挂载空壳通常低于 500。
 */
export function looksThin(html: string): boolean {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '');
  return text.length < 1500;
}

/** 默认平台分流：桌面 Tauri 命令 / 安卓离屏 WebView 桥 */
const defaultFetchVia = async (url: string, timeoutMs: number): Promise<RenderedPage | null> => {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  if (IS_ANDROID_APP) return renderViaAndroid(url, timeoutMs);
  const { invoke } = await import('@tauri-apps/api/core');
  const [finalUrl, html, visibleText] = await invoke<[string, string, string]>('render_page', { url });
  return html ? { html, finalUrl: finalUrl || url, visibleText } : null;
};

/** 安卓：请求 HeidBridge 离屏渲染，结果经 heid-render 事件回传 */
function renderViaAndroid(url: string, timeoutMs: number): Promise<RenderedPage | null> {
  return new Promise(resolve => {
    const bridge = (window as unknown as {
      HeidBridge?: { renderPage?: (u: string) => void };
    }).HeidBridge;
    if (!bridge?.renderPage) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: RenderedPage | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('heid-render', onRender);
      window.clearTimeout(timer);
      resolve(value);
    };
    const onRender = (e: Event) => {
      const detail = (e as CustomEvent<{ html?: string; url?: string; text?: string }>).detail;
      finish(detail?.html ? { html: detail.html, finalUrl: detail.url || url, visibleText: detail.text } : null);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('heid-render', onRender);
    bridge.renderPage(url);
  });
}

/** 渲染指定 URL；失败或平台不支持时返回 null（调用方回退静态结果） */
export async function renderFetch(
  url: string,
  deps?: RenderFetchDeps,
  timeoutMs = 45000,
): Promise<RenderedPage | null> {
  const fetchVia = deps?.fetchVia ?? defaultFetchVia;
  try {
    return await fetchVia(url, timeoutMs);
  } catch (e) {
    console.warn('[renderFetch] 渲染兜底失败，回退静态结果:', e);
    return null;
  }
}
