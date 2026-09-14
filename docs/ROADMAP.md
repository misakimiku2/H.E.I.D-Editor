# H.I.D.E 后续开发规划

> 定位：**轻量文本编辑器**。每项功能都要过"轻量"这道门槛：不显著增加包体积、不引入常驻后台、不让界面复杂化。
> 当前版本：v1.0.0（2026-09，发布链路就绪）

## 版本策略

应用尚未正式发布，遵循 SemVer 惯例走 0.x 阶段：**0.x 内随意加功能、随意破坏兼容**；
路线图核心（v0.3 ~ v0.5）与发布链路（文件关联、CI 等，见 v1.0.0 一节）完成后升 **v1.0.0 = 正式发布**。
历史里程碑与新编号的对应：初始提交 = 0.1.0，安卓移植 = 0.2.0，本次「及格线」批次 = 0.3.0，编辑体验批次 = 0.4.0。

## 现状盘点

已有能力：13+ 语言语法高亮、Minimap、粘性滚动、代码折叠、多标签页（脏状态）、Markdown 预览/表格编辑/图片插入/格式化工具、外部修改 Diff 时间线、会话恢复、深浅色主题、桌面 + 安卓双端、查找/替换/跳转到行、编码检测与转换（UTF-8/UTF-16/GBK/GB18030/Big5/Shift_JIS）、换行符保留与转换、状态栏（行列/选中/编码/换行符）、最近打开文件。

v1.1 时核实的缺口已全部补齐（见 v0.3 一节的勾选）。

---

## v0.3 —— 补齐文本编辑器的"及格线"（P0）✅ 已完成（2026-09）

1. ✅ **查找 / 替换 / 跳转到行**（最高优先级）
   - 自绘 FindReplaceBar（`src/components/FindReplaceBar.tsx`）+ 纯函数查找引擎（`src/lib/searchCore.ts`）+ 高亮扩展（`src/lib/editorSearch.ts`），不依赖 @codemirror/search 面板，桌面 / 手机 / 平板同一套交互
   - 正则（含 `$1` 引用替换）、大小写、全词匹配、匹配计数与循环导航；`Ctrl+F` / `Ctrl+H` / `Ctrl+G`
2. ✅ **编码支持（中文用户刚需）**
   - Rust 侧 `encoding_rs`（`src-tauri/src/encoding.rs` + `read_text_file` / `write_text_file` 命令）：BOM → 二进制判定 → 严格 UTF-8 → GBK / GB18030 / Big5 / Shift_JIS 无损认定 → GBK lossy 回退，含 12 个单元测试
   - 保存按原编码写回（BOM 保留）；状态栏「以编码重新打开」/「转换编码并保存」
   - 安卓 SAF 经 Kotlin 桥 `writeUri(uri, content, encoding, bom)` 按编码写盘；浏览器端 JS 启发式检测（`src/lib/encoding.ts`）
3. ✅ **换行符处理**：打开保留原始 CRLF/LF/CR（编辑器内 LF 归一，保存时还原），状态栏显示并一键转换，eol 纳入脏状态判定
4. ✅ **状态栏完善**：`行:列`、选中字符数、编码（含 BOM 标记）、换行符
5. ✅ **最近打开文件**：最多 15 条（`src/lib/recentFiles.ts`），菜单显示最近 8 条，打开 / 另存 / 拖拽均记录

> v0.3 后续细化：查找浮层统一 portal 弹出在指针位置（不跟随）；新增 Markdown 纯预览态查找
> （`PreviewFindBar`，只搜渲染后文本，CSS Custom Highlight API 高亮，旧 WebView 降级为计数 + 滚动定位），
> 替代此前 WebView/浏览器自带的查找栏。

## v0.4 —— 编辑体验（P1）✅ 已完成（2026-09）

