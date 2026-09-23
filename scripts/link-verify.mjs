/**
 * v1.5 设备互联的运行时验收脚本（一次性工具）。
 *
 * 交付判据：两端能握手、抓包看不到明文（阶段 0），且阶段 1 的配对 → TOFU → 记住设备 →
 * 免扫自动重连 端到端成立。关键是这里用 Node 的 crypto **独立实现**一遍对端协议
 * （X25519 + HKDF + ChaCha20-Poly1305 + Ed25519 身份签名 + LS 派生），与真应用握多次手。
 * 独立实现能通，才说明帧格式、密钥派生、身份签名不是「只有 Rust 自己解得开」的私有约定。
 *
 * 覆盖：
 *   A 应用当服务端：Node 当手机走「配对 + 允许 TOFU + 验桌面指纹 + LS 对称 + 免扫重连 + 票用后即废」
 *   B 应用当客户端：Node 当桌面（带身份、发 Auth）；含「期望指纹不符 → 应用中止」
 *   C 配对票不匹配、D 入参校验、E 未登记 keyId 的重连被拒
 *
 * 用法：先 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri:dev`，
 * 再 `node scripts/link-verify.mjs`。跑之前先 link_server_stop（上一轮点开的共享不会随 dev 重启释放）。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const CDP_PORT = 9223;
const INFO_C2S = Buffer.from('heid-link-v1 c2s');
const INFO_S2C = Buffer.from('heid-link-v1 s2c');
const LS_INFO = Buffer.from('heid-link-ls-v1');
const CODE_PREFIX = Buffer.from('heid-link-shortcode-v1');
const X25519_PRIV_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_PUB_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 同步写 fd 1：脚本可能中途挂起或被看门狗终止，异步缓冲的 console.log 会丢掉已跑过的行
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
const ok = (name, cond, extra = '') =>
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`${label} 超时 ${ms}ms`); }),
  ]);
}

/* ---------------------------------------------------------------- CDP */

async function cdpSession() {
  const { WebSocket } = await import(pathToFileURL(`${REPO}/node_modules/ws/wrapper.mjs`).href);
  const targets = await withTimeout(new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json' }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => res(JSON.parse(s)));
    }).on('error', rej);
  }), 8000, '取 CDP /json 列表');
  const pages = targets.filter((t) => t.type === 'page');
  const page = pages.find((t) => /localhost:\d+/.test(t.url)) || pages[0];
  if (!page) throw new Error('没有 page target：' + targets.map((t) => t.url).join(', '));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await withTimeout(new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }), 8000, '连 CDP ws');
  let id = 0;
  const pending = new Map();
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    withTimeout(new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); }), 15000, `CDP ${method}`);

  const invoke = async (cmd, args) => {
    const expr = `(async()=>{ try { return JSON.stringify({ok:true, v: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})}); } catch(e){ return JSON.stringify({ok:false, e: String(e && e.message || e)}); } })()`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(`${cmd}: ${JSON.stringify(r.error)}`);
    const parsed = JSON.parse(r.result?.result?.value ?? '{"ok":false,"e":"no value"}');
    if (!parsed.ok) throw new Error(`${cmd} 失败：${parsed.e}`);
    return parsed.v;
  };
  const close = () => ws.close();
  return { invoke, close };
}

async function waitStatus(invoke, pred, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await invoke('link_status');
    if (pred(last)) return last;
    await sleep(120);
  }
  return last;
}

