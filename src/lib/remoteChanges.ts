/**
 * 桌面推来的文件变更（v1.5 阶段 4）：载荷形状、订阅入口，与「这一帧跟我有什么关系」的判据。
 *
 * 单独成文件的两条理由：判据被两处共用（文件树要重列哪几层、打开着的标签要不要去核对），
 * 而这两处分属不同组件；协议形状只写一遍，改的时候只有一处会漏。
 *
 * 形状与 `src-tauri/src/link/watch.rs` 的 `FsPayload` 一一对应：
 * `{"dirs":["","src/components"]}` —— `/` 分隔、**相对共享根**，`""` 就是共享根自己。
 * 载荷是空的（退化帧）不等于「没有变化」，而是「桌面那一帧装不下」：
 * 此时手机端要把手里所有可见的东西都重取一遍，判据统一收在 [`ALL`] 这一个值上。
 */
import { subscribeRemoteEvents } from './link';

/** 与 Rust `link::EVENT_TABS` 同名 */
export const EVENT_TABS = 'tabs';
/** 与 Rust `link::EVENT_FS` 同名 */
export const EVENT_FS = 'fs';
/** 与 Rust `link::EVENT_ROOT` 同名 */
export const EVENT_ROOT = 'rootChanged';

/** 一帧 `fs` 的内容：`ALL` = 整棵树都算变了；数组 = 变了这些目录（相对共享根） */
export type FsDirs = 'all' | string[];

/** 退化帧的判据。只在解析这一处产生，别处不再各写一份空串比较 */
export const ALL: FsDirs = 'all';

/**
 * 解析 `fs` 推送的载荷。三种来源都归到 [`FsDirs`]：
 * - 空串 / 非 JSON / 形状不对 → `ALL`：**宁可多重取一次，也不能把"变了"读成"没变"**；
 * - `{"dirs":[…]}` → 那份目录集合（原样保留 `""`，它就是根）。
 */
export function parseFsDirs(data: string): FsDirs {
  if (!data) return ALL;
  try {
    const v = JSON.parse(data) as { dirs?: unknown };
    if (!Array.isArray(v?.dirs)) return ALL;
    const dirs = v.dirs.filter((d): d is string => typeof d === 'string');
    // 一条都没剩下等于不知道变了什么，按整棵树处理
    return dirs.length ? dirs : ALL;
  } catch {
    return ALL;
  }
}

/** 这个文件所在的目录（相对共享根）。根下的文件其父目录就是 `""` */
export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** 一帧变更是否可能动到这个文件 —— 动没动最终由内容哈希定，这里只决定"要不要去核对" */
export function fileTouched(rel: string, dirs: FsDirs): boolean {
  return dirs === ALL || dirs.includes(parentRel(rel));
}

/**
 * 一帧变更是否落在树上某个已加载目录里（落了就该重列它）。
 *
 * 两边都是相对共享根的 `/` 分隔路径，所以这是**同一集合的求交**而不是前缀匹配：
 * 帧里的 `src` 说的是「`src` 这一层的内容变了」，树上要重列的也正是 `src` 那个节点。
 * 新出现的目录不用单独处理 —— 它还没被加载，重列它的父目录自然就把它带出来。
 */
export function dirTouched(dirRel: string, dirs: FsDirs): boolean {
  return dirs === ALL || dirs.includes(dirRel);
}

/**
 * 手机上的树挂在共享根的 `mountRel` 这一层；帧里出现了它的**某一层上级**时，
 * 说明这个挂载点本身可能被改名或删掉了 —— 这时该重列的是树根那一行，
 * 而不是继续显示一份早已不存在的内容（子节点自己不会出现在帧里，等是等不到的）。
 *
 * 挂载点就是共享根（`''`）时永远返回 false —— 它上面没有层了，那种情况由 [`dirTouched`]
 * 里的 `""` 那一条覆盖。
 */
export function mountPointTouched(mountRel: string, dirs: FsDirs): boolean {
  if (dirs === ALL) return true;
  // 挂载点就是共享根时它上面没有层了，这一路由 dirTouched 里 `""` 那一条负责
  if (!mountRel) return false;
  const segs = mountRel.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (dirs.includes(segs.slice(0, i).join('/'))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ 订阅入口 */

/**
 * 订一路桌面的文件变更推送。两件事分开回调，因为手机端的动作完全不同：
 * `fs` 只重列受影响的几层，`rootChanged` 要把手里的树整个丢掉重来。
 *
 * 非 Tauri 环境（纯前端跑 vitest、浏览器版）没有这条链路，直接返回空操作 ——
 * 与 `link.subscribeRemoteEvents` 同一口径，调用方不必自己判平台。
 */
export function subscribeFileChanges(handlers: {
  /** 一帧变更到达：`ALL` 表示桌面那一帧装不下，把手里可见的都重取一遍 */
  onDirs: (dirs: FsDirs) => void;
  /** 桌面换了共享根 */
  onRootChanged?: () => void;
}): () => void {
  const { onDirs, onRootChanged } = handlers;
  return subscribeRemoteEvents((type, data) => {
    if (type === EVENT_FS) onDirs(parseFsDirs(data));
    else if (type === EVENT_ROOT) onRootChanged?.();
  });
}
