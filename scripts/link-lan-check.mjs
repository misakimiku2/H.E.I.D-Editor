/**
 * v1.5 设备互联的跨机实测工具（驱动**手机/模拟器**那一侧，桌面在另一台电脑上）。
 *
 * 与 `link-verify.mjs` 的分工：那份跑在本机桌面应用上、自己扮演对端，验的是协议与命令面；
 * 这一份只需要一个**能改的共享根 + 一条真实的局域网链路**，不需要真机，
 * 把阶段 2/3/4 的判据在跨机形态下再跑一遍 —— 特别是 `link-verify` 量不到的那条：
 * 桌面侧 notify 监听真的把变更推到手机了吗。
 *
 * 用法（手机侧 = 连着 adb 的模拟器/调试包）：
 *   node scripts/link-lan-check.mjs status                  链路现状 + 共享根 + 桌面标签
 *   node scripts/link-lan-check.mjs fsprobe [n] [gap]       第 n 次探测：写一次、等多久收到 fs 帧
 *   node scripts/link-lan-check.mjs protocol                阶段 2/3 逐条（读写/冲突/逃逸/超限/标签）
 *   node scripts/link-lan-check.mjs pair 123456             用 6 位短码配对（桌面要点 TOFU）
 *   node scripts/link-lan-check.mjs pairtest                用固定测试短码配对（桌面开着测试模式，无需点允许）
 *   node scripts/link-lan-check.mjs reconnect <keyId> --host=IP   免扫重连
 *
 * 公共参数：`--file=nested/probe.txt` 探测用的文件（**必须已存在**，命令面没有建文件的能力）、
 * `--wait=12` 每次等帧的秒数、`--host= --port=` 配对时连哪台、`--cdp=9222`。
 *
 * 时钟口径：模拟器的页面时钟与本机的 node 时钟差了几十小时，所以帧延迟**只用页面时间戳相减**，
 * node 侧的计时只用来决定"还要不要等"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const PKG = 'com.nexus.editor';
const EVENT = 'heid-link-event';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const POS = argv.filter((a) => !a.startsWith('--'));

const CDP_PORT = Number(flag('cdp', 9222));
const FILE = flag('file', 'README.txt');
const WAIT_MS = Number(flag('wait', 12)) * 1000;
const N = Number(POS[1] || 5);
const GAP_MS = Number(POS[2] || 20) * 1000;

// 同步写 fd 1：中途挂起时异步缓冲会丢掉已跑过的行
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 手机侧页面 */

