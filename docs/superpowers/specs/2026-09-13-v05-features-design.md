# v0.5 差异化功能批次设计（文件树 / 导出 HTML / 网址导入 / 双语 / 字数）

- 日期：2026-09-13
- 状态：已确认范围，自主模式下按本推演落地，可随时调整
- 范围：H.E.I.D（Nexus Editor），Tauri 2 + React 19 + Rust，桌面 + 安卓
- 对应路线图：`docs/ROADMAP.md` v0.5 一节（第 10 ~ 14 项）

## 1. 背景与范围

v0.5 主题是"小而美的差异化"。本批次实现全部 5 项，顺序与提交切分：

| # | 功能 | 主要新增 | 提交 |
| --- | --- | --- | --- |
| 13 | 界面中英双语 | `src/lib/i18n.ts` | feat(i18n) |
| 14 | 字数统计 | `src/lib/wordCount.ts` | feat(statusbar) |
| 11 | Markdown 导出 HTML | `src/lib/markdownHtml.ts` | feat(export-html) |
| 12 | 网址导入 Markdown | Rust `http_get` + `src/lib/urlImport.ts` | feat(url-import) |
| 10 | 文件树侧栏 | `FileTreeSidebar.tsx` + `fileTree.ts` + SAF 桥 | feat(file-tree) |

先做基础设施（文案字典）与纯函数，最大的文件树 UI 放最后；每项一个 commit，可独立验收。版本号在全部完成后统一升 0.5.0。

## 2. 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| i18n 方案 | 自写词典 + `t()` 纯函数，中文表 `as const` 为 key 源，英文表与它同构（TS 校验两表 key 对齐） | 300+ 条文案规模下 i18next 等库（约 30KB）是过度设计；类型对齐从编译期杜绝漏译 |
| 语言偏好存放 | 并入 `EditorSettings`（新增 `language: 'system' \| 'zh' \| 'en'`），默认 `system` 按 `navigator.language` 解析 | 复用现有 settings 统一存取与逐字段校验回退，不另起 localStorage 键 |
| 字数口径 | CJK 感知：CJK 字符每字计 1，连续拉丁字母/数字串计 1（Word/WPS 口径）；非 Markdown 标签按空白分词；字符数按码点计 | 路线图口径；中英文混排计数符合中文用户直觉 |
| 导出 HTML 渲染 | 复用 react-markdown + remark-gfm，叠加 `react-dom/server` 的 `renderToStaticMarkup`，动态 `import()` 懒加载 | react-dom 已是依赖，零新增；与站内预览渲染同源，一致性最好；备选 marked（40KB 新依赖）弃 |
| 导出样式 | 单文件内联 `<style>`（约 2KB 精简排版 CSS），按导出时主题生成深/浅一套，无外部资源引用 | "轻量"：产物任何环境双击即开，样式不丢 |
| 抓取 HTTP 方案 | Rust `ureq`（rustls）同步 GET 命令：仅 http/https、15s 超时、5MB 上限、≤5 次重定向 | 轻于 reqwest/hyper 全家桶；Tauri 同步命令跑在独立线程池不卡 UI |
| 非 UTF-8 网页 | `http_get` 响应体直接走 `encoding::detect_and_decode`，返回结构与 `read_text_file` 完全一致 | GBK/Big5 页面零成本复用现有编码检测链 |
| 正文提取 + 转 MD | 前端动态 `import()` defuddle + turndown | 路线图点名；约 50KB gzip 仅用时加载，不进主包 |
| 图片处理 | v0.5 只保留远程 URL | 新标签页尚未落盘、无目标目录，"下载到本地"此刻是伪命题；列入后续细化 |
| 文件树平台 | 桌面 + 安卓（路线图"桌面 + 平板"） | 安卓新增 SAF 桥（openDocumentTree + DocumentsContract 列目录）；SAF 部分封装独立，受阻可单独延后不影响整体 |
| 目录列举封装 | `DirLister` 提供者接口：桌面 = dialog + plugin-fs `readDir`；安卓 = SAF 桥 | 前端树组件只面向接口，两平台差异收敛在两个小提供者里 |
| 目录刷新 | 懒加载（展开才列子项）+ 侧栏手动刷新按钮；v0.5 不做实时 watch | 守住轻量；fs 插件 watch 留作后续细化 |
| 抽屉记忆 | 记住最后一次打开的文件夹；启动不自动加载 I/O，抽屉首次打开时恢复，失效静默降级空态 | 抽屉"默认关闭"，启动零额外 I/O |
| App.tsx 拆分 | v0.5 不做 | 路线图把结构拆分排在 v1.0；新逻辑全部落独立文件，App.tsx 只加接线代码 |

## 3. 13 · 界面中英双语

### 3.1 数据模型（`src/lib/i18n.ts`）

