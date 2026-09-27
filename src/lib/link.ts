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
/** 与 Rust `link::EVENT_REMOTE` 同名：对端主动推的事件（阶段 3 起有 `tabs`） */
export const LINK_REMOTE_EVENT = 'heid-link-event';
/** 与 Rust `PROTOCOL_VERSION` 同步；不一致说明两端版本错开，要提示升级 */
export const LINK_PROTOCOL = 1;

/**
 * 桌面开着共享时，面板问一句「屏幕上该摆哪张码」的间隔。
 *
 * **换不换不由这里判**（那是服务端 `link_pair_info` 的事：一张票挂够 `pair::REFRESH_AFTER`
 * 才换）。这里只是按时去问，所以开两个面板也不会出现两个定时器互相抢着换码 ——
 * 那正是「屏幕上摆的这张已经不是当前那张」的来源（2026-09-27 实测）。
 */
export const QR_POLL_MS = 15_000;

const PREFS_KEY = 'heid-link-prefs';

export type LinkRole = 'off' | 'server' | 'client';

/** `link_pair_qr` 的返回：二维码 URI + 6 位短码 + 本机地址（供手填兜底显示）。 */
export interface QrInfo {
  uri: string;
  code: string;
  host: string;
  port: number;
  fp: string;
  name: string;
}

/** 已配对设备行。 */
export interface PairInfo {
  keyId: string;
  name: string;
  pairedAt: number;
  /** 这台是开着测试配对模式自动放进来的一台 —— 列表里要标出来，才知道该撤哪几行 */
  viaTest: boolean;
}

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
  /** 桌面当前的共享范围（人话形态）；手机侧恒空。开启态必须让用户看得见暴露了什么 */
  rootDisplay: string;
  /** 对端设备 id（LS 的 keyId）。远程标签的身份键 `hide-remote://<它>/…` 用它，不能用 IP */
  peerKeyId: string;
  /** bind 成功但迟迟没有连接尝试：大概率是 Windows 防火墙 */
  firewallHint: boolean;
  /** 共享根之外、因「桌面上正开着」而暴露给手机的文件数（阶段 3 的白名单） */
  openShared: number;
  /**
   * 测试配对模式开着：不过期、任何设备都能连、来了自动允许。
   * 这是一扇开着的门，所以它和 `rootDisplay` / `openShared` 同一条规矩 —— 必须常驻可见。
   * 故意不进 `LinkPrefs`：重启之后应当是关的。
   */
  testPair: boolean;
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
  rootDisplay: '',
  peerKeyId: '',
  firewallHint: false,
  openShared: 0,
  testPair: false,
};

/** Rust 侧 `Refused.code` 的稳定取值；UI 按它出双语标签，原始 reason 作次要信息 */
export type LinkRefuseCode =
  | 'busy' | 'version' | 'ticket' | 'timeout' | 'protocol' | 'handshake' | 'slowdown';
const REFUSE_CODES: LinkRefuseCode[] = [
  'busy', 'version', 'ticket', 'timeout', 'protocol', 'handshake', 'slowdown',
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
    rootDisplay: typeof o.rootDisplay === 'string' ? o.rootDisplay : '',
    peerKeyId: typeof o.peerKeyId === 'string' ? o.peerKeyId : '',
    firewallHint: o.firewallHint === true,
    openShared: typeof o.openShared === 'number' ? o.openShared : 0,
    testPair: o.testPair === true,
  };
}

export interface LinkPrefs {
  /** 总开关是否记忆（2026-09-23 定：记忆，启动时上次为开则自动 bind） */
  enabled: boolean;
  port: number;
  /** 手机侧记住上次连的地址与票，省一次手输 */
  host: string;
  ticket: string;
  /** 手机侧配对成功后记住的设备 keyId（公开标识）与对端设备名，重启据此免扫自动重连 */
  keyId: string;
  peerName: string;
}

