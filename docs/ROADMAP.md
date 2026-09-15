# H.I.D.E 后续开发规划

> 定位：**轻量文本编辑器**。每项功能都要过"轻量"这道门槛：不显著增加包体积、不引入常驻后台、不让界面复杂化。
> 当前版本：v1.1.0（2026-09，可视化内容视图批次已发布）

## 版本策略

应用已完成正式发布，此后走 SemVer 常规节奏：**功能版挂主题、补丁版随修随发**。
每个版本只挂一个主题、功能项控制在三项以内，做完再规划下一版 —— 避免一次性铺太多摊子。

历史里程碑：0.1.0 初始提交、0.2.0 安卓移植、0.3.0「及格线」批次、0.4.0 编辑体验、
0.5.0 差异化小功能、v1.0.0 正式发布（发布链路 + 工程化）、v1.1.0 可视化内容视图。

## 现状盘点（v1.1.0）

已有能力：30+ 语言语法高亮、小地图、粘性滚动、代码折叠、多标签页（脏状态）、
查找/替换/跳转到行、Markdown 分屏预览（公式 / Mermaid / 表格编辑 / 导出 HTML / 网址导入）、
CSV 网格编辑器、SVG 工作台、图片查看器、文件树侧栏、外部修改 Diff 时间线、会话恢复与草稿、
编码检测与转换（8 种）、换行符保留与转换、自动更新、文件关联与单实例，桌面 + 安卓双端。

仍存在的边界（后文按此排期）：

| 类别 | 边界 |
| --- | --- |
| 平台 | 只打包 Windows（NSIS）与 Android（侧载 APK）；应用内更新仅桌面 |
| 大文件 | 超 200 万字符降级；查找扫描上限 200 万字符 / 5000 匹配；小地图画布行数上限未实测 |
| 检索 | 只有单文件查找；没有跨文件（文件夹）搜索 |
| 格式能力 | 无打印、无十六进制查看、无 JSON/YAML 结构化视图 |
| 安卓 | 无外部修改 diff / 文件监听；文件树在手机端隐藏（图片查看因此在手机没有入口）；SAF 下的新建 / 重命名 / 删除未接 |
| 工程 | 无 lint / format；hooks 与 App / CodeEditor / MarkdownPreview 无测试；`csp: null`；fs 权限 `path: "**"` |

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

## v0.5 —— 小而美的差异化（P2）✅ 已完成（2026-09）

10. ✅ **可选文件树侧栏**（`FileTreeSidebar.tsx` + 纯状态库 `src/lib/fileTree.ts` + `DirLister` 双提供者）
    - 默认关闭的抽屉式目录浏览（桌面 + 安卓平板宽屏）：标题栏 PanelLeft 开关 + 菜单「打开/关闭文件夹」
    - 懒加载（展开才列子项）、目录优先排序、活动标签高亮、脏状态橙点、记住根目录（启动零 I/O）、手动刷新
    - 桌面 = dialog + plugin-fs readDir；安卓 = SAF 桥 openTree + listTree（DocumentsContract），文件经 document URI 走既有打开通道
11. ✅ **Markdown 导出 HTML**（`src/lib/markdownHtml.ts`）：复用 react-markdown + remark-gfm 经 renderToStaticMarkup，
    单文件内联 `<style>`（深/浅一套），零新增依赖；桌面另存 / 安卓 SAF 新建文档 / 浏览器 Blob 下载
12. ✅ **网址导入 Markdown**（导出 HTML 的逆操作）：粘贴 URL → 抓取网页 → 提取正文 → 转成 Markdown 插入新标签页
    - Rust `http_get` 命令（ureq/rustls）：超时 + 5MB 上限 + 仅 http/https + NUL 判二进制；非 UTF-8 页面复用既有编码检测
    - defuddle + turndown(GFM) 动态 import（懒加载 chunk，不进主包）；结果以 `<站名/标题>.md` 分屏新标签页打开，头部写 title/来源 URL/抓取时间
    - 明确不支持：JS 动态渲染的 SPA、需登录的页面；图片保留远程 URL
13. ✅ **界面中英双语**（`src/lib/i18n.ts` + `i18nContext.tsx`）：中文表 `as const` 为 key 源、英文表同构（编译期对齐）；
    偏好并入 settings（`language: system|zh|en`，system 按 navigator.language 解析）；300+ 条文案全量迁移
14. ✅ **字数统计**（`src/lib/wordCount.ts`）：状态栏「X 字 · Y 词」，Markdown 按 CJK 感知计数（Word/WPS 口径），字符按码点计

## v1.0.0 —— 正式发布（发布与工程化）✅ 已完成（2026-09）

15. ✅ **文件关联与单实例**
    - NSIS 经 `bundle.fileAssociations` 注册 42 个文本/代码扩展名的「打开方式」（Editor 角色）
    - `tauri-plugin-single-instance`：二次启动不开启新进程，聚焦已有窗口；
      argv 路径首实例经 `take_launch_paths` 命令取走、二次实例经 `heid-open-paths` 事件转发，前端统一走 openPathIntoTab
