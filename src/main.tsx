import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { IS_ANDROID_APP } from './lib/platform';

/* 安卓端安全区与键盘高度：MainActivity 通过 HeidBridge/heid-insets 事件提供。
   启动时拉取一次，后续由 heid-insets 事件跟随旋转/键盘弹出收起更新 */
if (IS_ANDROID_APP) {
  const apply = (top: number, bottom: number, kb: number) => {
    const root = document.documentElement;
    const n = (v: unknown) => (Number.isFinite(v) ? (v as number) : 0);
    root.style.setProperty('--heid-safe-top', `${n(top)}px`);
    root.style.setProperty('--heid-safe-bottom', `${n(bottom)}px`);
    /* 键盘高度：App 根容器据此收缩布局，底部工具栏/信息栏始终浮在键盘上方 */
    root.style.setProperty('--heid-kb', `${n(kb)}px`);
  };
  const bridge = (window as any).HeidBridge;
  if (bridge) {
    try {
      apply(bridge.top(), bridge.bottom(), bridge.kb ? bridge.kb() : 0);
    } catch {
      /* 桥不可用时保持 CSS 回退值 */
    }
  }
  window.addEventListener('heid-insets', (e) => {
    const d = (e as CustomEvent<{ top?: number; bottom?: number; kb?: number }>).detail;
    apply(d?.top ?? 0, d?.bottom ?? 0, d?.kb ?? 0);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
