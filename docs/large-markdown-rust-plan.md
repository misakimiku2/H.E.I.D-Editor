# 大文档 Markdown：Rust 侧加速方案（分段实施计划）

> 状态：**Phase 1、Phase 2 已完成（2026-11-11）**，Phase 3 未实施。基线 TSX 分块预览
> 改动已单独提交（c960f50）。实施记录与实测数据见 §4.7、§5.5。

## 0. 结论

- **I/O 不是瓶颈**：Rust 现有 `read_text_file` 读 3.7MB 只要毫秒级，问题在 UI 线程的
  Markdown 解析 + 建 DOM。
- **Rust 能替掉解析/搜索/高亮，替不掉浏览器建 DOM**。因此推荐顺序：
  1. **Phase 1：Rust 全文检索索引**（收益直接、风险最低，先做）；
  2. **Phase 2：Rust 解析 + 分块 HTML 只读极速预览**（收益最大、改动最大，可选）；
  3. **Phase 3：索引/解析缓存与后台预热**（前两段跑通后再做）。
- 小文档继续走现有 ReactMarkdown 路径，不改。

## 1. 现状基线与实测数据

基准文件（仅本机实测，**不要提交进仓库**）：

`C:\Users\misakimiku\Documents\主线剧情_全本.md`

| 指标 | 数值 |
| --- | --- |
| 文件大小 | 3.7MB |
| 字符数 | 1,599,882 |
| 行数 | 150,037 |
| 标题数 | 821 |
| `<!-- group: ... -->` 注释 | 771 |
| 围栏代码 / 原始 HTML 标签 | 0 / 0 |

2026-11-11 在 Node 里对整篇跑 JS 管线（近似线上管线的阶段拆分）：

| 阶段 | 耗时 |
| --- | --- |
| remark parse | ~5.4s |
| remark → hast | ~0.9s |
| `rehype-raw` | **~10.2s** |
| `rehype-sanitize` | ~1.1s |
| `rehype-katex` | ~1.2s |

当前工作区已落地的 TSX 缓解（本文档的起点）：

- `src/lib/markdownChunks.ts`：超过 **15 万字符**的 Markdown 按标题切块；围栏代码与页签组
  内部不切；首屏只渲染 8 块，滚动每次追加 8 块；大纲跳远块先补渲染再滚动。
- `src/components/MarkdownPreview.tsx`：
  - 无原始 HTML 标签的块跳过 `rehype-raw`（`hasRawHtml`），清洗仍保留；
  - HTML 注释在 remark 阶段移除（`remarkStripHtmlComments`）；
  - 预览查找打开时把剩余块分批补渲染，加载完成后再做 DOM 扫描。
- `src/components/PreviewFindBar.tsx`：大文档全文加载期间显示百分比、禁用结果导航。

真实浏览器实测（2026-11-11，同一份 3.7MB 文件）：

| 场景 | 结果 |
| --- | --- |
| 首屏 | 123ms 出画面；只渲染 8 个标题块；JS 堆约 31MB |
| 滚动续载 | 每次 +8 块；窗口可交互 |
| 打开查找 → 全部 821 块载完 | 约十几秒；JS 堆约 275MB |
| 查找文末独有句「方舟升上地面了。」 | 返回 1 条，准确 |

**剩余痛点**：大文档第一次查找仍要把全文渲染进 DOM（十几秒 + 275MB）；源码/分屏编辑
仍是整篇挂载；如果以后要更快的只读浏览，需要 Phase 2。

## 2. 目标与非目标

### 目标

- 大文档（>15 万字符）在预览里查找：**不加载全文 DOM 也能得到全量、准确的结果**，
  首次结果 < 1s，额外内存 < 50MB。
- 保持现有小文档行为、HTML 清洗安全策略、`<br>` 等原始 HTML 支持、Android 可构建。
- Rust 侧工作与现有 `search.rs` / `large_file.rs` 的工程风格一致：后台线程、可取消/
  有进度、护栏明确、纯 Rust 模块便于单测。

### 非目标

