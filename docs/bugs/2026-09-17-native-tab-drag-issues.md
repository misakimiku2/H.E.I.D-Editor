# 标签原生拖拽(Native HTML5 DnD)遗留问题记录

日期:2026-09-17
状态:Bug A 已修复并回归验证;跨窗合并待人工复验(自动化受限,见下)
相关提交:`05102a7`(原生 DnD 重写)、`0e6df02`(占位符+文档级放行)、`eba14d4`(禁用拖放拦截)、本次修复(见文末)

## Bug A(严重):轻微拖拽立即脱离成窗,源窗口拖拽中途被销毁 —— 已修复 ✅

### 根因(假设 1 成立,已实证)

Chromium 知名行为:**在 `dragstart` 里同步折叠/隐藏拖拽源元素,会令拖拽循环立即中止,
`dragend` 在鼠标未松开时触发**。旧代码在 dragstart 中 `setDragView` 触发 React 重渲染,
把被拖标签同步折叠为 `width:0 + opacity:0`(TabBar 旧 249-253 行),正好命中。

### 修复内容

1. **源标签不再折叠**(TabBar.tsx):拖拽期间保持原尺寸、仅 `opacity-40` 半透明
   (Chrome 式);让位空隙仍由其后标签的 `translateX` 表达,落点回到原位
   (`dropIndex === startIndex`)时不显示空隙不让位。
2. **`freshRects` 改按 `data-tab-id` 排除被拖标签**:源标签保持原尺寸后,
   不能再用「宽度 ≤4px」识别折叠标签。
3. **dragend 早到防护**(tabDragCore `isPrematureDragEnd`/`DRAGEND_MIN_MS=200`):
   dragend 历时低于 200ms 视为 Chromium 异常中止,按取消处理——清暂存载荷、
   不重排、不脱离(新 IPC 路径 `onNativeDragCancel` → App `cancelTabDrag`)。
4. **顺带修复栏内重排右移差一位**:TabBar 的 dropIndex 是「非拖标签」坐标
   (gapIndexFromRects 语义),而 applyMove 需要「含被拖标签」坐标,右移时相差 1,
   旧代码向右拖一格会无操作、拖过最右会落点提前一格。新增
   `ownDropIndexOf` 在提交时换算。

### 回归验证(GUI 自动化,注入鼠标 + Win32 枚举 + 像素探针)

- ✅ 栏内轻拖(36px)后按住 2s+:窗口数不变、源窗口健在、无新窗产生(旧版此时已脱离+自毁);
- ✅ 松手在标签条上 → handled=true 正常收尾,标签恢复不透明,无脱离;
- ✅ 拖出标签条在内容区松手 → 脱离成窗,新窗位置 = 光标 − 抓取偏移(实测 1818 = 1900−82),
  单标签源窗口自毁;
- ✅ 栏内重排右移:[untitled-1][untitled-3] → 拖过右缘松手 → [untitled-3][untitled-1]
  (旧代码此场景无操作);
- ✅ 栏内重排左移:[untitled-3][untitled-4] → [untitled-4][untitled-3];
- ✅ 中三分位粘滞:落点回到原位(p === startIndex)时不产生空隙、不提交重排;
- ✅ 单测:tabDragCore 新增纯函数测试(isPrematureDragEnd / ownShiftFor /
  ownSlideOffsetX / ownDropIndexOf / clampForeignCaretX),全量 640 测试通过,tsc 无错误。

### 次轮修正(2026-09-18,用户实测反馈)

1. **重排视觉改 Chrome 式**:隐藏系统拖拽快照(模块级预加载 1px 透明图),
   被拖标签自身平滑滑动到落点槽位(opacity-90 + 投影,`ownSlideOffsetX`),
   去掉自家虚线占位框;中三分位粘滞语义不变。
2. **外源合并占位符**:恢复绿色边框矩形;caretX 夹紧到标签条可视区
   (`clampForeignCaretX`)——占位符溢出会触发浏览器拖拽边缘自动滚动,
   把已有标签推走/裁切(用户实测"标签往左挤压、首标签被裁"的根因)。
