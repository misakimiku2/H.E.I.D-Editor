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

- `src/lib/session.test.ts`：往返一致、storage 不可用、损坏/非对象/结构非法 JSON、非法条目过滤与默认值归一、virtual 标签往返、旧版无 kind 快照兼容。
- 手动验收：开多个文件重启恢复；脏标签下分别用 X 按钮、Alt+F4、任务栏关闭验证确认框；取消后窗口留存、数据完好。

## 7. 修订记录

### 修订 1（2026-09-12，用户反馈两项）

**问题 A：未关闭的 welcome.ts 重启后消失。** 原设计把无路径标签一律排除在快照外，用户「没关 welcome.ts、直接打开了其他文件」的场景下 welcome 重启后丢失。

修订：`SessionTab` 改为可辨识联合——

```ts
type SessionTab =
  | { kind: 'file'; path: string; mdView: SessionMdView }   // 磁盘文件，恢复时重读
  | { kind: 'virtual'; title: string };                     // 无路径且未编辑的标签
```

- 快照规则：无路径标签仅当 `!isDirty` 时存为 virtual（welcome 存示例内容、untitled 存空内容，均可确定性重建，恢复无损）；
- 脏的无路径标签仍不持久化——其存亡由退出确认决定，用户确认放弃后不应「复活」；
- 恢复时初始 welcome 标签按固定 id（`INITIAL_WELCOME_ID`）精确识别，仅当其仍未被编辑时让位给快照内容；`activePath` 为 null 时回退到第一个无路径标签（通常即 welcome）；
- 旧版无 `kind` 的快照条目（仅有 `path` + `mdView`）按 file 兼容解析。

**问题 B：退出确认改用应用内自绘弹窗。** 原设计走 `@tauri-apps/plugin-dialog` 的原生 `ask`，与应用视觉割裂。

修订：复用既有 `ConfirmDialog` 组件（红色 danger 确认键，Esc / 遮罩点击等同取消），经 `pendingDiscard` state + Promise 化的 `askDiscardConfirm` 桥接异步确认流；退出确认与关闭脏标签确认（`confirmDiscardTab`）统一走该弹窗，三端（桌面 / 安卓 / 浏览器）一致，同时移除了 WebView 下不可靠的 `window.confirm` 分支。安卓返回键的逐层关闭序列把确认弹窗列为最上层（返回 = 取消确认）。已有待确认项时新的确认请求直接被拒，避免叠开弹窗。

### 修订 2（2026-09-12，用户新增需求：退出并保存）

退出确认弹窗新增「退出并保存」按钮（蓝色强调，位于取消与红色「退出不保存」之间），`ConfirmDialog` 增加可选 `extraAction` prop 支持第三按钮；`askDiscardConfirm` 的决策从布尔改为 `'cancel' | 'discard' | 'save'`（关闭脏标签的弹窗不显示该按钮，行为不变）。

「退出并保存」的语义：

1. 逐个保存全部脏标签（`readOnly` 除外）：有路径的静默写盘（Ctrl+S 语义），无路径的（编辑过的 untitled 等）逐个走另存为对话框；
2. 任一保存被用户取消（另存为对话框点取消）或写盘失败 → **中止退出留在应用**——用户既不想丢数据也未完成保存，静默丢弃违背按钮承诺；失败原因已经由 `saveFileToDisk` 内部提示；
3. 全部成功 → 显式写入一次会话快照（提取的 `writeSessionSnapshot`，避免依赖 effect 在窗口销毁前未执行）→ 走既有 `onCloseRequested` / 安卓返回键的销毁链路关闭；
4. 保存+退出进行中（`exitingRef`）忽略重复的关闭请求，防止与另存为对话框并发触发第二轮保存。

追加（同日）：关闭单个脏标签的确认弹窗同样获得「关闭并保存」按钮，语义一致——先落盘（无路径走另存为），保存被取消/失败则不关闭标签；`confirmDiscardTab` 改为接收标签对象并依赖 `persistTab`（声明顺序随之调整到 `persistTab` 之后）。
