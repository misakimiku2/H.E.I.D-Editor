/**
 * 物理键盘接入检测（安卓 App）：MainActivity 经 InputManager 枚举非虚拟键盘设备
 * （外置键盘/键盘盖；软键盘是 isVirtual 设备，天然被排除），接入状态变化以
 * heid-hwkb 事件推送，初值由 HeidBridge.hwKb() 同步补读——事件可能在页面 JS
 * 就绪前已发过而丢失。桌面/浏览器无此桥，恒返回 false（提示可见性由调用方
 * 的 IS_TOUCH_PRIMARY 分支兜住，不受影响）。
 */
import { useEffect, useState } from 'react';
import { IS_TOUCH_PRIMARY } from '../lib/platform';

declare global {
  interface Window {
    HeidBridge?: { hwKb?: () => boolean };
  }
}

/** 是否接有物理键盘 */
export function useHardwareKeyboard(): boolean {
  const [has, setHas] = useState(() => !!window.HeidBridge?.hwKb?.());
  useEffect(() => {
    const on = (e: Event) => setHas(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener('heid-hwkb', on);
    return () => window.removeEventListener('heid-hwkb', on);
  }, []);
  return has;
}

/**
 * 快捷键提示可见性：鼠标为主（桌面）恒显示；触屏为主（平板）仅在接入物理
 * 键盘后显示——纯触屏没有可按的键，提示是噪音。手机布局本就没有这些提示，
 * 不受影响。
 */
export function useShowKbdHints(): boolean {
  const hw = useHardwareKeyboard();
  return !IS_TOUCH_PRIMARY || hw;
}
