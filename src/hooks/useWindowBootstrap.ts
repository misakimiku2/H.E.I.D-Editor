/**
 * 窗口启动载荷（仅 Tauri）：挂载后向 Rust 取一次本窗口的启动载荷。
 * - main / 浏览器：无载荷（ready 即真）；
 * - 拖出脱离的子窗口：kind='tab'，装载传输标签；
 * - 会话恢复拉起的子窗口：kind='session'，按整份快照重建。
 * 探测以模块级 Promise 共享：StrictMode 开发模式 effect 双执行时，
 * 第一次（会被 cleanup 丢弃）已经把「取后即清」的载荷消费掉，
 * 第二次必须复用同一 Promise 才能拿到载荷，否则永远为 null。
 */
import { useEffect, useState } from 'react';
import { isTauri } from '../lib/fileIO';
import { takeWindowBootstrap } from '../lib/windows';
import type { WindowBootstrapPayload } from '../lib/tabTransfer';

export interface WindowBootstrap {
  payload: WindowBootstrapPayload | null;
  /** 载荷探测完成（主窗口立即就绪，子窗口等一次 IPC） */
  ready: boolean;
}

let bootstrapPromise: Promise<WindowBootstrapPayload | null> | null = null;

export function useWindowBootstrap(): WindowBootstrap {
  const [state, setState] = useState<WindowBootstrap>(() => ({ payload: null, ready: !isTauri }));

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    bootstrapPromise ??= takeWindowBootstrap().catch(e => {
      console.error('[bootstrap] 启动载荷探测失败:', e);
      return null;
    });
    void bootstrapPromise.then(payload => {
      if (!disposed) setState({ payload, ready: true });
    });
    return () => { disposed = true; };
  }, []);

  return state;
}