export const DEFAULT_PREFS: LinkPrefs = {
  enabled: false,
  port: DEFAULT_LINK_PORT,
  host: '',
  ticket: '',
  keyId: '',
  peerName: '',
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
    keyId: typeof o.keyId === 'string' && isKeyId(o.keyId) ? o.keyId : '',
    peerName: typeof o.peerName === 'string' ? o.peerName : '',
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

/**
 * 配对成功后把对端记进偏好 —— 下次启动的免扫重连全靠这一份。
 * 地址取 `peerAddr`：客户端那一侧它就是「连过去时用的 地址:端口」，
 * 所以扫码这条没有输入框可填的路也记得住该连哪儿。
 */
export function rememberPeer(st: LinkStatus): void {
  // 两个都得有才记：只有 keyId 没有地址 = 一条已经断开的链路留下的半成品，
  // 记下去下次免扫重连会直接撞「地址不能为空」（Rust `mark_error` 同时清这两个字段）
  if (!st.peerKeyId || !st.peerAddr) return;
  const m = /^(.*):(\d{1,5})$/.exec(st.peerAddr || '');
  savePrefs({
    keyId: st.peerKeyId,
    peerName: st.peerDevice,
    host: m ? m[1] : st.peerAddr,
    ...(m ? { port: Number(m[2]) } : {}),
  });
}

/** 端口合法区间：与 Rust `link_server_start` 的校验一致，两端各挡一次 */
export function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** 配对票形状：32 位十六进制（与 Rust `is_valid_ticket` 一致） */
export function isTicket(s: string): boolean {
  return /^[0-9a-fA-F]{32}$/.test(s);
}

/** keyId 形状：16 位十六进制（与 Rust `pair::key_id` 一致，取自 LS 哈希前 8 字节） */
export function isKeyId(s: string): boolean {
  return /^[0-9a-fA-F]{16}$/.test(s);
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

/**
 * 开 / 关「测试配对模式」（开发用，见 Rust `link_test_pair_set`）。
 * 开着时那台电脑接受任何设备的配对并自动允许，所以界面上必须常驻显示 —— 返回的状态就是那份。
 */
export async function setTestPair(on: boolean): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_test_pair_set', { on }));
}

/** 桌面把**本窗口**文件树当前的根报给链路层当共享范围（设计稿 §2.3：不让用户再选第二遍）。
    传 null 即清除；手机端不用（手机恒为客户端，不暴露任何文件）。
    多窗口下每台各有一份树，哪一份暴露出去由聚焦窗口决定（§6.1），所以带上窗口标签。 */
export async function setSharedRoot(label: string, path: string | null): Promise<void> {
  if (!isTauri) return;
  await call<unknown>('link_set_root', { label, path }).catch(() => {});
}

/* ------------------------------------------------ 阶段 3：标签上报与对端事件 */

/** 与 Rust `link::board::TabReport` 同形（camelCase） */
export interface TabReport {
  path: string | null;
  title: string;
  language: string;
  mdView: string;
  dirty: boolean;
  readOnly: boolean;
  line: number;
  col: number;
  /** 桌面上正看着这一张。手机端连上时先把这一份摊开给用户，其余排进标签条 */
  active: boolean;
}

/**
 * 把前端标签列表压成上报用的最小快照。
 *
 * 只报**没有内容**的那几项：手机上那份列表要表达的是「桌面上开着什么」，
 * 内容本身永远走 `read` 现取 —— 一次上报带内容就等于允许两份"正在改的"存在。
 * 路径只收正常的磁盘路径：`content://`（手机 SAF）与 `hide-remote://`（远程标签）
 * 都不是桌面文件系统里的东西，报上去只会让桌面去解析一个打不开的路径。
 */
export function tabReports(
  tabs: {
    id: string;
    path: string | null;
    title: string;
    language: string;
    mdView: string;
    isDirty: boolean;
    readOnly: boolean;
  }[],
  activeId: string,
  cursor: { line: number; col: number } | null,
): TabReport[] {
  return tabs.map(t => {
    const p = t.path ?? null;
    const plain = p !== null && !p.includes('://');
    const on = t.id === activeId ? cursor : null;
    return {
      path: plain ? p : null,
      title: t.title,
      language: t.language,
      mdView: t.mdView,
      dirty: t.isDirty,
      readOnly: t.readOnly,
      line: on?.line ?? 0,
      col: on?.col ?? 0,
      active: t.id === activeId,
    };
  });
}

/** 报本窗口的标签列表；只有桌面前端会调它 */
export async function reportTabs(label: string, tabs: TabReport[]): Promise<void> {
  if (!isTauri) return;
  await call<unknown>('link_report_tabs', { label, tabs }).catch(() => {});
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

/* ------------------------------------------------------------ 阶段 1：配对与重连 */

function normPairings(raw: unknown): PairInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const o = (e ?? {}) as Partial<Record<keyof PairInfo, unknown>>;
    return {
      keyId: typeof o.keyId === 'string' ? o.keyId : '',
      name: typeof o.name === 'string' ? o.name : '',
      pairedAt: typeof o.pairedAt === 'number' ? o.pairedAt : 0,
      viaTest: o.viaTest === true,
    };
  });
}

