# v1.4 安卓触屏交互层设计

> 日期:2026-09-20。主题:安卓从「能看」到「能用」(ROADMAP v1.4,条目 37/38/39;条目 40 平台评估拆出本主题)。
> 适配规范依据:desktop-to-android 技能(触控目标 ≥48dp、hover/右键/快捷键必须有触屏等价物、拖拽必须给非拖拽替代)。

## 1. 背景与问题定位

现状是「桌面 UI + 手指戳」:布局壳已按设备分流,但**交互层完全按鼠标设计**。关键证据:

- `src/lib/platform.ts:6-18`:`IS_ANDROID_APP`(UA 判定)、`IS_TOUCH_PRIMARY`(`pointer: coarse`)、`NARROW_QUERY`(768px)——检测齐备,但 `IS_TOUCH_PRIMARY` 全仓只有 3 处使用(TabBar 禁拖拽/常显关闭钮、快捷键弹窗 Cmd 显示),交互层没有消费它。
- `src/App.tsx:126`:`isPhone = IS_ANDROID_APP && isNarrow` → **平板(≥768px)渲染完整桌面壳**:36px 高菜单栏、`p-1.5` 图标按钮(触点 ≈27px)、桌面密度状态栏。
- 右键菜单是核心交互:**12 个文件**挂 `onContextMenu`(App/CodeEditor/CsvGridEditor/ContextMenu/FileTreeSidebar/ImageViewer/MarkdownOutline/MarkdownPreview/MarkdownTools/TabBar/SvgWorkbench/SvgCanvas),安卓触屏无右键。
- 全仓 **0 处 onTouchStart**;双击交互 6 处;滚轮缩放 3 处(ImageViewer/SvgWorkbench/SvgCanvas);CSV 列宽/行高/重排/填充柄全是 `onMouseDown` 热区(v1.3.3 批次,纯鼠标)。
- `ContextMenu.tsx:28-29`:行高 30px、面板宽 216px、字号 xs——触屏点不中。
- 已有移动端骨架(本设计的地基):`src/components/mobile/` 四件套(TopAppBar h-12 / BottomToolbar 52px / Sheet / TabSheet)、safe-area 双通道(MainActivity 注入 CSS 变量 + env() 回退,`index.css:92-98`)、viewport `interactive-widget=resizes-content`(`index.html:5`)、`useMediaQuery` 钩子、`useDragScroll` 已正确绕开触屏(`src/hooks/useDragScroll.ts:37`)。
- Kotlin 桥(`src-tauri/gen/android/.../MainActivity.kt`):已有 `openDocs/createDoc/writeUri/openTree/listTree/exitApp/openUrl/renderPage`;**缺树上 renameDocument/deleteDocument/createDocument**,`fileOps.ts:14` 的 `treeManageAvailable = isTauriRuntime && !IS_ANDROID_APP` 把文件管理锁在桌面。

## 2. 架构决策(用户已拍板)

1. **触屏交互层由 `IS_TOUCH_PRIMARY` 驱动,手机与安卓平板共用同一套**(长按菜单/48dp 触点/捏合缩放/触觉反馈)。
2. **布局层维持现状**:<768px 手机壳;≥768px 平板/桌面壳。平板 = 桌面布局 + 触屏交互。
3. Tailwind v4 的 `hover:` 变体默认带 `(hover: hover)` 媒体查询,触屏自动不生效;手写 `:hover` 规则(文件树长名滚动等)手工包进 `@media (hover: hover)`。
4. 有意偏离技能一处:保留 `user-scalable=no`(编辑器类应用防手势冲突惯例),无障碍以 1.3× 字体缩放实测兜底;捏合缩放在查看器组件内自实现,不开放页面级缩放。

## 3. 类级映射表(桌面 → 触屏)

