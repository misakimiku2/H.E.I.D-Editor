# Markdown 写作体验升级计划（2026-11-11）

## 背景

用户为桌面 markdown 重度使用者（游戏知识库长文档）。经两轮功能盘点确认缺口，
升级分两批：第一批「写作手感」本次会话实施；第二批「知识库维护」留待后续会话。

现状基线（盘点证据，实施时复核修订）：

- Enter 表面绑 `insertNewlineAndIndent`（`src/components/CodeEditor.tsx:1656`），但语言包内置
  `markdownKeymap`（`Prec.high`，Enter → `insertNewlineContinueMarkup`）实际已提供列表/checkbox
  续行，且与契约一致（空项退出、有序 +1、checkbox 重置）。初轮盘点漏看了语言包自带键位；
  本轮以回归测试钉住契约，不写冗余实现。
- 粘贴：原生 Ctrl+V 有内置 `pasteURLAsLink`，但不 trim 首尾空白（复制 URL 带尾换行会坏链）；
  菜单/触屏粘贴（`pasteFromClipboard`）完全不成链接。本轮关掉内置、两入口统一同一契约，
  保留 mailto/xmpp 不回归。
- 预览 task checkbox 为 react-markdown 默认禁用态，无 `input` 覆写（`MarkdownPreview.tsx` mdComponents）。
- 预览已有回写通道：`onChange?: (next: string) => void`（`MarkdownPreview.tsx:758`），
  表格/图片编辑均经此回写；源码偏移坐标约定见 `useSrcData` / `BlockBaseContext`。

## 第一批（本次会话）

### 公共结构

新建 `src/lib/markdownSmartEdit.ts`，纯函数（无 DOM 依赖、可单测）：

1. `linkPasteInsert(pasted, selected)` → `string | null`
2. `toggleTaskAtOffset(content, offset)` → `string | null`

（原拟的 `listEnterAction` 在确认内置命令已覆盖契约后删除，不留死代码。）
CodeEditor / MarkdownPreview 只做薄接线。不新增依赖、不改 Rust。

### 1. Enter 列表/checkbox 续行

行为契约：

- 识别无序（`-` `*` `+`）与有序（`1.` `1)`）标记，含缩进与 `[ ]`/`[x]` checkbox；
- 续行：同缩进 + 同标记（有序数字 +1，保留分隔符）+ checkbox 统一重置为 `[ ] `；
- 空项（标记后无内容）回车：删除该行「缩进+标记+checkbox」整段前缀（退出列表），光标行首；
- 非列表行：回落 `insertNewlineAndIndent`，现有语义（含缩进续行）不变；
- 仅 `language === 'markdown'` 启用；plaintext 与其他语言不变；
- 安卓显式 Enter 绑定保留（只换 run 函数，不撤绑定，见 CodeEditor.tsx:1651 注释）。

不做：有序后续项自动重排、整节移动。blockquote 续行内置命令自带，属契约外赠送，不拆除。

实施：内置命令已覆盖，无需接线；`CodeEditor.enter.test.tsx` 增 6 个 markdown 回归用例
（无序/有序/checkbox/嵌套/空项/非列表）钉住契约，沿用现有 jsdom 按键模式。

### 2. 选中文字粘贴 URL 自动成链接

行为契约：

- 粘贴文本 trim 后单行且匹配 `^(https?://|www\.)\S+$` 才触发；`www.` 目标补 `https://` 前缀；
- 选区非空、单行、不含 `[` `]` 才包裹，插入 `[选中](url)`，光标末尾；否则走原粘贴路径；
- 仅 markdown 启用。

接线（两路径共用纯函数）：

- `src/lib/codemirror.ts` markdown loader 设 `pasteURLAsLink: false`，关掉不 trim 的内置实现；
- 原生 Ctrl+V：CodeEditor 增加 markdown 专属 paste domEvent handler，置于图片拦截之后
  （图片 handler 未命中返回 false，由此接管）；
- 菜单/触屏粘贴：`pasteFromClipboard` 增加 linkify 参数，`pasteAtCursor` 按
  `language === 'markdown'` 传入（右键与触屏工具条共用入口）。

测试：纯函数用例（http/www/mailto/xmpp/多行/非 URL/选区含括号/空选区）；
`CodeEditor.pastelink.test.tsx` 组件用例（原生 trim/多行不包裹/mailto 不回归/触屏工具条）。

### 3. 预览 checkbox 点击回写

行为契约：

- `onChange` 存在时预览 task checkbox 可点击，点击 toggle 该行 `[ ]`↔`[x]` 并经 onChange 回写；
- `onChange` 不存在保持禁用；导出 HTML（`markdownHtml.ts`）不受影响；
- 触屏可点（共享前端，安卓同受益）。

实现：

- `li` 覆写经 context 注入源码行首偏移（`node.position.start.offset + BlockBaseContext`，
  复用现有全文坐标约定）；`input` 覆写消费 context，点击调 `toggleTaskAtOffset`
  （读实时 content，正则仅替换该行第一个 checkbox 标记），不匹配则放弃；
- 已知限制：预览 180ms 防抖窗口内偏移可能相对实时内容过期——与现有表格/图片回写一致，
  本次不扩大解决。

测试：纯函数用例（双向 toggle/嵌套/有序任务列表/过期偏移放弃）；组件用例沿用
`MarkdownPreview.tabletouch.test.tsx` 的 mock 模式，点击 input 断言 onChange。

### 波及面

- 共享前端：安卓同得三项（Enter 绑定保留、触屏粘贴走菜单路径、checkbox 可点），不新增平台分支；
- 无新依赖、无 Rust/协议改动，bundle 增量可忽略；
- 撤销/重做走现有 onChange/dispatch 路径，与现状表格/图片编辑一致。

### 验证

- `vitest run` 全绿（1501 用例）+ `tsc && vite build` 通过；新增用例单跑 5 次稳定；
- 人工验收清单：三级嵌套列表续行；有序 1.→2.；空项退出；选中粘贴 URL（含尾换行 trim）；
  触屏工具条粘贴成链接；预览点 checkbox 源码同步且可撤销；纯预览/导出 checkbox 仍禁用。

## 第二批（后续会话，仅大纲）

1. 链接/图片本地路径补全 + 坏链坏图检查器；
2. 跨文件替换：全文件夹搜索 → 列改动清单 → 确认后批量执行（先给方案再动手）；
3. 本地历史/版本快照另立项目（需 C 盘容量上限与自动清理），不并入本文实施范围。

第二批启动时另行设计评审，本文只留方向。

## 不做

- prettier 全文规范化、frontmatter、TOC 插入（视实际需求，不默认推）；
- 所见即所得、换栈等方向性改动。