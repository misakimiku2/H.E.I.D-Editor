# 文档模板 — 实施计划

日期：2026-11-09
对应规格：`docs/superpowers/specs/2026-11-09-doc-templates-design.md`

按 TDD 推进：每个单元先写失败测试，再实现到绿。纯函数/数据层先行（无 UI 依赖），Rust 命令次之，UI 与接线最后。全程 `npm run test` + `npx tsc --noEmit` 保持绿。

## 阶段 1 — 纯函数与数据模型

**1.1 `src/lib/docTemplates.ts`（新）**
- 先写 `src/lib/docTemplates.test.ts`：
  - `renderTemplate`：`{{title}}`/`{{date}}` 替换、`{{ title }}` 空白容忍、未知键 `{{foo}}` 原样、多次出现全替换。
  - `ensureMdExtension`：`a`→`a.md`、`a.md`→不变、`A.MD`→不变、`a.txt`→`a.txt.md`。
  - `templateTitle`：`a.md`→`a`、`A.MD`→`A`、`a`→`a`。
  - `validateFileName`：空/纯空白→非法、含 `\ / : * ? " < > |`→非法、正常名→合法。
- 实现：`DocTemplate` 类型、`NIKKE_SAMPLE` 常量（规格附录内容，id `builtin-nikke`）、上述四函数。

**1.2 `src/lib/settings.ts`（改）**
- 先在 `settings.test.ts` 增用例：缺失 `templates`→注入示例；`templates:[]`→保留空；坏项（缺 name/content 非字符串/超长）丢弃；上限 50；`loadSettings` 空存储带示例、删光往返后不复活。
- 实现：`EditorSettings.templates`、`DEFAULT_SETTINGS.templates=[NIKKE_SAMPLE]`、`normalizeSettings` 追加逐字段校验（复用 1.1 的常量与约束）。

## 阶段 2 — Rust 落盘命令

**2.1 `src-tauri/src/fsops.rs` + `lib.rs`（改）**
- 先在 fsops.rs 加 `#[cfg(test)]` 用例（临时目录）：新建成功且内容一致、撞名返回 `"exists"`、父目录不存在报错。
- 实现 `fs_create_text_file(path, content)`：`create_new` 打开→写 UTF-8→`sync_all`；`AlreadyExists`→`Err("exists")`；中途失败删半成品；`lib.rs` `generate_handler!` 注册。
- `cargo test`（src-tauri）验证。

## 阶段 3 — 前端封装

**3.1 `src/lib/fileOps.ts`（改）**
- 增 `fsCreateTextFile(path, content)`：动态 import invoke 调 `fs_create_text_file`（与 `fsCreateEmptyFile` 并列，仅桌面分支语义）。
- `fileOps.test.ts` 增 mock invoke 用例：透传路径/内容、错误向上抛。

## 阶段 4 — UI 组件

**4.1 `src/components/TemplateManagerDialog.tsx`（新）+ 测试**
- 列表/编辑两视图；新建/编辑（name + 等宽 textarea）/删除（ConfirmDialog）；`onChange` 上抛。
- 组件测试：新建保存、编辑保存、删除需确认、空 name 禁保存。

**4.2 `src/components/TemplatePickerDialog.tsx`（新）+ 测试**
- 模板单选 + 文件名输入 + 创建；`validateFileName` 门禁；撞名/错误 inline；空列表空态 + 去管理；「管理模板…」回调。
- 组件测试：选中+合法名才可创建、非法名提示、创建回调带渲染后内容与目标路径、撞名提示不清空。

## 阶段 5 — 文案与接线

**5.1 `src/lib/i18n.ts`**：zh/en 同步新增 `menu.newFromTemplate` + `template.*`（选择模板/文件名/创建/管理模板/新建/编辑/删除/已存在请换名/暂无模板/非法文件名等）。

**5.2 `src/components/SettingsDialog.tsx`**：桌面门槛内加「文档模板」行（数量 + 管理按钮），打开 Manager。

**5.3 `src/App.tsx`**：主菜单「从模板新建」项（最近打开后、保存组前，门槛同网址导入）；Picker/Manager 开关 state；创建成功回调：有本地树根→`fsCreateTextFile(join(root,name))`，撞名回传 Picker 提示；无本地根→`save({defaultPath})`+`writeLocalPath`；成功 `openPathIntoTab`。

## 阶段 6 — 验证与验收

- `npm run test`、`npx tsc --noEmit`、`npm run build` 全绿；`cargo test` 绿。
- 桌面手工验收：有/无本地文件夹两条落盘路径、撞名换名、`{{title}}`/`{{date}}` 渲染、删光模板重启不复活、重启模板仍在、文件树自动刷新。
- 不夹带无关改动；提交前经用户确认。

## 波及面核对

新增 3 个源文件 + 3 个测试文件 + Rust 命令；改动 settings/fileOps/SettingsDialog/App/i18n/lib.rs。不动保存/草稿/文件树核心、capabilities、安卓 SAF 桥。