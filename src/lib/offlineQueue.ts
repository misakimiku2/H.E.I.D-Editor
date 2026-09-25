/**
 * 离线写队列（v1.5 阶段 5）：断连期间的保存先落在手机本地，重连后按顺序回写桌面。
 *
 * 纯逻辑（折叠、回放顺序、回放决策、容量）与读写面分开写在同一文件：折叠与决策是这个
 * 子系统唯一容易想错的地方（见下），把它们留在能单测的位置上，IO 只是把结果搬到 IndexedDB。
 *
 * 三条判据的来源，都是条目 44 的硬约束：
 * 1. **基线取最初读到的那份，折叠时不跟着更新**。否则第二次离线保存会把「中间态」当基线，
 *    回放时拿它去比对桌面 → 桌面只要没动过也判成「变了」，凭空产出一堆假冲突。
 * 2. **权威是内容哈希，不是「收到过帧」**。回放直接发 `write`：桌面在这条命令里就已经拿基线
 *    判过一次，不一致时一个字都不写、并把它那一份带回来。判据因此只存在于桌面一处 ——
 *    手机先发一次 `stat` 再决定写不写，是多养一份会漂移的副本（还多一次往返，
 *    而两次之间桌面随时能改）。撞出冲突就交给既有 diff 时间线由人裁决 ——
 *    两边都是有效修改，程序代选可能毁掉工作。
 * 3. **写不进去必须说出来**。`drafts.ts:71` 那种「超限即 return false」在这里不可接受，
 *    每个失败都回一个带原因的形状，由调用方出文案。
 *
 * 键就是「哪台设备的哪个文件」，所以同文件折叠是一次 `put` 覆盖而不是「先查有没有」，
 * 并发保存不可能产出两条。
 */
import { IdbError, openStore } from './idb';
import { MAX_DRAFT_CHARS } from './drafts';

export const OFFLINE_DB = 'heid-offline';
export const OFFLINE_STORE = 'writes';

/** 队列里最多攒多少个文件。超了是**拒绝新的**而不是丢掉旧的 —— 丢一份等于丢用户的工作 */
export const MAX_OFFLINE_ENTRIES = 100;

/**
 * 单条内容的字符上限，与草稿同源（`drafts.ts` 的 `MAX_DRAFT_CHARS`）：
 * 2M 字符按 CJK 的 3 字节算正好落在远程写入的 6 MB 上限内，两个天花板不会打架。
 */
export const MAX_OFFLINE_CHARS = MAX_DRAFT_CHARS;

/** `queued` 等着回放；`conflict` 要用户裁决，回放跳过它 */
export type OfflineState = 'queued' | 'conflict';

export interface OfflineEntry {
  /** 队列键 `${deviceId}\u0000${relPath}`：同文件同键，折叠因此是覆盖而非插入 */
  id: string;
  /** 哪台电脑的（换一台连上不能把上一台的改动写过去） */
  deviceId: string;
  /** 相对该设备共享根的路径，回放时按它发 `stat` / `write` */
  relPath: string;
  /** 手机侧标签的身份键 `hide-remote://…`，树上的标记按它找 */
  path: string;
  /** 文件名，只给提示文案用 */
  title: string;
  /** 落盘态文本（换行符已按标签的 eol 还原）。回放原样发出，不再二次转换 */
  text: string;
  encoding: string;
  bom: boolean;
  /** 最初读到那份时的内容基线；折叠不更新（见文件头第 1 条） */
  baseHash: string;
  /** 第一次入队的时刻：回放顺序与折叠后都保留它 */
  queuedAt: number;
  /** 最近一次改动落进队列的时刻 */
  updatedAt: number;
  attempts: number;
  state: OfflineState;
  /** 上一次尝试为什么没成；空串 = 还没试过。给长按菜单与横幅的次要信息用 */
  lastError: string;
}

/** 入队要的东西：与 `remote.ts` 的 `RemoteWriteArgs` 同形，多带标签的身份与标题 */
export interface OfflineInput {
  deviceId: string;
  relPath: string;
  path: string;
  title: string;
  text: string;
  encoding: string;
  bom: boolean;
  baseHash: string;
}

export type OfflineReject =
  /** 内容超单条上限：这一份进不了队列，得让用户自己另存 */
  | { ok: false; reason: 'toobig'; chars: number; limit: number }
  /** 文件数满：新的这条被拒，已有的不动 */
  | { ok: false; reason: 'full'; limit: number }
  /** 没有基线：拿空基线落盘等于覆盖桌面的改动，桌面侧也会以 badparams 拒 */
  | { ok: false; reason: 'nobaseline' }
  /** 存储本身出了问题（隐私模式没有 IDB / 配额写满 / 事务被中止） */
  | { ok: false; reason: 'storage'; detail: string };

export type OfflineResult = { ok: true; entry: OfflineEntry; collapsed: boolean } | OfflineReject;

/* ------------------------------------------------------------------ 纯逻辑 */

export function entryIdOf(deviceId: string, relPath: string): string {
  return `${deviceId}\u0000${relPath}`;
}

/** 入队前的三道闸：基线、尺寸、条数。都只读输入，不碰存储 */
export function checkCapacity(
  input: OfflineInput,
  existing: OfflineEntry[],
): { ok: true } | Exclude<OfflineReject, { ok: true }> {
  if (!input.baseHash) return { ok: false, reason: 'nobaseline' };
  if (input.text.length > MAX_OFFLINE_CHARS) {
    return { ok: false, reason: 'toobig', chars: input.text.length, limit: MAX_OFFLINE_CHARS };
  }
  const id = entryIdOf(input.deviceId, input.relPath);
  const known = existing.some(e => e.id === id);
  if (!known && existing.length >= MAX_OFFLINE_ENTRIES) {
    return { ok: false, reason: 'full', limit: MAX_OFFLINE_ENTRIES };
  }
  return { ok: true };
}

