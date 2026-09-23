/**
 * v1.5 阶段 0 的验收脚本（一次性工具，不进仓库）。
 *
 * 交付判据是「两端能互相 hello，抓包看不到明文」。这里用 Node 的 crypto 独立实现
 * 一遍对端协议（X25519 + HKDF-SHA256 + ChaCha20-Poly1305），与真应用握两次手：
 *   A. 应用当服务端，Node 当手机客户端；
 *   B. 应用当客户端，Node 当桌面服务端（含配对票不匹配、第二台被拒两条错误路径）。
 * 独立实现能通，才说明帧格式与密钥派生不是"只有 Rust 自己解得开"的私有约定。
 *
 * 用法：先 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri:dev`，
 * 再 `node link-verify.mjs`。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仓库根：本文件在 scripts/ 下，`ws` 从仓库的 node_modules 解析
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const CDP_PORT = 9223;
const TICKET = '0123456789abcdef0123456789abcdef';
/** 本脚本扮演的这一端派生密钥用的票；每个用例开始前要设成对端实际在用的那一张 */
let currentTicket = TICKET;
const INFO_C2S = Buffer.from('heid-link-v1 c2s');
const INFO_S2C = Buffer.from('heid-link-v1 s2c');
const X25519_PRIV_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_PUB_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const log = (...a) => console.log(...a);
const ok = (name, cond, extra = '') =>
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

/* ---------------------------------------------------------------- CDP */

async function cdpSession() {
  // Windows 下动态 import 必须是 file:// URL，裸绝对路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const { WebSocket } = await import(pathToFileURL(`${REPO}/node_modules/ws/wrapper.mjs`).href);
  const targets = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json' }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => res(JSON.parse(s)));
    }).on('error', rej);
  });
  const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url));
  if (!page) throw new Error('没找到应用页面 target：' + targets.map((t) => t.url).join(', '));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

  /** 在页面里调用应用的 Tauri 命令（走真实 IPC，因此 ACL 授权也被一并验到） */
  const invoke = async (cmd, args) => {
    const expr = `(async()=>{ try { return JSON.stringify({ok:true, v: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})}); } catch(e){ return JSON.stringify({ok:false, e: String(e && e.message || e)}); } })()`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(`${cmd}: ${JSON.stringify(r.error)}`);
    const parsed = JSON.parse(r.result?.result?.value ?? '{"ok":false,"e":"no value"}');
    if (!parsed.ok) throw new Error(`${cmd} 失败：${parsed.e}`);
    return parsed.v;
  };

  const close = () => ws.close();
  return { invoke, close, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(invoke, pred, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await invoke('link_status');
    if (pred(last)) return last;
    await sleep(120);
  }
  return last;
}

/* ---------------------------------------------------------------- 协议（Node 侧独立实现） */

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const rawPriv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { privateKey, publicKey, rawPub: Buffer.from(rawPub), rawPriv: Buffer.from(rawPriv) };
}

function peerPub(b64) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_PUB_PREFIX, Buffer.from(b64, 'base64')]),
    format: 'der', type: 'spki',
  });
}

function sharedSecret(mine, peerRawB64) {
  return Buffer.from(crypto.diffieHellman({ privateKey: mine.privateKey, publicKey: peerPub(peerRawB64) }));
}

function hkdf(ikm, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(currentTicket), info, 32));
}

/** ring 与本脚本对 12 字节 nonce 的解释一致：前 4 字节是小端计数器，后 8 字节是 nonce */
function nonceOf(seq) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(seq), 4);
  return n;
}

function seal(key, seq, plain) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonceOf(seq), { tagLength: 16 });
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function open(key, seq, frame) {
  const ct = frame.subarray(0, frame.length - 16);
  const tag = frame.subarray(frame.length - 16);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonceOf(seq), { tagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function writeFrame(sock, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([head, payload]));
}

/** 读一帧（长度前缀 + 载荷）；把线上原始字节一并回传给调用方做明文检查 */
function readFrame(sock) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      sock.off('data', onData);
      res({ payload: buf.subarray(4, 4 + len), head: buf.subarray(0, 4 + len) });
    };
    sock.on('data', onData);
    sock.once('error', rej);
    sock.once('close', () => rej(new Error('对端在成帧前关闭')));
  });
}

