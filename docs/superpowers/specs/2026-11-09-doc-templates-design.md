# 文档模板（从模板新建）— 设计文档

日期：2026-11-09
状态：已与需求方逐项确认（存储方案 A / 应用内管理 / 输名直存 / 自动变量）

> **实现演进（同日迭代，以此为准）**：创建行为最终改为「只开一个带模板内容的未保存 markdown 标签页，手动保存时才落盘」（与网址导入同源），不再直接写文件。据此移除了原 `fs_create_text_file` Rust 命令、`fsCreateTextFile` 封装与 picker 的撞名/错误处理。模板选择改用 `Dropdown` 下拉（默认选中首个）；模板内容编辑复用 `CodeEditor`（markdown 右键菜单/高亮/撤销）并加 markdown 预览切换；管理弹窗加返回来源页导航。下文为最初设计存档。

## 背景与目标

需求方要把大量游戏内容（如 NIKKE 角色，后续也会有别的游戏/主题）记录成 Markdown 文档。这类文档数量多、结构高度雷同，每次手搓骨架低效。目标：提供**通用文档模板**能力——维护一组可自定义的模板，一键按模板生成带骨架的新文档并落盘打开。模板不绑定任何特定游戏，NIKKE 只是首个内置示例。

非目标（本期不做）：双链/标签/frontmatter 元数据过滤、关系图谱、模板变量弹窗填写、模板文件夹导入导出、安卓端入口。这些是知识库的"进阶套件"，当前场景用不上，按 YAGNI 砍掉。

## 需求清单（已确认）

| 项 | 结论 |
|---|---|
| 模板来源 | 应用内管理：设置里新增模板管理面板，可新增/编辑/删除，存本地设置（localStorage） |
| 内置示例 | 自带 1 个 NIKKE 角色模板；仅首次启动（无任何已存设置）注入，删除后不复活 |
| 使用入口 | 主菜单（右上角汉堡菜单）新增「从模板新建」项 |
| 生成方式 | 选模板 → 输文件名 → 有本地文件夹则直接存进文件树根目录，否则弹系统另存为；同时打开成标签页 |
| 占位符 | `{{title}}`→文件名（去扩展名）、`{{date}}`→当天日期（YYYY-MM-DD）；其余 `{{…}}` 原样保留 |
| 撞名 | 本地直存路径：提示换名字，**不提供覆盖**；系统另存为路径：覆盖确认交给系统原生对话框 |
| 平台 | 仅桌面（门槛与「网址导入」一致：`isTauri && !IS_TOUCH_PRIMARY`）；安卓按发版策略本期不做 |

## 一、架构与数据流

核心原则：**模板是设置里的一个数组，渲染是纯函数，落盘复用现有文件写入/打开管线**——不引入新的持久化通道，不新增 Rust 文件操作权限。

```
主菜单「从模板新建」
   ▼
TemplatePickerDialog（选模板 + 输文件名）
   │  renderTemplate(content, {title, date})  ← 纯函数替换占位符
   ▼
有本地树根？ ── 是 ──> fs_create_text_file(root/name.md, content)  ← 新 Rust 命令，create_new 语义
   │                        │ 撞名 → 返回 exists → 弹窗内提示换名
   │                        └ 成功 ─┐
   └── 否 ──> save({defaultPath}) 系统另存为 ──> writeLocalPath(target, content)
                                     └ 成功 ─┤
                                             ▼
                              openPathIntoTab(path) 打开 + 文件树监听自动刷新
```

模板管理是独立支路：设置面板「文档模板」行 → TemplateManagerDialog（列表/编辑两视图），改动经 `onChange` 写回 `settings.templates`，由 App 层现有 effect 自动持久化。

## 二、数据模型与持久化

`src/lib/settings.ts`：

```ts
export interface DocTemplate {
  id: string;        // 稳定标识，内置示例固定 'builtin-nikke'，新建用 crypto.randomUUID()
  name: string;      // 展示名，非空，trim 后 ≤ 60 字符
  content: string;   // Markdown 骨架，≤ 20000 字符
}
// EditorSettings 追加字段
templates: DocTemplate[];
```

