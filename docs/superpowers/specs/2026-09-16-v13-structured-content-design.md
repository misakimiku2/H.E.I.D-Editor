# v1.3 结构化内容与新格式 — 设计文档

日期：2026-09-16
状态：依据 `docs/ROADMAP.md` v1.3 条目（32–35）实现，范围与 YAGNI 边界以 ROADMAP 为准

## 背景

v1.2 把"打开任意文件不翻车"收口后，v1.3 的主题是**把"打开即能看懂"扩展到更多文件类型**：
JSON/YAML 的结构化浏览、Markdown 的导航与图片资产管理、CSV 的排序筛选、打印/导出 PDF。
四项都是顺着"内容格式深度"这条既有逻辑的延长线，不新增常驻进程、不显著增加主包体积。

新增依赖仅 `js-yaml`（YAML 解析/序列化，动态 import 懒加载 chunk，不进主包；JSON 用原生 `JSON.parse`）。

---

## 功能 32：JSON / YAML 结构化视图

### 视图模型（复用 CSV 的双视图模式）

- 页签新增 `jsonView?: 'tree' | 'text'`（挂 `FileTab`，随会话内存存续，对标 `csvView`）。
- 路由条件：语言为 `json` / `yaml`、非二进制、非大文件预览、内容 ≤ 200 万字符且能整篇解析 → 默认树视图；解析失败或超限默认文本。工具栏（CSV 切换按钮同位置）提供"树 / 文本"切换 + "格式化"按钮。
- 解析失败仍手动切树视图时：显示错误横幅（含行列信息）+「切回文本视图」按钮，不白屏。

### 模块

- `src/lib/jsonTree.ts`（纯函数，新增）：
  - `parseStructured(text, kind)`：JSON 用 `JSON.parse`；YAML 动态 `import('js-yaml')` load。返回 `{ value } | { error }`。
  - `buildTree(value)`：任意 JS 值 → 通用节点树 `{ kind: 'object'|'array'|'string'|'number'|'boolean'|'null', key, raw, children, count }`；YAML 的非字符串键 `String()` 归一；循环引用（YAML anchor 理论可产生）以 `seen` 集合截断。
  - `formatStructured(text, kind, indent)`：JSON 用 `JSON.stringify(parse, null, indent)`；YAML 用 js-yaml `dump(indent=2)`（YAML 禁 Tab）。缩进取编辑器设置（空格/Tab 宽度）。
- `src/components/JsonTreeViewer.tsx`（新增）：只读树浏览。
  - 缩进层级线 + 折叠箭头；对象/数组显示 `{ n 项 }` / `[ n 项 ]` 计数徽标；标量按类型着色（复用编辑器 palette 风格：字符串绿、数字蓝、布尔/空值橙灰）。
  - 默认展开前 2 层；工具条：全部展开 / 全部收起 / 复制值（单节点标量右键或点击复制，走 `writeClipboardText`）。
  - 性能闸门：单个对象/数组直接子节点 > 500 时，展开只渲染前 500 并提示剩余数量（折叠态无渲染成本；配合默认两层折叠，万级节点文档无压力）。
- 格式化为**一次普通编辑**：走 `updateTabContent`（可撤销、变脏），不自动保存。

---

## 功能 33：Markdown 增强

### a) 大纲侧栏导航

- `src/lib/markdownOutline.ts`（纯函数）：`extractHeadings(md)` 扫描 ATX 标题（`#{1,6}`），跳过围栏代码块（``` / ~~~ 计数）、行内代码整行、引用内标题不跳（按 CommonMark 行为属引用块，仍可导航）；返回 `{ level, text, line, offset }[]`（`offset` 为行首 `#` 的全文偏移）。
- `src/components/MarkdownOutline.tsx`（新增）：按层级缩进的标题列表，当前无高亮跟踪（滚动同步属增值项，首版不做）。
- 集成：markdown 标签页工具栏新增「大纲」开关（ListTree 图标，默认关）；开启时在预览区左侧插入 220px 侧栏（手机端隐藏入口）。点击标题：
  - 预览可见（分屏/预览态）→ `MarkdownPreviewHandle.scrollToOffset(offset)`（查询 `[data-md-start]` 里 ≥ offset 的最近标题元素滚过去）；
  - 编辑器可见 → 复用 `FileTab.jumpRequest` 跳转该行（分屏时两者都做）。

### b) 粘贴图片自动落盘并插入相对路径（桌面）

- `CodeEditor` 新增 prop `onImagePaste?: (file: File) => Promise<string | null>`；markdown 且提供该 prop 时挂 `EditorView.domEventHandlers({ paste })`：剪贴板含 `image/*` 文件 → `preventDefault` → 落盘成功拿到相对路径后在光标处插入 `![](相对路径)`（走 view.dispatch，入撤销历史）。
- 落盘（`src/lib/markdownImagePaste.ts`）：目标 `<md 目录>/assets/paste-YYYYMMDD-HHmmss(-n).<ext>`；`fs_mkdir` 幂等建目录，plugin-fs `writeFile` 写二进制；返回相对路径（`/` 分隔）。扩展名从 MIME 推断。
- 边界：标签页无磁盘路径（未保存的新建）→ 不拦截，按普通文本粘贴处理并提示「先保存文件再粘贴图片」；安卓 SAF 无二进制写桥 → 不启用；浏览器模式 → 转 data: URI 插入（≤ 2MB，超过拒绝）。
- **相对路径显示**：`MarkdownPreview` 新增 `baseDir` prop（取标签页目录），`MarkdownImage` 对相对 `src` 先与 baseDir 拼接再走 `resolveImageSrc`；既有 `|||LOCAL-FILE:` 绝对路径机制不变，两者共存。

