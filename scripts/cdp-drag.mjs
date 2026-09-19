/**
 * CDP 单指拖拽（开发辅助）：node scripts/cdp-drag.mjs x1 y1 x2 y2 [ms] [holdBeforeMove]
 * CSS 坐标下 touchStart → 停留 holdBeforeMove → 逐步 touchMove → touchEnd。
 * 单指合成可靠；多指不可靠（见 memory）。
 */
import WebSocket from 'ws';

const [x1, y1, x2, y2, ms = 400, hold = 120] = process.argv.slice(2).map(Number);
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
const sleep = (n) => new Promise(r => setTimeout(r, n));

const touch = (x, y) => ({ x, y, id: 1, force: 0.7, radiusX: 2, radiusY: 2, rotationAngle: 0 });
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(x1, y1)] });
await sleep(hold);
const steps = 10;
for (let i = 1; i <= steps; i++) {
  const x = x1 + (x2 - x1) * i / steps;
  const y = y1 + (y2 - y1) * i / steps;
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(x, y)] });
  await sleep(ms / steps);
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(150);
ws.close();
console.log(`drag (${x1},${y1}) -> (${x2},${y2}) done`);
