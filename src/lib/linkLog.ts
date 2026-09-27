/**
 * 互联日志环（进程内最近若干条互联事件），供「设备互联」里那行「互联日志」展开。
 *
 * 为什么记在前端而不是 Rust 侧：这条链路上值得记的事本来就都到得了前端 —— 状态快照
 * （`heid-link`）说了连上/断开/上次失败，对端推送（`heid-link-event`）说了有没有动静，
 * 命令是我自己发出去的。在发令与收状态这两处记，两端都不用新增命令，也就动不到 capability 那三处注册。
 *
 * 为什么不落盘：这是「刚才发生了什么」的现场，不是审计账本。写进文件就要管清理、
 * 隐私（对端设备名与地址都在里面）与两端各一份，为排障那点需求不值当。
 *
 * 票值、32 位配对码、6 位短码、LS 一律不进日志 —— 日志是可以整份复制走的，凭证不行。
 *
 * 行里存的是 i18n 键 + 参数而不是成品句子：界面出双语，console / logcat 那份镜像就按键说，
 * 反正是开发通道，读的人认得键名。
 */
import { IS_ANDROID_APP } from './platform';
import type { LinkStatus } from './link';
import type { MessageKey } from './i18n';

export type LinkLogLevel = 'info' | 'warn' | 'error';

export interface LinkLogLine {
  /** 发生时刻（Unix 毫秒）；合并过的行取最近那一次 */
  at: number;
  level: LinkLogLevel;
  key: string;
  params?: Record<string, string | number>;
  /** 同一件事重复发生的次数（高频推送并成一行，别把连接历史挤出环外） */
  n: number;
  /** 合并用的稳定标识；空串 = 这种事件从不合并 */
  merge: string;
}

const CAP = 200;
/** 回看最近这么多行找同一种事件；再远就当新的一次发生，另起一行 */
const MERGE_LOOKBACK = 6;

let lines: LinkLogLine[] = [];
let snap: LinkLogLine[] = [];
const subs = new Set<() => void>();

function emit(): void {
  snap = lines.slice();
  for (const cb of Array.from(subs)) cb();
}

/** `useSyncExternalStore` 的取快照：只在真变了时换那个数组，否则每渲染都给新对象它会反复重读 */
export function linkLogSnapshot(): LinkLogLine[] {
  return snap;
}

export function subscribeLinkLog(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function clearLinkLog(): void {
  lines = [];
  emit();
}

/**
 * 记一行。同 `merge` 且就在最近几行里 → 计数加一、时间推到这次，不另起一行。
 *
 * 双写两份：console（桌面 CDP 读得到）与安卓原生桥（华为/鸿蒙默认压掉第三方 App 的 logcat，
 * 所以界面里这份环缓冲才是稳的诊断通道 —— 与扫码页那 60 条同一套办法）。
 */
export function logLink(
  level: LinkLogLevel,
  key: string,
  params?: Record<string, string | number>,
  merge = '',
): void {
  const now = Date.now();
  if (merge) {
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - MERGE_LOOKBACK; i--) {
      if (lines[i].merge !== merge) continue;
      lines[i] = { ...lines[i], at: now, params, n: lines[i].n + 1 };
      emit();
      return;
    }
  }
  lines.push({ at: now, level, key, params, n: 1, merge });
  if (lines.length > CAP) lines = lines.slice(lines.length - CAP);
  emit();

  const tail = params ? ` ${JSON.stringify(params)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[heid-link] ${key}${tail}`);
  if (IS_ANDROID_APP) {
    try {
      (window as unknown as { HeidBridge?: { log(msg: string): void } }).HeidBridge?.log(`${key}${tail}`);
    } catch { /* 桥不在（浏览器壳 / 测试）就算了 */ }
  }
}

/** 环里的时间戳 → `HH:MM:SS`（本地时区，与界面那份一致） */
function clockOf(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/**
 * 把环摊成一份纯文本：日志标签页里显示的就是它，「另存为」出去的也是它（多一行导出时间）。
 * 行格式与标签页一致，所以存出去那份跟屏幕上看到的对得上。
 */
export function renderLogText(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  header?: string,
): string {
  const body = snap.map((l) =>
    `${clockOf(l.at)}  ${t(l.key as MessageKey, l.params)}${l.n > 1 ? ` ×${l.n}` : ''}`,
  ).join('\n');
  return header ? `${header}\n${body}` : body;
}

/**
 * 另存出去的那份加一行头：脱离应用之后，一串光秃秃的时:分:秒说不清是哪天、哪台机器。
 * 头里那句跟着界面语言走（英文界面不该存出一行中文）。
 */
export function logFileHeader(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  device: string,
): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `# H.I.D.E ${t('link.logTitle')} · ${day} ${clockOf(d.getTime())} · ${device} · ${t('link.logCount', { n: snap.length })}`;
}

/* ---------------------------------------------------------------- 状态跃迁 */

/** 上一份快照：日志要记的是「变了什么」，不是每次推送的全量 */
let prev: LinkStatus | null = null;

/**
 * 把一次状态推送摊成「和上次相比变了的那件事」。
 * 由 `link.ts` 的 `installLinkLogging` 挂在状态订阅上 —— 这一份只认状态，不认命令、不认 React。
 */
export function logStatusChange(s: LinkStatus): void {
  const p = prev;
  prev = s;

  if (!p) {
    if (s.connected) logLink('info', 'link.log.here', { device: s.peerDevice, addr: s.peerAddr });
    else if (s.listening) logLink('info', 'link.log.listening', { port: s.port });
    else if (s.role === 'client') logLink('info', 'link.log.clientReady');
    else logLink('info', 'link.log.off');
    return;
  }

  if (!p.listening && s.listening) logLink('info', 'link.log.listening', { port: s.port });
  if (p.listening && !s.listening) logLink('info', 'link.log.stopped');

  /* 连上与断开**不在这里记**：那两件事 Rust 那侧说得更全（走的是配对还是免扫、对端 keyId、
     握手用了多少毫秒、这条连接活了多久），它随 `heid-link-log` 事件过来，见 `link.log.up` / `down`。
     这里再记一遍就会出现同一件事两行、时间还差几毫秒 —— 那份日志是要拿去对质的。 */

  if (s.listening && p.rootDisplay !== s.rootDisplay) {
    logLink('info', 'link.log.scope', { root: s.rootDisplay || '—' });
  }
  if (!p.firewallHint && s.firewallHint) logLink('warn', 'link.log.firewall');

  // 同一句错误反复推过来只记一次；换了内容才是新的一次失败
  if (s.lastError && s.lastError !== p.lastError) logLink('error', 'link.log.failed', { msg: s.lastError });
}
