/**
 * CDP 长按探针（开发辅助）：node scripts/cdp-hold-probe.mjs x y [holdMs]
 * touchStart → 停留期间求值 → touchEnd → 抬手后再求值，两份结果都打印。
 * 求值内容固定为「最高层 fixed 弹层是否打开 + 按钮行高」。
 */
import WebSocket from 'ws';

const [x, y, ms = 700] = process.argv.slice(2).map(Number);
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 16 * 1024 * 1024 });
await new Promise(res => ws.on('open', res));

let seq = 0;
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq;
  const onMsg = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id === id) { ws.off('message', onMsg); resolve(msg.result); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  /* send() 返回的是 CDP 响应的 result 字段本身 */
  if (r?.exceptionDetails) return { EXCEPTION: r.exceptionDetails.exception.description };
  return r?.result?.value;
};

const PROBE = `(() => {
  const layers = [...document.querySelectorAll('div')].filter(d => {
    const s = getComputedStyle(d);
    return s.position === 'fixed' && parseInt(s.zIndex) >= 90 && d.querySelector('button');
  });
  const top = layers[layers.length - 1];
  if (!top) return { menuOpen: false };
  return {
    menuOpen: true,
    rows: [...top.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().height)),
  };
})()`;

const touch = { x, y, id: 1, force: 0.7, radiusX: 2, radiusY: 2, rotationAngle: 0 };
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
await new Promise(r => setTimeout(r, ms));
const during = await evalJs(PROBE);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise(r => setTimeout(r, 200));
const after = await evalJs(PROBE);
ws.close();
console.log('during hold:', JSON.stringify(during));
console.log('after lift :', JSON.stringify(after));