/**
 * 桌面：主动换一张配对码（「换一个码」那颗按钮）。非共享状态会报错，调用方兜住。
 * 换下去的那张不是当场失效 —— Rust 侧的配对窗还留着它，所以手机上正对着的码
 * 被换掉那一瞬间，拨过去仍然配得上。正有设备在握手时服务端不会换，只把当前那张原样给回来。
 */
export async function pairQr(): Promise<QrInfo | null> {
  if (!isTauri) return null;
  return call<QrInfo>('link_pair_qr');
}

/** 桌面：问一句「屏幕上该摆哪张码」。该换时服务端自己换，这里不需要知道。 */
export async function pairInfo(): Promise<QrInfo | null> {
  if (!isTauri) return null;
  return call<QrInfo>('link_pair_info');
}

export async function pairingsList(): Promise<PairInfo[]> {
  if (!isTauri) return [];
  return normPairings(await call<unknown>('link_pairings_list'));
}

export async function revokePairing(keyId: string): Promise<boolean> {
  if (!isTauri) return false;
  return call<boolean>('link_pairing_revoke', { keyId });
}

/** 手机：吃一段 `hide-link://pair?...`（扫码/粘贴得到）走配对。 */
export async function pairUri(uri: string, device: string): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_client_pair', { uri, device }));
}

/** 手机：相机不可用时手输 6 位短码配对（要另填 host/port）。 */
export async function pairCode(
  host: string,
  port: number,
  code: string,
  device: string,
): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_client_pair_code', { host, port, code, device }));
}

/** 手机：用记住的 host + keyId 免扫重连。 */
export async function reconnect(
  host: string,
  port: number,
  keyId: string,
  device: string,
): Promise<LinkStatus> {
  if (!isTauri) return { ...EMPTY_STATUS };
  return normalizeStatus(await call<LinkStatus>('link_client_reconnect', { host, port, keyId, device }));
}

/**
 * 订阅对端主动推的事件（阶段 3 起：桌面标签列表变了；阶段 4 起：桌面文件变了）。
 * 按类型分流与载荷解析都由调用方做 —— 这一层不认识任何具体类型的载荷形状，
 * 加一类推送不用改这里（与 Rust 帧层「不认识具体命令」同一条分工）。
 * `data` 原样带出：多数推送是空的（「变了，去重取」），只有 `fs` 那份带内容。
 */