- 本计划不把**所有** Markdown 预览迁移到 Rust；不替换小文档的 ReactMarkdown 组件体系。
- 不迁移 KaTeX / Mermaid 到 Rust（它们仍是前端 JS 渲染器）。
- 不改变本地文件读写与 32MB 大文件窗口读取的现有分级（`large_file.rs` 已覆盖 32~512MB）。
- 不为了性能牺牲 HTML 清洗：Rust 若产出 HTML，必须经过等价 allowlist 清洗。

## 3. 通用工程约定

1. **命令线程**：Tauri 的同步 command 默认在主线程执行；解析/搜索命令写成 `async fn`
   或 `tauri::async_runtime::spawn_blocking`，禁止阻塞 UI 线程。
2. **Android 可编译**：Phase 1 的搜索/解析 crate 必须是纯 Rust（`aho-corasick`、`memchr`、
   `comrak`/`pulldown-cmark` 等）。`regex` / `rayon` 目前只在桌面 target 声明；若 Android 也
   要正则查找，需要评估把 `regex` 加入全平台依赖（包体增量实测后再定）。
3. **IPC 体积**：文本内容只传一次；索引留在 Rust，前端拿索引 id/句柄。不要把 per-char
   offset map 通过 JSON 传给前端。
4. **安全**：Rust 产出的任何 HTML 必须用 `ammonia`（或等价 allowlist）清洗，并保留前端
   `rehype-sanitize` 作为第二道防线；allowlist 对齐 `src/lib/markdownRawHtml.ts`。
5. **语义对齐**：查找选项（大小写、整词、正则）与 `src/lib/searchCore.ts` / 现有跨文件
   搜索的语义保持一致；`regex` crate 不支持 lookaround，需像 `search.rs` 一样把编译错误
   回传前端。
6. **测试与基准**：Rust 用 `cargo test`；前端用 vitest；大文件基准只在本机跑，不提交
   用户的剧情文件。提交前 `npm test` + `npm run build` + `cargo test` 全绿。
7. **提交卫生**：当前工作区里另有 `CodeEditor.tsx` / `editorThemes.ts` 的未提交改动，
   与本计划无关；Phase 开始前先把基线 TSX 改动单独提交，避免混在一起。

## 4. Phase 1（推荐先做）：Rust 全文检索索引

### 4.1 目标

大文档预览里 Ctrl+F 时：

- Rust 解析一次 Markdown，得到「**渲染后可见文本** + 到源码偏移的分段映射」；
- 搜索在 Rust 后台线程完成，返回总数与命中项（源码偏移 + 片段）；
- 前端不再为了查找把全文 DOM 载入；导航时只补渲染命中的目标块。

### 4.2 Rust 侧

新增模块（名字待定，建议 `src-tauri/src/md_index.rs`）：

- 依赖：
  - GFM 解析：`comrak` 或 `pulldown-cmark`（开工前用小型 parity fixture 验证表格、任务
    列表、删除线、脚注、行内代码；选支持度更好的那个）；
  - 查找：字面量优先 `memchr` / `aho-corasick`；正则用 `regex`（注意 Android 依赖决策）；
  - 序列化：`serde`（`rename_all = "camelCase"`）。
- 索引结构：
  - `text: String`（投影后的可搜索文本）；
  - `segments: Vec<TextSegment>`：`{ text_start, source_start }`，文本段内与源码 1:1 或
    线性对应即足够把命中起点映射回源码；
  - `hash`、`built_at`、`source_len`，供缓存与 LRU 使用。
- 投影规则（按「渲染后可见文本」设计，逐条写单测）：
  - 标题/列表/引用前缀去掉，文字保留；块之间补 `\n`；
  - `**粗体**`、`*斜体*`、`~~删除线~~`、`` `行内码` ``、`==高亮==`、`^上标^`、`~下标~`
    去掉标记保留内容；
  - 链接保留文字、丢掉目标地址；图片建议丢掉（alt 不显示）；HTML 注释丢弃；
  - 表格保留单元格文字（去掉 `|`）；围栏代码保留代码内容（去掉围栏与 info string）；
  - 脚注、公式、emoji 短代码的语义差异先记录下来（见 4.6），不追求 100% 像素级一致；
  - 原始 HTML 标签：去掉标签、保留可见文字（与预览清洗后的可读内容对齐）。