6. ✅ **设置面板**（`src/components/SettingsDialog.tsx` + `src/lib/settings.ts` 统一存取，逐字段校验回退）
   - 字体、字号、行高、Tab 宽度、空格/Tab 缩进、自动换行（仅 Markdown / 总是 / 从不）、显示空白符
   - 小地图 / 粘性滚动开关（手机与降级模式下自动不可用）
7. ✅ **自动保存与草稿恢复**
   - 自动保存（默认关）：按间隔把「有路径且脏」的文件静默落盘；确认弹窗/退出流程期间暂停，避免和用户「不保存」的决策打架
   - 草稿恢复（始终开启）：脏标签内容防抖写入 `lib/drafts`（localStorage），会话恢复时叠加并标脏；
     「关闭不保存 / 退出不保存」明确清除草稿；单条草稿超 2MB 放弃保护（localStorage 配额）
8. ✅ **快捷键补齐**：`Ctrl+W` 关标签、`Ctrl+Tab` / `Ctrl+Shift+Tab` 切换标签；「键盘快捷键」帮助弹窗（桌面菜单 + 手机顶栏）
9. ✅ **性能与体积**
   - 13 个语言包全部改为按需 `import()`：主 bundle 2251 KB → 1667 KB（gzip 759 → 546 KB，-26%）
   - 大文件保护：超 200 万字符自动关闭语法高亮/小地图/补全/选区匹配，状态栏显示「大文件」
   - 二进制文件（检测含 NUL）：只读预览，状态栏显示「二进制 · 只读」

> v0.4 后续细化：标签栏右键菜单（新建 / 关闭其他 / 关闭全部，脏标签逐个确认）。
> 待定：小地图的大文件适配（固定画布高度 + 超阈值停用语法着色，解除约 1.3 万行的画布上限）——
> 待有真实 MB 级文档再验证实施。

## v0.5 —— 小而美的差异化（P2）✅ 已完成（2026-09）

10. ✅ **可选文件树侧栏**（`FileTreeSidebar.tsx` + 纯状态库 `src/lib/fileTree.ts` + `DirLister` 双提供者）
    - 默认关闭的抽屉式目录浏览（桌面 + 安卓平板宽屏）：标题栏 PanelLeft 开关 + 菜单「打开/关闭文件夹」
    - 懒加载（展开才列子项）、目录优先排序、活动标签高亮、脏状态橙点、记住根目录（启动零 I/O）、手动刷新
    - 桌面 = dialog + plugin-fs readDir；安卓 = SAF 桥 openTree + listTree（DocumentsContract），文件经 document URI 走既有打开通道；不做嵌套复杂操作（重命名/拖拽移入后续再议）
11. ✅ **Markdown 导出 HTML**（`src/lib/markdownHtml.ts`）：复用 react-markdown + remark-gfm 经 renderToStaticMarkup，
    单文件内联 `<style>`（深/浅一套），零新增依赖；桌面另存 / 安卓 SAF 新建文档 / 浏览器 Blob 下载
12. ✅ **网址导入 Markdown**（导出 HTML 的逆操作）：粘贴 URL → 抓取网页 → 提取正文 → 转成 Markdown 插入新标签页
    - Rust `http_get` 命令（ureq/rustls）：超时 + 5MB 上限 + 仅 http/https + NUL 判二进制；非 UTF-8 页面复用既有编码检测
    - defuddle + turndown(GFM) 动态 import（懒加载 chunk，不进主包）；结果以 `<站名/标题>.md` 分屏新标签页打开，头部写 title/来源 URL/抓取时间
    - 明确不支持：JS 动态渲染的 SPA、需登录的页面；图片保留远程 URL（相对地址按最终 URL 补全；「下载到本地」后续再议——新标签页未落盘无目标目录）
13. ✅ **界面中英双语**（`src/lib/i18n.ts` + `i18nContext.tsx`）：中文表 `as const` 为 key 源、英文表同构（编译期对齐）；
    偏好并入 settings（`language: system|zh|en`，system 按 navigator.language 解析）；300+ 条文案全量迁移
