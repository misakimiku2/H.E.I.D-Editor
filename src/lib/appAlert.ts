/**
 * 应用内警示弹窗的全局入口：替代原生 alert()（WebView 下为系统对话框，与应用视觉割裂）。
 * App 挂载时注册毛玻璃弹窗渲染器，非组件层（lib/hooks）直接 appAlert() 触发；
 * 未注册时兜底原生 alert，保证任何调用路径都有出口。
 */

type AlertFn = (message: string) => void;

let handler: AlertFn | null = null;

/** App 挂载时注册弹窗渲染器；卸载时传 null 解除 */
export function registerAppAlert(fn: AlertFn | null): void {
  handler = fn;
}

/** 显示应用内警示弹窗（标题固定为「提示」） */
export function appAlert(message: string): void {
  if (handler) handler(message);
  else alert(message);
}
