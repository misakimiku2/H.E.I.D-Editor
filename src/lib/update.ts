/**
 * 更新检查纯逻辑：
 * - 桌面走 tauri-plugin-updater（签名校验 + 差量安装），本模块只提供版本比较、
 *   「忽略此版本」与发行说明的 localStorage 持久化；
 * - 安卓侧载无原生更新器：经既有 http_get 命令抓取 latest.json，比较版本后提示前往
 *   Releases 页面手动下载（roadmap v1.0 的「安卓只做版本检查提示」）。
 * 自动检查每次启动都执行（启动 4 秒后延迟，避开 I/O 高峰），无节流——
 * 节流曾导致发版后 24h 内启动的客户端完全收不到提示。
 */

export const RELEASES_PAGE = 'https://github.com/misakimiku2/H.E.I.D-Editor/releases/latest';

/** Gitee 镜像的下载页（国内直连可达）；与 LATEST_JSON_URLS 的第二条同源 */
export const MIRROR_RELEASES_PAGE = 'https://gitee.com/misakimiku2/heid-editor/releases';

/**
 * latest.json 的候选源，按顺序尝试、取第一个拿到的合法清单。
 * 桌面端由 tauri-plugin-updater 读 `tauri.conf.json` 的 `plugins.updater.endpoints`（同样是数组、
 * 按序回退），这里服务的是安卓侧载的版本检查与启动时的文档自愈补种。
 * 第二条是 Gitee 镜像：国内不挂代理到不了 github.com，只有 GitHub 一个源时桌面端会静默停在旧版。
 * 镜像挂在一个固定 tag（`mirror-latest`）的 release 上，因为 Gitee 没有 GitHub 那种
 * `releases/latest/download/...`「永远指向最新版」的路径；每次发版由 CI 删除重建，地址保持不变。
 * 镜像那份清单里的安装包地址已改写成 Gitee 直链（否则拿到清单仍回 GitHub 取包，等于只镜像了清单），
 * 生成与校验见 scripts/mirror-gitee.mjs。
 */
export const LATEST_JSON_URLS = [
  'https://github.com/misakimiku2/H.E.I.D-Editor/releases/latest/download/latest.json',
  'https://gitee.com/misakimiku2/heid-editor/releases/download/mirror-latest/latest.json',
];

/** 版本号兜底（浏览器模式无 getVersion API；与 package.json / tauri.conf.json 同步维护） */
export const FALLBACK_APP_VERSION = '1.4.1';

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

/** 自动检查发现新版本时是否应弹通知：未被忽略，或比已忽略版本更新 */
export function shouldNotifyUpdate(latestVersion: string, ignoredVersion: string | null): boolean {
  if (!ignoredVersion) return true;
  return isNewerVersion(latestVersion, ignoredVersion);
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

/** 所有候选源都没拿到合法清单（网络不可达 / 镜像下线 / 内容不合法） */
export class UpdateSourceUnavailableError extends Error {
  readonly kind = 'unreachable' as const;
  constructor(readonly attempts: { url: string; message: string }[]) {
    super('update-source-unavailable');
    this.name = 'UpdateSourceUnavailableError';
  }
}

/**
 * 取回某个源的 latest.json 文本。由各端注入（安卓/桌面走 `http_get` 命令），
 * 以便 fetchLatestJson 本身不依赖 Tauri、可单测。
 */
export type LatestJsonGetter = (url: string) => Promise<string>;

/** 取某个源的文本：Tauri 的 `http_get` 命令（原生请求，无 CORS、超时与体积上限齐备） */
export const tauriHttpGetText: LatestJsonGetter = async url => {
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<{ text: string }>('http_get', { url });
  return res.text;
};

/** 命中的清单源 + 其地址，供调用方决定「前往下载」该开哪个页面 */
export type FetchedRelease = LatestReleaseInfo & { sourceUrl: string };

/**
 * 依次尝试候选源，取回并解析 latest.json：单个源请求失败或内容不合法都算该源不可用，
 * 继续往下试；全部落空抛 UpdateSourceUnavailableError（带每个源的失败原因，便于排查）。
 */
export async function fetchLatestJson(
  get: LatestJsonGetter,
  urls: string[] = LATEST_JSON_URLS,
): Promise<FetchedRelease> {
  const attempts: { url: string; message: string }[] = [];
  for (const url of urls) {
    try {
      const info = parseLatestJson(await get(url));
      if (info) return { ...info, sourceUrl: url };
      attempts.push({ url, message: 'invalid latest.json' });
    } catch (e) {
      attempts.push({ url, message: e instanceof Error ? e.message : String(e) });
    }
  }
  throw new UpdateSourceUnavailableError(attempts);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 检查更新命中的是哪个源，「前往下载 / 复制下载链接」就用那个源的页面：
 * 走镜像说明 GitHub 到不了，再给 GitHub 地址等于没给。
 */
export function downloadPageFor(sourceUrl: string | null): string {
  if (sourceUrl && hostOf(sourceUrl) === hostOf(MIRROR_RELEASES_PAGE)) return MIRROR_RELEASES_PAGE;
  return RELEASES_PAGE;
}

/* ---------- 「忽略此版本」持久化 ---------- */

export const IGNORED_VERSION_KEY = 'heid-update-ignored';

/** 用户忽略的版本号；存储缺失/损坏返回 null */
export function getIgnoredVersion(storage: Storage | null = defaultStorage()): string | null {
  const raw = safeGet(storage, IGNORED_VERSION_KEY);
  return raw && raw.length > 0 ? raw : null;
}

/** 记录「忽略此版本」；失败静默 */
export function setIgnoredVersion(version: string, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(IGNORED_VERSION_KEY, version);
  } catch { /* 忽略持久化失败 */ }
}

/* ---------- 发行说明持久化（重启后展示 + 关于里重看 / 回看过往版本） ---------- */

export interface StoredReleaseNotes {
  version: string;
  notes: string;
  /** 该版本的文档是否已在更新重启后自动打开过（每个版本只自动展示一次） */
  shown: boolean;
}

export const RELEASE_NOTES_KEY = 'heid-update-release-notes';

/** 历史更新文档最多保留份数（含最新；超出丢弃最旧） */
export const MAX_RELEASE_NOTES = 20;

/**
 * 读取已保存的更新文档列表（最新在前）。
 * 兼容旧版单对象格式（自动包装为单项列表）；损坏条目逐个跳过，整体损坏返回空列表。
 */
export function loadReleaseNotesList(storage: Storage | null = defaultStorage()): StoredReleaseNotes[] {
  const raw = safeGet(storage, RELEASE_NOTES_KEY);
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    const items: unknown[] = Array.isArray(data) ? data : [data];
    const list: StoredReleaseNotes[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.version !== 'string' || rec.version.length === 0) continue;
      list.push({
        version: rec.version,
        notes: typeof rec.notes === 'string' ? rec.notes : '',
        shown: rec.shown === true,
      });
    }
    return list;
  } catch {
    return [];
  }
}