/* ---------------------------------------------------------------- A：应用当服务端 */

async function appAsServer(invoke) {
  log('\n=== A. 应用当服务端，Node 当手机客户端 ===');
  const st = await invoke('link_server_start', { port: 47123 });
  ok('link_server_start 返回 listening', st.listening === true, `port=${st.port}`);
  const ticket = await invoke('link_ticket');
  ok('配对码形状 32 hex', /^[0-9a-f]{32}$/.test(ticket), ticket.slice(0, 8) + '…');
  currentTicket = ticket;

  const conn = await new Promise((res, rej) => {
    const s = net.connect(47123, '127.0.0.1', () => { s.off('error', rej); res(s); });
    s.once('error', rej);
  });
  const mine = newKeyPair();
  writeFrame(conn, Buffer.from(JSON.stringify({
    t: 'hello', ver: 1, pub: mine.rawPub.toString('base64'), agent: 'heid-android-probe', device: 'Node-Probe',
  })));
  const helloAck = await readFrame(conn);
  const welcome = JSON.parse(helloAck.payload.toString());
  ok('应用回了 welcome 且带 32 字节公钥',
    welcome.t === 'welcome' && Buffer.from(welcome.pub, 'base64').length === 32);

  const shared = sharedSecret(mine, welcome.pub);
  const c2s = hkdf(shared, INFO_C2S);
  const s2c = hkdf(shared, INFO_S2C);
  // 应用侧 serve_conn 在握手后会立刻发一帧密文（用来让客户端第一时间发现票不匹配）
  const first = await readFrame(conn);
  const firstPlain = JSON.parse(open(s2c, 0, first.payload).toString());
  ok('应用首帧密文可被独立实现解开', firstPlain.msg?.t === 'ping', JSON.stringify(firstPlain));
  writeFrame(conn, seal(c2s, 0, Buffer.from(JSON.stringify({ seq: 0, msg: { t: 'pong' } }))));

  const s2 = await waitStatus(invoke, (x) => x.connected);
  ok('应用状态转为已连接并带上对端设备名',
    s2.connected === true && s2.peerDevice === 'Node-Probe', `${s2.peerDevice} @ ${s2.peerAddr}`);

  /* 线上明文检查：握手之后应用发出的字节里不得出现任何协议关键字或配对码 */
  const wire = Buffer.concat([first.head]);
  const hay = wire.toString('latin1');
  ok('应用发出的密文帧不含明文痕迹',
    !/ping|pong|seq|heid-link|ticket/.test(hay) && !hay.includes(TICKET),
    `${wire.length} 字节：${wire.subarray(4, 20).toString('hex')}…`);

  /* 第二台同时连：应被 busy 拒掉，而不是排队 */
  const second = await new Promise((res, rej) => {
    const s = net.connect(47123, '127.0.0.1', () => { s.off('error', rej); res(s); });
    s.once('error', rej);
  });
  const refused = await readFrame(second);
  const rj = JSON.parse(refused.payload.toString());
  ok('第二台收到 busy 拒绝', rj.t === 'refused' && rj.code === 'busy', rj.reason);
  conn.destroy(); second.destroy();
  await invoke('link_server_stop');
}

/* ---------------------------------------------------------------- B：应用当客户端 */

/** 起一个 Node 侧的"桌面"，role 决定它欢迎哪种连接 */
function nodeServer(port, { sendPingFirst = true } = {}) {
  const received = [];
  const server = net.createServer(async (sock) => {
    try {
      const { payload } = await readFrame(sock);
      received.push({ dir: 'in', bytes: payload });
      const hello = JSON.parse(payload.toString());
      if (hello.t !== 'hello') { sock.destroy(); return; }
      const mine = newKeyPair();
      writeFrame(sock, Buffer.from(JSON.stringify({ t: 'welcome', ver: 1, pub: mine.rawPub.toString('base64') })));
      const shared = sharedSecret(mine, hello.pub);
      const c2s = hkdf(shared, INFO_C2S);
      const s2c = hkdf(shared, INFO_S2C);
      if (sendPingFirst) writeFrame(sock, seal(s2c, 0, Buffer.from(JSON.stringify({ seq: 0, msg: { t: 'ping' } }))));
      const { payload: ct, head } = await readFrame(sock);
      received.push({ dir: 'out→in', bytes: head });
      const env = JSON.parse(open(c2s, 0, ct).toString());
      received.push({ env });
      writeFrame(sock, seal(s2c, 1, Buffer.from(JSON.stringify({ seq: 1, msg: { t: 'pong' } }))));
      setTimeout(() => sock.destroy(), 400);
    } catch {
      sock.destroy();
    }
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, received })));
}