/* ------------------------------------------------- 协议（Node 侧独立实现，对齐 identity.rs/pair.rs） */

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey, rawPub: Buffer.from(rawPub) };
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
function hkdf(ikm, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));
}
const keysFrom = (shared, saltStr) => ({
  c2s: hkdf(shared, Buffer.from(saltStr), INFO_C2S),
  s2c: hkdf(shared, Buffer.from(saltStr), INFO_S2C),
});
/** 长期链路密钥：只掺 shared、空 salt —— 与 pair::derive_link_secret 对齐 */
const deriveLS = (shared) => hkdf(shared, Buffer.alloc(0), LS_INFO);
const keyIdHex = (ls) => crypto.createHash('sha256').update(ls).digest().subarray(0, 8).toString('hex');
/** 6 位短码：sha256(prefix+secret) 前 4 字节大端 % 1e6 —— 与 pair::short_code 对齐 */
function shortCode(secret) {
  const d = crypto.createHash('sha256').update(Buffer.concat([CODE_PREFIX, Buffer.from(secret)])).digest();
  return String(d.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
function base32(bytes) {
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
/** 指纹：base32(SHA-256(pub)[:8]) —— 与 identity::fingerprint 对齐 */
const fingerprint = (pubRaw) => base32(crypto.createHash('sha256').update(pubRaw).digest().subarray(0, 8));
/** 身份证明要签的字节 —— 与 identity::auth_message 对齐 */
function authMessage(who4, clientPub, serverPub, idPub) {
  return Buffer.concat([Buffer.from('heid-link-auth-v1'), who4, clientPub, serverPub, idPub]);
}
const SRV4 = Buffer.from([0x73, 0x72, 0x76, 0x00]); // "srv\0"
function ed25519Verify(pubRaw, msg, sigRaw) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_PUB_PREFIX, pubRaw]), format: 'der', type: 'spki',
  });
  return crypto.verify(null, msg, key, sigRaw);
}

function nonceOf(seq) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(seq), 4);
  return n;
}
function seal(key, seq, plain) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonceOf(seq), { tagLength: 16 });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function open(key, seq, frame) {
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonceOf(seq), { tagLength: 16 });
  d.setAuthTag(frame.subarray(frame.length - 16));
  return Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()]);
}
function writeFrame(sock, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([head, payload]));
}
function readFrame(sock, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); rej(new Error('readFrame 超时')); }, timeoutMs);
    const onError = () => { cleanup(); rej(new Error('对端在成帧前关闭')); };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      cleanup();
      res({ payload: buf.subarray(4, 4 + len), head: buf.subarray(0, 4 + len) });
    };
    function cleanup() {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onError);
    }
    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onError);
  });
}
function tcp(port) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => { s.off('error', rej); res(s); });
    s.once('error', rej);
  });
}
function parsePairUri(uri) {
  const q = new URL(uri.replace('hide-link://', 'http://x/')).searchParams;
  return { host: q.get('host'), port: +q.get('port'), ticket: q.get('ticket'), name: q.get('name'), fp: q.get('fp') };
}

/* ---------------------------------------------------- Node 当手机：配对一次握手 */

/** 连上 port，按 mode 走完一次握手（含验桌面 Auth），返回握手后仍在的 socket + LS + 明文痕迹。 */
async function phoneHandshake(port, { mode, saltStr, ticket, keyId = '', slot = 'ticket', device = 'Node-Probe', expectFp = null }) {
  const conn = await tcp(port);
  const mine = newKeyPair();
  writeFrame(conn, Buffer.from(JSON.stringify({
    t: 'hello', ver: 1, pub: mine.rawPub.toString('base64'), agent: 'heid-android-probe',
    device, mode, key_id: keyId, slot,
  })));
  const welcome = JSON.parse((await readFrame(conn)).payload.toString());
  const shared = sharedSecret(mine, welcome.pub);
  const { c2s, s2c } = keysFrom(shared, saltStr);
  const first = await readFrame(conn);
  const env = JSON.parse(open(s2c, 0, first.payload).toString());
  const auth = env.msg;
  const idPub = Buffer.from(auth.id, 'base64');
  const fp = fingerprint(idPub);
  const msg = authMessage(SRV4, mine.rawPub, Buffer.from(welcome.pub, 'base64'), idPub);
  const sigOk = ed25519Verify(idPub, msg, Buffer.from(auth.sig, 'base64'));
  writeFrame(conn, seal(c2s, 0, Buffer.from(JSON.stringify({ seq: 0, msg: { t: 'pong' } }))));
  const ls = deriveLS(shared);
  const fpMatch = !expectFp || fp === expectFp;
  return { conn, ls, fp, sigOk, fpMatch, cipherHead: first.head, mode, ticket };
}