/**
 * 同一文件的第二次离线保存并成一条：**内容取最新，基线与 queuedAt 保留最初那份**。
 * attempts / lastError 也留着 —— 那是「这条试过几次、上次为什么没成」的历史，
 * 不该因为用户又改了一版就清零。状态回到 queued：内容变了，该重新判一次。
 */
export function collapse(
  prev: OfflineEntry,
  input: OfflineInput,
  now: number,
): OfflineEntry {
  return {
    ...prev,
    text: input.text,
    encoding: input.encoding,
    bom: input.bom,
    title: input.title,
    path: input.path,
    state: 'queued',
    updatedAt: now,
  };
}

export function freshEntry(input: OfflineInput, now: number): OfflineEntry {
  return {
    id: entryIdOf(input.deviceId, input.relPath),
    deviceId: input.deviceId,
    relPath: input.relPath,
    path: input.path,
    title: input.title,
    text: input.text,
    encoding: input.encoding,
    bom: input.bom,
    baseHash: input.baseHash,
    queuedAt: now,
    updatedAt: now,
    attempts: 0,
    state: 'queued',
    lastError: '',
  };
}

/** 回放顺序：先排队的先写（同文件折叠保住了最早的 queuedAt），同刻按 id 定序保证可复现 */
export function sortForReplay(entries: OfflineEntry[]): OfflineEntry[] {
  return entries
    .filter(e => e.state === 'queued')
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 某一台上才该回放：连着 A 电脑时不能把 B 的改动写进 A 的同名文件 */
export function forDevice(entries: OfflineEntry[], deviceId: string): OfflineEntry[] {
  return entries.filter(e => e.deviceId === deviceId);
}

/* ------------------------------------------------------------------ 读写面 */

/**
 * 存储层形状：与 `idb.ts` 的 IdbStore 结构相同（多出来的 `get` 这里用不上）。
 * 单独声明是为了让单测能塞一个「必坏」的替身，把配额写满那条路径验到位。
 */
export interface OfflineStore {
  getAll<T = OfflineEntry>(): Promise<T[]>;
  put(value: unknown, key: IDBValidKey): Promise<void>;
  del(key: IDBValidKey): Promise<void>;
  clear(): Promise<void>;
}

/** 连接按库缓存一份：队列在启动时读一次、之后每笔保存碰一下，犯不着次次开库 */
let shared: Promise<OfflineStore> | null = null;

function defaultStore(): Promise<OfflineStore> {
  if (!shared) shared = openStore(OFFLINE_DB, OFFLINE_STORE);
  return shared;
}

function detailOf(e: unknown): string {
  if (e instanceof IdbError) return e.reason === 'unavailable' ? '这台设备的本地存储不可用' : e.detail;
  return e instanceof Error ? e.message : String(e);
}

/** 读整个队列。读不出来（这台设备没有 IDB）回空数组：启动路径不该被存储打断，
    而「这一份到底存进去没有」由 [`enqueue`] 的返回值负责，两者不是一件事 */
export async function loadQueue(store: Promise<OfflineStore> = defaultStore()): Promise<OfflineEntry[]> {
  try {
    const list = await (await store).getAll<OfflineEntry>();
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch {
    return [];
  }
}

/** 形状校验：库里躺着一条不认识的东西（旧版本写的 / 手工改过的）就跳过它，而不是让整块界面白掉 */
function valid(e: unknown): e is OfflineEntry {
  const o = e as Partial<OfflineEntry> | null;
  return !!o && typeof o.id === 'string' && typeof o.deviceId === 'string'
    && typeof o.relPath === 'string' && typeof o.text === 'string'
    && typeof o.baseHash === 'string' && typeof o.queuedAt === 'number'
    && (o.state === 'queued' || o.state === 'conflict');
}

/**
 * 入队（含折叠）。失败一定带原因 —— 调用方要据此告警，
 * 「这一份没能存进手机，请复制到别处」是这一刻唯一还在用户这边的信息。
 */
export async function enqueue(
  input: OfflineInput,
  store: Promise<OfflineStore> = defaultStore(),
  now: number = Date.now(),
): Promise<OfflineResult> {
  const s = await store;
  const existing = await loadQueue(store);
  const cap = checkCapacity(input, existing);
  if (!cap.ok) return cap;
  const id = entryIdOf(input.deviceId, input.relPath);
  const prev = existing.find(e => e.id === id);
  const entry = prev ? collapse(prev, input, now) : freshEntry(input, now);
  try {
    await s.put(entry, id);
  } catch (e) {
    return { ok: false, reason: 'storage', detail: detailOf(e) };
  }
  return { ok: true, entry, collapsed: !!prev };
}

/** 覆盖式写回一条（改状态、加 attempts 都走它）。写不回去回 false，由调用方决定怎么说 */
export async function putEntry(
  entry: OfflineEntry,
  store: Promise<OfflineStore> = defaultStore(),
): Promise<boolean> {
  try {
    await (await store).put(entry, entry.id);
    return true;
  } catch {
    return false;
  }
}

export async function removeEntry(
  id: string,
  store: Promise<OfflineStore> = defaultStore(),
): Promise<void> {
  try {
    await (await store).del(id);
  } catch {
    /* 已经不在了就是要的效果，下次读还会是空的 */
  }
}

export async function clearQueue(store: Promise<OfflineStore> = defaultStore()): Promise<void> {
  try {
    await (await store).clear();
  } catch {
    /* 同上 */
  }
}
