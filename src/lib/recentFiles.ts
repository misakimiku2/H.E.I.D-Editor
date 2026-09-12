/**
 * 最近打开文件（纯函数 + localStorage 持久化）：
 * 菜单「最近打开」数据源；安卓 content URI 与桌面路径同构存储。
 */

export interface RecentFile {
  path: string;
  name: string;
  at: number;
}

export const MAX_RECENT_FILES = 15;
const STORAGE_KEY = 'heid-recent-files';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 读取最近列表（旧的损坏数据视为空列表）；storage 不可用时返回空 */
export function listRecentFiles(storage: Storage | null = defaultStorage()): RecentFile[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const items: RecentFile[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.path !== 'string' || rec.path.length === 0) continue;
      items.push({
        path: rec.path,
        name: typeof rec.name === 'string' && rec.name ? rec.name : rec.path,
        at: typeof rec.at === 'number' ? rec.at : 0,
      });
    }
    return items;
  } catch {
    return [];
  }
}

/** 记录一次打开：同路径去重移到最前，超出上限丢弃最旧 */
export function addRecentFile(
  path: string,
  name: string,
  storage: Storage | null = defaultStorage(),
): RecentFile[] {
  const rest = listRecentFiles(storage).filter(f => f.path !== path);
  const next = [{ path, name, at: Date.now() }, ...rest].slice(0, MAX_RECENT_FILES);
  save(storage, next);
  return next;
}

/** 清空最近列表 */
export function clearRecentFiles(storage: Storage | null = defaultStorage()): RecentFile[] {
  save(storage, []);
  return [];
}

function save(storage: Storage | null, items: RecentFile[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* 持久化失败不影响功能 */
  }
}
