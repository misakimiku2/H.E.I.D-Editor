/**
 * 应用主题（浅色 / 深色 / 跟随系统）：
 * - 安卓 WebView 的 prefers-color-scheme 不随运行时系统主题更新，改走 HeidBridge（isSystemDark / heid-sysdark 事件）；
 * - 安卓无应用内主题切换（键盘等系统界面不可控），始终跟随系统；
 * - 原生滚动条与表单控件经根元素 color-scheme 跟随主题。
 */
import { useEffect, useState } from 'react';
import { IS_ANDROID_APP } from '../lib/platform';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'heid-theme-mode';

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (IS_ANDROID_APP) return 'system'; /* 安卓无应用内主题：始终跟随系统（键盘等系统界面不可控） */
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState(
    () => IS_ANDROID_APP
      ? !!(window as any).HeidBridge?.isSystemDark?.()
      : window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  /* 系统主题变化监听（跟随系统模式使用） */
  useEffect(() => {
    if (IS_ANDROID_APP) {
      const onSysDark = (e: Event) => {
        const d = (e as CustomEvent<{ dark: boolean }>).detail;
        if (d && typeof d.dark === 'boolean') setSystemDark(d.dark);
      };
      window.addEventListener('heid-sysdark', onSysDark);
      return () => window.removeEventListener('heid-sysdark', onSysDark);
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, themeMode);
  }, [themeMode]);

  const isDarkMode = themeMode === 'dark' || (themeMode === 'system' && systemDark);

  /* 安卓：系统状态栏/导航栏图标外观跟随应用主题（浅色主题=深色图标，反之亦然） */
  useEffect(() => {
    if (!IS_ANDROID_APP) return;
    try { (window as any).HeidBridge?.setDarkTheme?.(isDarkMode); } catch { /* 桥不可用时忽略 */ }
  }, [isDarkMode]);

  /* 原生滚动条与表单控件跟随主题：Chromium 依据根元素的 color-scheme 渲染深色滚动条 */
  useEffect(() => {
    document.documentElement.style.colorScheme = isDarkMode ? 'dark' : 'light';
  }, [isDarkMode]);

  return { themeMode, setThemeMode, isDarkMode };
}