/* ---------------------------------------------------- A：应用当服务端（手机视角） */

async function appAsServer(invoke) {
  log('\n=== A. 应用当服务端，Node 当手机：配对 → TOFU → LS 对称 → 免扫重连 → 票作废 ===');
  const st = await invoke('link_server_start', { port: 47123 });
  ok('link_server_start 起监听', st.listening === true, `port=${st.port}`);

  const qr = await invoke('link_pair_qr');
  const p = parsePairUri(qr.uri);
  ok('pair_qr 载荷含 32hex 票 + 13 字符 base32 指纹',
    /^[0-9a-f]{32}$/.test(p.ticket) && /^[A-Z2-7]{13}$/.test(p.fp), `${p.ticket.slice(0, 8)}… fp=${p.fp}`);
  ok('二维码 URI 带本机局域网地址', !!p.host, `host=${p.host}:${p.port}`);
  ok('6 位短码 = Node 侧独立派生的同一个', qr.code === shortCode(p.ticket), `app=${qr.code} node=${shortCode(p.ticket)}`);

  // 配对：salt = 票
  const pair = await phoneHandshake(47123, { mode: 'pair', saltStr: p.ticket, ticket: p.ticket, expectFp: p.fp });
  ok('Node 验出桌面身份签名', pair.sigOk);
  ok('桌面身份指纹 = 二维码里的指纹（防抢答）', pair.fpMatch, `live=${pair.fp}`);
  const cipher = pair.cipherHead.subarray(4).toString('latin1');
  ok('握手后首帧密文无明文痕迹', !/auth|sig|pong|seq|heid-link/.test(cipher) && !cipher.includes(p.ticket));

  // TOFU 有竞态：服务端读完 pong 才挂 pending；approve 到生效前反复点，直到连上
  let conn = null;
  for (let i = 0; i < 40; i++) {
    try { await invoke('link_pair_approve'); } catch { /* pending 还没挂上 */ }
    conn = await waitStatus(invoke, (x) => x.connected, 1000);
    if (conn.connected) break;
    await sleep(150);
  }
  ok('允许 TOFU 后应用状态转已连接 + 带手机名',
    conn && conn.connected && conn.peerDevice === 'Node-Probe', conn ? `${conn.peerDevice} @ ${conn.peerAddr}` : '未连上');

  const list = await invoke('link_pairings_list');
  const kid = keyIdHex(pair.ls);
  ok('两端 LS 对称：应用登记出的 keyId 与 Node 算的一致',
    list.some((d) => d.keyId === kid), `node=${kid} app=${JSON.stringify(list.map((d) => d.keyId))}`);

  // 免扫重连：salt = LS 的十六进制，keyId 带上；桌面按 keyId 查它存的同一把 LS
  pair.conn.destroy();
  await sleep(200);
  const re = await phoneHandshake(47123, { mode: 'reconnect', saltStr: pair.ls.toString('hex'), keyId: kid, expectFp: p.fp });
  ok('重连握手用存下的 LS 成功、身份仍匹配', re.sigOk && re.fpMatch);
  const reConnected = await waitStatus(invoke, (x) => x.connected, 4000);
  ok('免扫重连后应用再次已连接（没弹第二次 TOFU）', reConnected.connected === true);
  re.conn.destroy();
  // 等应用确实断开再试二次配对，否则先撞上"同一时刻只服务一台"的 busy 门（它在票检查之前）
  await waitStatus(invoke, (x) => !x.connected, 4000);

  // 票用后即废：拿刚配过的那张票再来一次配对，应被拒（已消费）
  const bad = await tcp(47123);
  const badEph = newKeyPair();
  writeFrame(bad, Buffer.from(JSON.stringify({
    t: 'hello', ver: 1, pub: badEph.rawPub.toString('base64'), agent: 'x', device: 'Ghost',
    mode: 'pair', key_id: '', slot: 'ticket',
  })));
  const refusedFrame = await readFrame(bad);
  const rj = JSON.parse(refusedFrame.payload.toString());
  ok('一次性票用后即废（二次配对被拒）', rj.t === 'refused' && rj.code === 'ticket', rj.reason || JSON.stringify(rj));
  bad.destroy();
  await invoke('link_server_stop');
}

