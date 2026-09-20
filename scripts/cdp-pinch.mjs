/**
 * CDP 双指捏合（开发辅助，一次性）：node scripts/cdp-pinch.mjs ax ay bx by [spreadPx]
 * 在 (ax,ay) 与 (bx,by) 落下两指，把第二指沿两指连线方向外移 spreadPx。
 */
import WebSocket from 'ws';

const [ax, ay, bx, by, spread = 120] = process.argv.slice(2).map(Number);
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 16 * 1024 * 1024 });
await new Promise(res => ws.on('open', res));

let seq = 0;
const send = (method, params) => new Promise((resolve) => {
  const id = ++seq;
  const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id === id) { ws.off('message', onMsg); resolve(m.result); } };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (n) => new Promise(r => setTimeout(r, n));
const pt = (x, y, id) => ({ x, y, id, force: 0.7, radiusX: 2, radiusY: 2, rotationAngle: 0 });

const dx = bx - ax, dy = by - ay;
const len = Math.hypot(dx, dy) || 1;
const ux = dx / len, uy = dy / len;

await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(ax, ay, 1)] });
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(ax, ay, 1), pt(bx, by, 2)] });
const steps = 8;
for (let i = 1; i <= steps; i++) {
  const nx = bx + ux * spread * i / steps, ny = by + uy * spread * i / steps;
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(ax, ay, 1), pt(nx, ny, 2)] });
  await sleep(30);
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pt(ax, ay, 1)] });
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(200);
ws.close();
console.log(`pinch (${ax},${ay})-(${bx},${by}) spread=${spread}`);
