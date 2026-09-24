/**
 * 远程文件（v1.5 阶段 2）：`hide-remote://` 身份键的编解码 + 桌面四条命令的前端封装。
 *
 * 命令走 Rust 的 `link_request`（一条已加密的局域网连接），本文件只是它的一层薄壳：
 * 字段名与 `src-tauri/src/link/fsrv.rs` 的 serde 形状一一对应，改一边必须改另一边；
 * 失败按**稳定码**分流（保存路径要按 `notfound` / `toobig` / `outside` / `noroot`
 * 出不同文案，不能只有一个「失败了」）。
 *
 * 路径形态：`hide-remote://<deviceId>/<相对共享根的路径>`。用 deviceId 而不是 IP ——
 * 换网或 DHCP 重新分配之后，手机上已经打开的标签仍要指向同一台设备。
 * 请求本身不带 deviceId：连接是单活的，路由由 Rust 侧决定，这个 id 只承担身份。
 */
import { isTauri } from './fileIO';

export const REMOTE_SCHEME = 'hide-remote://';

/** 远程读写的字节上限，与 Rust 侧 `link::fsrv::MAX_REMOTE_FILE_BYTES` 同值。
    超了就不是「降级只读」而是死角：远程没有分块预览协议，桌面侧的分块读取是 desktop-only 的。 */
export const REMOTE_MAX_FILE_BYTES = 6 * 1024 * 1024;

/** 反斜杠写成常量，免得在字符串转义里绕 */
const BS = String.fromCharCode(92);
/** 段分隔：解码之后的串里两种斜杠都算分隔符（桌面 `roots::check_rel` 同口径） */
const SEG_SPLIT = /[/\\]/;
/** 纯点段（`..` / `...`）是向上跳：与桌面同判据，不止逐字比 `..` */
const UP_SEG = /^\.{2,}$/;

/** 远程身份键解析结果。`rel` 是解码后的、以 `/` 分隔的相对共享根路径（根为空串） */
export interface RemoteRef {
  deviceId: string;
  rel: string;
}

/** `list` 的目录条目（`size` 对目录恒为 0） */
export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface RemoteListResult {
  entries: RemoteEntry[];
  /** 撞了桌面 3000 条上限：如实带出去，别让人以为目录就只有这些 */
  truncated: boolean;
}

export interface RemoteStatResult {
  size: number;
  mtimeMs: number;
  isDir: boolean;
  /** 目录与超过 `REMOTE_MAX_FILE_BYTES` 的文件为空串（为超限文件算哈希得先读一遍全文件，不值） */
  hash: string;
}

/** 前五个字段与桌面命令 `read_text_file` 的返回逐字同形，好共用 `openedFromDecoded` */
export interface RemoteReadResult {
  text: string;
  encoding: string;
  bom: boolean;
  lossy: boolean;
  binary: boolean;
  /** 这次读到内容的基线，保存时原样带回 */
  hash: string;
  size: number;
  mtimeMs: number;
}

/**
 * `write` 的两种结局走同一个形状。`serverHash` / `serverText` / `serverEncoding`
 * 只在 `conflict` 为真时存在（Rust 侧 `skip_serializing_if`），要按可能缺失读；
 * 末两个没有 skip，不冲突时是货真价实的 false。
 */
export interface RemoteWriteResult {
  conflict: boolean;
  hash: string;
  size: number;
  mtimeMs: number;
  serverHash?: string;
  serverText?: string;
  serverEncoding?: string;
  serverBom: boolean;
  serverBinary: boolean;
}

export interface RemoteWriteArgs {
  relPath: string;
  text: string;
  encoding: string;
  bom: boolean;
  /** 必填：缺基线的写入等于静默覆盖桌面的改动，命令面以 `badparams` 拒掉 */
  baseHash: string;
}

/**
 * 按码分流的失败。`code` 取自 Rust 侧的稳定标识，`unknown` 表示串不是约定形状；
 * 另有一个只在本机没有链路时出现的 `unavailable`（见 `unavailable()`）。
 */
