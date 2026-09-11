# 安卓移植设计（Android Port）

- 日期：2026-09-12
- 状态：已批准，实施中
- 范围：H.E.I.D（Nexus Editor），Tauri 2 + React 19，目标 Android 手机 + 平板

## 1. 背景与目标

现有 H.E.I.D 是 Tauri 2 桌面应用（Rust 壳 40 行、零自定义命令，文件操作全部走官方 fs/dialog 插件；前端约 5400 行 React）。目标：

1. 移植到 Android，**手机与平板**双形态适配，交互符合移动端习惯；
2. 保持单代码库，Windows 桌面版行为零回归。

技术路线（已与用户确认）：**Tauri 2 官方 Android 目标直接移植**，前端全量复用；不做 Capacitor 封装、不做 Kotlin/Compose 原生重写。

功能范围：核心功能分级适配。**外部修改 diff / 文件监听功能在安卓版整体不实现**（用户决定）：官方 fs `watch` 不支持 Android，且 SAF `content://` 文件无真实路径可监听；桌面端该功能保持不动。

## 2. 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 技术路线 | Tauri 2 Android（`tauri android init` 生成 gradle 工程） | 前端全量复用、一套代码双端；项目已有 `mobile_entry_point` 模板残留 |
| 平台检测 | 新增 `src/lib/platform.ts`：`IS_ANDROID_APP`（`__TAURI_INTERNALS__` + UA）、`IS_TOUCH_PRIMARY`（pointer:coarse） | 条件渲染集中在少量入口，布局适配以 CSS 媒体查询为主 |
| 断点 | 手机 <768px；平板 ≥768px；≥1024px 启用小地图/粘性滚动 | 与 Material 断点习惯一致；平板尽量保留桌面能力 |
| 桌面回归 | 桌面行为路径不改；移动端分支全部以平台/断点守卫 | 桌面是当前生产形态，零回归优先 |
| Rust 改动 | 仅 `lib.rs` 图标逻辑加 `#[cfg(desktop)]` 门控 | 移动端无 window.set_icon API，不改编译失败 |
| diff/监听 | Android 端 `useExternalFileWatcher` 直接禁用，无 diff 徽章/弹窗 | 官方不支持 + 用户明确砍掉；后续版本再评估 |
| 工程入库 | `src-tauri/gen/android` 提交入库 | 需保留 MainActivity 返回键定制等人工修改 |

## 3. 移动端 UI 与交互设计

### 3.1 手机（<768px）

- **顶栏**：Logo + 当前文件名（脏点）+ 标签数徽标（点开 TabSheet）+ ⋮ 溢出菜单（新建/另存为/插入图片/插入表格/主题/关于/关闭标签）。隐藏自绘窗口按钮。
- **底部工具栏**（拇指区）：打开、保存、撤销、重做、编辑|预览切换、更多。状态栏隐藏。
- **TabSheet**：底部抽屉列出全部标签（文件名/路径/脏点，关闭 X 常显）。
- **模态**（图片插入/确认框/关于）呈现为底部 sheet 或全屏。
- **不启用**：小地图、粘性滚动、行号拖选、分屏（编辑/预览二选一）。

### 3.2 平板（≥768px）

桌面布局去掉窗口按钮：标签条（关闭 X 触控常显）、菜单栏三视图切换、分屏可用；≥1024px 启用小地图与粘性滚动；保留状态栏；旋转/尺寸变化靠媒体查询自适应。

### 3.3 交互替换矩阵

| 桌面 | 安卓 |
| --- | --- |
| 右键格式化菜单 | 长按选区（WebView 触发 contextmenu，复用 FormatMenu 组件改锚点定位）+ 工具栏入口 |
| hover 显示标签关闭 X | 触屏下常显 |
| Ctrl+S/O/N/Z/Y | 底部工具栏与菜单按钮（物理键盘仍可用） |
| Escape 关闭弹层 | 系统返回键：MainActivity 拦截 → JS 事件逐层关闭；无弹层时走与桌面一致的脏标签退出确认 |
| 悬停近似表格 +/− 按钮 | 点选单元格编辑时在其上方浮出增删行列工具条 |
| 拖拽文件打开 | 移除（不适用） |
| title 悬停提示 | 按钮均带图标+文字标签 |

