/**
 * 平台与形态检测：安卓 App 与桌面/浏览器共用一套前端，
 * 移动端的布局与交互分支统一收敛到这里，桌面行为不受影响。
 */

export const IS_ANDROID_APP: boolean =
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in window &&
  /Android/i.test(window.navigator.userAgent);

/** 触控为主的设备（无悬停能力）；平板可能仍接物理键盘 */
export const IS_TOUCH_PRIMARY: boolean =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

/** 手机 / 平板布局分界（CSS px） */
export const NARROW_QUERY = '(max-width: 767.98px)';

/**
 * 从路径或 Android content:// URI 推导显示文件名。
 * 例：content://com.android.../document/primary%3ADownload%2Fnotes.md → notes.md
 */
export function displayNameFromPath(path: string): string {
  if (path.startsWith('content://')) {
    let seg = path.slice('content://'.length);
    const docIdx = seg.indexOf('/document/');
    if (docIdx >= 0) {
      seg = seg.slice(docIdx + '/document/'.length);
    } else {
      const sIdx = seg.indexOf('/');
      if (sIdx >= 0) seg = seg.slice(sIdx + 1);
    }
    try {
      seg = decodeURIComponent(seg);
    } catch {
      /* 编码异常时按原文处理 */
    }
    const tail = seg.split(/[/:]/).filter(Boolean).pop();
    return tail || path;
  }
  return path.split(/[\\/]/).pop() || path;
}
