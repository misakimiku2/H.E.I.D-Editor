/**
 * 会话持久化（仅 Tauri 桌面端使用）：
 * 记录上次打开的真实文件标签（路径 + markdown 视图模式）与激活标签路径，
 * 重启时由 App 按路径重读磁盘恢复（磁盘内容为准，恢复为干净状态）。
 * 无路径的标签页（welcome / untitled）不持久化——与
 * 「退出时未保存内容经确认即丢弃」的语义保持一致。
 */

export type SessionMdView = 'edit' | 'split' | 'preview';

/** 一个可恢复标签页的最小持久化信息（标题 / 语言 / 内容从磁盘重新推导） */
export interface SessionTab {
  path: string;
  mdView: SessionMdView;
}

export interface SessionState {
  tabs: SessionTab[];
  /** 激活标签页的路径；null 表示激活的是无路径标签（恢复时回退到最后一个） */
  activePath: string | null;
}

const STORAGE_KEY = 'heid-session';
const MD_VIEWS: SessionMdView[] = ['edit', 'split', 'preview'];

/* localStorage 在隐私模式 / 禁用 Cookie 下访问可能抛错，统一收敛为 null */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 读取上次会话；不存在或结构不合法时返回 null（非法条目逐条丢弃） */
export function loadSessionState(storage: Storage | null = defaultStorage()): SessionState | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const { tabs, activePath } = data as Record<string, unknown>;
    if (!Array.isArray(tabs)) return null;
    const parsed: SessionTab[] = [];
    for (const t of tabs) {
      if (!t || typeof t !== 'object') continue;
      const { path, mdView } = t as Record<string, unknown>;
      if (typeof path !== 'string' || path.length === 0) continue;
      parsed.push({
        path,
        mdView: MD_VIEWS.includes(mdView as SessionMdView) ? (mdView as SessionMdView) : 'edit',
      });
    }
    return {
      tabs: parsed,
      activePath: typeof activePath === 'string' && activePath.length > 0 ? activePath : null,
    };
  } catch {
    return null;
  }
}

/** 保存当前会话；storage 不可用时静默忽略（持久化失败不影响编辑功能） */
export function saveSessionState(state: SessionState, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[session] 保存会话失败:', e);
  }
}
