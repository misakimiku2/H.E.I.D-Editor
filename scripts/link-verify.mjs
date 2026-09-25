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

/** 当前所有页面 target（多窗口时每个文档窗各一个，URL 全是同一个 localhost，只能按 label 分） */
async function listPages() {
  const targets = await withTimeout(new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json' }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => res(JSON.parse(s)));
    }).on('error', rej);
  }), 8000, '取 CDP /json 列表');
  return targets.filter((t) => t.type === 'page');
}

/** 连到指定窗口（'main' / 'win-N'）：逐个 target 试，用页面自己的 Tauri 元数据认领标签。
    标题不可靠 —— 标题跟着激活文档变，两个窗口可能同名。 */
async function attach(label, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    for (const p of await listPages()) {
      let s = null;
      try {
        s = await openPage(p);
        const got = await s.evalJs('return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ""');
        if (got === label) return s;
      } catch { /* 这个 target 可能正在导航，下一轮再试 */ }
      s?.close();
    }
    await sleep(400);
  }
  throw new Error(`找不到窗口标签为 ${label} 的页面 target`);
}

async function openPage(page) {
  const { WebSocket } = await import(pathToFileURL(`${REPO}/node_modules/ws/wrapper.mjs`).href);
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

/** 连上 port，按 mode 走完一次握手（含验桌面 Auth），返回握手后仍在的 socket + LS + 明文痕迹。
    返回的 `next` 是这条连接**唯一**的读取器，从第一帧起就挂着 —— 调用方一律用它取帧，
    不要再对同一个 socket 另起一个 frameReader 或 readFrame。 */
async function phoneHandshake(port, { mode, saltStr, ticket, keyId = '', slot = 'ticket', device = 'Node-Probe', expectFp = null }) {
  const conn = await tcp(port);
  const next = frameReader(conn);
  const mine = newKeyPair();
  writeFrame(conn, Buffer.from(JSON.stringify({
    t: 'hello', ver: 1, pub: mine.rawPub.toString('base64'), agent: 'heid-android-probe',
    device, mode, key_id: keyId, slot,
  })));
  const welcome = JSON.parse((await next()).payload.toString());
  const shared = sharedSecret(mine, welcome.pub);
  const { c2s, s2c } = keysFrom(shared, saltStr);
  const first = await next();
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
  return { conn, next, ls, fp, sigOk, fpMatch, cipherHead: first.head, mode, ticket, keys: { c2s, s2c } };
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
  // 从现在开始这条 socket 上的帧只由这一个读取器经手（它在握手前就挂上了）
  const nextOnPair = pair.next;
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

  /* 桌面「开始服务你了」的信号：一进 run_pump 就发的第一帧 ping。
     手机那份 connected 就是押在它到达之后（(b)），所以要等满一个 15 s 心跳才转已连接的说法作废。
     序号 1：0 已被 Auth 用掉。 */
  let served = '';
  try {
    served = JSON.parse(open(pair.keys.s2c, 1, (await nextOnPair(3000)).payload).toString()).msg.t;
  } catch (e) { served = `没读到帧：${String(e?.message ?? e).slice(0, 50)}`; }
  ok('桌面开始服务时立刻发一帧 ping（不等 15 s 心跳）', served === 'ping', served);

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

  /* 归因（v1.5 开工单 (a)）：面板「上次失败」那一行要说清是**谁拒的**。
     两条判据是一对：先要求具体原因落到位，再要求一条「拨开就断、连自己是谁都没说」的空连接
     （`nc host port` 的形状）不许把它冲成「对端已关闭连接」—— 那是"谁先挂断"盖掉"谁拒的"，
     用户会去查网络，而真相是配对码该刷新。 */
  const why = await waitStatus(invoke, (x) => x.lastError.includes('配对码已过期'), 3000);
  ok('票过期/已用被拒时，桌面记的是自己拒的那个具体原因',
    why.lastError.includes('配对码已过期'), why.lastError);
  bad.destroy();
  const silent = await tcp(47123);
  silent.destroy();
  await sleep(1500);
  const still = await invoke('link_status');
  ok('拨开就断的空连接不改动那一行',
    still.lastError.includes('配对码已过期'), still.lastError);
  await invoke('link_server_stop');
}

/* ------------------------ J：测试配对模式（v1.5 开工单第 2 条，跨机实测用） */

/** 那张哨兵票的票面（与 `pair::TEST_TICKET` 同一个字面）。两处对不上就说明有人改了一边没改另一边。 */
const TEST_TICKET = '5eedc0de5eedc0de5eedc0de5eedc0de';

/**
 * 这一段验的是「这扇开着的门被关好了三次」：
 * 开着时任何设备拿固定码就能连（不用谁点允许）、连上的设备在账上打得清清楚楚、
 * 关掉之后那个固定码立刻失效。少了任何一条，这个模式就从"省一次点击"变成"留了一道后门"。
 */
async function testPairMode(invoke) {
  const PORT = 47128;
  log('\n=== J. 测试配对：固定码免确认 → 记账带标记 → 关掉即失效 ===');
  await invoke('link_test_pair_set', { on: false });
  const st = await invoke('link_server_start', { port: PORT });
  ok('J 段起监听', st.listening === true, `port=${st.port}`);

  ok('没开测试模式时，拿固定测试票配不上（默认不是一扇开着的门）', await (() => {
    // 盐不匹配这件事在服务端表现为「等不到 pong」，所以判据是应用没有转成已连接，而不是收到 refused
    phoneHandshake(PORT, { mode: 'pair', saltStr: TEST_TICKET, ticket: TEST_TICKET }).then((r) => r.conn.destroy()).catch(() => {});
    return waitStatus(invoke, (x) => x.connected, 2500).then((x) => !x.connected);
  })());

  const armed = await invoke('link_test_pair_set', { on: true });
  ok('link_test_pair_set(true) → 状态位 testPair', armed.testPair === true);
  const qr = await invoke('link_pair_qr');
  ok('开着模式时 pair_qr 不冲掉固定票（否则点一次面板门就关了）',
    parsePairUri(qr.uri).ticket === TEST_TICKET && qr.code === shortCode(TEST_TICKET),
    `code=${qr.code} 状态里的票=${armed.ticket?.slice(0, 8)}…`);
  ok('状态快照里的票就是那张哨兵票（手机侧照旧走同一个入口）', armed.ticket === TEST_TICKET);

  // 关键一条：这一段**从头到尾不调 link_pair_approve**。连上了就证明自动允许真生效了。
  const pair = await phoneHandshake(PORT, { mode: 'pair', saltStr: TEST_TICKET, ticket: TEST_TICKET });
  ok('测试票握手：桌面身份签名验得过', pair.sigOk);
  let status = null;
  for (let i = 0; i < 12 && !(status && status.connected); i++) {
    status = await waitStatus(invoke, (x) => x.connected, 1000);
  }
  ok('没有人点允许也连上了，且带上了设备名',
    status?.connected === true && status?.peerDevice === 'Node-Probe',
    status ? `${status.peerDevice} @ ${status.peerAddr}` : '未连上');

  const list = await invoke('link_pairings_list');
  const kid = keyIdHex(pair.ls);
  const mine = list.find((d) => d.keyId === kid);
  ok('跳过确认没跳过记账：这台落在「已配对设备」里且打了 viaTest 标记',
    !!mine && mine.viaTest === true, JSON.stringify(list.map((d) => [d.keyId.slice(0, 6), d.viaTest])));

  // 关掉之后：哨兵票立刻失效
  pair.conn.destroy();
  await waitStatus(invoke, (x) => !x.connected, 4000);
  const off = await invoke('link_test_pair_set', { on: false });
  ok('link_test_pair_set(false) → 状态位归零', off.testPair === false);
  const after = await tcp(PORT);
  const eph = newKeyPair();
  writeFrame(after, Buffer.from(JSON.stringify({
    t: 'hello', ver: 1, pub: eph.rawPub.toString('base64'), agent: 'x', device: 'Ghost',
    mode: 'pair', key_id: '', slot: 'ticket',
  })));
  const rj = JSON.parse((await readFrame(after)).payload.toString());
  ok('关掉后固定码立刻被拒', rj.t === 'refused' && rj.code === 'ticket', rj.reason || JSON.stringify(rj));
  after.destroy();

  // 再确认可普通配对这条路没被这个模式带松：重新开一次共享走一次正常票 + TOFU
  const qr2 = await invoke('link_pair_qr');
  const p2 = parsePairUri(qr2.uri);
  ok('关掉之后 pair_qr 回到随机票（不是那张公开的哨兵票）',
    /^[0-9a-f]{32}$/.test(p2.ticket) && p2.ticket !== TEST_TICKET, `${p2.ticket.slice(0, 8)}…`);
  await invoke('link_server_stop');
}

/* ---------------------------------------------------- B/C/D/E：Node 当桌面 与错误路径 */

/** 起一个 Node 侧「桌面」：带一把身份、握手后发 Auth（含桌面设备名）。返回它观察到的东西与控制把手。
 *
 *  为什么这里也要发那一下 ping：手机把 `connected` 押到「对端第一帧」到达之后（(b)），
 *  所以**任何**扮演桌面的一方都得在开始服务时发一帧，否则应用当客户端永远不转已连接。
 *  这不是给测试开后门 —— 是这段判据本来就该跟着协议走，`serve()` 就是「我开始服务你了」那一刻。
 *  `serveAfterPong: false` 则用来量中间那一档（等待电脑上确认）。 */
function nodeDesktop(port, { saltStr, identity, name = 'Node-Desktop', serveAfterPong = true }) {
  const seen = { hello: null, plain: [], cipher: null, shared: null };
  const ctl = { serve: null, refuse: null, stop: null, sock: null };
  const server = net.createServer(async (sock) => {
    ctl.sock = sock;
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
      writeFrame(sock, seal(s2c, 0, Buffer.from(JSON.stringify({
        seq: 0, msg: { t: 'auth', id: idPub.toString('base64'), sig: sig.toString('base64'), name },
      }))));
      const { head } = await readFrame(sock);
      seen.cipher = head;
      let sseq = 1; // 0 已被 auth 用掉
      const sendMsg = (msg) => {
        writeFrame(sock, seal(s2c, sseq, Buffer.from(JSON.stringify({ seq: sseq, msg }))));
        sseq += 1;
      };
      ctl.serve = () => sendMsg({ t: 'ping' });
      ctl.refuse = (reason) => sendMsg({ t: 'refused', code: 'denied', reason });
      ctl.stop = () => sock.destroy();
      if (serveAfterPong) ctl.serve();
      // 挂着别断：应用那一侧的连接要活到断言做完
      await new Promise((r) => {
        sock.once('close', r);
        sock.once('error', r);
      });
    } catch { sock.destroy(); }
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({
    server, seen, ctl,
    close: () => { server.close(); ctl.stop?.(); },
  })));
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
  log('\n=== B. 应用当客户端，Node 当桌面：握手时机 + hello 明文形状 + 票不上网 ===');
  const TICKET = '0123456789abcdef0123456789abcdef';
  const DESKTOP = 'Node-Desktop-PC';
  const id = newEd25519();
  /* 先让 Node「握着不发」：这一段第一半要量的就是桌面还没开始服务时手机不许报已连接
     （(b) —— 桌面的 connected 那一刻对应真人点「允许」，之前每条命令都会等满 30 s） */
  const { server, seen, ctl, close } = await nodeDesktop(47900, {
    saltStr: TICKET, identity: id, name: DESKTOP, serveAfterPong: false,
  });
  await invoke('link_client_connect', { host: '127.0.0.1', port: 47900, ticket: TICKET, device: 'SM-X808U' });
  // Node 收到 pong = 应用的客户端握手已完成，此刻桌面一帧都没发
  const handUntil = Date.now() + 8000;
  while (!seen.cipher && Date.now() < handUntil) await sleep(100);
  ok('应用完成握手（验过 Auth 并回了 pong）', !!seen.cipher);

  let mid = null;
  for (let i = 0; i < 20; i += 1) {
    mid = await invoke('link_status');
    if (mid.waitingConfirm || mid.connected || mid.lastError) break;
    await sleep(100);
  }
  ok('(b) 桌面开始服务之前，手机不谎报已连接',
    mid.connected === false && mid.waitingConfirm === true,
    JSON.stringify({ connected: mid.connected, waitingConfirm: mid.waitingConfirm, err: mid.lastError }));
  ok('(c) 桌面设备名随 Auth 上来，中间那一档也叫得出对面是哪台电脑',
    mid.peerDevice === DESKTOP, `status.peerDevice=${mid.peerDevice}`);

  const t0 = Date.now();
  ctl.serve();
  const up = await waitStatus(invoke, (x) => x.connected, 1500);
  ok('(b) 桌面一进泵发第一帧，手机 1 秒内转已连接', up.connected === true, `${Date.now() - t0}ms`);
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

  /* 会话中途对端发来 refused：原因要原样落到手机上，而不是等心跳判死或让请求等满 30 s
     —— 桌面点「拒绝」走的就是这一帧（serve_conn 里 code=denied）。 */
  ctl.refuse('桌面端拒绝了这次配对');
  const denied = await waitStatus(invoke, (x) => x.lastError.includes('拒绝'), 4000);
  ok('(b) 被拒时手机拿到桌面的原话、且不再算已连接',
    denied.connected === false && denied.lastError.includes('桌面端拒绝了这次配对'), denied.lastError);
  close();
  await invoke('link_client_disconnect');
  server.unref?.();
}

