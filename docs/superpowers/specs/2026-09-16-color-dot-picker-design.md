# 代码内联颜色圆点 + 轻量取色器 — 设计文档

日期：2026-09-16
状态：已与需求方逐项确认

## 背景与目标

H.I.D.E 的代码编辑目前对颜色值没有任何可视化：CSS/JSON/SVG/前端源码里的 `#4ec9b0`、`rgba(…)`、`hsl(…)` 只是普通文本，改颜色全靠脑内换算。目标是在颜色字面量旁边内联显示一个**该颜色的小圆点**，点击圆点弹出**轻量取色器**，拖动调色时**实时写回源码**。

产品定位约束：零新依赖，取色器手写（约 200 行）；不追求成为设计工具，只覆盖高频颜色写法。

## 需求清单（已确认）

| 项 | 结论 |
|---|---|
| 识别格式 | Hex（`#abc` / `#abcd` / `#aabbcc` / `#aabbccdd`）+ `rgb()/rgba()` + `hsl()/hsla()`（逗号写法与现代空格写法、百分比参数均支持）；命名颜色（red、blue…）不做 |
| 取色器 | 自制轻量浮层：饱和度/亮度色块 + 色相滑条 + 透明度滑条 + Hex 输入框（含 alpha），零依赖 |
| 写入时机 | 拖动时实时写入文档，一次连续拖动在撤销历史中合并为一条记录 |
| 圆点位置 | 颜色值**前面**内联插入（VS Code 惯例） |
| 适用范围 | 所有走 CodeEditor 的代码文件（含 markdown 代码块、SVG 源码）；纯正则识别，不依赖语法树 |
| 开关 | 设置项「颜色标记」，默认开启 |

## 一、架构与数据流

核心原则：**识别是视口级纯函数扫描，写入是普通文档事务**——与大文件策略、撤销/重做、脏标记、diff 时间线全部自然复用。

```
文档变更 / 视口滚动
   │ ViewPlugin（仅扫描可见视口行）
   ▼
colorLiteral.findLiterals(lineText)  ← 纯函数，正则
   │ {from, to, rgba}[]
   ▼
Decoration.widget(ColorDotWidget)  → 行内圆点（背景 = 颜色）
   │ 点击圆点（domEventHandlers 命中）
   ▼
React 浮层 ColorPickerPopover（定位 = coordsAtPos）
   │ 拖动 onChange(rgba) → serializeColor() 保持原格式
   ▼
view.dispatch({ changes: {from, to, insert} })  → 文档 → 重扫描 → 圆点同步
```

### 新增模块

- `src/lib/colorLiteral.ts`：文档层纯函数。
  - `findColorLiterals(text): ColorLiteral[]` — 正则找出全部颜色字面量（偏移 + 解析结果）。
  - `parseColorLiteral(text): Rgba | null` — 单个字面量解析为 `{r, g, b, a}`（0–255 / 0–1）。
  - `serializeColorLiteral(rgba, style): string` — 按原写法格式家族回写（见下）。
- `src/lib/colorMath.ts`：色彩空间纯函数。RGB↔HSV 转换、色块坐标↔SV 值、滑条位置↔色相/alpha、CSS 颜色字符串生成。
- `src/components/colorDotExtension.ts`：CM6 扩展。`ViewPlugin`（视口扫描 + 装饰集维护）、`ColorDotWidget`（12px 圆点 DOM）、`domEventHandlers`（点击命中 → 回调 `{view, from, to}`）。
- `src/components/ColorPickerPopover.tsx`：受控浮层组件，props 为 `{rgba, onChange, onClose}`，不直接碰文档。
- `CodeEditor.tsx`：接线层——挂扩展、管理浮层状态与颜色区间、dispatch 写回（撤销分组）。

### 关键机制

