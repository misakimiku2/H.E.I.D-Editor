# 安卓：从外部应用「打开方式」选 H.I.D.E，文档并没有被打开

记录于 2026-09-22 · 目标版本 v1.4.2 · **已于 v1.4.2 修复**（修复记录见文末）

## 现象

在文件管理器 / 其他应用里对 `.txt` `.md` `.json` 等文件选「打开方式 → H.I.D.E」，
H.I.D.E 被拉起，但只是正常启动到上次的界面，那个文件没有打开。

## 根因

**入向 intent 从来没被消费过。**

- `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 声明了 4 组
  `ACTION_VIEW` + `CATEGORY_DEFAULT/BROWSABLE` 的 intent-filter（`text/plain`、
  `application/json`、`application/xml`、`image/svg+xml` + `.txt/.log/.md` 路径匹配），
  所以应用**能出现在系统「打开方式」列表里**。
- `src-tauri/gen/android/app/src/main/java/com/nexus/editor/MainActivity.kt` 里唯一的
  `ACTION_VIEW` 在第 284 行，是**往外**打开链接用的；`onCreate` 不读 `intent.data`，
  也没有 `onNewIntent` 覆写。前端侧同样没有任何接收入口。

即：系统把 URI 递过来了，我们没接。

## 第二条根因（2026-09-23 装机实测时才发现，比第一条更挡路）

**「打开方式」列表里很多情况下根本没有 H.I.D.E**——不是选了没反应，是压根不出现。

Android 匹配 intent-filter 时**只看提供方报出的 MIME，扩展名不参与**
（`<data android:pathPattern>` 在有 MIME 的前提下不构成额外门槛，实测数字型 MediaStore URI
`content://media/external/file/1000000038` 配 `text/plain` 照样命中）。
自动生成的那 5 组 filter 只声明了 `text/plain`、`text/html`、`application/xml`、
`application/json`、`image/svg+xml`，而系统实际报出的类型是：

| 文件 | 提供方报出的 MIME | 修复前是否出现 |
| --- | --- | --- |
| `.txt` | `text/plain` | ✅ |
| `.md` | `text/markdown` | ❌ |
| `.py` | `text/x-python` | ❌ |
| `.csv` | `text/csv` | ❌ |

实测手段：`cmd package query-activities -a android.intent.action.VIEW -t text/markdown …`
修复前 0 条命中；在模拟器 Files 里点 `.md` 也确实在原地不动（没有任何应用能接）。

修法：在自动生成标记**之外**补一条手写 `intent-filter`，声明 `text/*` 通配
（VIEW + SEND + SEND_MULTIPLE）。刻意不带 pathPattern，也不带 BROWSABLE。
放在标记外是必须的——`tauri android build` 每次都会重写标记之间的内容
（历史上还观察到它轮换那 5 组 MIME 的顺序）。

## 与 v1.4.1 那条发行说明的关系

`106edc3`「轮换 MIME 类型配置」调整的是 intent-filter 里 MIME 的声明顺序，影响的是
**列不列得出来**，与「选了能不能打开」无关。v1.4.1 已发布，正文里那句
「修复了部分设备上系统『打开方式』里选不到 H.I.D.E 的问题（文件关联）」按上述口径理解才成立。

## v1.4.2 要做的

1. Kotlin 侧：`onCreate` 读 `intent.data`、覆写 `onNewIntent`（应用已在前台时也要能开），
   对拿到的 document URI 走 `takePersistableUriPermission`，经既有 `heid-saf` 事件通道
   （或新增一个启动参数查询命令）交给前端。
2. 前端侧：收到启动 URI 后按 SAF 路径复用现在的「打开文件」链路，注意与恢复的会话标签共存、
   以及冷启动时前端还没 ready 的时序。
3. 顺带定一下：同一文件重复打开、以及从外部打开时文件树根目录是否跟随。

## 修复记录（v1.4.2，2026-09-23）

### 计划里那条「覆写 onNewIntent」做不到

生成的 `TauriActivity.onNewIntent`（`gen/android/app/src/main/java/com/nexus/editor/generated/`）
是 `override fun` 不带 `open`，即 **final**，`MainActivity` 覆写会编译失败。
改挂 `androidx.activity` 的 `addOnNewIntentListener { … }`（`ComponentActivity` 提供，
链上 WryActivity / TauriActivity 都调了 `super.onNewIntent`，回调一定到）。