async function wrongFp(invoke) {
  log('\n=== C. 桌面身份指纹与码里不符 → 应用中止（防同网段抢答）===');
  const TICKET = '0123456789abcdef0123456789abcdef';
  const wrongId = newEd25519();
  // 服务端用 wrongId 这把身份；塞给应用的期望指纹是另一串 → 必然不符
  const { server, close } = await nodeDesktop(47901, { saltStr: TICKET, identity: wrongId });
  const bogusFp = 'ABCDEFGHIJKLM'; // 与 wrongId 的真实指纹不符
  const uri = `hide-link://pair?host=127.0.0.1&port=47901&ticket=${TICKET}&name=Node-Desktop&fp=${bogusFp}`;
  await invoke('link_client_pair', { uri, device: 'SM-X808U' });
  const s = await waitStatus(invoke, (x) => x.lastError.includes('指纹') || x.connected, 8000);
  ok('指纹不符时应用如实中止、不假装连上', s.lastError.includes('指纹') && !s.connected, s.lastError);
  close();
  server.unref?.();
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
  const st = await invoke('link_set_root', { label: 'main', path: root });
  const norm = (x) => String(x ?? '').replace(/[\\/]+$/, '').toLowerCase();
  ok('共享范围明示给前端（设置面板要显示它）', norm(st.rootDisplay) === norm(root), `rootDisplay=${st.rootDisplay}`);
  const pair = await pairedPhone(invoke, PORT);
  const connStatus = await invoke('link_status');
  ok('已连接状态带出对端 deviceId（hide-remote 的键）', /^[0-9a-f]{16}$/.test(connStatus.peerKeyId || ''), connStatus.peerKeyId);

  /* 应用帧序号从 1 起：握手已用掉两个方向的 0（手机回 pong、桌面发 Auth） */
  let tx = 1, rx = 1, idc = 0;
  // 这条连接唯一的读取器：握手时挂上的那一个（桌面一进泵就先推一帧 ping，见 (b)）
  const nextFrame = pair.next;
  const send = (msg) => {
    writeFrame(pair.conn, seal(pair.keys.c2s, tx, Buffer.from(JSON.stringify({ seq: tx, msg }))));
    tx += 1;
  };
  const ask = async (method, params) => {
    const id = ++idc;
    send({ t: 'req', id, method, params: JSON.stringify(params) });
    for (;;) {
      const f = await nextFrame(8000);
      const env = JSON.parse(open(pair.keys.s2c, rx, f.payload).toString());
      rx += 1;
      if (env.msg.t === 'ping') { send({ t: 'pong' }); continue; }
      /* 阶段 3 起桌面会随时推 event：它不是对任何请求的回答，跳过而不是判死 */
      if (env.msg.t === 'event') continue;
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

  await invoke('link_set_root', { label: 'main', path: null });
  const noroot = await ask('list', { relDir: '' });
  ok('清除共享范围后一律拒答（noroot）', noroot.ok === false && noroot.code === 'noroot');

  await invoke('link_server_stop');
  pair.conn.destroy();
  fs.rmSync(base, { recursive: true, force: true });
}

/** 按连接持续成帧的读取器。
    `readFrame` 每次挂一个新 listener、只取一帧，一次 data 事件里夹着的**第二帧会被丢掉**——
    前端并发两笔远程命令会合并进同一个 TCP 段，所以服务端这一侧必须自己缓冲。
    同理：**一条连接只许有一个读取器**，而且要尽早挂上 —— 桌面一进泵就先推一帧 ping（(b)），
    晚一步建读取器，那一帧可能在"没有 listener 的窗口"里被吐掉，之后的每一帧就都解不开了
    （F 段 2026-09-25 那次「Unsupported state」就是这个，`head` 一并带出以便验明文痕迹）。 */
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
      frames.push({ payload: buf.subarray(4, 4 + len), head: buf.subarray(0, 4 + len) });
      buf = buf.subarray(4 + len);
    }
    while (waiters.length && frames.length) waiters.shift()(frames.shift());
  });
  return (timeoutMs = 5000) =>
    new Promise((res, rej) => {
      if (frames.length) return res(frames.shift());
      /* 超时必须把 waiter 从队列里摘掉。留着它，下一帧会被交给这个已经 reject 的承诺
         并就地丢掉 —— 于是"之后所有帧都看不见"。阶段 4 的判据要连着等好几轮空帧，
         2026-09-24 就是这条把一次真能收到推送的链路读成了"0 帧"。 */
      const w = (f) => { clearTimeout(t); res(f); };
      const t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        rej(new Error('读取帧超时'));
      }, timeoutMs);
      waiters.push(w);
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
      let sseq = 0; // 本端密文序号：每次 sendMsg 递增（auth 是 0，之后第一帧就是「我开始服务你了」）
      const sendMsg = (msg) => {
        writeFrame(sock, seal(s2c, sseq, Buffer.from(JSON.stringify({ seq: sseq, msg }))));
        sseq += 1;
      };
      sendMsg({ t: 'auth', id: idPub.toString('base64'), sig: sig.toString('base64'), name: 'Node-FileServer-PC' });
      // 与真实桌面同一时刻：开始服务 = 立刻发一帧 ping（手机把 `connected` 押在对端第一帧之后，见 (b)）
      sendMsg({ t: 'ping' });
      let cseq = 0; // 应用第一帧密文是 pong（seq 0），之后每个 req 递增
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
        sendMsg({
          t: 'res', id: m.id, ok: out.ok, code: out.code ?? '', error: out.error ?? '', data: out.data ?? '',
        });
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
  ok('断开后的请求立刻报错而不是等超时', waited < 12_000, `${waited}ms · ${after}`);
  /* 阶段 5 的离线队列只认**码**分流「这次没送到」与「桌面拒绝了这个路径」：
     按人话正则判会让改文案顺手把判据改掉，而前端认不出来时的表现是「拔网线编辑会丢」。 */
  ok('断连后的失败以稳定码抛给前端（离线队列的分岔口）',
    /^(nolink|dropped): /.test(after.replace(/^link_request 失败：/, '')), after);
  ok('未连接时的失败码是 nolink', /nolink: /.test(after), after);
  await invoke('link_client_disconnect');
}