- `DEFAULT_SETTINGS.templates = [NIKKE_SAMPLE]`（内置示例常量，含 `{{title}}`/`{{date}}`）。
- `normalizeSettings` 追加 `templates` 校验，规则：
  - `rec.templates` 是数组 → 逐项校验（id/name/content 均为字符串、name trim 后非空且 ≤60、content ≤20000），坏项丢弃，最多保留 50 条；**空数组 `[]` 原样保留**（用户删光不再注入）。
  - `rec.templates` 缺失/非数组（老版本升级上来）→ 回退 `[NIKKE_SAMPLE]`，实现"升级后首次给一份示例"。
  - 无已存设置（`loadSettings` 走 `!raw` 分支）→ 返回 `DEFAULT_SETTINGS`，天然带示例。
  - 由此保证"删除后不复活"：只要持久化里有过 `templates:[]`，normalize 就不会再塞示例。
- 持久化沿用 `saveSettings`（App 层 effect 自动写 `heid-settings`），无新存储 key。

## 三、占位符渲染（纯函数）

`src/lib/docTemplates.ts`（新文件，收纳模板相关纯函数 + 内置示例）：

```ts
renderTemplate(content: string, vars: { title: string; date: string }): string
```

- 替换 `{{title}}`、`{{date}}`，容忍花括号内侧空白（`{{ title }}` 亦匹配），大小写敏感、仅这两个键。
- 其余 `{{…}}`（未知键）原样保留。
- `title` = 最终文件名去掉 `.md` 扩展名；`date` = 本地当天 `YYYY-MM-DD`。
- 配套纯函数：`ensureMdExtension(name)`（不以 `.md` 结尾则追加 `.md`，大小写不敏感判断；`note.txt` 会变成 `note.txt.md`，规则保持单一）、`templateTitle(name)`（去 `.md`）。
- 文件名校验（前端，纯函数 `validateFileName`）：trim 后非空；不含 `\ / : * ? " < > |`（Windows 非法字符）；不合法时「创建」禁用并 inline 提示。

## 四、落盘与撞名（新 Rust 命令）

`src-tauri/src/fsops.rs` 新增 `fs_create_text_file(path, content) -> Result<(), String>`，并在 `lib.rs` 的 `generate_handler!` 注册：

- `OpenOptions::new().write(true).create_new(true).open(path)`：**目标已存在即失败**，天然防覆盖且无 TOCTOU 竞态。
- 已存在（`ErrorKind::AlreadyExists`）→ 返回哨兵字符串 `"exists"`，前端据此提示换名。
- 其余 IO 错误 → 返回 `e.to_string()`。
- 写入 UTF-8 字节 + `sync_all`；中途失败顺手删掉半成品文件（新建文件无"截断旧文件"风险，不需 tmp+rename）。
- 自定义命令不走 plugin-fs 权限，无需改 capabilities。

前端封装 `fsCreateTextFile(path, content)`（`src/lib/fileOps.ts`，动态 import invoke，与 `fsCreateEmptyFile` 并列）。

## 五、UI 组件

三个新组件 + 两处既有文件接线，全部沿用现有毛玻璃弹窗 / `panelRows` / `ContextMenu` 视觉语言与 `useT()` 文案模式。

1. **TemplatePickerDialog**（`src/components/TemplatePickerDialog.tsx`）
   - 模板列表（单选，展示 name + 首行/字符数预览）+ 文件名输入框 + 「创建」按钮。
   - 「创建」在"已选模板且 `validateFileName` 通过"前禁用；非法字符 inline 提示；文件名输入回车可提交。
   - 底部「管理模板…」入口 → 关闭自身、打开 Manager。
   - 空列表（模板被删光）→ 空态文案 + 「去管理模板」按钮。
   - 撞名（Rust 返回 exists）→ 弹窗内 inline 提示"已存在，换个名字"，不清空已输内容；其他错误同样 inline 显示。
   - 创建成功 → 关闭自身，回调交给 App 打开标签页。

2. **TemplateManagerDialog**（`src/components/TemplateManagerDialog.tsx`）
   - 列表视图：每行 name + 预览 + 「编辑」「删除」；顶部「新建模板」。
   - 编辑视图：name 输入框 + 等宽大 textarea（content）+ 「保存」「取消」。保存校验 name 非空。
   - 删除走现有 `ConfirmDialog` 二次确认。
   - 所有改动经 `onChange(nextTemplates)` 上抛，由 App 合并进 settings。