16. ✅ **自动更新**
    - 桌面 `tauri-plugin-updater` + `createUpdaterArtifacts`：minisign 密钥对已生成
      （私钥本地保存不入库，公钥内嵌配置，见 `docs/RELEASE.md`）；启动 4s 后静默检查（24h 节流）+「关于」弹窗手动检查，确认后下载安装并经 plugin-process 重启
    - 安卓侧载：复用既有 `http_get` 抓取 `latest.json` 比较版本，有新版提示「前往下载」跳转 Releases 页；浏览器模式无更新通道
    - 发布流程：推送 `v*` 标签触发 release 工作流，tauri-action 产出签名安装包 + latest.json 自动建 Release
17. ✅ **CI**：GitHub Actions（`.github/workflows/ci.yml`）—— vitest + tsc + 前端构建、Windows NSIS 桌面构建（无 secrets 依赖，关闭签名产物）、安卓 arm64 debug APK 构建；`release.yml` 按标签签名发布
18. ✅ **代码结构**：`App.tsx`（原 2743 行 → 现 1695 行）拆分为 9 个 hooks + 纯逻辑库；核心路径补单测

## v1.1.0 —— 可视化内容视图 ✅ 已完成（2026-09）

19. ✅ **CSV 网格编辑器**（`src/lib/csv.ts` + `src/components/CsvGridEditor.tsx`）：`.csv` / `.tsv` 默认进入类 Excel 网格视图
    - 单元格点击输入、框选、行虚拟滚动、行列增删、拖拽填充柄（复制 / 循环 / 等差）、TSV 剪贴板互通、编辑栏、列宽自适应与拖拽
    - 数据事实单一来源仍是 `tab.content`：每一笔编辑走一次 `updateTabContent()`，撤销/重做、脏标记、diff 时间线、草稿全部自动复用
    - 性能闸门：> 5MB 或 > 5 万行默认文本视图
20. ✅ **SVG 可视化工作台**（`SvgWorkbench.tsx`）：左侧源码 + 右侧 blob 隔离预览（脚本不执行），滚轮缩放、拖拽平移、适应面板 / 原始尺寸
21. ✅ **内置图片查看器**（`ImageViewer.tsx`）：智能初始尺寸（大图适应、小图原始）、光标锚点缩放、1:1 切换、底部信息栏
22. ✅ **README 与截图重写**：功能亮点分区 + 6 张界面截图（`docs/screenshots/`）
23. ✅ **Mermaid 图与编辑弹窗**（`src/lib/mermaid.ts` + `MermaidEditModal.tsx`）：预览渲染、编辑弹窗与格式化工具

---

## v1.1.x —— 维护批次 ✅ 已完成（2026-09）

24. ✅ **版本号常量同步**：`src/lib/update.ts` 的 `FALLBACK_APP_VERSION` 更新为 `1.1.0`，与 `package.json` / `tauri.conf.json` / `Cargo.toml` 一致（发布前检查四处版本号）
25. ✅ **未入库内容提交**：Mermaid 编辑弹窗（`feat(markdown)`）、`src-tauri/nsis/` 安装钩子与外壳注册脚本（`build(shell)`）均已入库
26. ✅ **零散修正**：`src-tauri/Cargo.toml` 描述更正为 H.I.D.E 产品定位，去除历史残留文案

## v1.2 —— 大文件与跨文件检索（P0）

主题：**把"打开任意文件"这条路径做到不翻车**。这是用户第一分钟就会遇到、也是同类轻量编辑器被抱怨最多的一环。
设计稿：`docs/superpowers/specs/2026-09-15-large-file-strategy.md`（三层分级：≤32MB 可编辑 / 32~512MB 只读分块预览 / >512MB 拒绝并给替代建议）。

27. ✅ **超大文件打开**（Rust `src-tauri/src/large_file.rs` + `src/lib/largeFile.ts` + `LargeFileViewer.tsx`）
    - probe 单次顺扫统计行数并构建自适应稀疏行偏移表（条目超 2M 步长翻倍稀释，内存 ≤ 16MB）；
      read_line_window 按行窗口读取（CRLF 剥离、超长行 1MB 截断、单窗口 4MB 预算）；UTF-16 按码元扫描换行
    - 前端虚拟滚动（滚动条代理映射 + sticky 行块，超浏览器布局上限按比例压缩）+ 换窗去抖防竞态 + 跳转行
    - 打开路由三层分级统一收敛：选择器 / 最近 / 文件树 / 拖拽 / argv / 会话恢复全部先查尺寸再决定
    - 编辑出口：提取当前窗口到可编辑新标签页；大文件标签不进外部文件监听（避免整读做 diff 基准）
28. **跨文件搜索**：文件夹范围内的文本检索（复用文件树已有的目录提供者；按需触发、不建常驻索引、不驻留后台进程），结果列表可跳转到文件行列
29. ✅ **查找上限解除**（`src/lib/searchCore.ts`）：解除 200 万字符扫描与 5000 匹配上限——全量计数、
    「全部替换」走 `replaceAllInText` 全文一次替换不再截断；装饰高亮仍限 5000 条（CM6 渲染约束），UI 显示「共 N 处（仅高亮前 5000 处）」
