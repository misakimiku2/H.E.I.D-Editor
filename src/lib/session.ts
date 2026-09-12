/**
 * 会话持久化（仅 Tauri 桌面端使用）：
 * 记录上次会话的标签页列表与激活标签，重启时由 App 重建。
 * - file 标签：只存路径 + markdown 视图模式，恢复时重读磁盘（磁盘内容为准，恢复为干净状态）；
 *   脏的 file 标签同样只存路径——未保存内容由草稿（lib/drafts）按路径承载，恢复时叠加并标脏；
 * - virtual 标签：无路径的标签（welcome 示例页 / untitled），draft=false 表示内容可确定性重建；
 *   draft=true 表示退出时是脏标签，未保存内容在草稿里（lib/drafts 的 untitled:<title> 键），
 *   仅用于异常退出后的恢复；用户明确「不保存」退出时草稿与快照条目一并清除，标签不应"复活"。
 */

export type SessionMdView = 'edit' | 'split' | 'preview';

/** 一个可恢复标签页的持久化描述 */
export type SessionTab =
  | { kind: 'file'; path: string; mdView: SessionMdView }
  | { kind: 'virtual'; title: string; draft?: boolean };

export interface SessionState {
  tabs: SessionTab[];
  /** 激活标签的文件路径；null 表示激活的是无路径标签（恢复时回退 welcome / 最后一个） */
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
      const rec = t as Record<string, unknown>;
      if (rec.kind === 'virtual') {
        if (typeof rec.title === 'string' && rec.title.length > 0) {
          parsed.push({ kind: 'virtual', title: rec.title, draft: rec.draft === true ? true : undefined });
        }
        continue;
      }
      /* file 条目；兼容无 kind 的旧版快照（仅有 path + mdView） */
      if (rec.kind !== 'file' && rec.kind !== undefined) continue;
      if (typeof rec.path !== 'string' || rec.path.length === 0) continue;
      const mdView = MD_VIEWS.includes(rec.mdView as SessionMdView)
        ? (rec.mdView as SessionMdView)
        : 'edit';
      parsed.push({ kind: 'file', path: rec.path, mdView });
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