14. ✅ **字数统计**（`src/lib/wordCount.ts`）：状态栏「X 字 · Y 词」，Markdown 按 CJK 感知计数（Word/WPS 口径），字符按码点计

> v0.5 后续细化：文件树实时 watch（fs 插件 watch 已授权）、文件树重命名/删除、
> 网址导入的图片下载到本地、导出 HTML 的代码高亮、欢迎页文档内容按语言切换、en 词典懒加载（当前主包 +23KB）。

## v1.0.0 —— 正式发布（发布与工程化）✅ 已完成（2026-09）

> 以下发布门槛全部就位（连同 v0.3 ~ v0.5 的功能面），版本号已升至 **v1.0.0**。

15. ✅ **文件关联与单实例**
    - NSIS 经 `bundle.fileAssociations` 注册 40+ 文本/代码扩展名的「打开方式」（Editor 角色）
    - `tauri-plugin-single-instance`：二次启动不开启新进程，聚焦已有窗口；
      argv 路径首实例经 `take_launch_paths` 命令取走、二次实例经 `heid-open-paths` 事件转发，前端统一走 openPathIntoTab
16. ✅ **自动更新**
    - 桌面 `tauri-plugin-updater` + `createUpdaterArtifacts`：minisign 密钥对已生成
      （私钥本地保存不入库，公钥内嵌配置，见 `docs/RELEASE.md`）；启动 4s 后静默检查（24h 节流）+「关于」弹窗手动检查，确认后下载安装并经 plugin-process 重启
    - 安卓侧载：复用既有 `http_get` 抓取 `latest.json` 比较版本，有新版提示「前往下载」跳转 Releases 页；浏览器模式无更新通道
    - 发布流程：推送 `v*` 标签触发 release 工作流，tauri-action 产出签名安装包 + latest.json 自动建 Release
17. ✅ **CI**：GitHub Actions（`.github/workflows/ci.yml`）—— vitest + tsc + 前端构建、Windows NSIS 桌面构建（无 secrets 依赖，关闭签名产物）、安卓 arm64 debug APK 构建；`release.yml` 按标签签名发布
18. ✅ **代码结构**：`App.tsx`（2743 行）拆分为 9 个 hooks（useTheme / useEditorState / useDiffTimelines / useFileActions / useSessionPersistence / useDiscardConfirm / usePlatformIntegration / useAppShortcuts / useSplitScroll）+ 纯逻辑库（lib/fileIO、lib/tabModel、lib/tabHistory、lib/update 等）；核心路径补单测（撤销历史合并/截断、文件解码与换行符归一、版本比较、latest.json 解析、自动检查节流），前端单测 235 → 254 条

> v1.0 后续可议（不影响发布）：文件树实时 watch 与重命名/删除、网址导入图片下载到本地、
> 导出 HTML 的代码高亮、欢迎页文案按语言切换、en 词典懒加载（当前主包 +23KB）、
> 小地图大文件适配（待真实 MB 级文档验证）、安卓 release 签名（侧载 debug 签名已够用）。

---

## 明确不做（守住"轻量"）

插件系统、LSP/智能补全、内嵌终端、Git 集成、账号与云同步、主题市场、AI 面板常驻。
—— 需要这些的用户有 VS Code；H.I.D.E 的目标是"秒开、2-3 MB、够用的编辑器"。

## 优先级依据

1. 查找替换第一：没有 `Ctrl+F` 的编辑器，用户第一分钟就会流失，且实现成本低（官方扩展）。
2. 编码第二：中文 Windows 用户打开 GBK 文件乱码是致命体验，是同类轻量编辑器（Notepad3、Notepad--）的基本盘。
3. 之后按"一个版本一个主题"推进：设置体验 → 差异化小功能 → 发布链路，避免摊子铺大。