/* ------------------------- 阶段 3：标签上报、聚焦窗口判定与 event 推送 */

/** 点某个窗口里的「文件树」开关，再点指定文件那一行 —— 走的是用户那条路，
    于是应用自己的上报回路（useTabReport → link_report_tabs）被真正跑到。
    开关是**翻转**而不是"打开"（`handleToggleTree`），所以抽屉已经开着就不要再点它。 */
async function openFileViaTree(s, file) {
  const toggled = await s.evalJs(`
    if (document.querySelector('.heid-tree-row')) return 'already';
    const want = ['文件树', 'File Tree'];
    const b = [...document.querySelectorAll('button')]
      .find(x => want.includes((x.getAttribute('title') || x.getAttribute('aria-label') || '').trim()));
    if (!b) return 'NO-TOGGLE:' + [...document.querySelectorAll('button')]
      .map(x => (x.getAttribute('title') || x.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 12).join(',');
    b.click(); return 'ok';`);
  if (toggled !== 'ok' && toggled !== 'already') throw new Error(`找不到文件树开关：${toggled}`);
  const clicked = await s.evalJs(`
    const sel = '.heid-tree-row[title$="${file}"]';
    for (let i = 0; i < 40; i++) {
      const row = document.querySelector(sel);
      if (row) { row.click(); return 'ok'; }
      await new Promise(r => setTimeout(r, 100));
    }
    return 'NO-ROW:' + [...document.querySelectorAll('.heid-tree-row')].map(n => n.title).slice(0, 8).join(',');`);
  if (clicked !== 'ok') throw new Error(`文件树里没有 ${file}：${clicked}`);
  /* 点开之后标签条要等一次文件读完才多出一格，所以轮询而不是立刻看 ——
     立刻看会把"刚点下去"误判成"没开成"。 */
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  let grew = false;
  for (let i = 0; i < 25 && !grew; i += 1) {
    grew = await s.evalJs(`return [...document.querySelectorAll('[data-tab-id]')].some(n => (n.textContent || '').includes(${JSON.stringify(stem)}))`);
    if (!grew) await new Promise((r) => setTimeout(r, 120));
  }
  if (!grew) throw new Error(`点了 ${file} 但桌面上没出现这个标签（先查是不是没开成，再查有没有上报）`);
}