- 命令接口（草案）：
  ```rust
  #[derive(serde::Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct MdSearchOptions {
      query: String,
      case_sensitive: bool,
      regexp: bool,
      whole_word: bool,
      max_results: usize, // 前端展示上限，total 仍全量统计
  }

  #[derive(serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  struct MdSearchMatch {
      source_start: u32,
      source_end: u32,
      snippet: String,
  }

  #[derive(serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  struct MdSearchResult {
      total: u32,
      capped: bool,
      matches: Vec<MdSearchMatch>,
      index_ms: u32,
      search_ms: u32,
  }

  #[tauri::command] async fn md_index_build(cache_key: String, content: String) -> Result<u32, String>;
  #[tauri::command] async fn md_search(index_id: u32, options: MdSearchOptions) -> Result<MdSearchResult, String>;
  #[tauri::command] fn md_index_release(index_id: u32);
  ```
  - 也可以合并成单命令（内容 + 选项），但如果 build 需要几百毫秒，分开更便于缓存与进度。
- 缓存：
  - `Mutex<HashMap<u32, Arc<MdIndex>>>` + LRU 上限（建议 2~4 份）；
  - `cache_key` 用内容哈希（如 FNV/xxhash）；索引在 Rust 内存中，`md_index_release` 释放；
  - 大文档上限与现有编辑层一致（32MB），超限直接返回错误由前端回退。
- 注册：在 `src-tauri/src/lib.rs` 的 `invoke_handler` 里加三条命令。

### 4.3 前端接入

- 新增桥接（建议 `src/lib/mdSearchBridge.ts`）：
  - `isTauri` 时 `invoke('md_index_build' / 'md_search')`；浏览器/失败时返回 null，
    走现有「补载全文 + DOM 扫描」路径；
  - 按 `content` 哈希缓存 index id，内容变化时释放旧索引。
- `MarkdownPreview`：
  - 仅在 `chunkedPreview && isTauri` 时启用 Rust 查找；
  - 打开查找后后台 build index（不阻塞首屏）；FindBar 显示「正在建立索引…」或复用现有
    百分比 UI；
  - 导航：`sourceStart` → 在 `renderBlocks` 里二分找块（md 块用 `start`，页签组用首个
    section 的 `start`）→ 扩 `visibleBlockCount` 到目标块 → 渲染后滚动到 `data-md-start`；
  - 目标块渲染后，可在该块 DOM 内做一次局部查找并高亮（视觉反馈）；全量高亮不在第一版
    强求，重点是「搜得到、跳得准、计数对」。
- `PreviewFindBar` 扩展：
  - 支持「外部搜索适配器」：`externalCount/current` 由 Rust 结果驱动；
  - 加载/建索引期间禁用导航并显示进度；失败自动回退现有逻辑；
  - 现有小文档路径保持原样（不启用外部适配器）。

### 4.4 验收标准（3.7MB 基准文件）

- [x] 打开查找后首次返回结果 < 1s（不含用户输入时间；build + search 合计）。
      release 实测索引 56ms + 查找 1–2ms。
- [x] 搜索「方舟升上地面了。」total = 1，导航到最后一章且不加载全文 DOM。
      真实桌面应用实测：1/1 并跳到文末；组件测试确认导航前第 40 章未渲染。
- [x] 查找期间窗口可拖动、可滚动，无 >500ms 长任务（用 Performance 面板抽查）。
      真实应用输入/导航全程可交互；索引与查找均在 `spawn_blocking`，未做 Performance
      面板长任务量化。
- [x] 额外 JS 堆 < 50MB；Rust 索引内存可释放。未单独量化 JS 堆：不再补载全文 DOM；
      Rust 索引实测约 6.4MB（按需折叠副本另加），`md_index_release` 可释放。
- [x] 搜索结果与现有 DOM 查找在代表性文档上一致（普通段落、标题、链接文字、代码块、
      `==高亮==`、中文/英文大小写、整词）。已知差异：tab 标签、脚注引用编号、HTML 实体。
