# 启动性能后续优化：主 bundle 瘦身（懒加载 Markdown 渲染栈）

> 状态：**待启动的需求**（2026-09-18 记录）。当日启动时序修复（窗口按需显示）上线后，
> 用户确认启动速度已可接受，本文档仅记录后续若要继续压缩「窗口出现时间」的实现路径，
> 无排期承诺。

## 背景

启动链路现状（v1.3.1 后）：主窗口以 `visible: false` 创建（`src-tauri/tauri.conf.json`），
前端完成会话恢复后调 `show()`（`src/App.tsx` 启动效果），看门狗兜底
（`src-tauri/src/lib.rs` / `windows.rs`）。白屏与空界面闪帧已消除，但「窗口出现」的绝对
时间仍取决于三段串行耗时：

1. WebView2 进程初始化（平台成本，基本不可压）；
2. **主 bundle 的下载解析与执行**（本文档目标，冷启动约数百毫秒）；
3. 会话恢复 IPC 读盘（已并行化，量级小）。

## 现状数据（2026-09-18，dist 实测）

| chunk | 体积 | 加载时机 |
| --- | --- | --- |
| `index-*.js` | ~2.5 MB | **主包，首帧前必须执行** |
| `elk-*.js` | ~1.5 MB | 懒（mermaid 布局引擎，按需） |
| `index-*.js`（次） | ~974 KB | 随主包（推测为共享依赖，如 CodeMirror state/view） |
| `cynefin-*.js` | ~688 KB | 懒（mermaid） |
| `mermaid.core-*.js` | ~669 KB | 懒（mermaid） |
| `cytoscape.esm-*.js` | ~444 KB | 懒（mermaid） |
| `katex-*.js` | ~261 KB | **疑似随主包**：`MarkdownPreview` 静态 import `rehype-katex`，katex 因被静态图与懒加载图（`lib/markdownHtml`）共享而拆成独立 chunk，但很可能首帧前就被拉取执行 |

主包 2.5 MB 的构成没有做过精确测量，**动手前第一步应接 `rollup-plugin-visualizer`
拿准确占比**。已知的高占比嫌疑（按依赖关系推断）：

- `react-syntax-highlighter`（Prism/refractor 全语言集）——仅 `MarkdownPreview` 使用；
- `react-markdown` + remark/rehype/micromark 全家桶（gfm/math/emoji）——仅 Markdown
  预览与 `lib/markdownHtml`（已懒）使用；
- `katex`——随 `rehype-katex`；
- react-dom、`@uiw/react-codemirror`（CodeMirror 核心）、lucide 图标等启动必需项，
  不可懒。CodeMirror 各语言包已是独立懒 chunk（`src/lib/codemirror.ts`），不占主包。

## 关键原则：只拆不懒没有收益

Tauri 的前端资产在本地磁盘，没有网络往返；`manualChunks` 拆分既不减少总字节数也不减少
总解析量（所有 chunk 仍会在首帧前执行）。**唯一有效的手段是懒加载（dynamic import），
把非启动路径的解析与执行推迟到真正用到时。**

## 候选项（按预期收益排序）

1. **`MarkdownPreview` 整体 `React.lazy`**：markdown 渲染栈（react-markdown、
   remark/rehype 系、react-syntax-highlighter、katex 及其 CSS）只在预览真正渲染时加载。
   `MarkdownPreview` 目前被 `App.tsx` 静态 import，是主包最大单一来源。
   配套两点：
   - Suspense 占位用主题底色（与 `index.html` 内联脚本一致），避免预览区闪白；
   - 首帧后 `requestIdleCallback(() => import('.../MarkdownPreview'))` 预热——
     上次会话激活标签是 markdown 预览时，不让用户感知到二次加载。
2. **`react-syntax-highlighter` 换 `PrismLight` + 按需注册语言**：即便不整体懒加载，
   从全语言集缩到常用语言集也能显著减体积；需对照现有文档高亮实际用到的语言清单。
3. **其余低频依赖按调用点懒加载**：`turndown`（HTML→MD 转换）、`js-yaml`、`defuddle`
   （网址导入）等，逐个确认调用点后改 `import()`。
4. **压缩审计**：确认 vite 产物在 NSIS 包内是否被再压缩（updater 侧已有 zip 压缩，
   本地加载的收益主要是更少的磁盘读取，量级小，优先级最低）。

## 验证与回归风险

- 度量：`rollup-plugin-visualizer` 产物 `stats.html` 对比改造前后主包体积；
  启动到 `show()` 的耗时可在 App 启动效果里打点（`performance.now()`，仅调试构建输出）。
- 回归面：markdown 预览首次打开的白屏占位、预览内 KaTeX/mermaid/代码高亮功能不回退、
  `lib/markdownHtml`（导出 HTML）与 `MarkdownPreview` 的共享依赖关系变化后仍正常、
  会话恢复到 markdown 激活标签的路径（懒加载与恢复竞态）。
- 测试：`MarkdownPreview` 相关用例（`*.test.tsx`）在 vitest + jsdom 下需适配
  `React.lazy` 的异步渲染（`act` + `waitFor`）。

## 决策记录

- 2026-09-18：启动时序修复落地（见当日 feat/perf 提交），用户确认启动速度可接受；
  本项作为按需启动的后续优化记录在案，有需求时按上述顺序实施。
