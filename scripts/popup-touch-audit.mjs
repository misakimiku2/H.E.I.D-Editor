/**
 * 弹窗层触点量测（ROADMAP 52② 的「量的方法」）
 *
 *   node scripts/popup-touch-audit.mjs --label "设置弹窗"
 *
 * 连接 adb 转发出来的 WebView 调试端口，量**当前屏幕**上每个可交互控件的实际 rect，
 * 打印低于 48dp 的项，有违例则退出码 1（能当门禁挂到验收脚本里）。
 *
 * 为什么不用现成的全局 touch-target 审计：那个在本应用报的约 60 条子 48dp 项绝大多数是噪声
 * （标签内 svg、脏点、cm-gutterElement），总数没法用。这里的口径是：只量「这一屏实际会点到的东西」，
 * 所以状态要自己开到位——用 cdp-audit.mjs 点进去，再跑本脚本量。
 *
 * 前置：模拟器装 debug 包（release 无调试端点），并且
 *   adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 * 装完必须 force-stop 再启动，否则跑的还是旧代码（见 android-install.sh 头部说明）。
 */
import WebSocket from 'ws';

const FLOOR = 48;
const label = (() => {
  const i = process.argv.indexOf('--label');
  return i > 0 ? process.argv[i + 1] : 'screen';
})();

/* 已知不属于弹窗层的噪声，口径沿用 ROADMAP 52 的判断：
   标签条整体（含标签关闭 ×）与选区延展/行号拖拽把手维持原样（shelved / 明确不做），编辑器内部另算。 */
const DUMP = `(() => {
  const cls = (el) => (el.className && el.className.toString ? el.className.toString() : '');
  const noise = (el) => el.closest('.cm-editor, .cm-gutters, [data-tab-id]')
    || /min-w-\\[28px\\]/.test(cls(el))
    || (el.getAttribute('aria-label') || '').includes('延展选区')
    || cls(el).includes('fixed opacity-0');
  const SEL = 'button,input,textarea,select,summary,[role="button"],[role="slider"],[role="tab"],[role="checkbox"],[role="menuitem"],a[href]';
  const rows = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    /* checkVisibility 在旧内核（Mate 的 Chrome 99）没有，缺省时按有尺寸放行 */
    if (r.width < 2 || r.height < 2 || (el.checkVisibility ? !el.checkVisibility() : false)) continue;
    if (noise(el)) continue;
    rows.push({
      name: ((el.getAttribute('aria-label') || el.title || (el.textContent || '').trim() || el.placeholder || '')
        .replace(/\\s+/g, ' ').slice(0, 20)),
      tag: el.tagName.toLowerCase(),
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      box: (el.closest('[class*="pointer-coarse"]') ? 'coarse' : '') || (matchMedia('(pointer: coarse)').matches ? 'coarse-device' : 'fine-device'),
    });
  }
  const bad = rows.filter(x => Math.min(x.w, x.h) < ${FLOOR}).map(x =>
    String(Math.min(x.w, x.h)).padStart(3) + 'dp ' + x.w + 'x' + x.h + ' ' + x.tag + ' ' + x.name);
  /* 抬档之后要顺手确认弹窗没被撑出可视框：面板底边越过视口、或内部出现裁切滚动，都算这一屏的问题。
     （v1.4.2 给「关于」加 max-h + overflow-y-auto 就是因为手机壳只剩十几像素余量） */
  const panels = [...document.querySelectorAll('div')]
    .filter(d => /rounded-2xl|rounded-xl/.test(cls(d)) && d.getBoundingClientRect().height > 200)
    .map(d => { const r = d.getBoundingClientRect();
      return { over: Math.round(Math.max(0, r.bottom - innerHeight) + Math.max(0, -r.top)),
               h: Math.round(r.height),
               clip: [...d.querySelectorAll('*')].reduce((n, c) => n + (c.scrollHeight > c.clientHeight + 4 ? 1 : 0), 0) };
    });
  return JSON.stringify({ vw: innerWidth, vh: innerHeight, rows, bad, panels });
})()`;

const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('没有 page target：确认 adb forward 与 WebView 调试端口'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
const { result } = await new Promise(res => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: DUMP, returnByValue: true } }));
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) res(m); });
});
ws.close();

if (result?.exceptionDetails) { console.error('求值异常:', result.exceptionDetails.text); process.exit(2); }
const { vw, vh, rows, bad, panels } = JSON.parse(result.result.value);
const min = rows.length ? Math.min(...rows.map(r => Math.min(r.w, r.h))) : null;
/* 面板只有「越过可视框」才算问题；内部有滚动容器是正常的（长列表就靠它） */
const spill = panels.filter(p => p.over > 1);

console.log(`### ${label}  视口 ${vw}×${vh}  控件 ${rows.length} 个  最小边 ${min}dp  ` +
  `${bad.length || spill.length ? '❌' : '✅'}` +
  `${panels.length ? `  面板 高${Math.max(...panels.map(p => p.h))}${spill.length ? ' 溢出可视框' : ''}` : ''}`);
for (const r of bad) console.log(`   ${r}`);
for (const p of spill) console.log(`   面板溢出 ${p.over}dp（高 ${p.h}）—— 抬档后弹窗装不下，需要 max-h + 内部滚动`);
if (bad.length || spill.length) console.log(`   门禁：触屏触点最小边 ≥ ${FLOOR}dp，且弹窗不得溢出可视框`);
process.exit(bad.length || spill.length ? 1 : 0);