- [x] 浏览器/非 Tauri 环境自动回退现有查找，功能不退化。
- [x] `cargo test`、`npm test`、`npm run build` 全绿；Android target `cargo check` 通过。

### 4.5 风险与对策

| 风险 | 对策 |
| --- | --- |
| 投影规则与 remark 扩展（emoji/上下标/高亮）有差异 | 先写 parity fixture；接受并记录可解释的差异，不追求逐字一致 |
| 正则语义与 JS 不一致（lookaround） | 与 `search.rs` 一致：返回编译错误；文档标注限制 |
| Android 包体/依赖 | 先字面量/大小写/整词，regex 仅桌面或评估后再开 |
| 内容 IPC 传输大 | 内容只在 build 时传一次；索引 id 复用；必要时按 mtime+路径缓存 |
| 索引构建 UI 卡顿 | `async` + `spawn_blocking`；前端显示构建进度/可取消 |

### 4.6 待定语义（开工前先定，写进代码注释）

- emoji 短代码：预览会渲染成 emoji，搜索 `smile` 是否应命中 `:smile:`？**已定：不命中**
  （投影时跳过短代码；不做 gemoji 表校验，首字符须为 ASCII 小写字母以避开时间串）。
- 脚注：`[^1]` 在预览里是上标数字，搜索 `1` 是否命中引用？**已定：引用标记不进入投影，
  脚注定义正文照常进入**。
- 图片 alt：预览不显示 alt，**已定：不进入投影**。
- 公式：`$x^2$` 渲染为公式，**已定：保留公式源码文本**，便于定位。

### 4.7 实施记录（2026-11-11）

- Rust：新增 `src-tauri/src/md_index.rs`
  - 解析用 `pulldown-cmark 0.13`（`default-features = false`）：GFM 表格/任务列表/删除线/
    脚注、上下标、公式均为原生事件；`==高亮==` 作为唯一自定义标记在投影后统一剥离。
  - 投影文本按事件区间记录「文本段 → 源码 UTF-16 偏移」；代码/公式/HTML 可见文字标记为
    保护区间，不参与标记剥离。跨事件的 `^2^` 闭标记通过整篇保留区间重建处理。
  - 缓存：FNV-1a 64 内容哈希 + 最多 3 份 LRU；`md_index_build` / `md_search` 走
    `spawn_blocking`，`md_index_release` 释放。内容上限 32MB。
  - 查找：字面量（大小写敏感/ASCII 折叠/完整 Unicode 折叠）、整词、正则（仅桌面，编译
    错误回传前端显示「正则无效」）。
- 前端：新增 `src/lib/mdSearchBridge.ts`；`PreviewFindBar` 增加外部搜索适配器
  （构建中显示「索引中…」并禁用导航，失败自动回退）；`MarkdownPreview` 仅在
  `chunkedPreview && isTauri && !IS_ANDROID_APP` 时启用，导航按源码偏移二分定位块、
  扩渲染后滚动并做块内局部高亮。
- 实测（3.7MB 剧情全本，release）：索引 **56ms**，查找 **1–2ms**；debug 上界
  401ms / 20ms。投影文本 1,156,123 字符 / 130,883 段，索引常驻约 **6.4MB**
  （不含按需构建的 ASCII 折叠副本 ~3.3MB）。JS 侧不再补载全文 DOM。
- 已知差异：tab 标签文字、脚注引用编号、HTML 实体解码不进入/不等价于投影；
  Android 暂不启用 Rust 查找（保持现有补载路径），但 Rust 模块已通过 Android
  `cargo check`。
- 注册坑位：除 `lib.rs` 的 `generate_handler!` 外，本项目还要求把新命令登记进
  `src-tauri/build.rs` 的 `AppManifest::commands` 与 `capabilities/default.json` 的
  `allow-<命令名>`；漏任一处运行时都是 `Command not found`（jsdom 测试测不到）。
- 完善后的真实应用冒烟（dev，3.7MB）：打开查找显示「索引中…」→ 输入
  「方舟升上地面了。」返回 **1** → Enter 跳到文末并橙色高亮；窗口全程可交互。
- 验证：Rust 237 项测试、前端 1579 项测试、`npm run build`、Android target
  `cargo check` 全绿；3.7MB 导航到文末的「不加载全文」行为有组件级回归测试。