export class RemoteError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

export function isRemoteError(e: unknown): e is RemoteError {
  return e instanceof RemoteError;
}

/** Rust 的 Err 串约定为 `"<稳定码>: <给人看的中文原因>"`（`link.rs` 组帧时按此拼接）。
    只切**第一个**分隔符，所以原因里的全角冒号不会被当成码的分隔；码按形状限定成小写字母数字，
    于是一句本来只给人看的话（`C:\tmp: 打不开`）不会被拆出一个假码，而是整串留作原因。 */
const CODE_HEAD = /^([a-z][a-z0-9]*): ([\s\S]*)$/;

export function parseRemoteError(raw: unknown): RemoteError {
  // invoke 以字符串 reject，但仍可能裹成 Error：取其 message，别把 "Error: " 前缀当成码
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw ?? '');
  const m = CODE_HEAD.exec(s);
  return m ? new RemoteError(m[1], m[2]) : new RemoteError('unknown', s);
}

export function isRemotePath(path: string | null | undefined): boolean {
  return !!path && path.startsWith(REMOTE_SCHEME);
}

/**
 * 单段名字的 URI 编码。逐段编码而不是整串编码，`/` 分隔符才不会被一起编掉
 * （`platform.ts` 的远程分支与文件树的懒加载都按裸 `/` 切段）；反过来段内的 `/`
 * 只会以 `%2F` 的形态出现，解码时也就不会被误当成目录分隔符。
 */
export function encodeRemoteSegment(name: string): string {
  return encodeURIComponent(name);
}

/** 共享根的键以裸设备名结尾（`hide-remote://<dev>`），不挂多余的斜杠 */
export function makeRemotePath(deviceId: string, rel: string): string {
  const body = rel.split('/').map(encodeRemoteSegment).join('/');
  return body ? `${REMOTE_SCHEME}${deviceId}/${body}` : `${REMOTE_SCHEME}${deviceId}`;
}

/* ------------------------------------------------ 根外白名单引用（阶段 3 §6.3） */

/**
 * 白名单引用的保留首段，与 Rust 侧 `link::board::OPEN_HEAD` 同值。
 * 桌面上开着、但不在共享根里的文件，靠它寻址：`@w/<12 位十六进制>/<文件名>`。
 *
 * 为什么不是设计稿 §4.2 原先写的 `tabOpen {index}`：下标会随开关标签漂移，
 * 手机上那份标签的身份键必须稳定（同一份文件重开不该变成另一个标签），
 * 而 `read` / `write` 的基线判定也才能与根内文件共用同一条通道。
 */
export const OPEN_REL_HEAD = '@w';

const OPEN_REL = /^@w\/([0-9a-f]{12})\/([^/\\]+)$/;

/** 这条 `rel` 是不是白名单引用（而不是共享根内的相对路径） */
export function isOpenRel(rel: string): boolean {
  return OPEN_REL.test(rel);
}

/** 从白名单引用里取出文件标识；不是引用就返回 null */
export function openRelId(rel: string): string | null {
  return OPEN_REL.exec(rel)?.[1] ?? null;
}

/** 桌面 `tabs` 命令的一行。`rel` 与 `reason` 互斥：能打开才有 rel。 */
export interface RemoteTabView {
  title: string;
  language: string;
  mdView: string;
  dirty: boolean;
  readOnly: boolean;
  line: number;
  col: number;
  /** 打开它要用的相对引用：共享根内是普通相对路径，根外是 `@w/…`；打不开是空串 */
  rel: string;
  /** `''` | `dirty`（桌面有未保存的修改）| `novirtual`（还没保存到磁盘）| `missing`（现在读不到） */
  reason: string;
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    /* 编码异常时按原文保留该段（与 platform.ts 的 content:// 分支同一风格），
       让桌面侧去判定，而不是在这里抛出去打断整棵树的渲染 */
    return seg;
  }
}

