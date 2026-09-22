# 安卓：从外部应用「打开方式」选 H.I.D.E，文档并没有被打开

记录于 2026-09-22 · 目标版本 v1.4.2 · 严重度：功能缺失（非回归）

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
