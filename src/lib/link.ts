/**
 * 设备互联（v1.5）前端侧：状态类型、命令封装、事件订阅与偏好持久化。
 *
 * 桌面恒为服务端（开关 + 端口 + 配对票），手机恒为客户端（手填地址 + 票）。
 * 这里的命令名、字段名与 `src-tauri/src/link.rs` 一一对应 —— 改一边必须改另一边，
 * 且 `LinkStatus` 的字段是 Rust 侧 `#[serde(rename_all = "camelCase")]` 的结果。
 *
 * 浏览器（非 Tauri）环境下所有命令调用都退化成"未启用"，不抛错：
 * 设置面板会在界面上显示「当前平台不可用」，而不是弹一串 invoke 失败。
 */

import { IS_ANDROID_APP } from './platform';
import { isTauri } from './fileIO';

/** 设计稿 §12.1 第 3 条：默认端口取不常用值，设置里可改，占用时明确报错 */
export const DEFAULT_LINK_PORT = 47123;
/** 与 Rust `link::EVENT` 同名 */
export const LINK_EVENT = 'heid-link';
/** 与 Rust `PROTOCOL_VERSION` 同步；不一致说明两端版本错开，要提示升级 */
export const LINK_PROTOCOL = 1;

const PREFS_KEY = 'heid-l…refs';

export type LinkRole = 'off' | 'server' | 'client';

export interface LinkStatus {
  role: LinkRole;
  listening: boolean;
  port: number;
  connected: boolean;
  peerDevice: string;
  peerAddr: string;
  ticket: string;
  lastError: string;
  protocol: number;
}

export const EMPTY_STATUS: LinkStatus = {
  role: 'off',
  listening: false,
  port: 0,
  connected: false,
  peerDevice: '',
  peerAddr: '',
  ticket: '',
  lastError: '',
  protocol: 0,
};

/** Rust 侧 `Refused.code` 的稳定取值；UI 按它出双语标签，原始 reason 作次要信息 */
export type LinkRefuseCode = 'busy' | 'version' | 'ticket' | 'timeout' | 'protocol' | 'handshake';
const REFUSE_CODES: LinkRefuseCode[] = [
  'busy', 'version', 'ticket', 'timeout', 'protocol', 'handshake',
];

export function isRefuseCode(s: string): s is LinkRefuseCode {
  return (REFUSE_CODES as string[]).includes(s);
}

/**
 * 状态归一化：命令返回与事件载荷都过这里。
 * 缺字段一律按"关闭"处理而不是抛错 —— 这条链路上任何一次解析失败都不该让
 * 设置面板整块白掉（阶段 5 的离线队列才需要严格错误处理）。
 */
export function normalizeStatus(raw: unknown): LinkStatus {
  const o = (raw ?? {}) as Partial<Record<keyof LinkStatus, unknown>>;
  const role = o.role === 'server' || o.role === 'client' ? o.role : 'off';
  return {
    role,
    listening: o.listening === true,
    port: typeof o.port === 'number' ? o.port : 0,
    connected: o.connected === true,
    peerDevice: typeof o.peerDevice === 'string' ? o.peerDevice : '',
    peerAddr: typeof o.peerAddr === 'string' ? o.peerAddr : '',
    ticket: typeof o.ticket === 'string' ? o.ticket : '',
    lastError: typeof o.lastError === 'string' ? o.lastError : '',
    protocol: typeof o.protocol === 'number' ? o.protocol : 0,
  };
}

export interface LinkPrefs {
  /** 总开关是否记忆（2026-09-23 定：记忆，启动时上次为开则自动 bind） */
  enabled: boolean;
  port: number;
  /** 手机侧记住上次连的地址与票，省一次手输 */
  host: string;
  ticket: string;
}

export const DEFAULT_PREFS: LinkPrefs = {
  enabled: false,
  port: DEFAULT_LINK_PORT,
  host: '',
  ticket: '',
};

/** 偏好读写：坏数据一律回落到默认值，不抛错（设置面板不该因为一处脏数据打不开） */
export function parsePrefs(raw: string | null): LinkPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let o: Partial<Record<keyof LinkPrefs, unknown>>;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  const port = typeof o.port === 'number' && isUsablePort(o.port) ? o.port : DEFAULT_LINK_PORT;
  return {
    enabled: o.enabled === true,
    port,
    host: typeof o.host === 'string' ? o.host : '',
    ticket: typeof o.ticket === 'string' && isTicket(o.ticket) ? o.ticket : '',
  };
}

export function loadPrefs(): LinkPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch: Partial<LinkPrefs>): LinkPrefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进去：功能仍可用，只是下次启动不记忆 */
  }
  return next;
}

/** 端口合法区间：与 Rust `link_server_start` 的校验一致，两端各挡一次 */
export function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** 配对票形状：32 位十六进制（与 Rust `is_valid_ticket` 一致） */
export function isTicket(s: string): boolean {
  return /^[0-9a-fA-F]{32}$/.test(s);
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 本端角色：手机只能当客户端，桌面只能当服务端 —— 拓扑是定死的（设计稿 §2.1） */
export function linkRole(): LinkRole {
  return IS_ANDROID_APP ? 'client' : 'server';
}

/**
 * 本端显示名（握手时发给对端）。手机取 `Build.MODEL`（经 HeidBridge，设计稿 §12.1 第 4 条）；
 * 桌面取不到机器名时用固定串兜底，不要发空字符串 —— 配对确认框会显示成「允许  访问」。
 */
export function deviceName(): string {
  if (IS_ANDROID_APP) {
    try {
      const m = (window as unknown as { HeidBridge?: { deviceModel?: () => string } })
        .HeidBridge?.deviceModel?.();
      if (typeof m === 'string' && m.trim()) return m.trim();
    } catch {
      /* 桥不可用（浏览器壳 / 旧包）：走兜底名 */
    }
    return 'H.I.D.E (Android)';
  }
  return 'H.I.D.E';
}

export async function fetchStatus(): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_status'));
}

export async function startServer(port: number): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_server_start', { port }));
}

export async function stopServer(): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_server_stop'));
}

export async function fetchTicket(): Promise<string> {
  if (!isTauri) return '';
  return call<string>('link_ticket');
}

export async function connectTo(
  host: string,
  port: number,
  ticket: string,
  device: string,
): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(
    await call<LinkStatus>('link_client_connect', { host, port, ticket, device }),
  );
}

export async function disconnectClient(): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_client_disconnect'));
}

/** 订阅状态变更。返回退订函数；非 Tauri 环境返回空操作。 */
export function subscribeLinkStatus(cb: (s: LinkStatus) => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const fn = await listen<LinkStatus>(LINK_EVENT, (e) => cb(normalizeStatus(e.payload)));
    if (cancelled) fn();
    else unlisten = fn;
  })().catch(() => {
    /* 订阅失败只意味着状态不再自动刷新；面板仍可按显式 fetch 显示 */
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * 启动时按记忆状态自动开启共享（2026-09-23 定的"记忆开关"）。
 * 只在桌面调用；失败不弹错，把原因留在状态里，由设置面板显示 ——
 * 启动路径上任何一次端口占用都不该打断窗口出现。
 */
export async function autoStartFromPrefs(): Promise<LinkStatus | null> {
  if (!isTauri || IS_ANDROID_APP) return null;
  const prefs = loadPrefs();
  if (!prefs.enabled) return null;
  try {
    return await startServer(prefs.port);
  } catch {
    try {
      return await fetchStatus();
    } catch {
      return null;
    }
  }
}