## 5. Phase 2（可选，较大）：Rust 解析 + 分块 HTML 只读极速预览

> 只有在 Phase 1 完成后，仍觉得「大文档阅读」不够快，再启动本阶段。
> 目标不是替换小文档预览，而是给大文档一个**显式的只读极速模式**。

### 5.1 方案

- Rust：`comrak`/`pulldown-cmark` 解析 + `ammonia` 清洗（+ 可选 `syntect` 语法高亮），
  输出分块 HTML：
  ```rust
  struct MdHtmlChunk { start: u32, end: u32, html: String }
  #[tauri::command] async fn md_render_chunks(content: String, cache_key: String) -> Result<Vec<MdHtmlChunk>, String>;
  ```
  - 内容大时可分页/按需请求单块，避免一次 IPC 传全部 HTML；
  - 复用 Phase 1 的内容哈希缓存与后台线程。
- 前端：新增 `LargeMarkdownHtmlPreview`：
  - 复用现有分块懒加载/大纲跳转；
  - 每块 `dangerouslySetInnerHTML`；
  - 明确横幅「极速预览（只读）」+「切换到完整预览」按钮（完整预览仍走当前 React 路径，
    可能较慢，但交互齐全）；
  - 大文档默认用极速模式还是保持现状，做成设置项或首次提示（待定）。

### 5.2 功能回退范围（第一版建议）

极速只读模式**暂不提供**：

- 表格可视化编辑（增删行列/单元格编辑）；
- 页签组的可视化增删改（仍按当前选中页签静态渲染，可切换）；
- Mermaid 编辑、图片查看器/右键菜单、任务勾选回写、预览右键格式化。

保留：标题/段落/列表/表格静态展示、链接（本地 .md 链接仍走现有导航守卫）、代码块
静态展示、脚注/删除线等 GFM 静态效果。预览内查找接 Phase 1 索引：导航到目标块并做
块内高亮（已实现），不要求全量高亮。

图片：第一版可只支持 http(s) 远程图；本地图片需要前端在插入 HTML 后扫描 `img` 并复用
`resolveImageSrc` 换 blob URL——若做，单独列子任务。

### 5.3 验收

- [x] 3.7MB 首块 HTML 返回 < 200ms；滚动加载流畅；Rust 解析内存可释放。
      debug 实测首块 24k 字 15ms、8 块批量 117ms；HTML 只在 Rust 侧临时存在，
      JS 缓存上限 120 块；真实应用滚动/跳转流畅。
- [x] HTML 无脚本/事件属性/危险协议（用 XSS fixture 验证）。`ammonia` 单测覆盖
      script/onerror/javascript:/style/iframe/svg 等。
- [x] 小文档完全不受影响；极速模式只在用户明确选择/大文档阈值以上启用。
- [x] 与完整预览的静态文本内容一致（抽样对比）。已知差异见 §5.5。

### 5.4 风险

- 组件体系迁移成本高，交互回退需要用户预期管理；
- KaTeX/Mermaid 仍是 JS，Rust HTML 里需保留占位或降级；
- 清洗 allowlist 与前端必须同源维护，否则出现「完整预览能显示、极速预览不显示」。

### 5.5 实施记录（2026-11-11）

- Rust：新增 `src-tauri/src/md_render.rs`
  - `pulldown-cmark`（`html` feature）渲染 + `ammonia` allowlist 清洗；allowlist 对齐
    `markdownRawHtml.ts`（u/mark/font/big/input 等，mark 只留 `md-mark-*`、code 只留
    `language-*`；script/style 连同内容丢弃；url 协议用 ammonia 默认白名单）。
  - 批量命令 `md_render_html_chunks`（单次 ≤16 块 / 2MB，`spawn_blocking`），
    前端一次取 8 块。
