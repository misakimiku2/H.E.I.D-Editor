# 会话恢复与关闭确认设计（Session Restore & Close Confirm）

- 日期：2026-09-12
- 状态：已实现（自主模式下按本推演落地，可随时调整）
- 范围：H.E.I.D（Nexus Editor），Tauri 2 + React 19

## 1. 背景与目标

此前应用每次重启都显示固定的 `welcome.ts` 示例页；且未保存修改只有在点击自定义标题栏 X 按钮时才会被确认，Alt+F4 / 任务栏关闭会静默丢失数据。目标：

1. 重启后自动恢复上次打开的文档（磁盘文件），并恢复激活标签与 markdown 视图模式；
2. 所有关闭路径（自定义按钮 / Alt+F4 / 任务栏关闭）在存在未保存修改时统一弹确认框。

## 2. 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 持久化内容 | 只存「路径 + mdView」元数据，不存文档内容 | 恢复时以磁盘为准；与「退出确认即丢弃未保存内容」语义一致，避免用户确认放弃后重启又"复活"的矛盾 |
| 无路径标签（welcome / untitled） | 不持久化 | 从未被保存过的内容已由关闭确认兜底；恢复后回退 welcome 示例页或空状态 |
| 激活标签 | 存 `activePath`，恢复时定位；无路径激活则回退最后一个恢复标签 | 无需持久化内部 tab id |
| 关闭拦截位置 | JS 端 `getCurrentWindow().onCloseRequested`（Tauri 官方确认模式），Rust 零改动 | Tauri 2 在存在 close-requested 监听时自动拦截系统关闭并转发事件；备选的 Rust `WindowEvent::CloseRequested` + 自定义事件方案更绕，不取 |
| 拦截后的真正关闭 | `appWindow.destroy()`（需 `core:window:allow-destroy` 权限） | `onCloseRequested` 事件已 `preventDefault`，必须显式销毁 |
| 自定义 X 按钮 | 改为直接 `close()`，确认逻辑全部收拢到拦截器 | `close()` 同样触发 close-requested，统一单次确认，避免双重弹窗 |
| 浏览器模式 | `beforeunload` 有脏标签时拦截刷新/关闭；不注册 onCloseRequested | 浏览器无系统关闭概念，开发模式同样有数据保护 |
| 存储介质 | `localStorage`（key `heid-session`） | 数据量极小（纯路径元数据），无需引入 store 插件 |

## 3. 数据模型（`src/lib/session.ts`）

```ts
type SessionMdView = 'edit' | 'split' | 'preview';

interface SessionTab {
  path: string;        // 真实文件绝对路径（仅 Tauri）
  mdView: SessionMdView;
}

interface SessionState {
  tabs: SessionTab[];
  activePath: string | null;  // null = 激活的是无路径标签
}
```

- `loadSessionState(storage?)`：损坏 JSON / 结构非法返回 `null`；非法条目逐条丢弃，`mdView` 非法回退 `edit`；storage 参数可注入（node 测试环境无 localStorage）。
- `saveSessionState(state, storage?)`：storage 不可用静默忽略，持久化失败不影响编辑。

## 4. 运行时行为（`src/App.tsx`）

**恢复**（挂载 effect，仅 Tauri）：读快照 → 逐路径 `readLocalPath` 重读磁盘（文件已删除/移动则跳过）→ 全部失效则清快照并保留 welcome 标签 → 成功则丢弃未被编辑过的初始 welcome 标签、合并恢复标签，按 `activePath` 设置激活。恢复完成前置 `hydratedRef`，期间不写快照（StrictMode 双执行由 `disposed` 守卫）。

**持久化**（`tabs`/`activeTab` 变化 effect，仅 Tauri 且已 hydrate）：快照 = 全部有路径标签的 `{path, mdView}` + `activePath`。

**关闭拦截**（挂载 effect，仅 Tauri）：`onCloseRequested` 一律 `preventDefault()` → 查脏标签数 → 0 直接 `destroy()`；否则 `ask()` 原生确认（复用既有 `confirmWindowClose` 逻辑）→ 确认则 `destroy()`，取消则留在原处。确认等待期间忽略后续关闭请求防连弹；确认流程异常时宁可关不掉也不静默丢数据。

## 5. 权限

`capabilities/default.json` 新增 `core:window:allow-destroy`（`close` 此前已授权）。

## 6. 测试

- `src/lib/session.test.ts`：往返一致、storage 不可用、损坏/非对象/结构非法 JSON、非法条目过滤与默认值归一。
- 手动验收：开多个文件重启恢复；脏标签下分别用 X 按钮、Alt+F4、任务栏关闭验证确认框；取消后窗口留存、数据完好。
