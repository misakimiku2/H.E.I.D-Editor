# 外部 Diff 功能设计（External Diff）

- 日期：2026-09-11
- 状态：已通过（用户确认全部关键决策）
- 范围：H.E.I.D（Nexus Editor），Tauri 2 + React 19 + CodeMirror 6

## 1. 背景与目标

当应用中打开的文件被外部程序修改时：

1. 自动感知并（在无本地未保存修改时）自动更新编辑器内容；
2. 顶部菜单栏出现带徽标的 Diff 按钮，点击打开 diff 弹窗；
3. 弹窗内按时间线展示历次外部修改（链式：A→B、B→C……），左右双栏对比；
4. 每条 diff 可单独「接受」（移除该条）或「撤销修改」（把旧内容写回磁盘），两者均需二次确认；
5. 时间线每文件默认保留 10 条，超出丢弃最旧。

## 2. 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 本地脏状态 + 外部修改冲突 | 不自动更新编辑器，记录 diff 并标记冲突，由用户在弹窗中决定（VS Code 风格） |
| 撤销语义 | 把该条 diff 的 before 内容写回磁盘文件，编辑器同步回退 |
| 操作粒度 | 时间线每条可单独接受/撤销；撤销某条时该条及其后所有条目一并移除，之前的保留 |
| 展示形式 | 左右双栏对比（左旧右新，红删绿增，空行对齐，带行号） |
| 检测技术 | `@tauri-apps/plugin-fs` 官方 `watch` API（方案 A），零 Rust 代码 |
| 运行环境 | 仅 Tauri 桌面端启用；浏览器模式（`npm run dev`）功能不启用 |
| 持久化 | 内存态，不持久化；关闭标签页即丢弃该文件时间线 |

## 3. 数据模型

```ts
interface ExternalDiffEntry {
  id: string;
  before: string;      // 修改前磁盘内容快照
  after: string;       // 修改后磁盘内容快照
  detectedAt: number;  // 检测到的时间戳
}
```

App 级结构（均为内存态）：

- `diffTimelines: Map<文件路径, ExternalDiffEntry[]>` —— 每文件时间线，上限 `MAX_DIFF_ENTRIES = 10`（常量可调），追加时超出即丢弃最旧；
- `diskContents: Map<路径, string>` —— 每路径「最后已知磁盘内容」，用于识别真实变更与自身写入，兼作去抖基准；
- `unwatchers: Map<路径, () => void>` —— watch 取消函数，管理监听生命周期。

时间线为链式结构：第 N 条的 `before` 等于第 N-1 条的 `after`（首条的 before 为建立监听时读到的磁盘内容）。

## 4. 监听生命周期

- 打开带 `path` 的标签页 → 若该路径无 watcher 则建立 `watch(path, cb)`，并初始化 `diskContents`；已有则复用（同路径多标签页共享一份监听）。
- 关闭标签页 → 若该路径不再被任何标签页引用，unwatch 并清理 `diffTimelines` / `diskContents` / `unwatchers` 中的对应项。
- 应用内保存（Ctrl+S / 另存为到已监听路径）→ 更新 `diskContents`，后续 watch 事件比对无差异，不产生 diff。
- 撤销写回磁盘 → 同上（自写识别）。

## 5. 检测流程

watch 事件到达 → 以 300ms 去抖窗口合并连发事件 → 重新 `readFile` → 与 `diskContents` 中已知内容比对：

- **相同** → 忽略（自身写入或无实质变化的触碰）；
- **不同** → 判定为真实外部修改：
  1. 追加 diff 条目 `{ before: 旧已知内容, after: 新内容 }`，更新 `diskContents` 为新内容；
  2. 该路径的标签页若**干净**（`!isDirty`）：编辑器 `content` 与 `originalContent` 同步为新内容（不产生脏状态），并以 major 方式计入标签页撤销历史（Ctrl+Z 可回退这次外部替换）；
  3. 若**脏**：编辑器内容不动，`originalContent` 更新为新磁盘内容（`isDirty = content !== originalContent` 语义保持真实），标签页显示「外部已修改」冲突标记；
  4. 时间线超过 10 条 → 丢弃最旧（其快照随之不可恢复，属有界历史的预期行为）。

## 6. UI 设计

### 6.1 Diff 按钮

- 位置：菜单栏右侧、主题切换组左边；
- 仅当任一打开文件存在未处理 diff 条目时显示；
- lucide `GitCompare` 图标 + 条数徽标；hover 提示「外部修改 diff」。

### 6.2 Diff 弹窗