export function subscribeRemoteEvents(cb: (type: string, data: string) => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const fn = await listen<{ type?: string; data?: string }>(LINK_REMOTE_EVENT, e => {
      const t = typeof e.payload?.type === 'string' ? e.payload.type : '';
      if (t) cb(t, typeof e.payload?.data === 'string' ? e.payload.data : '');
    });
    if (cancelled) fn();
    else unlisten = fn;
  })().catch(() => {
    /* 订阅失败只意味着列表不再自动刷新；设备页仍可靠下拉/重进刷新 */
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
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

/** 用户这一趟是不是**主动断开**过：那是他的决定，自动接回来不该把它覆盖掉。 */
let userClosedLink = false;
export function markLinkUserClosed(on: boolean): void {
  userClosedLink = on;
}

/**
 * 掉线之后接回来的节奏：头几次很快（Wi-Fi 抖一下、桌面刚收到 RST 就该立刻接得上），
 * 之后退到一分钟一轮，别在电脑真关机了的时候空转。连上即归零。
 *
 * 为什么第一次只要 2 秒：桌面发现上一条死了有两个途径 —— 收到 RST（息屏就是这种，秒级）
 * 或心跳超时（15 s × 2）。前者根本不需要等，后者由后面几档兜住。
 */
const LINK_RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * 顶栏那颗图标转圈转到哪儿为止：整套退避节奏跑完（2+5+10+30+60 ≈ 一分四十七秒）就不转了，
 * 回到「扫一扫」。**图标变回去不等于放弃重连** —— 后台仍按最后一档 60 秒一直试下去，
 * 只是不再让界面摆着一个"马上就有结果"的转圈骗人（他 2026-09-27 定的这一档）。
 */
export const LINK_REDIAL_SPINS = LINK_RETRY_MS.length;

let redialSnap: { spinning: boolean } = { spinning: false };
const redialSubs = new Set<() => void>();

/** `useSyncExternalStore` 的取快照：只在真变了时换那个对象，否则每次渲染都新对象它会反复重读 */
export function linkRedialSnapshot(): { spinning: boolean } {
  return redialSnap;
}

export function subscribeLinkRedial(cb: () => void): () => void {
  redialSubs.add(cb);
  return () => { redialSubs.delete(cb); };
}

function setRedial(spinning: boolean): void {
  if (redialSnap.spinning === spinning) return;
  redialSnap = { spinning };
  for (const cb of redialSubs) cb();
}

/**
 * 手机上"链路掉了就自己接回来"。
 *
 * 为什么需要：安卓息屏会挂起 Wi-Fi 栈，手机这条 TCP 客户端连接被系统直接销毁（2026-09-27 实测：
 * 按电源键息屏，桌面十几秒后收到 RST）。这条链路**不做后台常驻**（项目「轻量」那道门槛），
 * 亮屏时也等不到可靠的 `visibilitychange`（WebView 里实测不触发），所以触发点用"掉线"本身：
 * 状态推送说没连着，就按上面的节奏重试；连上了立刻停表。
 *
 * 为什么要退避而不是立刻重拨：桌面那边可能还没发现上一条连接已经死了（心跳 15 s × 2 次），
 * 那段时间它谁都不接（同时只服务一台，回 `busy`）。
 *
 * 返回注销函数（给 App 的 effect 用）。
 */
export function startLinkKeepAlive(): () => void {
  if (!isTauri || !IS_ANDROID_APP) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fails = 0;
  let dead = false;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const arm = () => {
    // 用户点过「断开」就别再排这一枪：排了会先亮一下"正在接回"的转圈，说的却是他刚做的反方向决定
    if (dead || timer || userClosedLink) return;
    const wait = LINK_RETRY_MS[Math.min(fails, LINK_RETRY_MS.length - 1)];
    setRedial(fails < LINK_REDIAL_SPINS);
    timer = setTimeout(() => {
      timer = null;
      const p = loadPrefs();
      if (dead || userClosedLink || !p.host || !p.keyId) { setRedial(false); return; }
      fails += 1;
      setRedial(fails < LINK_REDIAL_SPINS);
      void reconnect(p.host, p.port, p.keyId, deviceName()).catch(() => null);
      arm();
    }, wait);
  };
  const off = subscribeLinkStatus((s) => {
    if (s.connected) { fails = 0; stop(); setRedial(false); return; }
    /* 有地址却没连着 = 那一次拨号还在路上（Rust 在拨号那一刻写 `peer_addr`，失败或断开才清）。
       这时候再补一枪就是自己跟自己抢：两条连接几乎同时到桌面，桌面侧旧那条的读循环会撞上
       新那条的密文，报出来的是一句指向加密的「帧解密失败」（2026-09-27 他手机上"扫完反而连不上"
       就是这么来的——自动重连与他手动扫撞进了同一秒）。等这一次有结果再说。 */
    if (s.peerAddr) { stop(); return; }
    // role 停在 client = 配过对、现在没连着；桌面端（server）与"没配过对"都不该自己拨号
    if (s.role === 'client') arm();
    else { stop(); setRedial(false); }
  });
  return () => { dead = true; off(); stop(); setRedial(false); };
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

/**
 * 手机启动时按记住的设备免扫重连（设计稿 §7.1 第 4 条）。只在安卓、且有 host + keyId 时尝试；
 * 失败不弹错、不清记录（IP 变了这次连不上，下次还试），把原因留在状态里由面板显示。
 * 桌面不需要（它的"自动"是 autoStartFromPrefs 那侧）。
 */
export async function autoReconnectFromPrefs(): Promise<LinkStatus | null> {
  if (!isTauri || !IS_ANDROID_APP) return null;
  const prefs = loadPrefs();
  if (!prefs.host || !prefs.keyId) return null;
  try {
    return await reconnect(prefs.host, prefs.port, prefs.keyId, deviceName());
  } catch {
    return null;
  }
}
