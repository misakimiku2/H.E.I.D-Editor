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
 *   F 阶段 2：已加密连接上跑 list / stat / read / write，结果逐条与磁盘核对，
 *     含保存冲突回传桌面最新内容、四类逃逸被拒、超限文件拒开、没设根时拒答
 *
 * 用法：先 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri:dev`，
 * 再 `node scripts/link-verify.mjs`。跑之前先 link_server_stop（上一轮点开的共享不会随 dev 重启释放）。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  /** 直接在页面里求值（要动 localStorage 时用，不经过命令通道） */
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面求值失败：' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const close = () => ws.close();
  return { invoke, evalJs, close };
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
  // keys 带出去才好在握手之后继续发应用帧：两个方向的 seq 0 已被 pong / Auth 用掉
  return { conn, ls, fp, sigOk, fpMatch, cipherHead: first.head, mode, ticket, keys: { c2s, s2c } };
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

/* ------------------------------------------------- 阶段 2：命令面走真实连接 */

/** 配一次对并允许 TOFU，返回握手后的连接。与 A 段同一套流程，只是不带 A 那些断言。 */
async function pairedPhone(invoke, port) {
  const qr = await invoke('link_pair_qr');
  const p = parsePairUri(qr.uri);
  const pair = await phoneHandshake(port, { mode: 'pair', saltStr: p.ticket, ticket: p.ticket, expectFp: p.fp });
  for (let i = 0; i < 40; i++) {
    try { await invoke('link_pair_approve'); } catch { /* pending 还没挂上 */ }
    const st = await waitStatus(invoke, (x) => x.connected, 1000);
    if (st.connected) return pair;
    await sleep(150);
  }
  throw new Error('TOFU 允许之后仍未进入已连接');
}

async function stage2Files(invoke) {
  log('\n=== F. 阶段 2：真实加密链路上的 list / stat / read / write ===');
  /* 用 47124 而不是 A/D 的 47123：Windows 上上一台设备的连接留在 TIME_WAIT 时，
     按 SO_EXCLUSIVEADDRUSE 绑定的监听套接字会被拒绑（本机实测 45 秒未散，
     已由 link.rs::bind_listener 换成可操作文案）。本段的成败不该取决于上一段跑没跑过。 */
  const PORT = 47124;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'heid-stage2-'));
  const root = path.join(base, 'shared');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'sub'));
  const ORIGINAL = '# 桌面原有内容\r\n第二行\r\n';
  fs.writeFileSync(path.join(root, 'notes.md'), ORIGINAL);
  fs.writeFileSync(path.join(root, 'sub/b.txt'), 'gb\n');
  fs.writeFileSync(path.join(base, 'outside.md'), '根外的文件');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

  await invoke('link_server_start', { port: PORT });
  const st = await invoke('link_set_root', { path: root });
  const norm = (x) => String(x ?? '').replace(/[\\/]+$/, '').toLowerCase();
  ok('共享范围明示给前端（设置面板要显示它）', norm(st.rootDisplay) === norm(root), `rootDisplay=${st.rootDisplay}`);
  const pair = await pairedPhone(invoke, PORT);
  const connStatus = await invoke('link_status');
  ok('已连接状态带出对端 deviceId（hide-remote 的键）', /^[0-9a-f]{16}$/.test(connStatus.peerKeyId || ''), connStatus.peerKeyId);

  /* 应用帧序号从 1 起：握手已用掉两个方向的 0（手机回 pong、桌面发 Auth） */
  let tx = 1, rx = 1, idc = 0;
  const send = (msg) => {
    writeFrame(pair.conn, seal(pair.keys.c2s, tx, Buffer.from(JSON.stringify({ seq: tx, msg }))));
    tx += 1;
  };
  const ask = async (method, params) => {
    const id = ++idc;
    send({ t: 'req', id, method, params: JSON.stringify(params) });
    for (;;) {
      const f = await readFrame(pair.conn, 8000);
      const env = JSON.parse(open(pair.keys.s2c, rx, f.payload).toString());
      rx += 1;
      if (env.msg.t === 'ping') { send({ t: 'pong' }); continue; }
      if (env.msg.t === 'res' && env.msg.id === id) {
        return { ...env.msg, data: env.msg.data ? JSON.parse(env.msg.data) : null };
      }
      throw new Error(`等 res(${id}) 时收到 ${JSON.stringify(env.msg)}`);
    }
  };

  const listed = await ask('list', { relDir: '' });
  const names = (listed.data?.entries ?? []).map((e) => e.name);
  ok('list 根目录：目录在前、含 notes.md',
    listed.ok === true && names[0] === 'sub' && names.includes('notes.md'), JSON.stringify(names));
  ok('list 目录条目不带假尺寸',
    (listed.data?.entries ?? []).every((e) => (e.isDir ? e.size === 0 : e.size > 0)));

  const read1 = await ask('read', { relPath: 'notes.md' });
  ok('read 换行符原样带回（归一是前端 openedFromDecoded 的事）', read1.data?.text === ORIGINAL, JSON.stringify(read1.data?.text));
  const onDisk = fs.readFileSync(path.join(root, 'notes.md'));
  ok('read 的基线哈希 = 磁盘字节的 SHA-256', read1.data?.hash === sha(onDisk));
  ok('read 的编码与二进制判定与桌面同源', read1.data?.encoding === 'utf-8' && read1.data?.binary === false);
  const sub = await ask('read', { relPath: 'sub/b.txt' });
  ok('子目录里的文件按相对路径可达', sub.ok === true && sub.data?.text === 'gb\n');

  const WROTE = '# 从手机改的\r\n新行\r\n';
  const w1 = await ask('write', { relPath: 'notes.md', text: WROTE, encoding: 'utf-8', bom: false, baseHash: read1.data.hash });
  ok('write 基线一致 → 落盘且不判冲突', w1.ok === true && w1.data?.conflict === false);
  ok('桌面上真的看见了新内容（逐字节核对）', fs.readFileSync(path.join(root, 'notes.md'), 'utf8') === WROTE);
  ok('write 回传的新基线 = 新字节的哈希', w1.data?.hash === sha(Buffer.from(WROTE, 'utf8')));

  /* 冲突：手机拿旧基线写，桌面必须一个字都不写，并把最新那份带回给 diff 时间线 */
  const DESKTOP_NEW = '# 桌面上又改了一次';
  fs.writeFileSync(path.join(root, 'notes.md'), DESKTOP_NEW);
  const w2 = await ask('write', { relPath: 'notes.md', text: '# 手机上改的', encoding: 'utf-8', bom: false, baseHash: w1.data.hash });
  ok('基线不符 → 判冲突而不是覆盖', w2.ok === true && w2.data?.conflict === true);
  ok('冲突带回桌面最新内容', w2.data?.serverText === DESKTOP_NEW, JSON.stringify(w2.data?.serverText));
  ok('判冲突时桌面内容一字未动', fs.readFileSync(path.join(root, 'notes.md'), 'utf8') === DESKTOP_NEW);
  const w3 = await ask('write', { relPath: 'notes.md', text: 'x', encoding: 'utf-8', bom: false, baseHash: w2.data.serverHash });
  ok('换成带回的新基线后同一次保存就能落盘', w3.ok === true && w3.data?.conflict === false);
  const w4 = await ask('write', { relPath: 'notes.md', text: 'x', encoding: 'utf-8', bom: false, baseHash: '' });
  ok('没有基线的写入被拒（而不是静默覆盖）', w4.ok === false && w4.code === 'badparams', w4.error);

  /* 逃逸：这一层写错就等于把整个磁盘交给局域网 */
  const esc = [
    ['read 上跳一层', 'read', { relPath: '../outside.md' }, 'badpath'],
    ['read 借子目录上跳', 'read', { relPath: 'sub/../../base/outside.md' }, 'badpath'],
    ['read 绝对路径', 'read', { relPath: 'C:/Windows/win.ini' }, 'absolute'],
    ['read UNC', 'read', { relPath: '\\\\server\\share\\x' }, 'absolute'],
    ['write 出根', 'write', { relPath: '../outside.md', text: 'x', encoding: 'utf-8', baseHash: 'aa' }, 'badpath'],
    ['list 出根', 'list', { relDir: '..' }, 'badpath'],
  ];
  for (const [name, method, params, want] of esc) {
    const r = await ask(method, params);
    ok(`${name} 被拒（${want}）`, r.ok === false && r.code === want, `${r.code} ${r.error ?? ''}`);
  }
  ok('根外文件逐字未变', fs.readFileSync(path.join(base, 'outside.md'), 'utf8') === '根外的文件');

  /* 上限、缺失与越界之外 */
  const big = path.join(root, 'huge.bin');
  fs.writeFileSync(big, Buffer.alloc(0));
  fs.truncateSync(big, 7 * 1024 * 1024);
  const bigStat = await ask('stat', { relPath: 'huge.bin' });
  ok('stat 报得出超限文件的尺寸', bigStat.ok === true && bigStat.data?.size === 7 * 1024 * 1024, `size=${bigStat.data?.size}`);
  ok('超限文件不为其读全文件算哈希', bigStat.data?.hash === '');
  const bigRead = await ask('read', { relPath: 'huge.bin' });
  ok('超限文件拒绝远程打开', bigRead.ok === false && bigRead.code === 'toobig', bigRead.error);
  const miss = await ask('read', { relPath: 'nope.md' });
  ok('不存在的路径报 notfound', miss.ok === false && miss.code === 'notfound');
  const unknown = await ask('delete', {});
  ok('命令面之外的方法被拒', unknown.ok === false && unknown.code === 'unknown');

  await invoke('link_set_root', { path: null });
  const noroot = await ask('list', { relDir: '' });
  ok('清除共享范围后一律拒答（noroot）', noroot.ok === false && noroot.code === 'noroot');

  await invoke('link_server_stop');
  pair.conn.destroy();
  fs.rmSync(base, { recursive: true, force: true });
}

/** 按连接持续成帧的读取器。
    `readFrame` 每次挂一个新 listener、只取一帧，一次 data 事件里夹着的**第二帧会被丢掉**——
    前端并发两笔远程命令会合并进同一个 TCP 段，所以服务端这一侧必须自己缓冲。 */
function frameReader(sock) {
  let buf = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) break;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      frames.push(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
    while (waiters.length && frames.length) waiters.shift()({ payload: frames.shift() });
  });
  return (timeoutMs = 5000) =>
    new Promise((res, rej) => {
      if (frames.length) return res({ payload: frames.shift() });
      const t = setTimeout(() => rej(new Error('读取帧超时')), timeoutMs);
      waiters.push((f) => { clearTimeout(t); res(f); });
    });
}

/* ------------------------------- 阶段 2 手机侧：应用当客户端发远程命令 */

/** Node 当「会答远程命令的桌面」：握手后收 req、按 fsrv 的形状回 res，并记下收到的一切。 */
function nodeFileServer(port, { saltStr, identity }) {
  const seen = { methods: [], ids: [] };
  let live = null; // 已建立的连接：测试要能真的掐掉它，server.close() 只挡新连接
  const server = net.createServer(async (sock) => {
    live = sock;
    try {
      const next = frameReader(sock);
      const { payload } = await next();
      const hello = JSON.parse(payload.toString());
      const mine = newKeyPair();
      writeFrame(sock, Buffer.from(JSON.stringify({ t: 'welcome', ver: 1, pub: mine.rawPub.toString('base64') })));
      const shared = sharedSecret(mine, hello.pub);
      const { c2s, s2c } = keysFrom(shared, saltStr);
      const idPub = identity.rawPub;
      const sig = identity.sign(authMessage(SRV4, Buffer.from(hello.pub, 'base64'), mine.rawPub, idPub));
      writeFrame(sock, seal(s2c, 0, Buffer.from(JSON.stringify({ seq: 0, msg: { t: 'auth', id: idPub.toString('base64'), sig: sig.toString('base64') } }))));
      let cseq = 0; // 应用第一帧密文是 pong（seq 0），之后每个 req 递增
      let sseq = 1; // 本端密文序号：0 已被 auth 用掉
      for (;;) {
        const { payload: raw } = await next(30_000);
        const env = JSON.parse(open(c2s, cseq, raw).toString());
        cseq = env.seq + 1;
        const m = env.msg;
        if (m.t !== 'req') continue;
        seen.methods.push(m.method);
        seen.ids.push(m.id);
        const p = JSON.parse(m.params || '{}');
        let out;
        if (m.method === 'list') {
          out = { ok: true, data: JSON.stringify({ entries: [{ name: 'notes.md', isDir: false, size: 4, mtimeMs: 111 }], truncated: false }) };
        } else if (m.method === 'read' && p.relPath === 'notes.md') {
          out = { ok: true, data: JSON.stringify({ text: '# hi', encoding: 'utf-8', bom: false, lossy: false, binary: false, hash: 'hash-of-notes', size: 4, mtimeMs: 111 }) };
        } else if (m.method === 'read') {
          out = { ok: false, code: 'badpath', error: '路径不合法：不允许上级目录' };
        } else if (m.method === 'write') {
          // 故意回成"桌面也改过"，看前端能不能把它接到 diff 时间线而不是报保存失败
          out = { ok: true, data: JSON.stringify({ conflict: true, hash: 'h2', size: 9, mtimeMs: 222, serverHash: 'srv-h', serverText: '桌面上改的', serverEncoding: 'utf-8', serverBom: false, serverBinary: false }) };
        } else {
          out = { ok: false, code: 'unknown', error: '桌面不支持的命令' };
        }
        writeFrame(sock, seal(s2c, sseq, Buffer.from(JSON.stringify({
          seq: sseq,
          msg: { t: 'res', id: m.id, ok: out.ok, code: out.code ?? '', error: out.error ?? '', data: out.data ?? '' },
        }))));
        sseq += 1;
      }
    } catch { /* 对端断开即收摊 */ }
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({
    server, seen, drop: () => live && live.destroy(),
  })));
}

async function appAsClientFiles(invoke) {
  log('\n=== G. 阶段 2 手机侧：应用作为客户端发 list / read / write ===');
  const PORT = 47903;
  const TICKET = '0123456789abcdef0123456789abcdef';
  const { server, seen, drop } = await nodeFileServer(PORT, { saltStr: TICKET, identity: newEd25519() });
  /* 桌面恒为服务端是产品设定：开关记着「开」时，页面每次挂载都会 autoStartFromPrefs 起监听，
     那会把这一段的客户端角色抢回去（表现为「连不上也不报错」，因为 publish 顺手清了 lastError）。
     本段是故意把桌面当手机用的，所以先把持久化的开关关掉，再停掉可能在听的监听。 */
  await evalJs(`const k='heid-link-prefs';const p=JSON.parse(localStorage.getItem(k)||'{}');p.enabled=false;localStorage.setItem(k,JSON.stringify(p));return true;`);
  await invoke('link_server_stop');
  await invoke('link_client_connect', { host: '127.0.0.1', port: PORT, ticket: TICKET, device: 'SM-X808U' });
  const up = await waitStatus(invoke, (x) => x.connected || x.lastError, 8000);
  ok('客户端连上并进入已连接', up.connected === true, up.lastError || up.peerAddr);
  ok('已连接状态带出对端 deviceId（远程路径的键）', /^[0-9a-f]{16}$/.test(up.peerKeyId || ''), up.peerKeyId);

  const listed = JSON.parse(await invoke('link_request', { method: 'list', params: JSON.stringify({ relDir: '' }) }));
  ok('远程 list 走通队列→发送→应答→唤醒等待者',
    listed.entries?.[0]?.name === 'notes.md' && listed.truncated === false, JSON.stringify(listed));
  const read1 = JSON.parse(await invoke('link_request', { method: 'read', params: JSON.stringify({ relPath: 'notes.md' }) }));
  ok('远程 read 带回解码结果与基线哈希', read1.text === '# hi' && read1.hash === 'hash-of-notes');

  /* 两笔并发：错配 id 的话，其中一笔会拿到另一笔的载荷 */
  const both = await Promise.all([
    invoke('link_request', { method: 'read', params: JSON.stringify({ relPath: 'notes.md' }) }),
    invoke('link_request', { method: 'write', params: JSON.stringify({ relPath: 'notes.md', baseHash: 'stale' }) }),
  ]);
  ok('并发两笔各回各的（按 id 配对，不是按到达顺序）',
    JSON.parse(both[0]).text === '# hi' && JSON.parse(both[1]).conflict === true, JSON.stringify(both).slice(0, 90));
  const conflict = JSON.parse(both[1]);
  ok('冲突是一笔成功应答并带回桌面内容', conflict.serverText === '桌面上改的' && conflict.serverHash === 'srv-h');

  let rejected = '';
  try { await invoke('link_request', { method: 'read', params: JSON.stringify({ relPath: '../x' }) }); }
  catch (e) { rejected = String(e?.message ?? e); }
  /* invoke 的包装会自己加「link_request 失败：」前缀，所以看的是码在不在最前面那段 */
  ok('失败以「码: 原因」的形状抛给前端（remote.ts 按码分流）', /badpath: 路径不合法/.test(rejected), rejected);

  /* 断链后不得让前端等满 30 秒超时 */
  const t0 = Date.now();
  server.close();
  drop();
  await new Promise((res) => {
    const iv = setInterval(() => invoke('link_status').then((s) => { if (!s.connected) { clearInterval(iv); res(); } }), 100);
    setTimeout(() => { clearInterval(iv); res(); }, 6000);
  });
  let after = '';
  try { await invoke('link_request', { method: 'list', params: '{}' }); } catch (e) { after = String(e?.message ?? e); }
  const waited = Date.now() - t0;
  ok('断开后的请求立刻报错而不是等超时', /(没.{0,3}连着|断开|未连接)/.test(after) && waited < 12_000, `${waited}ms · ${after}`);
  await invoke('link_client_disconnect');
}

/* ---------------------------------------------------------------- main */

// 兜底看门狗：无论如何 100 秒内退出，免得某个 await 卡住把 dev 拖住
setTimeout(() => { log('\nWATCHDOG: 超时，强制退出'); process.exit(2); }, 180_000).unref();

log('main: 连接 CDP…');
const { invoke, evalJs, close } = await cdpSession();
log('main: CDP 就绪，开始用例');
/* LINK_VERIFY_ONLY=G 只跑某一段：调试时不必等 A–F 的四十秒，也避开前一段留下的状态 */
const ONLY = (process.env.LINK_VERIFY_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
async function safe(name, fn) {
  if (ONLY.length && !ONLY.some((k) => name.includes(k))) return;
  try { await fn(); } catch (e) { ok(`${name} 未抛异常`, false, String(e?.message ?? e)); }
}
try {
  try { await invoke('link_server_stop'); } catch { /* */ }
  try { await invoke('link_client_disconnect'); } catch { /* */ }
  await safe('入参校验', () => badInputs(invoke));
  await safe('A 应用当服务端', () => appAsServer(invoke));
  await safe('F 阶段 2 命令面', () => stage2Files(invoke));
  await safe('G 阶段 2 手机侧通路', () => appAsClientFiles(invoke));
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