- **左侧时间线**：按文件分组（文件名为组头，含未处理条目的文件才出现），组内时间倒序；每条显示时间与 `+N -M` 增删行统计；当前选中条目高亮；
- **右侧对比区**：选中条目的左右双栏 diff——左列 before、右列 after，删除行红底、新增行绿底、修改处两侧对齐并用空行填充，显示行号；
- **操作按钮**（作用于选中条目）：
  - **接受**：二次确认 → 仅移除该条目；磁盘与编辑器均不动（脏冲突场景下本地编辑保留，`originalContent` 已随检测更新）；
  - **撤销修改**：二次确认 → 将该条 `before` 写回磁盘（`writeFile`），更新 `diskContents`，该路径所有标签页的 `originalContent` 同步为写回内容（它始终跟踪磁盘最后已知状态）；干净标签页的编辑器内容同步回退并计撤销历史，脏标签页本地内容不动（`isDirty` 依据新的 `originalContent` 重新成立）；移除该条及其后所有条目（链条已断），之前的保留；
- Esc / 点击遮罩关闭；弹窗打开期间新到的外部修改实时反映进时间线（状态驱动渲染）。

### 6.3 二次确认弹窗

- 自绘小型模态，叠加在 diff 弹窗上层（Tauri WebView2 下 `window.confirm` 不可靠，且与应用视觉统一）；
- 接受：「确认接受这次外部修改？该 diff 条目将从时间线移除。」
- 撤销：「确认撤销这次外部修改？磁盘文件将被恢复到此修改之前的内容。」
- 「确认 / 取消」两键，Esc/遮罩等同取消。

### 6.4 标签页冲突标记

脏且存在未处理 diff 的标签页，在标签上显示橙色提示点（区别于现有的琥珀色脏状态点，加 `GitCompare` 小图标或外圈样式），hover 提示「文件已被外部修改，点击菜单栏 Diff 按钮处理」。

## 7. 组件划分

| 单元 | 职责 |
| --- | --- |
| `src/lib/diffTimeline.ts` | 时间线纯函数：追加、上限裁剪、接受移除、撤销级联移除、统计（+N -M） |
| `src/hooks/useExternalFileWatcher.ts` | 监听管理：建立/取消 watch、300ms 去抖、重读与真实变更判定，回调通知 App |
| `src/components/DiffModal.tsx` | diff 弹窗：时间线 + 双栏对比 + 接受/撤销触发 |
| `src/components/ConfirmDialog.tsx` | 通用二次确认小模态 |
| `src/App.tsx` | 集成：状态持有、Diff 按钮、标签页冲突标记、接受/撤销动作（含写回磁盘） |

diff 行级计算使用 `diff`（jsdiff）的 `diffLines`。

## 8. 依赖与权限变更

- npm 新增：`diff`（+ `@types/diff` devDep）；
- `src-tauri/capabilities/default.json` 新增：`fs:allow-watch`、`fs:allow-unwatch`；
- Rust 代码：零改动。

## 9. 边界与错误处理

- 外部删除/重命名导致重读失败 → 忽略本次事件并 `console.warn`（不做删除场景处理）；
- watch 建立失败（权限/路径失效）→ 该文件静默降级为无外部检测，不影响其他功能；
- 大文件：`diffLines` 与内存快照在文本编辑器场景可接受，10 条上限约束内存；
- 浏览器模式：`isTauri === false` 时整个功能不启用；
- 另存为产生新路径 → 按新打开路径处理（建立监听）。

## 10. 测试策略

- 引入 vitest（最小代价，仅纯逻辑）：
  - `diffTimeline` 纯函数：追加与链式 before/after、上限裁剪丢最旧、接受移除单条、撤销级联移除该条及之后、增删统计；
  - 变更判定：内容相同忽略、不同产出条目（可通过注入 fake read 判定函数测试 hook 内的纯逻辑部分）；
- UI 与端到端行为通过 `npm run tauri:dev` 手动验证清单：
  1. 外部修改文件 → 编辑器自动更新 + 时间线出现第 1 条；
  2. 再次外部修改 → 第 2 条，且 before 为第 1 条的 after；
  3. 脏状态下外部修改 → 编辑器不动、标签页出现冲突标记、originalContent 更新；
  4. 接受（经确认）→ 条目移除，磁盘/编辑器不变；
  5. 撤销（经确认）→ 磁盘内容回退、干净标签页编辑器同步回退、该条及之后条目移除；
  6. 应用内 Ctrl+S 保存 → 不产生 diff（自写识别）；
  7. 连续 11 次外部修改 → 时间线保持 10 条；
  8. 关闭标签页 → unwatch、再外部修改无反应、重开后从当前内容重新开始。