/**
 * 手机侧先挡一道明显的越界，桌面 `roots::resolve_rel` 才是权威。
 * 判据一律作用在**解码之后**的串上：`%2e%2e`、`..%2Foutside` 解出来才露出 `..`，
 * 而且解码后的斜杠桌面还会再切一次，所以按同一个口径再切一遍来看段。
 */
export function parseRemotePath(path: string): RemoteRef | null {
  if (!path.startsWith(REMOTE_SCHEME)) return null;
  const body = path.slice(REMOTE_SCHEME.length);
  const slash = body.indexOf('/');
  const deviceId = slash >= 0 ? body.slice(0, slash) : body;
  const tail = slash >= 0 ? body.slice(slash + 1) : '';
  if (!deviceId) return null;
  const segs = tail ? tail.split('/') : [];
  // 空段来自前导或重复斜杠，即 `/etc/passwd`、`\server\share` 那类绝对写法的特征
  if (segs.some(s => s === '')) return null;
  const rel = segs.map(decodeSegment).join('/');
  // 冒号既是 Windows 盘符也是 NTFS 交替数据流的分隔符，桌面整串禁，这里跟着禁
  if (rel.includes(':') || rel.startsWith('/') || rel.startsWith(BS)) return null;
  if (rel.split(SEG_SPLIT).some(s => UP_SEG.test(s))) return null;
  return { deviceId, rel };
}

/* ------------------------------------------------------------------ 命令封装 */

export type RemoteMethod = 'list' | 'stat' | 'read' | 'write' | 'tabs';

/**
 * `link_request` 成功时带回的是**结果 JSON 文本**而不是对象（Rust 侧返回 `String`），
 * 四条命令共用这一道转换。解析不成说明链路本身出了岔子，如实归到 `unknown`，
 * 而不是返回一个空对象骗过调用方。
 */
export function parseRemoteResponse<T>(method: RemoteMethod, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new RemoteError('unknown', `桌面的 ${method} 结果无法解析：${String(e)}`);
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 浏览器与纯前端环境里根本没有这条链路。如实抛错而不是返回空值 ——
    返回空列表会让人误判成「桌面上没这个文件」 */
function unavailable(): RemoteError {
  return new RemoteError('unavailable', '这台设备没有连着桌面，请先在「设置 · 设备互联」里完成配对');
}

/** 一条命令的往返：Err 串在这里统一归成带稳定码的 RemoteError */
async function request<T>(method: RemoteMethod, params: Record<string, unknown>): Promise<T> {
  try {
    const raw = await call<string>('link_request', { method, params: JSON.stringify(params) });
    return parseRemoteResponse<T>(method, raw);
  } catch (e) {
    throw e instanceof RemoteError ? e : parseRemoteError(e);
  }
}

export async function remoteList(relDir: string): Promise<RemoteListResult> {
  if (!isTauri) throw unavailable();
  return request<RemoteListResult>('list', { relDir });
}

export async function remoteStat(relPath: string): Promise<RemoteStatResult> {
  if (!isTauri) throw unavailable();
  return request<RemoteStatResult>('stat', { relPath });
}

export async function remoteRead(relPath: string, forceEncoding?: string): Promise<RemoteReadResult> {
  if (!isTauri) throw unavailable();
  return request<RemoteReadResult>('read', { relPath, forceEncoding: forceEncoding ?? null });
}

/** 保存。`baseHash` 是 `read` 带回的那一份基线，原样传回去 */
export async function remoteWrite(args: RemoteWriteArgs): Promise<RemoteWriteResult> {
  if (!isTauri) throw unavailable();
  return request<RemoteWriteResult>('write', { ...args });
}

/** 桌面正打开着的标签（阶段 3）。无参：要哪一份由桌面的聚焦窗口决定。 */
export async function remoteTabs(): Promise<RemoteTabView[]> {
  if (!isTauri) throw unavailable();
  const list = await request<RemoteTabView[]>('tabs', {});
  // 桌面上的命令面只会给数组；真给了别的形状就是协议错开，如实报而不是当空列表
  return Array.isArray(list) ? list : [];
}