/** 模拟器上的 WebView 调试口挂在 abstract socket 上，每次重启应用 pid 都会变，所以顺手转发。 */
function adbForward() {
  try {
    const serial = flag('serial', '');
    const dev = serial ? ['-s', serial] : [];
    const pid = execFileSync('adb', [...dev, 'shell', 'pidof', PKG], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (!pid) return log('（adb 没找到应用进程，假设 ' + CDP_PORT + ' 已经转发好了）');
    execFileSync('adb', [...dev, 'forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
    log(`adb forward tcp:${CDP_PORT} -> webview_devtools_remote_${pid}`);
  } catch (e) {
    log(`（adb forward 没做成：${String(e.message).slice(0, 80)}，继续用现成的转发）`);
  }
}

async function openPage() {
  adbForward();
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('tauri'));
  if (!page) throw new Error('CDP 端口上没有 H.I.D.E 页面，先确认应用已启动、adb forward 已建立');
  const { WebSocket } = await import(pathToFileURL(`${REPO}/node_modules/ws/wrapper.mjs`).href);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let mid = 0;
  const waiting = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const js = (expr, ms = 30000) => new Promise((res) => {
    const id = ++mid;
    const t = setTimeout(() => { waiting.delete(id); res({ err: `求值超时 ${ms}ms` }); }, ms);
    waiting.set(id, (m) => {
      clearTimeout(t);
      const d = m.result && m.result.exceptionDetails;
      if (d) res({ err: 'JS: ' + String((d.exception && d.exception.description) || d.text).slice(0, 300) });
      else res({ val: m.result.result.value });
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  /** 调手机侧命令。失败以 `{err}` 返回而不是抛出 —— 错误文本就是判据本身。 */
  const invoke = async (method, params) => {
    const r = await js('(async()=>{try{return "OK "+JSON.stringify(await window.__TAURI_INTERNALS__.invoke('
      + JSON.stringify(method) + ',' + JSON.stringify(params || {}) + '))}catch(e){return "ERR "+String(e&&(e.message||e))}})()');
    if (r.err) return { err: r.err };
    const s = String(r.val);
    return s.startsWith('ERR ') ? { err: s.slice(4) } : { ok: JSON.parse(s.slice(3)) };
  };
  const req = async (method, params) => {
    const r = await invoke('link_request', { method, params: JSON.stringify(params || {}) });
    // `link_request` 的返回本身是一段 JSON 文本，Tauri 又把它当字符串编了一层 —— 解两层才是载荷
    if (r.ok && typeof r.ok === 'string') { try { r.ok = JSON.parse(r.ok); } catch { /* 原样留给调用方看 */ } }
    return r;
  };
  return { ws, js, invoke, req, close: () => ws.close() };
}

/** 页面里挂一个常驻监听器，把每一条互联推送记进 `window.__frames`。
 *  **`transformCallback` 的第二个参数是 `once` 不是 persistent** —— 传 `true` 会让回调收到第一条之后
 *  自己注销，于是「一条连接只到一帧」。2026-09-25 就是这一处把阶段 4 误判成 1/5 的（见
 *  `docs/bugs/2026-09-25-link-lan-findings.md` 的更正）。 */
async function watchFrames(p) {
  const r = await p.js(`(async()=>{
    window.__frames = [];
    if (!window.__frameListener) {
      const id = window.__TAURI_INTERNALS__.transformCallback((e)=>{
        (window.__frames = window.__frames || []).push([Date.now(), JSON.stringify(e && e.payload !== undefined ? e.payload : e)]);
        return undefined;
      });
      window.__frameListener = await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',
        { event: ${JSON.stringify(EVENT)}, target: { kind: 'Any' }, handler: id });
    }
    return 'listener ' + window.__frameListener;
  })()`);
  if (r.err) throw new Error('挂监听器失败：' + r.err);
  log(r.val);
}
const frames = async (p) => JSON.parse(String((await p.js('JSON.stringify(window.__frames||[])')).val || '[]'));
const fsFrames = async (p) => (await frames(p)).filter((x) => x[1].includes('"fs"'));

/* ------------------------------------------------------------------ status */

async function cmdStatus(p) {
  const st = await p.invoke('link_status');
  log('status   ', st.err ? '!! ' + st.err : JSON.stringify(st.ok));
  if (st.err || !st.ok.connected) return;
  const root = await p.req('list', { relDir: '' });
  log('list 根  ', root.err ? '!! ' + root.err : JSON.stringify(root.ok).slice(0, 1200));
  const tabs = await p.req('tabs', {});
  log('tabs     ', tabs.err ? '!! ' + tabs.err : JSON.stringify(tabs.ok).slice(0, 1200));
  const prefs = await p.js('JSON.stringify({tree:localStorage.getItem("heid-tree-root"),link:localStorage.getItem("heid-link-prefs")})');
  log('页面记的根', String(prefs.val || prefs.err).slice(0, 400));
}

/* ------------------------------------------------------------------ fsprobe */

/**
 * 判据实验：连续 n 次「通过链路写共享根里的一个文件」，每次记下手机端等到 fs 帧的延迟。
 * 全到 = 桌面侧监听在**本地目录**形态下没问题；仍然只到一两次 = 回到 watch.rs 这条线查。
 */
async function cmdFsProbe(p) {
  const st = await p.invoke('link_status');
  if (st.err || !st.ok.connected) throw new Error('手机上没有连着桌面：' + (st.err || 'connected=false'));
  log(`探测文件 ${FILE} · ${N} 次 · 每次间隔 ${GAP_MS / 1000}s · 单次最多等 ${WAIT_MS / 1000}s\n`);
  await watchFrames(p);

  const first = await p.req('read', { relPath: FILE });
  if (first.err) throw new Error('读不到探测文件（换成共享根里确实存在的文件）：' + first.err);
  const original = first.ok.text;
  const dir = FILE.includes('/') ? FILE.slice(0, FILE.lastIndexOf('/')) : '';
  let hit = 0;
  const lat = [];
  try {
    for (let i = 1; i <= N; i += 1) {
      const t0 = Date.now();
      const cur = await p.req('read', { relPath: FILE });
      if (cur.err) { log(`第 ${i} 次  read 失败：${cur.err}`); continue; }
      const pageT0 = Number((await p.js('Date.now()')).val);
      const mark = `${cur.ok.text}lan-probe ${i} ${new Date().toISOString()}\n`;
      const w = await p.req('write', {
        relPath: FILE, text: mark, encoding: cur.ok.encoding, bom: cur.ok.bom, baseHash: cur.ok.hash,
      });
      if (w.err || w.ok.conflict) { log(`第 ${i} 次  write 失败/冲突：${w.err || 'conflict ' + w.ok.serverHash.slice(0, 8)}`); continue; }
      const deadline = Date.now() + WAIT_MS;
      let got = null;
      while (Date.now() < deadline && !got) {
        await sleep(300);
        const fresh = (await fsFrames(p)).filter((x) => x[0] >= pageT0 - 50);
        got = fresh.find((x) => x[1].includes('"fs"')) || null;
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (got) {
        hit += 1;
        const d = Number(got[0]) - pageT0;
        lat.push(d);
        log(`第 ${i} 次  OK   ${d} ms 到帧（写出后 ${elapsed}s）  ${got[1].slice(0, 90)}`);
      } else {
        log(`第 ${i} 次  MISS 等 ${elapsed}s 没有帧（dirs 里该有 ${JSON.stringify(dir)}）`);
      }
      const rest = GAP_MS - (Date.now() - t0);
      if (i < N && rest > 0) await sleep(rest);
    }
  } finally {
    const back = await p.req('read', { relPath: FILE });
    if (!back.err) {
      const r = await p.req('write', {
        relPath: FILE, text: original, encoding: back.ok.encoding, bom: back.ok.bom, baseHash: back.ok.hash,
      });
      log(`\n还原 ${FILE}：${r.err ? '失败 ' + r.err : 'ok'}`);
    }
  }
  const sorted = [...lat].sort((a, b) => a - b);
  log(`\n成功率 ${hit}/${N}` + (sorted.length ? ` · 延迟中位 ${sorted[sorted.length >> 1]} ms · 最快 ${sorted[0]} · 最慢 ${sorted[sorted.length - 1]}` : ''));
  log(hit === N
    ? '这个形态下监听与推送链路都正常（第一轮跨机量到的 1/5 是探针把 transformCallback 的 once 当成 persistent，不是产品问题）'
    : hit === 0
      ? '一帧都没到：先确认探针的监听器是常驻的（别传第二个参数），再按桌面日志 / 手机 logcat / 页面计数三路对质'
      : '部分到达：帧会来但被静默打断，按那三路对质定位掉在哪一段');
}

/* ------------------------------------------------------------------ protocol */

const checks = [];
const check = (name, cond, extra = '') => {
  checks.push({ name, pass: !!cond });
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

async function cmdProtocol(p) {
  const st = await p.invoke('link_status');
  if (st.err || !st.ok.connected) throw new Error('手机上没有连着桌面：' + (st.err || 'connected=false'));
  const root = await p.req('list', { relDir: '' });
  check('list 根', !root.err && (root.ok.entries || []).length > 0, root.err || (root.ok.entries || []).length + ' 项');
  const parent = FILE.includes('/') ? FILE.slice(0, FILE.lastIndexOf('/')) : '';
  if (parent) {
    const sub = await p.req('list', { relDir: parent });
    check(`list ${parent}`, !sub.err, sub.err || (sub.ok.entries || []).length + ' 项');
  }
  const rd = await p.req('read', { relPath: FILE });
  check('read 带回基线哈希与编码判定', !rd.err && /^[0-9a-f]{64}$/.test(rd.ok.hash || '') && !!rd.ok.encoding,
    rd.err || `${rd.ok.encoding} bom=${rd.ok.bom} lossy=${rd.ok.lossy}`);
  if (!rd.err) {
    const st2 = await p.req('stat', { relPath: FILE });
    check('stat 与 read 同一哈希', !st2.err && st2.ok.hash === rd.ok.hash, st2.err);
    const stamp = `proto ${new Date().toISOString()}\n`;
    const w1 = await p.req('write', { relPath: FILE, text: rd.ok.text + stamp, encoding: rd.ok.encoding, bom: rd.ok.bom, baseHash: rd.ok.hash });
    const rb = await p.req('read', { relPath: FILE });
    check('write 落盘并读回一致', !w1.err && !rb.err && rb.ok.text === rd.ok.text + stamp, w1.err || (rb.ok && rb.ok.text.length + 'B'));
    const stale = await p.req('write', { relPath: FILE, text: 'stale overwrite\n', encoding: rd.ok.encoding, bom: false, baseHash: rd.ok.hash });
    check('过期基线判冲突而不是覆盖', !stale.err && stale.ok.conflict === true && !!stale.ok.serverHash, stale.err);
    const after = await p.req('read', { relPath: FILE });
    check('冲突那次没改内容', !after.err && after.ok.text === rb.ok.text, after.err);
    const back = await p.req('write', { relPath: FILE, text: rd.ok.text, encoding: rb.ok.encoding, bom: rb.ok.bom, baseHash: rb.ok.hash });
    const done = await p.req('read', { relPath: FILE });
    check('还原', !back.err && !done.err && done.ok.text === rd.ok.text && done.ok.hash === rd.ok.hash, back.err || done.err);
  }
  for (const [rel, why] of [['../outside', '父目录穿越'], ['C:/Windows/win.ini', '绝对路径'],
    ['\\\\host\\share\\x.txt', 'UNC'], [parent + '/../../x', '多层回跳']]) {
    const r = await p.req('read', { relPath: rel });
    check(`逃逸被拒：${why}`, !!r.err, r.err ? String(r.err).slice(0, 60) : '竟然读到了');
  }
  const big = await p.req('read', { relPath: flag('big', 'blob.dat') });
  check('超限文件如实拒绝', !!big.err && /toobig|超过/.test(String(big.err)), big.err || '没有拒绝');
  const tabs = await p.req('tabs', {});
  check('tabs 命令可用', !tabs.err, tabs.err || (tabs.ok || []).length + ' 个标签');
  const bad = await p.req('nope', {});
  check('未知命令被拒', !!bad.err, bad.err || '竟然返回了');
  log(`\n${checks.filter((c) => c.pass).length}/${checks.length} PASS`);
}

/* ------------------------------------------------------------------ pair */

async function cmdPair(p) {
  const code = POS[1];
  if (!/^\d{6}$/.test(code || '')) throw new Error('配对短码是 6 位数字');
  const st = await p.invoke('link_status');
  const [h, por] = String(st.ok?.peerAddr || '').split(':');
  const host = flag('host', h);
  const port = Number(flag('port', por || st.ok?.port || 47123));
  if (!host) throw new Error('status 里没有对端地址，用 --host= 指定');
  log(`配对 ${host}:${port} 短码 ${code}（桌面那边 2 分钟内点「允许」）`);
  const r = await p.invoke('link_client_pair_code', { host, port, code, device: flag('device', 'lan-check') });
  log(r.err ? '发起失败 ' + r.err : '已发起');
  for (let i = 0; i < 40; i += 1) {
    await sleep(2000);
    const s = await p.invoke('link_status');
    log(`  [${(i + 1) * 2}s] connected=${s.ok?.connected} peer=${s.ok?.peerDevice || '(空)'} err=${s.ok?.lastError || '-'}`);
    if (s.ok?.connected) break;
    if (i === 9) log('  （已经 20s：去桌面端点「允许这台设备」）');
  }
}

/* ------------------------------------------------------------------ reconnect */

/** 免扫重连：keyId 从 `status` 的 peerKeyId 或桌面「已配对设备」里抄。 */
async function cmdReconnect(p) {
  const keyId = POS[1];
  if (!keyId) throw new Error('用法：reconnect <keyId> --host=IP [--port=47123]');
  const host = flag('host', '');
  if (!host) throw new Error('要 --host= 指定桌面地址');
  const r = await p.invoke('link_client_reconnect', {
    host, port: Number(flag('port', 47123)), keyId, device: flag('device', 'lan-check'),
  });
  log(r.err ? '重连失败 ' + r.err : '已发起');
  for (let i = 0; i < 15; i += 1) {
    await sleep(1000);
    const s = await p.invoke('link_status');
    if (s.ok?.connected) { log(`  [${i + 1}s] connected=true peer=${s.ok.peerDevice || '(名字空)'} keyId=${s.ok.peerKeyId}`); return; }
    if (i % 4 === 0) log(`  [${i + 1}s] connected=${s.ok?.connected} err=${s.ok?.lastError}`);
  }
  log('  15 s 内没连上');
}

/* ------------------------------------------------------------------ pairtest */

/**
 * 测试专用配对的手机侧一路：用**固定的测试短码**配对，全程没有人点 TOFU。
 * 连上了就说明「自动允许」这条在真 TCP 上成立（`via_test` 记账那半在 link-verify 的 J 段核，
 * 那是桌面侧的列表，手机看不到）。
 *
 * 短码由 `pair::TEST_TICKET` 经 `pair::short_code` 导出。这里重算一遍是为了脚本能自己跑，
 * 但**别把它当权威**：J 段会拿桌面上显示的那个码对一次，两处不一致就说明派生规则漂了。
 */
const TEST_TICKET = '5eedc0de5eedc0de5eedc0de5eedc0de';
const CODE_PREFIX = Buffer.from('heid-link-shortcode-v1');
const shortCode = (secret) => {
  const d = createHash('sha256').update(Buffer.concat([CODE_PREFIX, Buffer.from(secret)])).digest();
  return String(d.readUInt32BE(0) % 1_000_000).padStart(6, '0');
};

async function cmdPairTest(p) {
  const st = await p.invoke('link_status');
  const [h, por] = String(st.ok?.peerAddr || '').split(':');
  const host = flag('host', h);
  if (!host) throw new Error('status 里没有对端地址，用 --host= 指定');
  const port = Number(flag('port', por || st.ok?.port || 47123));
  const code = shortCode(TEST_TICKET);
  log(`测试短码 ${code} → ${host}:${port}（这条路上没有人点「允许」）`);
  await p.invoke('link_client_disconnect', {});
  await sleep(800);
  const r = await p.invoke('link_client_pair_code', { host, port, code, device: flag('device', 'lan-check-test') });
  log(r.err ? '发起失败 ' + r.err : '已发起');
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const s = await p.invoke('link_status');
    if (s.ok?.connected) {
      log(`  [${i + 1}s] PASS 自动允许生效：connected=true keyId=${s.ok.peerKeyId} peer=${s.ok.peerDevice || '(名字空)'}`);
      return;
    }
    if (i % 5 === 4) log(`  [${i + 1}s] connected=${s.ok?.connected} err=${s.ok?.lastError}`);
  }
  log(`  FAIL 12 位…20 s 内没连上：${JSON.stringify((await p.invoke('link_status')).ok?.lastError)} —— 桌面那侧的测试配对开关是开的吗？`);
}

/* ------------------------------------------------------------------ main */

const run = { status: cmdStatus, fsprobe: cmdFsProbe, protocol: cmdProtocol, pair: cmdPair, pairtest: cmdPairTest, reconnect: cmdReconnect }[cmd];
if (!run) {
  log('用法：node scripts/link-lan-check.mjs <status|fsprobe|protocol|pair|pairtest|reconnect> [参数]');
  process.exit(2);
}
const p = await openPage();
try {
  await run(p);
} catch (e) {
  log('!! ' + (e && e.message));
  process.exitCode = 1;
} finally {
  p.close();
}