3. **设置面板接线**（`src/components/SettingsDialog.tsx`）：新增「文档模板」行（展示当前模板数 + 「管理」按钮），仅桌面门槛内渲染；点击打开 Manager。

4. **主菜单接线**（`src/App.tsx`）：`menuOpen` 面板内新增「从模板新建」项（图标如 `LayoutTemplate`），位置在「最近打开」二级菜单之后、保存组分隔线之前；门槛同「网址导入」。点击打开 Picker。新增 Picker/Manager 的开关 state 与渲染，创建成功回调里 `openPathIntoTab`。

## 六、错误处理

- 模板数据损坏：normalize 逐项回退/丢弃，不影响其余设置与编辑功能（沿用 settings 既有容错哲学）。
- 撞名：inline 提示换名，不覆盖、不静默丢内容。
- 写盘失败（权限/磁盘满等）：inline 显示 Rust 原错，保留用户已输名字与所选模板。
- 系统另存为被取消：静默关闭，不落盘。
- 存储不可用（localStorage 被禁）：settings 既有行为是不持久化，模板仍可当次会话使用。

## 七、平台与门槛

- 所有模板 UI 入口（主菜单项、设置行、Picker、Manager）统一门槛 `isTauri && !IS_TOUCH_PRIMARY`（桌面 Tauri）。安卓/平板/纯浏览器不显示入口。
- 数据模型与纯函数不做平台裁剪（便于测试与未来扩展），仅 UI 入口按门槛隐藏。

## 八、测试

- **纯函数（vitest）**：`renderTemplate`（两键替换/空白容忍/未知键保留）、`ensureMdExtension`、`templateTitle`、`validateFileName`（空名/非法字符）、`normalizeSettings.templates`（坏项丢弃/空数组保留/缺失注入示例/上限 50）。
- **Rust**：`fs_create_text_file` 的新建成功、撞名返回 exists、非法路径报错（参照 `encoding.rs` 的 `#[cfg(test)]` 惯例，用临时目录）。
- **组件（vitest + testing-library，沿用现有 `*.test.tsx` 模式）**：Picker 的选中/文件名校验/创建回调/撞名提示；Manager 的新建/编辑/删除确认。
- **手工验收**：桌面全流程（有/无本地文件夹两条落盘路径、撞名、删光模板不复活、重启后模板仍在）。

## 九、i18n

`src/lib/i18n.ts` zh/en 两表同步新增 `template.*` 与 `menu.newFromTemplate` 等 key（编译期强制对齐）。代表性文案：从模板新建、选择模板、文件名、创建、管理模板、新建模板、编辑模板、删除模板、已存在请换名、暂无模板等。具体 key 清单在实施计划中逐条列出。

## 十、波及面

新增：`src/lib/docTemplates.ts`、`src/components/TemplatePickerDialog.tsx`、`src/components/TemplateManagerDialog.tsx`、对应测试、Rust `fs_create_text_file`。
改动：`settings.ts`（字段+校验）、`fileOps.ts`（封装）、`SettingsDialog.tsx`（一行）、`App.tsx`（菜单项+state+回调）、`i18n.ts`（文案）、`lib.rs`（注册命令）。
不改：现有保存/草稿/文件树核心逻辑、capabilities 权限、安卓 SAF 桥。

## 附录：内置 NIKKE 角色示例模板

结构依据 gamekee 图鉴页（档案/技能/评测三块）整理，字段留空待填。展示名「NIKKE 角色」，id `builtin-nikke`：

```markdown
# {{title}}

> 记录日期：{{date}}

## 基础信息

| 项目 | 内容 |
| --- | --- |
| 稀有度 |  |
| 爆裂阶段 |  |
| 属性 |  |
| 类型 |  |
| 武器 |  |
| 部队 |  |
| 企业 |  |
| 实装时间 |  |
| 声优 |  |

## 角色简介



## 技能

### 普通攻击
- 最大装弹数：
- 换弹时间：
- 伤害：

### 技能 1
- 类型 / CD：
- 效果：

### 技能 2
- 类型 / CD：
- 效果：

### 爆裂技能
- CD：
- 效果：

## 评测
- 强度评级：
- 推图 / Boss / PVP：
- 抽取建议：
- 定位：

## 养成与配队
- 魔方推荐：
- 词条优先级：
- 技能升级优先级：
- 配队：

## 备注

```