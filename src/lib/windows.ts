/**
 * 多窗口 IPC 门面（仅 Tauri 桌面有意义）：脱离成窗、跨窗口标签传输、光标命中。
 * 全部动态导入 + isTauri 守卫，非 Tauri 环境返回安全缺省，调用方无需判环境。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from './fileIO';
import type { WindowBootstrapPayload } from './tabTransfer';

/** 当前窗口 label（main / win-N）；非 Tauri 返回 'main'，会话键逻辑无需分支 */
export function currentWindowLabel(): string {
  if (!isTauri) return 'main';
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 释放点信息:前端内容区坐标 + 抓取点在标签内的偏移,后端换算全局屏幕坐标定位新窗口。
    字段名与 Rust DropPoint 的 serde camelCase 对齐(grabDx/grabDy,非 grabDX) */
export interface WindowDropPoint {
  clientX: number;
  clientY: number;
  grabDx: number;
  grabDy: number;
}

/** 新建文档窗口（载荷：单标签传输或整份会话快照），返回新窗口 label；失败返回 null。
    drop 传入释放点时,新窗口定位到鼠标释放处（并夹紧到显示器内） */
export async function createDocumentWindow(source: string, payload: WindowBootstrapPayload, drop?: WindowDropPoint): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return await invoke<string>('create_document_window', { source, payload, drop: drop ?? null });
  } catch (e) {
    console.error('[windows] 创建文档窗口失败:', e);
    return null;
  }
}

/** 新窗口挂载后取走自己的启动载荷（无载荷 = 主窗口/浏览器） */
export async function takeWindowBootstrap(): Promise<WindowBootstrapPayload | null> {
  if (!isTauri) return null;
  try {
    return await invoke<WindowBootstrapPayload | null>('take_window_bootstrap');
  } catch (e) {
    console.error('[windows] 取启动载荷失败:', e);
    return null;
  }
}

export interface CursorHit {
  label: string;
  x: number;
  y: number;
}

/** 全局光标命中测试（含本窗口，调用方按 label 过滤）；不在任何窗口上返回 null */
export async function windowUnderCursor(): Promise<CursorHit | null> {
  if (!isTauri) return null;
  try {
    return await invoke<CursorHit | null>('window_under_cursor');
  } catch {
    return null;
  }
}

/** 向指定窗口转发标签协议事件（Rust 白名单校验）；失败返回 false */
export async function sendToWindow(label: string, event: string, payload: unknown): Promise<boolean> {
  if (!isTauri) return false;
  try {
    await invoke('send_to_window', { label, event, payload });
    return true;
  } catch (e) {
    console.error('[windows] 转发事件失败:', event, e);
    return false;
  }
}

/** 当前存活的窗口数（含本窗口） */
export async function windowCount(): Promise<number> {
  if (!isTauri) return 1;
  try {
    return await invoke<number>('window_count');
  } catch {
    return 1;
  }
}

/** 监听发往本窗口的标签协议事件，返回取消监听函数 */
export async function listenTabEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen<T>(event, (e) => handler(e.payload));
    return un;
  } catch (e) {
    console.error('[windows] 监听事件失败:', event, e);
    return () => {};
  }
}