async function appAsClient(invoke) {
  log('\n=== B. 应用当客户端，Node 当桌面服务端 ===');
  currentTicket = TICKET;
  const { server, received } = await nodeServer(47900);
  const st = await invoke('link_client_connect', {
    host: '127.0.0.1', port: 47900, ticket: TICKET, device: 'SM-X808U',
  });
  ok('link_client_connect 被接受', st.role === 'client' && st.port === 47900);

  const s2 = await waitStatus(invoke, (x) => x.connected || x.lastError);
  ok('应用侧状态为已连接', s2.connected === true, s2.lastError || s2.peerAddr);

  const hello = JSON.parse(received[0].bytes.toString());
  ok('应用发的 hello 是明文且只含版本/公钥/设备名',
    hello.t === 'hello' && hello.ver === 1 && hello.device === 'SM-X808U'
      && Buffer.from(hello.pub, 'base64').length === 32, JSON.stringify(hello.agent));
  ok('配对码从不出现在网络上',
    !received.some((r) => r.bytes?.toString('latin1')?.includes(TICKET)),
    `检查了 ${received.length} 段线上字节`);
  const cipher = received[1]?.bytes?.toString('latin1') ?? '';
  ok('握手后的帧是密文', !/ping|pong|seq/.test(cipher),
    `${received[1]?.bytes?.length ?? 0} 字节`);
  ok('Node 独立实现解开了应用的响应', received[2]?.env?.msg?.t === 'pong',
    JSON.stringify(received[2]?.env));
  server.close();
  await invoke('link_client_disconnect');
}

async function wrongTicket(invoke) {
  log('\n=== C. 配对票不匹配 ===');
  currentTicket = TICKET;
  const { server } = await nodeServer(47901);
  await invoke('link_client_connect', {
    host: '127.0.0.1', port: 47901, ticket: 'ffffffffffffffffffffffffffffffff', device: 'SM-X808U',
  });
  const s = await waitStatus(invoke, (x) => x.lastError.includes('配对票') || x.connected, 8000);
  ok('应用如实报出配对票不匹配', s.lastError.includes('配对票'), s.lastError);
  ok('且不会假装成已连接', s.connected === false);
  server.close();
  await invoke('link_client_disconnect');
}

async function badInputs(invoke) {
  log('\n=== D. 入参校验（前端挡不住时的第二道） ===');
  const cases = [
    ['空地址', () => invoke('link_client_connect', { host: ' ', port: 47123, ticket: TICKET, device: 'x' })],
    ['短配对码', () => invoke('link_client_connect', { host: '127.0.0.1', port: 47123, ticket: 'abc', device: 'x' })],
    ['端口越界', () => invoke('link_server_start', { port: 80 })],
  ];
  for (const [name, fn] of cases) {
    let msg = '';
    try { await fn(); msg = '(没报错)'; } catch (e) { msg = String(e.message ?? e); }
    ok(`${name} 被拒`, msg !== '(没报错)', msg);
  }
}

/* ---------------------------------------------------------------- main */

const { invoke, close } = await cdpSession();
try {
  // 上一轮若中途崩掉，服务端还占着端口：先把两端都归零再测
  try { await invoke('link_server_stop'); } catch {}
  try { await invoke('link_client_disconnect'); } catch {}
  await badInputs(invoke);
  await appAsServer(invoke);
  await appAsClient(invoke);
  await wrongTicket(invoke);
} finally {
  try { await invoke('link_server_stop'); } catch {}
  try { await invoke('link_client_disconnect'); } catch {}
  close();
}
log('\n完成。');