```ts
export type Lang = 'zh' | 'en';

/** 中文为 key 源；en 表与 zh 同构，缺 key / 多 key 直接编译报错 */
const zh = { 'menu.openFile': '打开文件', /* ... */ } as const;
export type MessageKey = keyof typeof zh;
const en: Record<MessageKey, string> = { /* ... */ };

const DICTS: Record<Lang, Record<MessageKey, string>> = { zh, en };

/** 纯函数：{name} 占位符插值，缺参数原样保留 */
export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string;
export function resolveSystemLang(navigatorLanguage?: string): Lang;  // zh* → zh，其余 → en
```

React 侧 `src/lib/i18nContext.tsx`：`I18nProvider(lang)` + `useT()` 返回绑定的 `t`。非 React 模块（纯函数里的 alert 文案）经 `setRuntimeLang(lang)` 模块级注入，App 在语言变化时同步设置。

### 3.2 设置与切换

- `EditorSettings` 新增 `language: 'system' | 'zh' | 'en'`，默认 `'system'`；`normalizeSettings` 逐字段校验回退（同现有模式）。
- 设置面板新增「界面语言 / Language」选择（跟随系统 / 简体中文 / English），即时生效。
- App 内 `lang = settings.language === 'system' ? resolveSystemLang(navigator.language) : settings.language`。

### 3.3 文案迁移

App.tsx + 全部组件（含 mobile/ 4 个组件、各弹窗、MarkdownPreview 工具提示、状态栏、菜单、ConfirmDialog、ImageInsertModal、DiffModal、FindReplaceBar、PreviewFindBar、ShortcutHelpDialog、SettingsDialog）的硬编码中文全部替换为 `t()`。快捷键提示（Ctrl+F 等）、主题词（深色/浅色）一并入表。估计 300+ 条，机械替换。

i18n 先行落地，因此本批次后续功能（14/11/12/10）的新增文案直接以 `t()` 形式实现，不产生二次替换。

## 4. 14 · 字数统计（`src/lib/wordCount.ts`）

```ts
export interface WordCount { chars: number; words: number; }
/** cjkAware=true：CJK 每字 1 词 + 连续 [A-Za-z0-9'’-]+ 计 1 词；false：按空白分词 */
export function countWords(text: string, cjkAware: boolean): WordCount;
```

- 字符数按码点计（代理对算 1），单次线性扫描同时产出 chars/words，200 万字符毫秒级。
- 状态栏在「N 行」后追加 `X 字 · Y 词` 段（`tabular-nums`）；Markdown 标签 `cjkAware=true`。活动标签内容变化时经 useMemo 重算。

## 5. 11 · Markdown 导出 HTML（`src/lib/markdownHtml.ts`）

```ts
/** 动态 import react-markdown/remark-gfm/react-dom/server；全大写函数内部 await import */
export async function renderMarkdownToHtml(md: string, opts: { title: string; dark: boolean }): Promise<string>;
```

- 渲染管线与 `MarkdownPreview` 一致（react-markdown + remark-gfm；代码块沿用预览的语法高亮 inline style 组件）。
- 产出 `<!DOCTYPE html>` 单文件：`<meta charset>`、`<title>`、内联 `<style>`（body 版心、标题、段落、列表、引用、行内码/代码块、表格边框、图片自适应、hr、链接色），深浅色由 `opts.dark` 决定。
- 入口：桌面/平板菜单新增「导出为 HTML」（仅 Markdown 标签可用；无快捷键）。
- 落盘：桌面 `dialog.save`（默认名 `标题.html`）→ 复用 `writeLocalPath`（UTF-8 无 BOM）；安卓 `createDoc(name, 'text/html')` + 桥写 UTF-8；纯浏览器降级 Blob + `a[download]`。

## 6. 12 · 网址导入 Markdown

### 6.1 Rust（`src-tauri/src/http.rs` + `lib.rs` 注册）

```rust
#[tauri::command]
fn http_get(url: String) -> Result<HttpGetResult, String>
// HttpGetResult { status: u16, final_url: String, content_type: String,
//                 text: String, encoding: String, bom: bool, lossy: bool }
```

- `ureq`（默认 rustls）：仅 `http://` / `https://`（前缀校验 + 解析后 scheme 复核）；timeout 15s；重定向 ≤5；响应体读取上限 5MB（超限截断即报错"页面过大"）。
- 响应体字节走 `encoding::detect_and_decode`；检出 NUL（binary）返回 `"网页疑似二进制内容"` 错误。
- Cargo 新增 `ureq = "3"`。单元测试：URL/scheme 校验、重定向与超时参数构造（不联网）。

### 6.2 前端（`src/lib/urlImport.ts` + 导入弹窗）