- 前端（`MarkdownPreview.tsx`）
  - 大文档预览顶部常驻「极速预览（只读）」入口；进入后按可见窗口批量取 HTML，
    `dangerouslySetInnerHTML` 渲染；页签仍可切换，只读禁用表格编辑/右键菜单/任务回写。
  - **共享窗口渲染**：查找与大纲跳转只渲染目标附近（前 8 块 + 目标），完整预览与
    极速预览共用窗口；跳文末不再铺满整篇，二者切换不丢位置。
  - 查找接 Phase 1 索引：目标块 HTML 优先取回，导航后按命中 Range 精确居中并高亮。
- 实测（3.7MB 剧情全本）：真实桌面应用点击入口 → 输入「方舟升上地面了。」→ 1/1，
  跳到文末命中行并橙色高亮；窗口化后只渲染目标附近 9 块；表格/页签静态、远程图片可用。
- 已知差异：`==高亮==` 与词内 `^上标^`/`~下标~` 在极速模式按源码文本显示；
  Mermaid/KaTeX 为静态代码/公式源码；本地图片不加载（首版只支持 http(s)）；
  脚注跨块引用不建锚。完整预览行为不变。
- 注册：命令同时登记 `lib.rs`、`build.rs`、`capabilities/default.json`（三处缺一即
  运行时 `Command not found`）。
- 验证：Rust 249 项测试、前端 1584 项测试、`npm run build`、Android target
  `cargo check` 全绿。

## 6. Phase 3：索引/解析缓存与后台预热

- 打开 Markdown（>15 万字符，仅 Tauri 环境）后，在后台触发 `md_index_build`（Phase 1）
  或首批 HTML（Phase 2），用户按 Ctrl+F 时直接命中缓存；
- 缓存键：内容哈希（+ 解析器版本/allowlist 版本）；LRU 上限按文档大小限制（例如最多
  保留 2 份大文档索引）；
- 标签关闭/文档切换时释放对应索引；不要把多标签的大索引常驻内存；
- 可选磁盘缓存（按哈希存 projected text/index），第一版不建议做，先做内存 LRU；
- 验收：同一文档第二次查找 < 100ms；首次打开无可感知额外卡顿；编辑后索引失效正确。

## 7. 相关文件索引

| 文件 | 作用 |
| --- | --- |
| `src/lib/markdownChunks.ts` | 大文档按标题分块、`buildLargePreviewBlocks` |
| `src/components/MarkdownPreview.tsx` | 分块懒加载、共享窗口、极速预览、查找补载 |
| `src/components/PreviewFindBar.tsx` | 预览查找 UI、外部搜索引擎适配 |
| `src/lib/mdSearchBridge.ts` | 前端 ↔ Rust 索引/HTML 渲染桥接 |
| `src/lib/markdownRawHtml.ts` | HTML 白名单、`hasRawHtml` |
| `src/lib/remarkExt.ts` | 扩展语法、注释移除 |
| `src/lib/searchCore.ts` | 现有查找选项语义（大小写/正则/整词） |
| `src-tauri/src/md_index.rs` | Rust 全文检索索引（投影/映射/缓存/查找） |
| `src-tauri/src/md_render.rs` | Rust Markdown → 安全 HTML（极速预览） |
| `src-tauri/src/lib.rs` | Tauri 命令注册 |
| `src-tauri/build.rs` | 命令 ACL 清单（新增命令三处登记之一） |
| `src-tauri/capabilities/default.json` | 命令权限（新增命令三处登记之一） |
| `src-tauri/src/search.rs` | 现有跨文件搜索（rayon/正则/进度/取消可复用） |
| `src-tauri/src/large_file.rs` | 32MB+ 大文件窗口读取（**与 Markdown 预览分流无关**） |
| `src-tauri/Cargo.toml` | 依赖与 target 分级 |

## 8. 下一会话启动提示（可直接复制）

```text
先读 docs/large-markdown-rust-plan.md，特别是「1. 现状基线」和「4. Phase 1」。
本次只做 Phase 1：Rust 全文检索索引 + 大文档预览查找接入。
要求：
- 先单独提交/确认基线 TSX 改动，不要夹带 CodeEditor/editorThemes 的无关改动；
- 完成后跑 cargo test / npm test / npm run build，并用 3.7MB 基准文件实测
  首次结果耗时、额外内存、窗口是否可交互；
- 给出改动文件清单和实测数据后停下，不要开始 Phase 2。
```
