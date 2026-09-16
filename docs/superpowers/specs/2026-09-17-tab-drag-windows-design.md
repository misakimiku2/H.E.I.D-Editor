# 标签拖拽与多窗口(浏览器式)设计

日期:2026-09-17
状态:已确认(用户选定:同进程新窗口 / 所有窗口会话恢复 / 唯一标签拖出时源窗口关闭)

## 目标

1. 标签页可在标签条内拖拽重排序。
2. 标签拖出标签条 → 新建独立窗口装载该文档(未保存内容随行)。
3. 两个窗口之间可将标签互相拖入合并(插入到指定位置)。
4. 重启后所有窗口的会话按原样恢复(含各窗口位置尺寸)。

范围:仅 Tauri 桌面端。安卓(触屏)不启用脱离/合并;浏览器模式仅栏内重排。

## 关键决策

- **新窗口形态 = 同进程新 WebviewWindow**。应用已启用 single-instance 插件,
  真·第二进程会被弹回;浏览器多窗口同为单进程多窗口,行为一致、开销最小。
- **拖拽 = 原生 HTML5 DnD(OLE)**(v2 修订;v1 曾用指针自绘+浮影,
  但 DOM 画不到窗外,越窗后指针上空无一物,不符合桌面端直觉):
  dragstart 时 setDragImage(标签元素)——系统渲染的拖拽图像全局跟随光标(记事本式);
  栏内重排由 dragover 实时驱动;跨窗口合并由目标窗口直接收 dragover/drop,
  命中测试交给 OS,天然无重叠窗口歧义;标签载荷经 Rust 暂存区(PendingTabDrag)
  传递,不依赖跨实例 dataTransfer;脱离落点 = 光标位置(cursor_position),
  新窗定位后按所在显示器夹紧,先隐藏定位再显示避免闪帧。
- **跨窗口通信统一经 Rust 命令转发**(`emit_to`),避免为每个新窗口标签补前端事件权限。
- **会话快照按窗口隔离**:主窗口沿用 `heid-session`(老用户无感迁移),
  子窗口写 `heid-session:<label>`,清单键 `heid-session:manifest` 登记窗口列表。
  localStorage 同源共享,必须隔离,否则多窗口互相覆盖。
- **关闭规则**:关单窗(尚有其他窗口)→ 清自己的快照并从清单注销;
  关最后一个窗口(= 退出应用)→ 保留全部快照供下次整体还原。
  脏标签内容仍由草稿(按路径/标题键)承载,跨窗口天然有效。

## 交互规格

- 按住标签移动超过 6px 阈值进入拖拽;之前松手仍是普通点击切换。
- 拖拽中:原位标签半透明,光标跟随浮影(胶囊:文件名);标签间显示 2px 插入指示线,实时重排。
  标签条溢出时拖近边缘自动横滚。Esc 取消归位。
- 指针离开标签条 → 浮影切「脱离」形态(略放大);窗口内标签条外松手 = 脱离;窗口外松手 = 脱离。
- 拖到另一窗口标签条上方:目标窗口标签条高亮 + 插入指示线;松手即并入该位置并激活。
  目标已有同路径标签 → 仅聚焦,不重复打开。
- **回执协议**:脱离/合并都要等目标窗口 ack(`heid-tab-adopted`)后才移除源标签,
  超时 5s 放弃操作(源标签原样保留)。唯一标签脱离:ack 后源窗口自毁(此时窗口已无脏标签,无需确认)。
- 附赠:标签右键菜单「移到新窗口」(唯一标签时置灰),复用脱离链路。

## Rust 侧(src-tauri/src/windows.rs)

托管状态 `WindowBootstrap(Mutex<HashMap<String, Value>>)`。命令:

- `create_document_window(payload: Value) -> String`:label 取 `win-N` 最小空闲 N;
  存载荷 → `WebviewWindowBuilder`(无边框/阴影/级联偏移/尺寸继承源窗口)构建;
  按当前主题设任务栏图标;window-state 插件经 `on_window_ready` 对稳定 label 自动恢复几何。
- `take_window_bootstrap(window) -> Option<Value>`:新窗口前端挂载后按自身 label 取走(取后清空)。
- `window_under_cursor(app) -> Option<{label, x, y}>`:`cursor_position()` 对全部
  `webview_windows()` 做内容区命中,返回窗口内逻辑坐标(inner_position/scale_factor 换算)。
- `send_to_window(label, event, payload)`:`emit_to` 转发(标签转移 / 拖拽悬停 / 离开 / 放下 / ack)。
- `window_count(app) -> usize`:「是否最后一个窗口」判断。

能力:`capabilities/default.json` 的 `windows` 扩为 `["main", "win-*"]`。
单实例回调:main 不在时聚焦任一现存窗口。

## 前端结构

- `lib/tabDragCore.ts`(纯函数):插入索引计算、数组移动、拖拽状态机判定。+ vitest。
- `lib/tabTransfer.ts`:FileTab ↔ 传输载荷序列化(drop 运行时瞬态字段),事件名常量。+ vitest。
- `lib/windows.ts`:IPC 封装(create/take/underCursor/send/count,含 isTauri 守卫)。
- `hooks/useWindowBootstrap.ts`:挂载时 `take_window_bootstrap()` 一次,返回载荷与就绪态。
- `components/TabBar.tsx`:标签条从 App.tsx 抽出;拖拽 UI(浮影/指示线/悬停高亮)内聚在组件内,
  拖动过程 App 不重渲染;接收跨窗口拖拽事件并回调 `onAdoptTransfer`。
- `useSessionPersistence` 重构:启动快照可注入(主窗读本地,子窗用载荷);
  恢复例程抽出供两路复用;快照键按 label;新增 `releaseWindowSession()`(关闭规则)。
- App.tsx 接线:`moveTab`/`adoptTransfer`/`detachTab`,空窗自毁,「移到新窗口」菜单项。
- i18n:中英文案(右键菜单、失败提示)。

## 边界情况

- 同路径合并去重;2MB 级内容 IPC 无压力(超大文件标签本为空内容分块预览)。
- 传输崩溃竞态:目标先入快照、源后移除,最坏重复打开同文件,无数据丢失。
- 多窗同时关闭的清单竞态:最坏下次多恢复/少恢复一窗,可接受。
- 拖拽中浮影 z 层最高;指针捕获期间窗口拖拽区不触发(标签元素无 data-tauri-drag-region)。
- 草稿键按路径/标题,传输后不变;撤销历史不随标签转移(与浏览器一致)。

## 验证

vitest 纯函数测试;`tsc` 编译;`cargo check`。手动:重排/脱离/合并/重启恢复/脏标签迁移。
