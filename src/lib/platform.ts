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
  /* 远程文件 `hide-remote://<设备>/<相对路径>`：末段是逐段编码过的，解码一次取名字 */
  if (path.startsWith('hide-remote://')) {
    const tail = path.slice('hide-remote://'.length).split('/').pop() ?? '';
    try {
      return decodeURIComponent(tail) || path;
    } catch {
      return tail || path;
    }
  }
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

/**
 * 本地路径的所在目录（去掉末段文件名）；content:// 与无分隔符路径返回空串。
 * Windows 盘符根（C:\a.md → C:）与 Unix 根（/a.md → /）保留。
 */
export function dirNameOf(path: string): string {
  if (path.startsWith('content://')) return '';
  /* 远程路径按 `/` 分段（段内的 `/` 已被编成 %2F），去掉末段就是所在目录；
     只到设备名那一层时没有目录语义，与 content:// 同一处理 */
  if (path.startsWith('hide-remote://')) {
    const rest = path.slice('hide-remote://'.length);
    return rest.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (idx < 0) return '';
  return path.slice(0, idx);
}
