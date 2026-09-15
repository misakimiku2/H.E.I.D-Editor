/**
 * 更新检查纯逻辑：
 * - 桌面走 tauri-plugin-updater（签名校验 + 差量安装），本模块只提供版本比较与启动节流；
 * - 安卓侧载无原生更新器：经既有 http_get 命令抓取 latest.json，比较版本后提示前往
 *   Releases 页面手动下载（roadmap v1.0 的「安卓只做版本检查提示」）。
 */

export const RELEASES_PAGE = 'https://github.com/misakimiku2/H.E.I.D-Editor/releases/latest';
export const LATEST_JSON_URL =
  'https://github.com/misakimiku2/H.E.I.D-Editor/releases/latest/download/latest.json';

/** 版本号兜底（浏览器模式无 getVersion API；与 package.json / tauri.conf.json 同步维护） */
export const FALLBACK_APP_VERSION = '1.1.0';

/** 自动检查间隔：24h（localStorage 记录上次检查时间） */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const LAST_CHECK_KEY = 'heid-update-last-check';

export interface LatestReleaseInfo {
  version: string;
  notes?: string;
}

/**
 * 语义化版本比较（updater / npm 常见形式）：主.次.修订 号逐段数值比较，
 * 忽略前缀 v；带预发布标识（-alpha.1 等）的版本视为小于同号正式版。
 * 返回正数表示 a 更新，负数表示 b 更新，0 相等。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const clean = v.trim().replace(/^v/i, '');
    const [core, pre] = clean.split('-', 2);
    const nums = core.split('.').map(n => {
      const parsed = parseInt(n, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { nums, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  /* 同号：正式版 > 预发布 */
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/** candidate 是否比 current 更新（同版本 / 回退均返回 false） */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * 解析 updater 的 latest.json（静态 JSON 格式）：
 * { version, notes?, pub_date?, platforms: { "windows-x86_64": { signature, url } } }
 * 结构不合法返回 null（调用方静默跳过）。
 */
export function parseLatestJson(raw: string): LatestReleaseInfo | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const version = (data as Record<string, unknown>).version;
    if (typeof version !== 'string' || version.length === 0) return null;
    const notes = (data as Record<string, unknown>).notes;
    return { version, notes: typeof notes === 'string' ? notes : undefined };
  } catch {
    return null;
  }
}

/** 距上次检查已超过自动检查间隔（storage 缺失 / 损坏视为从未检查） */
export function shouldAutoCheck(now: number, storage: Storage | null = defaultStorage()): boolean {
  const raw = storage ? safeGet(storage, LAST_CHECK_KEY) : null;
  if (!raw) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true;
  return now - last >= AUTO_CHECK_INTERVAL_MS;
}

/** 记录本次检查时间（失败静默） */
export function markAutoChecked(now: number, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(LAST_CHECK_KEY, String(now));
  } catch { /* 忽略持久化失败 */ }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