- **视口级扫描**：ViewPlugin 在 `docChanged` / `viewportChanged` 时 rAF 去重后重扫 `view.visibleRanges`。成本只随可见行数增长，大文件（lowPerf）同样保持开启。
- **格式保留序列化**（`serializeColorLiteral`）：
  - 格式家族不变：`rgb()` 不会变成 `rgba()`、hex 不会变成函数式；hex 大小写跟随原值。
  - hex 位数：原 3/4 位且新颜色恰好可表达为 3/4 位时保持短写，否则就近扩为 6/8 位；原 6/8 位保持位数。
  - alpha 规则：原值不带 alpha 且新 alpha = 1 → 原样位数；原值不带 alpha 但 alpha 调至 < 1 → 升级为带 alpha 的同家族写法（`#rrggbb`→`#rrggbbaa`、`rgb()`→`rgba()`、`hsl()`→`hsla()`）；原值带 alpha 则始终保留 alpha 槽（= 1 时写 `1` / `ff`）。
  - 数字用规范间距（`rgb(12, 34, 56)`、现代写法 `rgb(12 34 56 / 0.5)`），原有奇葩空格被规范化（VS Code 同款行为）。
- **实时写入 + 撤销合并**：拖动中的每次 `onChange` 都 dispatch 文档事务（`userEvent: 'input.color'`）。撤销分组走应用层 `tabHistory` 的 800ms 连击合并（实现期确认：应用撤销不走 CM 内置 history，而是自管内容快照栈）——拖动首帧经由 markdown 格式化同一套 `majorNextRef` 标记 `major` 强制独立成条（避免并进此前的打字条目），后续帧间隔远小于 800ms，自然并入同一条 Ctrl+Z。
- **浮层定位与跟随**：打开时用 `view.coordsAtPos(from)` 定位（贴圆点下方，边缘翻转）；通过既有 `subscribeViewUpdate` 订阅几何变化重新定位；浮层打开期间编辑器内 Escape / 点击浮层外关闭。
- **区间失效防护**：浮层持有 `{from, to}`，文档事务后经 `tr.changes.mapPos` 重映射；重映射后内容不再是可解析颜色 → 自动关闭浮层。
- **只读模式**：`editable=false` 或 `readOnly` 时圆点照常展示（纯信息），点击不弹取色器。

## 二、交互细节

- 圆点 12px、圆形、与文本基线对齐；深浅主题下均有 1px 半透明描边，纯白/纯黑颜色也可辨识。
- 取色器浮层宽约 220px：SV 色块（160×120）+ 色相滑条 + alpha 滑条（棋盘格底纹）+ Hex 文本框（`#rrggbb[aa]`，可输入回车生效，非法输入不动）；配色随 `isDarkMode`。
- alpha 滑条始终显示；未动 alpha（= 1）时序列化不改变原格式（见上）。
- Hex 输入框支持 3/4/6/8 位，输入即实时写回。
- markdown 预览 / 网格视图 / 只读查看器不受影响；换行折叠区内的颜色不显示圆点（不可见区域不扫描）。

## 三、设置项与 i18n

- `settings.ts`：`EditorSettings` 新增 `colorDecorations: boolean`（默认 `true`），`normalizeSettings` 布尔校验回退，模式照抄 `minimap`。
- SettingsDialog 新增复选框（开关即时生效：走 CodeEditor 既有 `editorSettings` 依赖重建 extensions 的路径）。
- i18n：设置项文案、取色器 aria 标签补 zh/en 两份。

## 四、测试

- `src/lib/colorLiteral.test.ts`：识别（各格式、误报边界如 `#ifdef`、字符串内嵌 hex）、解析精度、序列化保格式（大小写/位数/家族/alpha 升级与保留、规范间距）。
- `src/lib/colorMath.test.ts`：RGB↔HSV 往返、边界值（0/360/纯灰）、坐标换算钳制。
- 扩展与浮层：构建通过 + 手动验收（浅/深主题、大文件滚动、拖动撤销、只读、区间失效）。

## 五、明确不做（YAGNI）

- 命名颜色（148 个 CSS 颜色名）——误报风险高、价值低。
- 取色器里的 HSL/RGB 分通道输入、取色吸管、最近使用颜色、调色板收藏。
- 小地图里的颜色着色、预览侧的颜色下划线。
- `color()` / `lab()` / `oklch()` 等新色彩空间函数。