### c) 导出 HTML 带代码高亮

- `markdownHtml.ts` 渲染管线加 `code` 组件：复用 `react-syntax-highlighter`（Prism，`oneDark`/`ghcolors` 随导出主题），有语言标注的围栏代码块输出着色 `<span style>`；无语言/行内代码维持现状。仍为单文件内联、零外部引用，全部库留在懒加载 chunk。

### d) 网址导入的图片下载到本地（图片本地化）

- Rust `http.rs` 新增 `http_get_binary(url) -> { base64, content_type }`：复用既有护栏（仅 http/https、15s 超时、5MB 上限），`detect_and_decode` 的二进制判定反转使用（文本视为失败），base64 编码返回。
- `src/lib/imageLocalize.ts`（纯函数 + 编排）：`collectRemoteImages(md)` 收集 `![…](http…)` 唯一远端图源；`localizeRemoteImages(md, dir, io)` 逐张下载 → 存 `<md 目录>/assets/remote-<url hash 8 位>.<ext>` → 全文替换为相对路径；单文档上限 50 张，失败逐张跳过并计数。
- 入口：菜单「图片本地化」（紧邻导出 HTML，仅桌面 + 标签页有路径时可用）；完成后通知「已本地化 N 张（M 张失败）」，内容变更走 `updateTabContent`（可撤销）。网页剪贴板场景复用 `http_get` 的 5MB/超时语义，不新增网络栈。

---

## 功能 34：CSV 只读态排序 / 筛选

**核心原则：排序/筛选是视图变换，不改写 `tab.content`**——与"网格编辑每一笔都落盘到 content"的既有数据流正交。

- `src/lib/csv.ts` 新增纯函数：
  - `compareCells(a, b)`：数值（既有 `NUMERIC_RE` 口径）数值比较，否则 `localeCompare(…, { numeric: true, sensitivity: 'base' })`；空串恒排最后。
  - `computeRowOrder(grid, opts)`：`opts = { sort?: { col, dir }, filter?: string, headerOn }` → 显示行 → 原始行下标映射；filter 为子串匹配（大小写不敏感，命中任一列即保留）；headerOn 时第 0 行恒在最前。
- `CsvGridEditor` 集成：
  - 排序入口在**列标右键菜单**（升序 / 降序 / 取消排序），列标显示 ▲▼ 指示；点击列标仍全选整列（不与排序冲突）。
  - 筛选输入框嵌在编辑栏（漏斗图标，清空即取消）。
  - 行号显示**原始行号**（排序/筛选后不误导）；`onShape` 扩展上报可见行数，状态栏显示「已显示 N / M 行」。
  - **结构操作降级**：排序或筛选生效期间，增删行列 / 剪切 / 清空 / 填充手柄禁用（右键菜单项置灰 + 提示），单元格内容编辑仍可用（按原始行写回）——排序筛选是"看"的态，改结构先还原视图。
- 幽灵行列（编辑余量）在排序/筛选态不参与显示与匹配。

---

## 功能 35：打印 / 导出 PDF

- 桌面（WebView2/Chromium）：隐藏 iframe + `contentWindow.print()`，系统打印对话框自带"另存为 PDF"目的地；安卓隐藏入口（WebView 无打印对话框）。
- `src/lib/printDoc.ts`（新增）：
  - `buildPlainPrintHtml(title, content)`：代码/文本类 → 编辑器字体等宽 `<pre>` + 行号 + `pre-wrap` 分页样式（深浅主题按当前模式取一套内联 CSS）。
  - `printHtml(html)`：动态 iframe，`srcdoc` 就绪后触发打印，`afterprint` 清理。
- 内容路由（复用现有渲染栈）：
  - markdown → 复用 `renderMarkdownToHtml`（含 c 项新增的代码高亮）；
  - csv 网格态 → 解析层 `parseCsv` → HTML 表格（全量数据，非当前筛选视图——文档打印而非屏幕转储）；
  - 其余文本/代码 → `buildPlainPrintHtml`；
  - 二进制 / 大文件预览 / 图片查看器 → 入口禁用。
- 入口：菜单「打印…」（紧邻导出 HTML）+ `Ctrl+P`（`useAppShortcuts`）。打印的是**当前标签页内容**，与视图模式无关（预览保活不影响）。

---

## 明确不做（本批次 YAGNI）

- JSON/YAML：不做人性化查询（JMESPath/JSONPath）、不做编辑树（树只读浏览 + 文本编辑）。
- 大纲：不做滚动联动高亮、不做点击改标题层级。
- 图片：不做图片压缩 / 格式转换 / 粘贴图床；本地化不处理 HTML `<img>` 残留。
- CSV：不做公式、多 sheet、单元格样式、多列复合排序（ROADMAP 明确不做）。
- 打印：不做自定义页眉页脚、打印预览 UI。
- 同批次候选（剪贴板监控、复制为富文本）：有余力再做，默认不做。

## 测试与验收

- 新增单测：`jsonTree.test.ts`（解析/建树/格式化/循环引用）、`markdownOutline.test.ts`（围栏跳过/层级/偏移）、`markdownImagePaste.test.ts`（命名/相对路径拼接）、`imageLocalize.test.ts`（收集/替换/上限）、`printDoc.test.ts`(纯 HTML 构建)、`csv.test.ts` 扩展（compareCells/computeRowOrder）。
- 全量 vitest + `tsc` + `vite build` 通过；主包体积不显著增长（js-yaml 必须落在懒加载 chunk，用构建产物核验）。
- 手工验收：Typora 式 JSON 折叠浏览、Ctrl+P 打印对话框出现、粘贴截图生成 assets 目录、URL 导入后一键本地化、CSV 排序筛选后行号保持原始。