| 桌面交互 | 触屏替代 | 落点批次 |
| --- | --- | --- |
| 右键菜单(12 处) | 长按 500ms 弹同一菜单(共用 openMenu),菜单行高 ≥44 | 一(非CSV)/四(CSV) |
| hover 才显关闭钮等 | 常显(TabBar 已做,推广到其余) | 一 |
| 文件树长名 hover 滚动 | 触屏禁用(截断显示) | 一 |
| 编辑器右键菜单 | 触屏不弹自绘菜单,放行系统长按选择/复制/粘贴 | 一 |
| JSON 树双击复制 | 行内常驻复制按钮 | 一 |
| 滚轮缩放(图片/SVG) | 双指捏合缩放 + 单指平移;双击 1:1 保留 | 三 |
| SVG 中键拖动平移 | 单指拖动平移 | 三 |
| CSV 拖拽重排/列宽/行高/填充柄 | 长按表头/行号菜单(移动 ±/自适应/重置/填充),填充柄触屏隐藏 | 四 |
| CSV 双击进编辑 | 单击选中、再击同格进编辑 | 四 |
| Ctrl 多选 | 菜单「全选本列/本行/全部」(从简) | 四 |
| Alt+Enter 单元格换行 | 编辑栏「换行」按钮 | 四 |
| 键盘快捷键 | 手机 BottomToolbar(已有,按内容类型扩组);物理键盘保留快捷键 | 一/四 |
| 文件树(手机无入口) | Sheet 抽屉承载 FileTreeSidebar,图片查看入口随之回归 | 二 |
| SAF 树上管理 | Kotlin 三桥 + fileOps 放开 + 确认弹窗复用 | 二 |

## 4. 批次计划

### 批次一:触控基建 + 共享组件(地基,两端同时受益)

- `src/hooks/useLongPress.ts`:pointer 事件实现;500ms 阈值,移动 >10px / pointerup / pointercancel / 第二指按下 / 容器滚动 即取消;仅响应 `pointerType !== 'mouse'`;触发时 `navigator.vibrate(10)`(try/catch 包裹)。返回与现有 `onContextMenu` 可并存的 handlers。
- `ContextMenu.tsx` 触屏变体:`IS_TOUCH_PRIMARY` 时行高 ≥44、字号 sm、面板宽 280,位置仍按触发点夹紧视口;外点关闭/滚动关闭逻辑复用。
- 长按接线(非 CSV、非查看器全部右键面):TabBar、FileTreeSidebar、MarkdownPreview、MarkdownTools、MarkdownOutline、JsonTreeViewer、App 级。CSV(批次四)与查看器(批次三)除外。
- 编辑器例外:`CodeEditor.tsx` 的 `handleEditorContextMenu` 在 `IS_TOUCH_PRIMARY` 下直接放行(不 preventDefault、不开自绘菜单),系统文本选择菜单可用。
- 共享层触点扫描(视觉可微涨、命中区必须 ≥48×48、相邻不重叠):菜单栏按钮(h-9 → 触屏 h-11/h-12)、TabBar、FindReplaceBar、Dropdown、各弹窗底部按钮、桌面状态栏。
- hover 隔离:`index.css` 手写 `:hover` 包 `@media (hover: hover)`;`onMouseEnter/Leave` 仅 2 处(App/FileTreeSidebar),逐个处理。

### 批次二:手机端补齐 + SAF 文件管理 + 签名(ROADMAP 37/38/39)

- 文件树抽屉化:手机端文件树开关把现成 `FileTreeSidebar` 装进现成 `Sheet`;图片查看器入口随之回归。
- 状态栏精简:手机只留编码/换行/读写态等关键项,详情收进长按(盘点后定稿)。
- SAF 桥:`MainActivity.kt` 新增 `renameDocument/deleteDocument/createDocument`(树上,经 treeUri+relPath 解析 document URI);`fileOps.ts` 放开 `treeManageAvailable` 为双端;FileTreeSidebar 菜单安卓点亮,删除复用 ConfirmDialog,提供器拒绝走通知卡片。
- release 签名:keystore 本地保存不入库 + 安卓签名配置 + 恢复 CI `android-release` 任务(移除 `if: false`,d43e8f0 暂停项)。

### 批次三:查看器触屏化

- `usePinchZoom`:双指缩放(锚点=双指中心)、单指平移;ImageViewer 接入(替代滚轮),双击 1:1 保留。
- SvgWorkbench/SvgCanvas:单指拖=平移(替代中键)、双指=缩放(替代滚轮),点选/拖拽移动元素不变(编辑模式点选优先于平移)。
- LargeFileViewer/HexViewer 原生滚动已可用,仅触点扫描。