30. **小地图大文件适配**：固定画布高度 + 超阈值停用语法着色，先实测确认画布行数上限再实施（`CodeEditor.tsx` 未设置上限常量，属未验证结论）
31. ✅ **十六进制查看**（`HexViewer.tsx`）：只读 hex 视图（16 字节/行，偏移 + hex + ASCII），二进制判定升级为
    16KB 采样（大文件里 NUL 可能藏在深处），与「二进制 · 只读」状态衔接
32. ✅ **撤销历史自适应降档**（`src/lib/tabHistory.ts`）：内容超 400 万字符自动把 200 条全文快照降至 5 条，
    状态栏提示；50MB 级文件连续编辑不再线性吃内存

## v1.3 —— 结构化内容与新格式（P1）

主题：**把"打开即能看懂"扩展到更多文件类型**，这是与纯文本编辑器拉开差距的地方。

32. **JSON / YAML 结构化视图**：格式化（缩进规范化）+ 折叠树浏览，复用现有只读视图模式
33. **Markdown 增强**：大纲侧栏导航、粘贴图片自动落盘并插入相对路径、导出 HTML 带代码高亮、网址导入的图片下载到本地
34. **CSV 只读态排序 / 筛选**：网格已有的解析层之上加排序与筛选（不做公式、多 sheet、单元格样式，见 `docs/superpowers/specs/2026-09-15-csv-grid-editor-design.md` 的 YAGNI 清单）
35. **打印 / 导出 PDF**：桌面走系统打印，复用现有渲染栈

> 同批次候选（有余力再做）：剪贴板监控（Notepad3 PasteBoard 式的「最小化粘贴板」），
> 做成设置项默认关闭，避免打扰；「复制为富文本（保留高亮）」与之同源，可一并考虑。

## v1.4 —— 移动端补齐与平台决策（P2）

主题：**安卓从"能看"到"能用"**；同时给多平台一个明确答复。

36. **手机端补齐**：图片查看入口（当前唯一入口是文件树，而文件树在手机端隐藏）、文件树抽屉化、精简状态栏
37. **SAF 文件管理**：`src/lib/fileOps.ts` 的 `treeManageAvailable` 目前桌面专属，安卓侧补新建 / 重命名 / 删除
38. **安卓 release 签名**：当前侧载用 debug 签名
39. **macOS / Linux 打包评估**：Tauri 本身跨平台，但 Windows 强绑定点明确（NSIS 钩子、注册表外壳集成、updater 产物为 `.exe`、CI 只有 `windows-latest` / `ubuntu-latest`）。先做可行性结论：要么补平台，要么明确「单平台做深」并写进 README

## v2.0 —— 可选 AI 与安全加固（P2）

主题：**在不破坏"秒开、2-3 MB"的前提下，给一个默认关闭的 AI 入口**。

40. **AI 按需接入（默认关闭）**
    - 形态约束：不常驻面板、不自动改文件；只能由快捷键 / 命令显式触发**单次**请求
    - 接入方式：优先对接 OpenAI 兼容端点（Ollama 本地端点即可跑通），把「离线、零费用、内容不出本机」作为默认推荐
    - 结果处理：生成内容先落在标签页或 diff 里，由用户逐条采纳 —— 复用既有 diff 时间线，规避「AI 改坏文件」的不信任
41. **安全加固**
    - `tauri.conf.json` 的 `csp: null` 收紧为白名单策略
    - `src-tauri/capabilities/default.json` 的 fs 权限从 `path: "**"` 收窄到用户实际选择的目录
    - 更新链路：已用 minisign 签名，参照 Notepad++ 因更新器未校验下载物而遭供应链投毒的事件（CVE-2025-15556），补上「校验失败即中止」的显式分支与版本回滚说明
42. **工程化收口**：引入 lint / format 并接入 CI；为 12 个 hooks 与主组件补关键路径测试；`MarkdownPreview.tsx`（1444 行）、`CodeEditor.tsx`（1369 行）继续拆分

---

## 明确不做（守住"轻量"）

插件系统、LSP/智能补全、内嵌终端、Git 集成、账号与云同步、主题市场、AI 面板常驻、
电子表格能力（公式 / 多 sheet / 单元格样式）、跨文件批量替换与宏录制。
—— 需要这些的用户有 VS Code；H.I.D.E 的目标是"秒开、2-3 MB、够用的编辑器"。

## 优先级依据

1. **打开文件这条路径优先**：大文件、乱码、换行符、找不到内容 —— 这四项决定用户第一分钟的去留，v1.2 全部收口。
2. **再补桌面顺手度**：跨文件搜索、打印 / 导出 PDF、十六进制查看，都是"平时不用、要用时必须有"的能力，且都不需要常驻进程。
3. **然后是内容格式深度**：Markdown / CSV / SVG / 图片已经把优势立起来，JSON / YAML 与打印是顺着同一逻辑的延长线。
4. **多平台与 AI 放最后**：两者都会显著增加维护面或包体积，且都不是当前用户停留的原因；先给结论（做 / 不做），再谈实现。