function saveReleaseNotesList(list: StoredReleaseNotes[], storage: Storage | null): void {
  try {
    storage?.setItem(RELEASE_NOTES_KEY, JSON.stringify(list));
  } catch { /* 忽略持久化失败 */ }
}

/**
 * 保存一份更新文档（发现新版本 / 开始安装时写入）：
 * 同版本重复保存视为替换并重置 shown（等待更新重启后展示）；最新插到列表头部；
 * 超出容量丢弃最旧。
 */
export function saveReleaseNotes(
  info: { version: string; notes?: string },
  storage: Storage | null = defaultStorage(),
): void {
  const list = loadReleaseNotesList(storage);
  const rest = list.filter(n => n.version !== info.version);
  const next = [{ version: info.version, notes: info.notes ?? '', shown: false }, ...rest];
  saveReleaseNotesList(next.slice(0, MAX_RELEASE_NOTES), storage);
}

/**
 * 更新重启后的开机展示：列表中存在「当前版本」且未展示过的文档时返回之并标记已展示
 * （每个版本只自动打开一次；关闭与否都不影响下次启动）；其余情况返回 null。
 */
export function consumeStartupReleaseNotes(
  currentVersion: string,
  storage: Storage | null = defaultStorage(),
): StoredReleaseNotes | null {
  const list = loadReleaseNotesList(storage);
  const index = list.findIndex(n => n.version === currentVersion && !n.shown);
  if (index < 0) return null;
  const found = list[index];
  const next = list.slice();
  next[index] = { ...found, shown: true };
  saveReleaseNotesList(next, storage);
  return found;
}

/**
 * 自愈补种：当前版本在文档列表中缺失、而 latest.json 的 version 恰为当前版本时，
 * 把其说明补种为未展示条目（下次开机展示 + 「关于 → 更新文档」入口出现）。
 *
 * 背景：发行说明的「写入」随 v1.3.0 上线，v1.2 及更早客户端点更新时不落盘，
 * 直升 v1.3 的用户没有任何条目（自动展示与入口都不存在）。补种在启动时静默进行；
 * latest.json 指向更新版本（有新版可用）或条目已存在时不动作，交给常规流程。
 * 返回是否发生了补种。
 */
export function maybeSeedCurrentVersionNotes(
  currentVersion: string,
  info: LatestReleaseInfo,
  storage: Storage | null = defaultStorage(),
): boolean {
  if (info.version !== currentVersion) return false;
  if (loadReleaseNotesList(storage).some(n => n.version === currentVersion)) return false;
  saveReleaseNotes({ version: currentVersion, notes: info.notes }, storage);
  return true;
}

/**
 * 通知卡片用的说明摘要：压缩空白后截断（Markdown 源文压成一行短句）。
 * 空串返回 null（卡片不渲染说明段）。
 */
export function summarizeNotes(notes: string | undefined, max = 160): string | null {
  if (!notes) return null;
  const flat = notes.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function safeGet(storage: Storage | null, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}