### 批次四:CSV 网格触屏化(最重)

- 表头/行号长按菜单:排序/左移右移(上移下移)/列宽±/自适应/重置/行高/插入/删除——「拖拽必须给非拖拽替代」的落点;填充柄触屏隐藏,菜单补「向下填充/循环填充」。
- 编辑流:单击选中、再击同格进编辑(防误触);编辑栏补「换行」按钮(替代 Alt+Enter)。
- 多选从简:菜单「全选本列/本行/全部」。
- 手机 BottomToolbar 按 CSV 内容类型切换按钮组(插入行列/自适应/换行开关)。

### 批次五:收尾

- 模拟器全量复测(每批的涉及面在当批已按§5 实测过,此处全屏过一遍):手机 AVD + 平板 AVD,x86_64 debug 构建;逐屏 `ui_describe` 读 bounds 验 ≥48dp;`font_scale 1.3` 复测破版;主流程实点。
- 返回键:优先关闭最上层浮层(Sheet/菜单),无浮层保持现状防误退。
- 全局审计:hover/右键/快捷键残留全局搜;ROADMAP 补记;v1.4.0 发版 Ritual(五处版本号+发行说明)。

### 交付状态(2026-09-21 复核,以代码与实测为准)

本文件是计划稿,批次三/五当初的记述与实际不符,补此对照以免后续会话误读:

- 批次一、二、四:与计划一致(批次四的「编辑栏补换行按钮」以长按菜单的行高步进替代路径落地)。
- 批次三:`usePinchZoom` + ImageViewer ✅;SvgCanvas ✅(空白单指平移、双指捏合,元素拖拽优先);
  **SvgWorkbench 预览面板当时未做**(仍是 `onMouseDown` 中键 + `wheel`,平板不可用),
  于 v1.4.0 发布前补上(单指平移 + 双指捏合 + 触屏触点档:检查面板/取色器/缩放工具条/分隔条)。
- 批次五:全量复测与发版 Ritual 随 v1.4.0 完成;明确遗留见下。

遗留(未做,非做了但坏):Markdown 表格行列的 hover 线条手柄无触屏出口;源码编辑器行号槽
触屏版整体未接(`if (!IS_ANDROID_APP)` 关闭);平板标签关闭钮 28×28(扩到 48 会与邻标签重叠,
替代为长按标签);SVG 元素位置无步进按钮(桌面靠方向键)。

## 5. 验收标准(每批)

1. vitest + tsc + 前端构建全绿(纯函数/钩子按仓库惯例 TDD)。
2. 模拟器实测:涉及面所有可点元素 bounds ≥48×48px(viewport scale=1,CSS px = dp),相邻命中区不重叠。
3. `font_scale 1.3` 布局不破版。
4. 桌面回归:鼠标路径行为零变化(触屏分支全部由 `IS_TOUCH_PRIMARY`/`isPhone` 门控)。
5. 技能完成清单:hover/右键/快捷键依赖无残留(全局搜)、无死路页面、主流程实点过。

## 6. 风险与已知怪癖

- **WebView 长按与 contextmenu**:Chrome/WebView 对文本长按会触发原生选择,自定义长按必须 `select-none` 的元素上使用(表头/行号/树行/标签,均已或将设 select-none);编辑器内容区明确让位系统(批次一例外项)。
- **IME 组合输入**:CM6 与 textarea 编辑期间不重写 DOM——本设计不触碰编辑器输入管线,仅菜单/触点层。
- **触觉反馈**:`navigator.vibrate` 在 WebView 需用户手势上下文,长按回调内调用满足;不支持时静默。
- **命中区扩展不重叠**:伪元素扩命中只在元素间有间距处用;密集排布处(菜单栏)直接涨视觉尺寸(触屏 h-11/h-12)。
- **桌面回归风险**:所有触屏分支门控于 `IS_TOUCH_PRIMARY`(交互)与 `isPhone`(布局),浏览器触屏(如 Surface)也会走触屏分支——视为正确行为(pointer: coarse 本就是触屏)。

## 7. 明确不做

Material 主题改造、第三方手势库(自实现长按/捏合,零新依赖)、平板专属双栏布局、iOS、页面级捏合缩放(user-scalable 维持 no)。
