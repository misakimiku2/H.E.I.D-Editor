/**
 * CDP 触屏适配审计脚本（开发辅助,不进构建）:
 * 用法: node scripts/cdp-audit.mjs "<JS 表达式>"
 * 连接 adb 转发出来的 WebView 调试端口,执行表达式并打印结果。
 */
import WebSocket from 'ws';

const expr = process.argv[2] ?? 'document.title';
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(res => ws.on('open', res));

const result = await new Promise((resolve, reject) => {
  const id = 1;
  const onMsg = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id === id) { ws.off('message', onMsg); resolve(msg); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
    expression: expr, returnByValue: true, awaitPromise: true,
  }}));
  setTimeout(() => reject(new Error('cdp timeout')), 20000);
});

ws.close();
if (result.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(result.result.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(result.result?.result?.value, null, 2));
}
