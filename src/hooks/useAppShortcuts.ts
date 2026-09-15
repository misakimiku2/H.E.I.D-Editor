/**
 * 全局快捷键（Ctrl+S/O/N/Z/Y/F/H/G/W、Ctrl+Tab 切换标签）。
 * effect 刻意不带依赖数组：每次渲染重新注册，保证闭包里始终是最新回调；
 * 编辑器 keymap 已接管的按键（已 preventDefault，但事件仍会冒泡到 window）不再重复处理。
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

export interface ShortcutHandlers {
  save: () => void;
  saveAs: () => void;
  openFile: () => void;
  newFile: () => void;
  undo: () => void;
  redo: () => void;
  openFind: (showReplace?: boolean, goto?: boolean) => void;
  closeActiveTab: () => void;
  switchTab: (delta: 1 | -1) => void;
  hasTab: () => boolean;
  /** 打印当前标签页（Ctrl+P；安卓无打印对话框，调用方不注册） */
  print?: () => void;
}

export function useAppShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault();
        handlers.saveAs();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        handlers.save();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        handlers.openFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handlers.newFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handlers.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        handlers.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        if (handlers.hasTab()) { e.preventDefault(); handlers.openFind(false, false); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        if (handlers.hasTab()) { e.preventDefault(); handlers.openFind(true, false); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        if (handlers.hasTab()) { e.preventDefault(); handlers.openFind(false, true); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        /* 浏览器里 Ctrl+W 归浏览器管无法拦截；打包后的应用内生效 */
        e.preventDefault();
        handlers.closeActiveTab();
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        handlers.switchTab(e.shiftKey ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && handlers.print) {
        e.preventDefault();
        handlers.print();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
}
