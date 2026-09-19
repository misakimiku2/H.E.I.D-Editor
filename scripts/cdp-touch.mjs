/**
 * CDP 触摸长按（开发辅助）：node scripts/cdp-touch.mjs x y [ms]
 * 在 CSS 坐标 (x,y) 触发 touchStart → 停留 → touchEnd，模拟手指长按。
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

const touch = { x, y, id: 1, force: 0.7, radiusX: 2, radiusY: 2, rotationAngle: 0 };
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
await new Promise(r => setTimeout(r, ms));
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise(r => setTimeout(r, 120));
ws.close();
console.log(`long-press at (${x},${y}) ${ms}ms done`);
