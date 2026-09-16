# 标签原生拖拽(Native HTML5 DnD)遗留问题记录

日期:2026-09-17
状态:待修复(下个会话)
相关提交:`05102a7`(原生 DnD 重写)、`0e6df02`(占位符+文档级放行)、`eba14d4`(禁用拖放拦截)

## 背景

标签拖拽已从「指针自绘浮影」迁移到「原生 HTML5 DnD(OLE)」:
标签 `draggable` + `setDragImage`,dragstart 登记载荷到 Rust 暂存区
(`PendingTabDrag`),dragover 三分位判定落点(空占位符+让位动画),
目标窗口 drop 消费载荷完成合并,源窗口 dragend 未被消费则脱离成窗到光标位置。
为让页面级 DnD 生效,主窗口 `dragDropEnabled: false`、
新建窗口 `disable_drag_drop_handler()`(wry 的 IDropTarget 拦截会吞掉页面拖拽事件,
曾导致 🚫 光标/合并失效,见 `eba14d4`)。

## Bug A(严重):轻微拖拽立即脱离成窗,源窗口拖拽中途被销毁

### 实测复现(自动化鼠标,已确认)

两个 H.I.D.E 窗口重叠的场景:
- 窗口甲(源):单标签 untitled-3,位于 [799,169];
- 窗口乙:welcome 单标签,位于 [538,152],与甲部分重叠(光标落点同时位于两窗边界内)。

操作:在甲的标签上 mousedown → 移动一次约 18px(仍在标签条内)→ **未松手**,
第二次 move 时源窗口已不存在("live pixel owner unavailable"),
同时新窗口出现在光标处(位置 = 光标 - 抓取偏移,精确吻合 `finish_tab_drag` 的落点计算)。

时间线:dragstart → 一次 dragover → **dragend(按钮未松)** → handleNativeDragEnd(handled=false)
→ finish_tab_drag → 脱离成窗 → wasOnlyTab 的源窗口自毁。

### 关键疑点:为什么 dragend 在拖拽进行中(按钮未松)就触发?

按优先级排查:

1. **源节点折叠样式剧变**:dragstart 即把被拖标签折叠(width:0/padding:0/opacity:0,
   带 transition-all)。怀疑 Chromium 在源元素尺寸/可见性剧变时提前终止 dragloop
   并派发 dragend。验证:去掉折叠动画(改为保持原尺寸+半透明)再复现。
2. **React 重渲染致源节点短暂离档**:dragstart 触发 setDragView 重渲染,
   检查被拖标签是否因条件渲染/样式切换被卸载重建(同 key 理论上不重建,需实证)。
3. **disable_drag_drop_handler 下 WebView2 对自定义 MIME 拖拽的兼容性**:
   用最小复现(纯 HTML 页面,无 React/无折叠样式)在相同配置下测试,
   排除框架因素;若最小页也复现,考虑该方案在 WebView2 上不可靠,需回退
   (恢复指针自绘方案或改用 tauri 拖放事件驱动)。
4. **两窗重叠的干扰**:复现时乙窗覆盖了落点区域;单窗场景是否复现需单独确认。

### 修复方向(按假设 1 成立时的首选)

- 拖拽期间源标签**不折叠**:保持原尺寸半透明(Chrome 式),占位符改由
  其后标签的 translateX 让位表达(占位宽仍 = 源标签宽);
- 或折叠延迟到首次 dragover 之后 100ms;
- 加防护:dragend 时若 `document.hasFocus()`/按钮仍按下/拖拽时长 < 200ms,
  忽略本次 dragend 不脱离(防过早触发的兜底)。

## Bug B:🚫 光标仍偶现

用户在 `eba14d4` 构建上报告拖拽时全程 🚫。`0e6df02` 已加文档级
dragover/drop 放行(自家 MIME preventDefault + dropEffect=move),
理论上应用窗口内不应再出现——**需在最新构建上复验**:
- 若应用窗口内仍 🚫:检查 document 放行监听是否生效
  (`canDetach` 门槛、types 是否含 `application/x-heid-tab`——
  跨 WebView2 实例后 types 可能被过滤,可改为 dragenter 时 peek 暂存区);
- 若仅在桌面/其它应用上 🚫:属 OLE GiveFeedback 限制,JS 不可控,
  Chrome 同样有此表现,可接受。

## 本轮已验证正常的功能(回归基线)

- 脱离落点:新窗口 = 光标 - 抓取偏移,按显示器夹紧,先隐藏定位再显示;
- 跨窗口合并:目标窗口占位符 + drop 消费暂存载荷 + ack,源窗口移除标签,
  单标签源窗口自毁,同路径干净标签让位给拖来缓冲;
- 占位符渲染(静态):虚线框 + 让位 transform 动画本体已工作;
- 多窗口会话恢复(按窗口快照 + manifest)、任务栏标题跟随激活文档;
- 未编辑 welcome 不入快照(纯占位窗口不复活)。

## 关键文件

- `src/components/TabBar.tsx` — 原生拖拽手势 + 占位符渲染(dragView/foreign 状态)
- `src/lib/tabDragCore.ts` — gapIndexFromRects 三分位判定(纯函数,有测试)
- `src/lib/tabTransfer.ts` — 载荷序列化与事件名(EV_TAB_ADOPTED)
- `src/lib/windows.ts` — beginTabDrag/consumePendingDrag/finishTabDrag IPC 封装
- `src-tauri/src/windows.rs` — PendingTabDrag 暂存区、create_document_window
  (async!同步会自死锁白屏)、finish_tab_drag、place_at_cursor 定位夹紧
- `src/hooks/useSessionPersistence.ts` / `src/lib/sessionWindows.ts` — 按窗会话
- 已知坑:serde camelCase 字段名(grabDx 而非 grabDX)不匹配会静默拒绝整条命令;
  PendingTabDrag 必须 manage 注册否则 state() panic;跨窗命令统一经
  send_to_window 白名单转发。