3. **脱离成窗即时反馈**:finish_tab_drag 成功后,仅当被拖标签是源窗口唯一标签
   (`wasOnlyTab`,载荷新增字段)才立即隐藏源窗口——视觉即时搬家;ack 到达后前端照旧自毁,
   5s 超时或 ack ok=false 时重新 show 源窗口并提示(标签仍在)。多标签源窗口**不隐藏**
   (初版无条件隐藏导致"3 标签拖走 1 个、旧窗口整个消失"),只随 ack 移除被拖标签。
   注意 Rust 改动需重启 tauri:dev / 重新编译才生效;
   dev 模式新窗口经 vite 加载偏慢属正常,生产构建会快得多。

## Bug B:🚫 光标偶现 —— 部分复验,仍需人工确认 ⚠️

本次自动化期间未再观察到"全程 🚫"(拖拽生命周期均正常推进),但自动化无法读取
光标形状(OLE 拖拽期间 GetCursorInfo 不可用)。仍需真实鼠标人工复验:
- 应用窗口内拖拽:不应出现 🚫(文档级放行已就位);
- 桌面/其它应用上:🚫 属 OLE GiveFeedback 限制,JS 不可控,可接受。

## 跨窗口合并 —— 自动化验证受阻,待人工复验 ⚠️

自动化注入鼠标(SendInput/mouse_event)驱动拖拽跨入另一应用窗口悬停时,
源窗口的 OLE 拖拽会话卡死(dragend 永不触发,需重启应用恢复);
同窗口内的拖拽生命周期完全正常。真实硬件鼠标未复现测试(无法自动化),
且本次改动未触及跨窗接收路径(foreign dragover / 窗口创建 / dragDrop 配置)。
上一轮 `0e6df02` 已用真实输入验证过合并可用。**建议人工快速复验一次:
拖动标签到另一 H.I.D.E 窗口标签条,应出现虚线占位符并合并。**

## 自动化测试补充说明(下次复用)

- MCP 截图/窗口坐标可能返回**过期缓存**,全局定位以 Win32 `GetWindowRect`/
  `EnumWindows` 为准;窗口自身光栅(get_app_state window_id)内容是实时的,
  可用于栏内布局测量与最终断言;
- `document.title` 改动不会同步到 Tauri 原生窗口标题,标题断言需走
  `getCurrentWindow().setTitle`;
- 双显示器(虚拟屏 3440x2520,上方还有一台 1080p)下,`mouse_event ABSOLUTE`
  归一化必须带 `MOUSEEVENTF_VIRTUALDESK`,否则 Y 被压缩——本项目用
  `SetCursorPos`(原始虚拟屏坐标)+ 纯按钮事件规避;
- 标签条局部几何(window-local):logo 约 0-110,首标签约 111-289(随标题长度变化),
  "+"紧随其后,strip 元素到 "+" 为止(之外是 flex-1 drag-region,松手=脱离)。

## 本轮已验证正常的功能(回归基线)

- 脱离落点:新窗口 = 光标 - 抓取偏移,先隐藏定位再显示;
- 跨窗口合并:目标窗口占位符 + drop 消费暂存载荷 + ack,源窗口移除标签,
  单标签源窗口自毁,同路径干净标签让位给拖来缓冲(待人工复验,见上);
- 占位符渲染:虚线框 + 让位 transform 动画;落点回原位时无占位符;
- 多窗口会话恢复(按窗口快照 + manifest)、任务栏标题跟随激活文档;
- 未编辑 welcome 不入快照(纯占位窗口不复活)。

## 关键文件

- `src/components/TabBar.tsx` — 拖拽手势 + 半透明源标签 + 占位符渲染
- `src/lib/tabDragCore.ts` — 纯逻辑:三分位判定、早到防护、让位几何、坐标换算(有测试)
- `src/lib/tabTransfer.ts` — 载荷序列化与事件名(EV_TAB_ADOPTED)
- `src/lib/windows.ts` — beginTabDrag/consumePendingDrag/finishTabDrag/cancelTabDrag IPC 封装
- `src-tauri/src/windows.rs` — PendingTabDrag 暂存区、create_document_window
  (async!同步会自死锁白屏)、finish_tab_drag、place_at_cursor 定位夹紧
- `src/App.tsx` — handleNativeDragStart/End/Cancel、handleAdoptForeignDrop、ack 处理
- 已知坑:serde camelCase 字段名(grabDx 而非 grabDX)不匹配会静默拒绝整条命令;
  PendingTabDrag 必须 manage 注册否则 state() panic;跨窗命令统一经
  send_to_window 白名单转发;dropIndex 坐标系换算见 `ownDropIndexOf`。
