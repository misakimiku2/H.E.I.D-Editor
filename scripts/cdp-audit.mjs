/**
 * CDP 触屏适配审计脚本（开发辅助,不进构建）:
 * 用法: node scripts/cdp-audit.mjs "<JS 表达式>" [--port=9222]
 *       node scripts/cdp-audit.mjs --insert="要打的字" [--port=9222]
 * 连接调试端口执行表达式并打印结果。默认 9222 = adb 转发出来的手机 WebView；
 * 9223 = 桌面端（`--remote-debugging-port=9223` 起的 tauri:dev）。
 *
 * `--insert` 走的是 CDP 的 `Input.insertText`：浏览器级的文本插入，落到当前聚焦的可编辑区。
 * 为什么不用 `adb shell input text`：那条发的是按键事件，WebView 里的 CodeMirror 收不到
 * （实测两轮：焦点确实在 contenteditable 上，字却进不去），而 `Input.insertText` 就是
 * DevTools 自己打字用的那条路。
 */
import WebSocket from 'ws';

const expr = process.argv[2] ?? 'document.title';
const portFlag = process.argv.find((a) => a.startsWith('--port='));
const insertFlag = process.argv.find((a) => a.startsWith('--insert='));
const port = portFlag ? portFlag.slice(7) : '9222';
const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
const page = targets.find(t => t.type === 'page' && String(t.url).includes('tauri'))
  ?? targets.find(t => t.type === 'page');
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
  const params = insertFlag
    ? { text: insertFlag.slice(9) }
    : { expression: expr, returnByValue: true, awaitPromise: true };
  ws.send(JSON.stringify({
    id,
    method: insertFlag ? 'Input.insertText' : 'Runtime.evaluate',
    params,
  }));
  setTimeout(() => reject(new Error('cdp timeout')), 20000);
});

ws.close();
if (result.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(result.result.exceptionDetails, null, 2));
} else if (insertFlag) {
  console.log('inserted');
} else {
  console.log(JSON.stringify(result.result?.result?.value, null, 2));
}