/** 等这个窗口的标签条安定下来：启动时的会话恢复是异步的（要重读磁盘），
    不等它就会把"恢复完成"当成"我刚点开了文件"，判据整个错位。 */
async function settleTabs(s, tries = 25) {
  let last = null;
  let same = 0;
  for (let i = 0; i < tries; i += 1) {
    const cur = await s.evalJs(`return [...document.querySelectorAll('[data-tab-id]')].map(n => (n.textContent || '').trim()).join('|')`);
    if (cur === last) { same += 1; if (same >= 3) return cur; } else { same = 0; last = cur; }
    await sleep(400);
  }
  return last;
}

/** 这个窗口是不是 Tauri 认定的聚焦窗口。
    不能用 `document.hasFocus()` —— WebView2 在窗口失活后仍然报告文档有焦点，
    实测过一次：手机上看到的明明是新建那个窗口的列表，主窗口的 hasFocus 却还是 true，
    照着它判就把一条正确的实现判成 bug。 */
const isFocused = (s, label) =>
  s.invoke('plugin:window|is_focused', { label }).then((v) => v === true).catch(() => false);

/**
 * 把这一段测试要依赖的应用状态归位。
 *
 * 上一轮中途失败会留下两类脏东西，都会把下一轮的判据错位：
 * - 多开的文档窗口还活着 —— 共享根按**聚焦窗口**取，聚焦的若是残留的 win-N，
 *   A–G 段手动设的主窗口根就根本不参与判定（表现为"命令面全拒"却看不出为什么）；
 * - 树根 / 会话里指向我临时目录的条目 —— 我的临时目录会被删掉，那些路径当场变成死标签。
 */
async function normalizeAppState() {
  /* 以「label 是 main 的那个页面」为基准，而不是 /json 的第一个 target —— 上一轮残留的
     win-N 常常才是第一个 target，拿它当主窗口就会去关自己，之后每次求值都超时。 */
  const ses = await attach('main');
  const me = await ses.evalJs('return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ""');
  for (let i = 1; i <= 8; i += 1) {
    const label = `win-${i}`;
    if (label === me) continue;
    try { await ses.invoke('plugin:window|close', { label }); } catch { /* 没有这个窗口 */ }
  }
  const root = await ses.evalJs(`return localStorage.getItem('heid-tree-root')`);
  const dirty = String(root ?? '').includes('heid-stage3-');
  if (dirty) {
    ok('桌面树根不是上一次运行遗留的临时目录', false, `heid-tree-root=${root}`);
    await ses.evalJs(`localStorage.removeItem('heid-tree-root'); return 1;`);
  }
  const dropped = await ses.evalJs(`
    const k = 'heid-session';
    const raw = localStorage.getItem(k);
    if (!raw) return 0;
    const st = JSON.parse(raw);
    const n = (st.tabs || []).length;
    st.tabs = (st.tabs || []).filter((t) => !String(t.path || '').includes('heid-stage3-'));
    if (n !== st.tabs.length) localStorage.setItem(k, JSON.stringify(st));
    return n - st.tabs.length;`);
  if (dropped) log(`main: 丢掉 ${dropped} 个遗留的临时目录标签`);
  /* 无条件重载主窗口：残留窗口关干净之后，看板里就只剩"主窗口报的那一份"。
     不重置的话，上一轮残留窗口的空标签列表会一直当聚焦窗口用，
     手机看到空列表而桌面明明开着四个标签 —— 后面每条判据都白测。 */
  await ses.evalJs(`location.reload(); return 1;`);
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const n = await ses.evalJs('return document.querySelectorAll("button").length');
    if (n) break;
    if (i === 4) await ses.evalJs(`await import('/src/main.tsx'); return 1;`).catch(() => {});
  }
  return ses;
}

