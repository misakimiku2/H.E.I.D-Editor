import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { IS_ANDROID_APP } from './lib/platform';

/* 安卓端安全区：MainActivity 通过 HeidInsets 桥提供状态栏/手势条高度，
   这里启动时拉取一次，后续由 heid-insets 事件跟随旋转等变化更新 */
if (IS_ANDROID_APP) {
  const apply = (top: number, bottom: number) => {
    const root = document.documentElement;
    root.style.setProperty('--heid-safe-top', `${Number.isFinite(top) ? top : 0}px`);
    root.style.setProperty('--heid-safe-bottom', `${Number.isFinite(bottom) ? bottom : 0}px`);
  };
  const bridge = (window as any).HeidBridge;
  if (bridge) {
    try {
      apply(bridge.top(), bridge.bottom());
    } catch {
      /* 桥不可用时保持 CSS 回退值 */
    }
  }
  window.addEventListener('heid-insets', (e) => {
    const d = (e as CustomEvent<{ top?: number; bottom?: number }>).detail;
    apply(d?.top ?? 0, d?.bottom ?? 0);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