## 4. 文件访问（Android SAF）

- **打开**：`dialog.open(multiple)` 返回 `content://` URI，`fs.readFile` 官方声明支持；标签显示名从 URI 末段解析，内部以 URI 为 `tab.path`。
- **保存已有**：`fs.writeFile(content://)` 官方支持但有历史边界问题（plugins-workspace#3356），实施中在模拟器实测；失败回退社区插件 tauri-plugin-android-fs。
- **另存为**：`dialog.save()` 官方平台表标注 Android 支持（对应系统 CREATE_DOCUMENT），同样实测，回退同上。
- **会话恢复**：SAF URI 跨进程重启可能失权（无 takePersistableUriPermission），现有代码对读失败文件已优雅跳过，v1 接受该限制。
- **capabilities**：按实测结果补充 content:// 相关作用域。

## 5. 改动清单

**新增**：`src/lib/platform.ts`；`src/components/mobile/`（TopAppBar / BottomToolbar / TabSheet）；格式化 sheet 复用 MarkdownTools 的 `MENU_SECTIONS`/`transformSlice` 纯逻辑。

**修改**：`index.html`（viewport：`viewport-fit=cover`、`user-scalable=no`、`interactive-widget=resizes-content`）；`index.css`（safe-area inset、触控目标 ≥44px）；`App.tsx`（响应式骨架、返回键事件、平台分支）；`CodeEditor.tsx`（断点禁用 minimap/sticky/行号拖选、触屏字号）；`MarkdownPreview.tsx`（表格工具触屏化、pointerdown 关闭菜单）；`useExternalFileWatcher.ts`（Android 禁用）；`ImageInsertModal`（系统选择器）；`session.ts`（URI 路径兼容）。

**工程**：`tauri android init` 生成 `src-tauri/gen/android`（应用名 H.E.I.D、自适应图标）；版本号统一升 1.1.0；README 增补安卓构建说明。

## 6. 实施阶段与验收

- **P0 工具链与空壳跑通**：rust android targets（已装）→ NDK → `tauri android init` → lib.rs 门控 → debug APK 模拟器启动出欢迎页（手机 AVD 截图通过）。
- **P1 布局骨架**：platform.ts + viewport/safe-area + 手机顶栏/底部工具栏/TabSheet + 平板去窗口按钮。
- **P2 触屏交互**：长按格式化、表格工具触屏化、返回键逐层关闭、IME 弹起、插入图片。
- **P3 SAF 文件访问**：打开/读取/保存/另存全链路实测（决策门：write-back 与 save()），禁用监听，会话恢复兼容。
- **P4 平板打磨**：分屏、≥1024px 小地图/粘性滚动、旋转适配。
- **P5 测试收尾**：手机+平板 AVD 自动化走查（逐屏截图）、真机冒烟、桌面回归（`tauri:dev` 冒烟 + vitest 全过）、版本号与 README。

## 7. 风险与决策门

1. content URI 写回 / CREATE_DOCUMENT 实测不符 → 回退社区 SAF 插件（P3 内解决，不动架构）。
2. 首次 NDK 下载与首次 Rust Android 构建较慢（10–20 分钟）。
3. 老设备 WebView 兼容：v1 底线 API 24+（Tauri 2 minSdk 默认值），以 API 35 模拟器验证为主、真机冒烟为辅。
4. CodeMirror 长按选区与原生文本选择手柄共存需事件调优（P2 专项）。

## 8. 测试方式

/android-dev（android-emulator MCP）：构建 → 安装 → 启动 → `android_screenshot` 逐屏核对 + 坐标点击/滑动模拟真实操作；覆盖欢迎页、编辑、预览、格式化 sheet、TabSheet、图片插入、平板分屏。桌面 `npm run tauri:dev` 冒烟确认零回归。