async function stage3Tabs() {
  log('\n=== H. 阶段 3：两个窗口的聚焦判定、标签上报回路与 event 推送 ===');
  /* 又一个独立端口：F/G 跑完后 47123/47124 可能还留着 TIME_WAIT（SO_EXCLUSIVEADDRUSE 会拒绑） */
  const PORT = 47127;
  /* 文件名带一次运行的唯一后缀：桌面上次运行留下的会话里不可能有它，
     "我点开的那个是新出现的"这条判据才在重跑时依然成立 */
  const TAG = Date.now().toString(36);
  const A = `a-${TAG}.md`;
  const B = `b-${TAG}.md`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'heid-stage3-'));
  const root = path.join(base, 'tree');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, A), '# alpha');
  fs.writeFileSync(path.join(root, B), '# beta');

  /* 用户自己的树根与标签会话先存下来，跑完原样还回去 —— 这段测试不改他的应用状态。
     顺手把上一次失败遗留的"指向临时目录的标签"从会话里剔掉：留着它，这一轮的
     "我点开的是个新文件"判据就不成立了，而且那本来就是我造的脏数据。 */
  const first = await attach('main');
  await first.evalJs(`
    const k = 'heid-session';
    const raw = localStorage.getItem(k);
    if (!raw) return 0;
    const st = JSON.parse(raw);
    const n = (st.tabs || []).length;
    st.tabs = (st.tabs || []).filter((t) => !String(t.path || '').includes('heid-stage3-'));
    localStorage.setItem(k, JSON.stringify(st));
    return n - st.tabs.length;`);
  const savedRoot = await first.evalJs(`return localStorage.getItem('heid-tree-root')`);
  const savedSession = await first.evalJs(`return localStorage.getItem('heid-session')`);
  /* 本机若记着「共享开着」，主窗口每次 reload 都会按记忆重新 bind（这正是 2026-09-23 定的
     记忆开关该做的事）。本段自己起监听，所以先把记忆关掉、跑完还原 ——
     否则换根那一步的 reload 会把服务端抢到默认端口上，把我这条测试连接踢掉。 */
  const savedPrefs = await first.evalJs(`return localStorage.getItem('heid-link-prefs')`);
  await first.evalJs(`
    const p = JSON.parse(localStorage.getItem('heid-link-prefs') || '{}');
    p.enabled = false;
    localStorage.setItem('heid-link-prefs', JSON.stringify(p));
    return 1;`);
  first.close();

  /* 中途抛错也必须还回去：上一轮失败没清干净时，遗留在会话里的标签
     会变成下一轮的"桌面本来就开着它"，把判据整个污染掉。 */
  let m = null, w2 = null, m2 = null, pair = null;
  let watchOn = true;
  const reloadedAtClock = { value: 0 };
  try {

  /* 把树根换成临时目录并刷新页面：换完之后 rootDisplay 应当自己变成它 ——
     这一步验的是"应用主动报根"那条回路，不是脚本手动 invoke 出来的结果 */
  await (await attach('main')).evalJs(
    `localStorage.setItem('heid-tree-root', ${JSON.stringify(root)}); location.reload(); return 1;`,
  );
  reloadedAtClock.value = Date.now();
  await sleep(1200);
    m = await attach('main');
  /* dev 的 #root 有空帧老毛病（vite 因 lockfile 变化重新预打包依赖，把首帧作废）。
     一行补挂 import('/src/main.tsx')；挂载要等 vite 现编整张依赖图，按秒级轮询而不是猜一个数。 */
  for (let i = 0; i < 40; i += 1) {
    const kids = await m.evalJs('return document.getElementById("root")?.childElementCount ?? 0');
    if (kids) break;
    if (i === 3) await m.evalJs(`await import('/src/main.tsx'); return 1;`);
    await sleep(500);
  }
  const mounted = await m.evalJs('return document.querySelectorAll("button").length');
  if (!mounted) throw new Error(`应用没挂上：#root=${await m.evalJs('return document.getElementById("root")?.innerHTML?.slice(0,60)')}`);

  await m.invoke('link_server_start', { port: PORT });
  let st = null;
  for (let i = 0; i < 30; i += 1) {
    st = await m.invoke('link_status');
    const norm = (x) => String(x ?? '').replace(/[\\/]+$/, '').toLowerCase();
    if (norm(st.rootDisplay) === norm(root)) break;
    await sleep(200);
  }
  const norm = (x) => String(x ?? '').replace(/[\\/]+$/, '').toLowerCase();
  ok('桌面自己把本窗口的树根报成共享范围（无人手动 invoke）',
    norm(st?.rootDisplay) === norm(root), `rootDisplay=${st?.rootDisplay}`);

    pair = await pairedPhone(m.invoke, PORT);
  const next = pair.next; // 一条连接一个读取器，且从握手起就挂着（见 frameReader 的注释）
  let tx = 1, rx = 1, idc = 0;
  const send = (msg) => {
    writeFrame(pair.conn, seal(pair.keys.c2s, tx, Buffer.from(JSON.stringify({ seq: tx, msg }))));
    tx += 1;
  };
  /** 解一帧成 Msg（心跳就地回 pong，不冒泡给调用方）。超时向上抛，由调用方决定怎么办。 */
  const recvMsg = async (timeoutMs = 8000) => {
    for (;;) {
      const env = JSON.parse(open(pair.keys.s2c, rx, (await next(timeoutMs)).payload).toString());
      rx += 1;
      if (env.msg.t === 'ping') { send({ t: 'pong' }); continue; }
      return env.msg;
    }
  };
  const ask = async (method, params) => {
    const id = ++idc;
    send({ t: 'req', id, method, params: JSON.stringify(params ?? {}) });
    for (;;) {
      const msg = await recvMsg();
      if (msg.t === 'event') continue; // 推送随时可能夹进来，不该打断一次请求
      if (msg.t === 'res' && msg.id === id) {
        return { ...msg, data: msg.data ? JSON.parse(msg.data) : null };
      }
      throw new Error(`等 res(${id}) 时收到 ${JSON.stringify(msg)}`);
    }
  };
  /** 手机看到的列表（rel 数组）。共享根内的条目就是相对路径，根外的是 `@w/…` */
  const rels = async () => (await ask('tabs')).data ?? [];
  const joined = (list) => list.map((x) => x.rel).filter(Boolean).sort().join(',');
  const has = (list, f) => list.some((x) => x.rel === f);
  const hasOpenOf = (list, f) => list.some((x) => x.rel.startsWith('@w/') && x.rel.endsWith(`/${f}`));

  /* 桌面上此刻还开着用户上次留下的标签（会话恢复），所以判据一律是
     "我点开的这个在不在 / 不在"，不做整份列表相等 —— 那样会把别人的文件算成失败。 */
  const seen = [];
  /* 手机看到的列表什么时候算安定：距最近一次 reload 至少 3.5 秒（会话恢复要重读磁盘），
     并且连续两次读到的内容一致。只看 DOM 标签条不行 —— "一个标签都没有"也是稳定态，
     会在恢复完成之前就提前返回，把空列表当成基线。 */
  const settlePhoneList = async (sinceReload, tries = 14) => {
    while (Date.now() < sinceReload + 3500) await sleep(300);
    let prev = joined(await rels());
    for (let i = 0; i < tries; i += 1) {
      await sleep(700);
      const now = joined(await rels());
      if (now === prev) return now;
      prev = now;
    }
    return prev;
  };

  // 状态监视：Bye 只可能来自 link_server_stop / link_client_disconnect / 又一次 server_start
  // （replace_stop 会踢掉正在跑的那台）。与其猜是哪条，不如把每次端口与连接状态的变化都记下来。
  let lastSnap = '';
  void (async () => {
    while (watchOn) {
      try {
        const x = await m.invoke('link_status');
        const now = `${x.port}/${x.listening ? 'L' : '-'}/${x.connected ? 'C' : '-'}`;
        if (now !== lastSnap) { log(`   (status -> ${now} err=${x.lastError})`); lastSnap = now; }
      } catch { return; }
      await sleep(300);
    }
  })();
  const before = await rels().then(async (x) => { await settlePhoneList(reloadedAtClock.value); return x; });
  log(`   （基线=[${joined(before)}]）`);
  ok('未点开的文件不在列表里（暴露的是开着的标签，不是整个磁盘）',
    !has(before, A) && !hasOpenOf(before, A), `基线=[${joined(before)}]`);

  /* event 推送：桌面点开一个文件，手机端**没有**任何请求在飞，应当收到一帧 event。
     注意这里绝不能用 `next()` 裸取一帧不解密 —— 接收计数器与实际流一旦错开，
     之后每一帧都解不开（nonce 与流顺序是绑死的）。 */
  await openFileViaTree(m, A);
  let pushed = null;
  const pushUntil = Date.now() + 6000;
  while (Date.now() < pushUntil && !pushed) {
    try {
      const msg = await recvMsg(1200);
      if (msg.t === 'event') pushed = msg.type;
    } catch { /* 这一轮没来，继续等 */ }
  }
  ok('桌面点开标签后，手机端在没有在飞请求的情况下收到 event{type:tabs}', pushed === 'tabs', String(pushed));
  await settleTabs(m);
  const withAlpha = await rels();
  if (!has(withAlpha, A)) {
    log(`   （桌面上的标签条：${await m.evalJs(`return [...document.querySelectorAll('[data-tab-id]')].map(n => (n.textContent || '').trim()).join('|')`)}；文件树行：${await m.evalJs(`return [...document.querySelectorAll('.heid-tree-row')].slice(0,6).map(n => n.title).join('|')`)}）`);
  }
  ok('点开的文件出现在手机端的列表里（根内 → 相对路径，不给 @w）',
    has(withAlpha, A), `列表=[${joined(withAlpha)}]`);

  /* 桌面那行"另外暴露了 N 个"必须与手机真正看到的 @w 条目数一致，否则明示就是假的 */
  const stAfter = await m.invoke('link_status');
  const openOnPhone = withAlpha.filter((x) => x.rel.startsWith('@w/')).length;
  ok('桌面明示的根外文件数 = 手机端拿到的 @w 条目数',
    stAfter.openShared === openOnPhone, `status=${stAfter.openShared}，手机=${openOnPhone}`);
  ok('根外条目都带得上文件名（手机端要靠它做标题与语言判定）',
    withAlpha.filter((x) => x.rel.startsWith('@w/')).every((x) => /\.[a-z0-9]+$/i.test(x.rel)),
    joined(withAlpha));

  /* 第二个窗口：它自己开一个不同的文件。两份列表不同，聚焦判定才叫被检验过 */
  const dump = async (why) => {
    const one = async (ses, tag) => {
      if (!ses) return `${tag}=无`;
      try {
        const st = await ses.invoke('link_status');
        return `${tag}: port=${st.port} listening=${st.listening} connected=${st.connected} err=${st.lastError}`;
      } catch (e) { return `${tag} 取不到状态：${String(e?.message ?? e).slice(0, 60)}`; }
    };
    log(`   （诊断 ${why}）`);
    log(`     ${await one(m, 'main')}`);
    log(`     ${await one(w2, '新窗口')}`);
  };
  const openBefore = (await m.invoke('link_status')).openShared;
  let label2 = '';
  try {
    label2 = await m.invoke('create_document_window', {
      source: 'main', payload: { kind: 'session', state: { tabs: [], activePath: null } }, drop: null,
    });
  } catch (e) { await dump('建窗失败'); throw e; }
  w2 = await attach(label2);
  try {
    await settleTabs(w2);
    await openFileViaTree(w2, B);
  } catch (e) { await dump('第二窗口那一段'); throw e; }
  await sleep(1800);

  /* B 与 A 一样在临时根之内，所以「根外额外暴露数」不该因为多开一个窗口而变化。
     这一条盯的是那个计数的**含义**：它报的是"根外多交出去几个"，不是"开了几个标签"。 */
  const openWithWin2 = (await m.invoke('link_status')).openShared;
  ok('在根内再开一个标签不会虚增「根外额外暴露」计数',
    openWithWin2 === openBefore, `${openBefore} -> ${openWithWin2}`);

  const afterCreate = await rels().catch(async (e) => { await dump('新建窗口后取列表'); throw e; });
  /* 聚焦判据：能测出"哪一个在前台"就按 §6.1 的字面判据断言。两个都不在前台
     （焦点在我这边的终端上）时不硬判，改判这一对可观察事实 —— 新建窗口把列表换成了
     那一份窗口的、关掉它又落回来；弱一档，但仍然是真判据，并且如实标出来。 */
  const fNew = await isFocused(w2, label2);
  const fMain = await isFocused(m, 'main');
  if (fNew !== fMain) {
    const who = fNew ? label2 : 'main';
    ok('手机看到的正是聚焦那份窗口的标签',
      has(afterCreate, fNew ? B : A) && !has(afterCreate, fNew ? A : B),
      `列表=[${joined(afterCreate)}]，聚焦=${who}`);
    seen.push({ who, list: joined(afterCreate) });
  } else {
    log('   （两个窗口都不在前台，聚焦判据降级为「新建即切换 + 关窗回落」这一对）');
    ok('新建窗口把手机看到的列表换成了那一份窗口的', has(afterCreate, B) && !has(afterCreate, A),
      `列表=[${joined(afterCreate)}]`);
    seen.push({ who: label2, list: joined(afterCreate) });
  }

  await w2.invoke('plugin:window|close', { label: label2 });
  await sleep(1800);
  const afterClose = await rels();
  ok('关掉那个窗口后列表落回还活着的那份（不是空列表）',
    has(afterClose, A) && !has(afterClose, B), `列表=[${joined(afterClose)}]`);
  seen.push({ who: 'main', list: joined(afterClose) });
  /* 「只测单窗口等于没测」：第二份窗口列表若从未在手机上出现过，上面两条判定就是白过的 */
  ok('本段确实检验过窗口之间的切换（手机见过第二个窗口那份列表）',
    seen.some((x) => x.list.includes(B)), seen.map((x) => `${x.who}=[${x.list}]`).join(' → '));

  /* 白名单的端到端一读：换一个根再报一次，原来那个"根内"的标签这一刻就落到根外了。
     手机上必须能凭 @w 引用把它读出来 —— 这条走的是跑着的应用，不是 Rust 单测里的替身。 */
  const other = path.join(base, 'other-root');
  fs.mkdirSync(other, { recursive: true });
  reloadedAtClock.value = Date.now();
  await m.evalJs(`localStorage.setItem('heid-tree-root', ${JSON.stringify(other)}); location.reload(); return 1;`);
  const m3 = await attach('main');
  for (let i = 0; i < 30; i += 1) {
    if (await m3.evalJs('return document.querySelectorAll("button").length')) break;
    if (i === 4) await m3.evalJs(`await import('/src/main.tsx'); return 1;`).catch(() => {});
    await sleep(500);
  }
  await settlePhoneList(reloadedAtClock.value);
  const moved = await rels();
  const ref = moved.find((x) => x.rel.startsWith('@w/') && x.rel.endsWith(`/${A}`));
  ok('换根之后，原来那个标签改由白名单引用寻址', !!ref, `列表=[${joined(moved)}]`);
  const read = ref ? await ask('read', { relPath: ref.rel }) : { ok: false, code: 'norel' };
  ok('手机端凭白名单引用读到桌面上的那份内容（逐字）',
    read.ok === true && read.data?.text === '# alpha', `${read.ok ? 'ok' : read.code}`);
  const stMoved = await m3.invoke('link_status');
  /* 换到空根之后，原来"根内"的那个标签落到根外：额外暴露恰好 +1
     （用户自己那几个根外标签本来就在数里，所以判差分而不是判绝对值） */
  ok('换根把那个标签推到根外后，额外暴露数如实 +1',
    stMoved.openShared === openBefore + 1, `${openBefore} -> ${stMoved.openShared}`);
  /* 白名单只给"确实开着的那一个文件"：拿它的引用往上跳一层必须被拒 */
  const up = await ask('read', { relPath: (ref ? ref.rel : '@w/000000000000/x').replace(/\/[^/]*$/, '/..') });
  ok('拿白名单引用往上跳一层被拒', up.ok === false, `${up.code ?? '放行了'}`);
  m3.close();

  log(`   （判定样本：${seen.map((x) => `${x.who}=[${x.list}]`).join(' → ')}）`);
  } finally {
    watchOn = false;
    /* 树根与标签会话原样还回去，再把测试点开过的标签从用户的会话里抹掉 */
    const back = m2 ?? m ?? w2;
    if (back) {
      const js = `localStorage.setItem('heid-tree-root', ${JSON.stringify(savedRoot ?? '')});
        ${savedSession === null ? `localStorage.removeItem('heid-session')` : `localStorage.setItem('heid-session', ${JSON.stringify(savedSession)})`};
        location.reload(); return 1;`;
      try { await back.evalJs(js); } catch { /* 页面可能正在导航，下一段用例自己会 attach 到新页面 */ }
    }
    try {
      await back?.evalJs(`
        ${savedPrefs === null ? `localStorage.removeItem('heid-link-prefs')` : `localStorage.setItem('heid-link-prefs', ${JSON.stringify(savedPrefs)})`};
        return 1;`);
    } catch { /* */ }
    try { await (m ?? back)?.invoke('link_server_stop'); } catch { /* */ }
    try { pair?.conn.destroy(); } catch { /* */ }
    for (const ses of [m, w2, m2]) { try { ses?.close(); } catch { /* */ } }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* ------------------------------------------------- 阶段 4：实时推送（真实应用当服务端） */

/**
 * I. 桌面改文件 → 手机端**没有请求在飞**也收到 event{fs}；换根 → event{rootChanged}。
 *
 * 这段不重复合并逻辑（那是 watch_probe 的六格数字与 Rust 单测管的），只验三条
 * "只有跑着的应用才能证明"的事：
 * 1. 监听确实**随连接**建起来 —— `sync_fs_watch` 全靠调用点，调用点漏了就是静默失灵；
 * 2. 载荷形状与手机端的解析是同一个约定（`{"dirs":[…]}`，手机端拿它跟自己已展开的层求交）；
 * 3. 逐层黑名单在真磁盘、真通知链路上挡住了 node_modules —— 挡不住的话一次 npm install
 *    就是十几万条事件涌进推送队列。
 *
 * 共享根必须由**前端自己报**（换 localStorage 里的树根 + reload），不能只调 `link_set_root`：
 * 暴露面按聚焦窗口取，前端下一次上报会把自己那一份盖回去。2026-09-24 这段第一次跑出来
 * 满屏"收不到帧"，就是这个原因 —— 判据本身没错，错在"桌面在监听哪一棵树"根本不是我以为的那一棵。
 */
async function stage4Live() {
  log('\n=== I. 阶段 4：桌面改文件 → 手机端收到 event{fs}；换根 → rootChanged ===');
  /* 独立端口：47123/47124/47127 可能还留着上一轮的 TIME_WAIT（SO_EXCLUSIVEADDRUSE 会拒绑） */
  const PORT = 47131;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'heid-stage4-'));
  const root = path.join(base, 'tree');
  const root2 = path.join(base, 'tree-after');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(root2, { recursive: true });
  fs.writeFileSync(path.join(root, 'ready.md'), '# 开场就有');

  const m = await attach('main');
  const savedRoot = await m.evalJs(`return localStorage.getItem('heid-tree-root')`);
  /* 本机若记着「共享开着」，每次 reload 都会按记忆重新 bind —— 那会把本段的连接踢掉，
     所以先关掉记忆、跑完还原（与 H 段同一处理） */
  const savedPrefs = await m.evalJs(`return localStorage.getItem('heid-link-prefs')`);
  await m.evalJs(`
    const p = JSON.parse(localStorage.getItem('heid-link-prefs') || '{}');
    p.enabled = false;
    localStorage.setItem('heid-link-prefs', JSON.stringify(p));
    return 1;`);
  /** dev 的 #root 有空帧老毛病（vite 因 lockfile 变化重新预打包，首帧作废）：按秒级轮询补挂一次 */
  const mount = async (why) => {
    for (let i = 0; i < 40; i += 1) {
      if (await m.evalJs('return document.getElementById("root")?.childElementCount ?? 0')) return true;
      if (i === 3) await m.evalJs(`await import('/src/main.tsx'); return 1;`).catch(() => {});
      await sleep(500);
    }
    return false;
  };
  /** 等前端把自己那棵树报成共享范围。报不到就别往下跑 —— 后面每一条都会以"静默"的形式失败 */
  const rootIs = async (want) => {
    const norm = (x) => String(x ?? '').replace(/[\\/]+$/, '').toLowerCase();
    for (let i = 0; i < 40; i += 1) {
      const st = await m.invoke('link_status');
      if (norm(st.rootDisplay) === norm(want)) return true;
      await sleep(250);
    }
    return false;
  };
  const swapRoot = async (to, why) => {
    await m.evalJs(`localStorage.setItem('heid-tree-root', ${JSON.stringify(to)}); location.reload(); return 1;`);
    await sleep(1200);
    if (!await mount(why)) throw new Error(`${why}：应用没挂上`);
    if (!await rootIs(to)) throw new Error(`${why}：前端没把它报成共享范围（rootDisplay 对不上）`);
  };

  let pair = null;
  try {
    await swapRoot(root, '换根到临时目录');
    await m.invoke('link_server_start', { port: PORT });
    ok('生效的共享根就是前端自己报的那一棵（fs 判据的前提）', await rootIs(root));
    pair = await pairedPhone(m.invoke, PORT);
    const next = pair.next; // 一条连接一个读取器，且从握手起就挂着（见 frameReader 的注释）
    let tx = 1, rx = 1;
    const send = (msg) => {
      writeFrame(pair.conn, seal(pair.keys.c2s, tx, Buffer.from(JSON.stringify({ seq: tx, msg }))));
      tx += 1;
    };
    /* 收帧与解帧只用这一个计数器；对同一个 socket 另起一个 frameReader
       会让两份缓冲各收到一遍帧，第二份从此每帧都解不开 */
    const recv = async (timeoutMs = 700) => {
      for (;;) {
        const env = JSON.parse(open(pair.keys.s2c, rx, (await next(timeoutMs)).payload).toString());
        rx += 1;
        if (env.msg.t === 'ping') { send({ t: 'pong' }); continue; }
        return env.msg;
      }
    };
    /** 在 budget 内收某类事件帧；每一帧都打出来 —— 这段既判"该来的来了"也判"不该来的没来" */
    const collect = async (budgetMs, type) => {
      const got = [];
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        try {
          const msg = await recv();
          if (msg.t !== 'event') continue;
          log(`   (event ${msg.type} data=${JSON.stringify(msg.data)})`);
          if (msg.type === type) got.push(msg);
        } catch (e) {
          // 解密失败与"真的没帧"是两件事：前者说明计数器失步，之后每一帧都解不开
          log(`   (读帧这轮没成：${String(e?.message ?? e).slice(0, 70)})`);
        }
      }
      return got;
    };
    const dirsOf = (list) => list.flatMap((x) => {
      try { return JSON.parse(x.data)?.dirs ?? []; } catch { return []; }
    });
    const askOnce = async (id, method, params) => {
      send({ t: 'req', id, method, params: JSON.stringify(params ?? {}) });
      for (;;) {
        const msg = await recv(4000);
        if (msg.t === 'res' && msg.id === id) return msg;
      }
    };

    /* 1) 刚连上：连接本身不该顺手推一帧 fs */
    ok('连上之后没有凭空发出的 fs 帧', (await collect(1200, 'fs')).length === 0);

    /* 2) 桌面改一个文件 —— 手机端一个请求都没发，就该看见它所在的那一层 */
    const stBefore = await m.invoke('link_status');
    log(`   (改文件之前：connected=${stBefore.connected} peerAddr=${stBefore.peerAddr} 我这条 socket 的本地端口=${pair.conn.localPort} rootDisplay=${stBefore.rootDisplay})`);
    fs.writeFileSync(path.join(root, 'ready.md'), '# 桌面刚改的');
    const stAfter = await m.invoke('link_status');
    log(`   (改完之后：connected=${stAfter.connected} peerAddr=${stAfter.peerAddr} 我这条=${pair.conn.localPort} err=${stAfter.lastError})`);
    const e1 = await collect(4000, 'fs');
    ok('桌面改文件后，手机端在没有在飞请求的情况下收到 event{fs}', e1.length >= 1, `${e1.length} 帧`);
    /* 不写"一次写入正好一帧"：实测一次 writeFileSync 在 Windows 上会分成几条通知
       （创建、写数据、关闭时补尺寸/时间戳），彼此间隔能越过一个合并窗口 → 3 帧。
       真正要盯的是"没有第二份监听在推"，那由后面「换根之后旧根不再推帧」那条夹住。 */
    ok('一次写入只推个位数帧、且每帧都是同一份目录（不是每个通知一帧新内容）',
      e1.length <= 4 && new Set(e1.map((x) => x.data)).size <= 2,
      `${e1.length} 帧 / ${new Set(e1.map((x) => x.data)).size} 种载荷`);
    ok('根目录下的变更报的是 ""（与手机端 makeRemotePath 的根同一个值）',
      dirsOf(e1).includes(''), JSON.stringify(dirsOf(e1)));
    ok('载荷里不混文件名（手机端按目录求交，文件名进了也没人用）',
      dirsOf(e1).every((x) => x === '' || x.split('/').every((seg) => !/\.[a-z0-9]+$/i.test(seg))),
      JSON.stringify(dirsOf(e1)));

    /* 3) 子目录里的变更报的是那一层的相对路径 —— 手机端就是拿它跟已展开的层求交 */
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    await collect(900, 'fs');
    fs.writeFileSync(path.join(root, 'src', 'live.md'), '# 子目录里改的');
    const e2 = await collect(4000, 'fs');
    ok('子目录里的变更按 src 这一层报上来', dirsOf(e2).includes('src'), JSON.stringify(dirsOf(e2)));

    /* 4) 逐层黑名单：40 次写入进 node_modules/pkg，一帧都不该有。
       动手前要先排空到"连续一个窗口安静"：Windows 会把前一轮那次根目录写入分成几条通知，
       彼此间隔能越过一个 300 ms 合并窗口（上面第 2 条注释记的就是这件事），
       只排 900 ms 时那条 `dirs:[""]` 的尾巴会掉进这一轮的零帧判据里 —— 2026-09-25 两次误报就是这么来的。 */
    for (let q = 0; q < 5; q += 1) { if ((await collect(900, 'fs')).length === 0) break; }
    for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(root, 'node_modules', 'pkg', `f${i}.js`), 'export default 1\n');
    const storm = await collect(1800, 'fs');
    ok('node_modules 里的 40 次写入不产生任何 fs 帧（一次 npm install 不会涌进推送队列）',
      storm.length === 0, `${storm.length} 帧：${JSON.stringify(dirsOf(storm))}`);
    /* 风暴之后主路还在：过滤器只是滤掉它，没把监听一起带走 */
    fs.writeFileSync(path.join(root, 'src', 'live.md'), '# 又改一次');
    const afterStorm = await collect(4000, 'fs');
    ok('依赖风暴之后 src 的变更照样推得到', dirsOf(afterStorm).includes('src'), JSON.stringify(dirsOf(afterStorm)));

    /* 5) 换根（仍走前端上报那条路）：手机端要收到 rootChanged，监听与命令面都要挪过去 */
    await swapRoot(root2, '换根到第二棵');
    const moved = await collect(6000, 'rootChanged');
    ok('桌面换根 → 手机端收到 event{rootChanged}', moved.length >= 1, `${moved.length} 帧`);
    const listed = await askOnce(91, 'list', { relDir: '' });
    ok('换根之后命令面也挪到新根（新根列得出来）', listed.ok === true, `${listed.code ?? ''}`);
    fs.mkdirSync(path.join(root2, 'fresh'), { recursive: true });
    await collect(900, 'fs');
    fs.writeFileSync(path.join(root2, 'fresh', 'n.md'), '新根里写的');
    const onNew = await collect(4000, 'fs');
    ok('新根里的变更按新根的相对路径报', dirsOf(onNew).includes('fresh'), JSON.stringify(dirsOf(onNew)));
    /* 旧根已经不在暴露面里：它再变也不该推给手机端 */
    fs.writeFileSync(path.join(root, 'src', 'live.md'), '# 旧根又改了');
    const onOld = await collect(1500, 'fs');
    ok('换根之后旧根不再推帧', onOld.length === 0, JSON.stringify(dirsOf(onOld)));
  } finally {
    try { await m.invoke('link_server_stop'); } catch { /* */ }
    try { pair?.conn.destroy(); } catch { /* */ }
    /* 树根与"记住开着共享"那条还原回去，再 reload —— 这段是借用户的应用在测，不该留下痕迹 */
    try {
      await m.evalJs(`
        ${savedRoot ? `localStorage.setItem('heid-tree-root', ${JSON.stringify(savedRoot)})` : `localStorage.removeItem('heid-tree-root')`};
        ${savedPrefs ? `localStorage.setItem('heid-link-prefs', ${JSON.stringify(savedPrefs)})` : `localStorage.removeItem('heid-link-prefs')`};
        location.reload(); return 1;`);
    } catch { /* 页面可能正在导航，下一段自己会 attach 到新页面 */ }
    m.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- main */

// 兜底看门狗：无论如何 100 秒内退出，免得某个 await 卡住把 dev 拖住
setTimeout(() => { log('\nWATCHDOG: 超时，强制退出'); process.exit(2); }, 180_000).unref();

log('main: 连接 CDP…');
/* 先归位再取会话：归位会关掉上一轮残留的文档窗口，而 /json 的第一个 page
   不保证是主窗口 —— 拿错窗口，A–G 段就会"全都拒"却看不出为什么。 */
const { invoke, evalJs, close } = await normalizeAppState();
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
  /* 上一轮把「测试配对模式」留着开了的话，A 段的「一次性票用后即废」必然假失败：
     开着那一档时挂的就是那张固定哨兵票，它按设计不会被消费掉。先归位再测。 */
  try { await invoke('link_test_pair_set', { on: false }); } catch { /* */ }
  await normalizeAppState(invoke, evalJs);
  await safe('入参校验', () => badInputs(invoke));
  await safe('A 应用当服务端', () => appAsServer(invoke));
  await safe('J 测试配对模式', () => testPairMode(invoke));
  await safe('F 阶段 2 命令面', () => stage2Files(invoke));
  await safe('G 阶段 2 手机侧通路', () => appAsClientFiles(invoke));
  await safe('B 应用当客户端', () => appAsClient(invoke));
  await safe('C 指纹不符', () => wrongFp(invoke));
  await safe('D 未登记 keyId', () => unknownKeyId(invoke));
  /* I 段自己会把前端的树根换成临时目录并 reload，放在 H 前面；两段都会换根，
     谁在后面对象就变了，所以 H 仍然排最后。 */
  await safe('I 阶段 4 实时推送', () => stage4Live());
  /* 放最后：这段会换用户的文件树根并 reload 页面，跑在前面对象就变了。
     跑之前先让应用把会话恢复完 —— 基线读到"没有标签"而中途又冒出几个，判据就全歪了。 */
  await safe('H 阶段 3 标签与聚焦', () => stage3Tabs());
} finally {
  try { await invoke('link_server_stop'); } catch { /* */ }
  try { await invoke('link_client_disconnect'); } catch { /* */ }
  close();
}
log('\n完成。');
process.exit(0);