### 没有复用 `heid-saf`，改成「队列 + 取走」

- 原生侧把收到的条目压进 `launchFiles` 队列，前端调 `HeidBridge.takeLaunchFiles()`
  **一次性取空**（返回 JSON 数组，元素为 `{uri,name}` 或 `{text}`）；
  同时派发 `heid-view` 事件催已在前台的前端再取一次。
- 队列是唯一事实源、取走即清 → 冷启动（事件必然丢）与热启动共用一条路径，
  React StrictMode 下 effect 跑两遍也不会把文件打开两次。
- **刻意不借用 `heid-saf` 通道**：`androidPickFiles()` 等调用方是「加一个一次性监听器等回包」，
  任何非 `kind:'open'` 的事件都会让它 `resolve(null)`——凭空冒出的外部打开事件会把用户
  正开着的文件选择器取消掉。

### 两条口径（原第 3 点）

- **同一文件重复打开**：目标标签**有未保存改动**时只把它切到前台，不用磁盘内容盖掉；
  标签干净时才重读磁盘（顺带刷新外部改过的内容）。
  这条只作用于外部交来的路径（`openPathFromExternal`），桌面端原有行为未动——
  桌面从文件树/最近打开进 `openPathIntoTab` 时**仍会覆盖脏标签**，是既有的数据丢失口子，
  已记入 ROADMAP 待办。
- **文件树根目录不跟随**：外部只给单个文档的授权，拿不到它所在目录的浏览权限，
  强行切根还会把用户当前打开的目录弄没。

### 分享（SEND / SEND_MULTIPLE）一并接了

manifest 里本来就声明了 SEND，分享到 H.I.D.E 同样是选中后毫无反应。现在：
附件走 `EXTRA_STREAM`（多个也收），纯文本分享走 `EXTRA_TEXT` →
落成一个新的未命名草稿标签（与 Ctrl+N 同一条路，进草稿、退出走未保存确认）。

### 实测（x86_64 debug 包，Android 15 模拟器，1.4.2 / versionCode 1004002）

| 用例 | 结果 |
| --- | --- |
| 冷启动：force-stop 后 `am start -a VIEW`（MediaStore 数字 URI） | 文件打开并成为当前标签，排在恢复的会话标签之后 ✅ |
| 冷启动：Files 里点 `.md`（真 UI、真授权） | 直接拉起 H.I.D.E 并打开，无需选应用（唯一命中）✅ |
| 热启动：应用在前台时再发一个文件 | `onNewIntent` 监听器生效，第二个文件打开 ✅ |
| 重复打开·脏标签 | 顶栏橙点仍在、未保存的那行字没被覆盖，仅切前台 ✅ |
| 重复打开·干净标签 | 磁盘内容改了再打开，编辑器换成新内容 ✅ |
| 分享文件（Files 长按 → 分享 → H.I.D.E） | 附件打开 ✅ |
| 分享纯文本（`am start -a SEND --es EXTRA_TEXT`） | 生成 `untitled-N.txt` 草稿并带未保存点 ✅ |
| 分享面板候选 | `text/plain` 的 SEND 列表里出现 H.I.D.E ✅ |
| MIME 覆盖 | `query-activities` 对 `text/markdown` 由 0 条命中变 1 条 ✅ |
| 手写 intent-filter 是否被构建重写 | `tauri android build` 后仍在 ✅ |

### 已知边界（不是没做，是做不到 / 留给后续）

- **临时授权**：提供器若不给 persistable 权限（`takePersistableUriPermission` 抛异常被吞），
  本次进程内能读能存，**杀掉应用重启后该标签恢复不了**（会话恢复会把它丢掉）。
  文件管理器与 MediaStore 多数给的是临时授权，这条会真实遇到。
- 提供方报 `application/octet-stream`（部分管理器对 `.svelte`/`.kts` 等冷门扩展）与
  `file://` URI（无 MIME）仍不匹配 → 不出现。要覆盖就得声明 `*/*` 或 scheme-only filter，
  代价是在所有文件类型里出现，本版没做。
- 平板档（≥768px）文件树顶栏少了一个按钮，未重新量过排布；改动是纯删项，风险低。
- 桌面端「覆盖脏标签」的口子见上，未在本版动。