/* ---------------------------------------------------- B/C/D/E：Node 当桌面 与错误路径 */

/** 起一个 Node 侧「桌面」：带一把身份、握手后发 Auth。返回它观察到的东西。 */
function nodeDesktop(port, { saltStr, identity }) {
  const seen = { hello: null, plain: [], cipher: null, shared: null };
  const server = net.createServer(async (sock) => {
    try {
      const { payload } = await readFrame(sock);
      seen.plain.push(payload);
      const hello = JSON.parse(payload.toString());
      seen.hello = hello;
      const mine = newKeyPair();
      writeFrame(sock, Buffer.from(JSON.stringify({ t: 'welcome', ver: 1, pub: mine.rawPub.toString('base64') })));
      const shared = sharedSecret(mine, hello.pub);
      seen.shared = shared;
      const { c2s, s2c } = keysFrom(shared, saltStr);
      const idPub = identity.rawPub;
      const sig = identity.sign(authMessage(SRV4, Buffer.from(hello.pub, 'base64'), mine.rawPub, idPub));
      writeFrame(sock, seal(s2c, 0, Buffer.from(JSON.stringify({ seq: 0, msg: { t: 'auth', id: idPub.toString('base64'), sig: sig.toString('base64') } }))));
      const { head } = await readFrame(sock);
      seen.cipher = head;
      setTimeout(() => sock.destroy(), 300);
    } catch { sock.destroy(); }
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, seen })));
}

function newEd25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    privateKey,
    rawPub: Buffer.from(rawPub),
    sign: (m) => Buffer.from(crypto.sign(null, m, privateKey)),
  };
}

async function appAsClient(invoke) {
  log('\n=== B. 应用当客户端，Node 当桌面：hello 明文只含版本/公钥/设备名/模式，票不上网 ===');
  const TICKET = '0123456789abcdef0123456789abcdef';
  const id = newEd25519();
  const { server, seen } = await nodeDesktop(47900, { saltStr: TICKET, identity: id });
  await invoke('link_client_connect', { host: '127.0.0.1', port: 47900, ticket: TICKET, device: 'SM-X808U' });
  const s = await waitStatus(invoke, (x) => x.connected || x.lastError, 8000);
  ok('应用作为客户端连上并验过桌面身份', s.connected === true, s.lastError || s.peerAddr);
  const hello = seen.hello || {};
  ok('应用发的 hello 是 pair 模式、带 32 字节公钥',
    hello.t === 'hello' && hello.ver === 1 && hello.mode === 'pair'
      && Buffer.from(hello.pub, 'base64').length === 32, `slot=${hello.slot} device=${hello.device}`);
  ok('配对票从不出现在网络上', !seen.plain.some((b) => b.toString('latin1').includes(TICKET)));
  const pong = (() => {
    if (!seen.shared || !seen.cipher) return false;
    try {
      const { c2s } = keysFrom(seen.shared, TICKET);
      const env = JSON.parse(open(c2s, 0, seen.cipher.subarray(4)).toString());
      return env.msg.t === 'pong';
    } catch { return false; }
  })();
  ok('应用验证过 Node 出的 Auth 并回了 pong（Node 独立实现解得开）', pong);
  server.close();
  await invoke('link_client_disconnect');
}