```ts
/** 动态 import defuddle + turndown；输入 http_get 结果，输出 { title, siteName, markdown } */
export async function importFromUrl(fetchResult): Promise<UrlImportResult>;
```

- 流程：菜单「从网址导入…」→ 弹窗（URL 输入 + 抓取/错误态 + 重试）→ `invoke('http_get')` → defuddle 提取正文 → turndown（GFM 规则：表格/围栏代码/删除线）转 MD → 新标签页（标题 `<站名或标题>.md`，标脏）。
- 头部元信息块：`> **来源**：{title}\n> **URL**：{finalUrl}\n> **抓取时间**：{ISO 时间}\n\n`。
- 图片保留远程 URL（相对地址按 finalUrl 补全为绝对地址）。
- 浏览器模式无该菜单项（无原生 HTTP）；明确不支持 SPA / 登录页（弹窗固定提示文案）。

## 7. 10 · 文件树侧栏

### 7.1 提供者接口（`src/lib/fileTree.ts`）

```ts
export interface DirEntry { name: string; path: string; isDir: boolean; }
export interface DirLister {
  /** 打开目录选择器，返回根目录标识（桌面为绝对路径，安卓为 SAF tree URI）；取消返回 null */
  chooseRoot(): Promise<string | null>;
  list(dirPath: string): Promise<DirEntry[]>;
}
export function getDirLister(): DirLister | null;  // 浏览器返回 null
```

- `TauriDirLister`：`plugin-dialog open({directory:true})` + `plugin-fs readDir`（capabilities 新增 `fs:allow-read-dir`，scope `**`）。
- `SafDirLister`：`HeidBridge.openTree()`（ACTION_OPEN_DOCUMENT_TREE + `takePersistableUriPermission`，结果经 `heid-saf` 事件回传，同 openDocs 模式）+ `HeidBridge.listTree(treeUri, subPath)`（DocumentsContract 列子项，JSON 数组：name/isDir/uri）。
- 纯状态函数（可单测）：`sortEntries`（目录优先、同组按名排、区域设置感知）、`matchDirtyPath`（tab path 前缀归属判断）。

### 7.2 安卓 Kotlin（MainActivity.kt）

`openTree()`（选目录 + 持久化授权 + `heid-saf` kind:'tree' 回传）与 `listTree(treeUri, subPath)`（buildChildDocumentsUriUsingTree 遍历，同步返回 JSON 字符串，WebView JS 线程内可调用）。约 150 行。

### 7.3 UI（`src/components/FileTreeSidebar.tsx`）

- **入口**：宽屏（`!isPhone`）标题栏左侧新增 `PanelLeft` 图标按钮（抽屉默认关）；菜单新增「打开文件夹 / 关闭文件夹」，菜单项与按钮仅宽屏布局可见，浏览器模式无。
- **布局**：桌面 = 左侧固定 240px 面板（编辑区自动让位）；安卓 = 覆盖式抽屉 + 遮罩。深浅色沿用现有 token。
- **节点**：目录行（chevron + 名称，点击展开/收起）、文件行（点击走 `openPathIntoTab`）；活动标签行高亮；脏标签显示橙点；缩进 12px/层；头部显示根目录名 + 刷新按钮。
- **错误**：目录读取失败 → 节点位显示内联错误态（可点重试）；根目录失效 → 空态文案。
- **记忆**：`localStorage` 存最后一次根目录；启动不加载，抽屉首次打开时若存在则自动 list 根目录。

## 8. 测试

| 模块 | 手段 |
| --- | --- |
| i18n | TS 同构校验即编译期测试；vitest：插值、`resolveSystemLang`、缺参数行为 |
| wordCount | vitest：中英混排、空白分词、emoji 码点、空串、大样本 |
| markdownHtml | vitest（Node 端 renderToStaticMarkup）：标题/代码/表格/引用片段断言、charset、title 注入 |
| urlImport | vitest：相对图片地址补全、头部元信息块、空正文报错 |
| fileTree | vitest：sortEntries、dirty 前缀匹配 |
| Rust http_get | `cargo test`：URL 校验、超限逻辑（不联网） |
| 端到端 | 安卓模拟器实测：SAF 选目录/浏览/打开文件；真实 URL 抓取转 MD |

每项完成即跑 `vitest + tsc`（+ Rust 项 `cargo test`）；全部完成后核对主 bundle 尺寸不高于 v0.4 的 1667KB（gzip 546KB），并升级版本号 0.4.0 → 0.5.0（package.json / Cargo.toml / tauri.conf.json）与 ROADMAP 勾选。

## 9. 明确不做（v0.5）

文件树实时 watch、重命名/删除/拖拽移入、图片下载到本地、SPA 动态渲染抓取、登录态抓取、第三语言。均记入 ROADMAP 后续细化。