async function wrongFp(invoke) {
  log('\n=== C. 桌面身份指纹与码里不符 → 应用中止（防同网段抢答）===');
  const TICKET = '0123456789abcdef0123456789abcdef';
  const wrongId = newEd25519();
  // 服务端用 wrongId 这把身份；塞给应用的期望指纹是另一串 → 必然不符
  const { server } = await nodeDesktop(47901, { saltStr: TICKET, identity: wrongId });
  const bogusFp = 'ABCDEFGHIJKLM'; // 与 wrongId 的真实指纹不符
  const uri = `hide-link://pair?host=127.0.0.1&port=47901&ticket=${TICKET}&name=Node-Desktop&fp=${bogusFp}`;
  await invoke('link_client_pair', { uri, device: 'SM-X808U' });
  const s = await waitStatus(invoke, (x) => x.lastError.includes('指纹') || x.connected, 8000);
  ok('指纹不符时应用如实中止、不假装连上', s.lastError.includes('指纹') && !s.connected, s.lastError);
  server.close();
  await invoke('link_client_disconnect');
}

async function unknownKeyId(invoke) {
  log('\n=== D. 未登记 keyId 的重连被服务端拒 ===');
  await invoke('link_server_start', { port: 47123 });
  const conn = await tcp(47123);
  const mine = newKeyPair();
  writeFrame(conn, Buffer.from(JSON.stringify({
    t: 'hello', ver: 1, pub: mine.rawPub.toString('base64'), agent: 'x', device: 'Ghost',
    mode: 'reconnect', key_id: 'deadbeefdeadbeef', slot: '',
  })));
  const rj = JSON.parse((await readFrame(conn)).payload.toString());
  ok('未知 keyId 收到 refused（不排队、不静默）', rj.t === 'refused', rj.code || JSON.stringify(rj));
  conn.destroy();
  await invoke('link_server_stop');
}

async function badInputs(invoke) {
  log('\n=== E. 入参校验（前端挡不住时的第二道）===');
  const cases = [
    ['空地址', () => invoke('link_client_connect', { host: ' ', port: 47123, ticket: '0123456789abcdef0123456789abcdef', device: 'x' })],
    ['短配对码', () => invoke('link_client_connect', { host: '127.0.0.1', port: 47123, ticket: 'abc', device: 'x' })],
    ['端口越界', () => invoke('link_server_start', { port: 80 })],
    ['坏 hide-link uri', () => invoke('link_client_pair', { uri: 'http://example.com', device: 'x' })],
    ['非 6 位短码', () => invoke('link_client_pair_code', { host: '127.0.0.1', port: 47123, code: '12', device: 'x' })],
  ];
  for (const [name, fn] of cases) {
    let msg = '';
    try { await fn(); msg = '(没报错)'; } catch (e) { msg = String(e.message ?? e); }
    ok(`${name} 被拒`, msg !== '(没报错)', msg);
  }
}

/* ---------------------------------------------------------------- main */

// 兜底看门狗：无论如何 100 秒内退出，免得某个 await 卡住把 dev 拖住
setTimeout(() => { log('\nWATCHDOG: 超时，强制退出'); process.exit(2); }, 100_000).unref();

log('main: 连接 CDP…');
const { invoke, close } = await cdpSession();
log('main: CDP 就绪，开始用例');
async function safe(name, fn) {
  try { await fn(); } catch (e) { ok(`${name} 未抛异常`, false, String(e?.message ?? e)); }
}
try {
  try { await invoke('link_server_stop'); } catch { /* */ }
  try { await invoke('link_client_disconnect'); } catch { /* */ }
  await safe('入参校验', () => badInputs(invoke));
  await safe('A 应用当服务端', () => appAsServer(invoke));
  await safe('B 应用当客户端', () => appAsClient(invoke));
  await safe('C 指纹不符', () => wrongFp(invoke));
  await safe('D 未登记 keyId', () => unknownKeyId(invoke));
} finally {
  try { await invoke('link_server_stop'); } catch { /* */ }
  try { await invoke('link_client_disconnect'); } catch { /* */ }
  close();
}
log('\n完成。');
process.exit(0);
