//! 多窗口支持(桌面):标签拖出脱离成窗与跨窗口合并的 Rust 桥。
//! - create_document_window:`win-N` 取最小空闲 label(稳定 label 供 window-state
//!   插件按窗恢复几何),启动载荷暂存,新窗口前端挂载后经 take_window_bootstrap 取走;
//!   必须为 async 命令:同步命令在主线程执行,build() 等主线程处理建窗消息会自死锁
//!   (Windows 上表现为窗口壳出现但 webview 永远白屏);
//! - 标签拖拽暂存区(PendingTabDrag):拖起时登记载荷,目标窗口 drop 时消费(consume),
//!   源窗口 dragend 时收尾(finish)——未被任何窗口收下则脱离成窗到光标位置;
//! - send_to_window:跨窗口事件统一经 emit_to 转发(白名单防通用桥);
//! - window_count:关闭规则(是否最后一个窗口)判断。
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 新窗口启动载荷(标签传输 / 会话恢复),按 label 暂存,取后即清
#[derive(Default)]
pub struct WindowBootstrap(Mutex<HashMap<String, Value>>);

/// 进行中的标签拖拽载荷(前端 dragstart 登记,目标窗口 drop 消费,
/// 源窗口 dragend 收尾):单槽位即可——同一时刻只有一个鼠标拖拽
#[derive(Default)]
pub struct PendingTabDrag(Mutex<Option<Value>>);




/// 拖拽释放点(前端内容区逻辑坐标 + 抓取点在标签内的偏移):
/// 用于把新窗口定位到鼠标释放处
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPoint {
    pub client_x: f64,
    pub client_y: f64,
    pub grab_dx: f64,
    pub grab_dy: f64,
}

/// 把新窗口定位到全局光标点(逻辑坐标):外框左上 = 光标 - 抓取偏移,
/// 使标签落点即新窗标签条位置;并夹紧到该点所在显示器内
fn place_at_cursor(ww: &WebviewWindow, cursor: tauri::PhysicalPosition<f64>, grab_dx: f64, grab_dy: f64) -> Option<tauri::LogicalPosition<f64>> {
    let sf = ww.scale_factor().ok()?;
    let (gx, gy) = (cursor.x, cursor.y);
    let mut wx = gx / sf - grab_dx;
    let mut wy = gy / sf - grab_dy;

    /* 夹紧到光标所在显示器:右缘留 8px、顶缘留 8px、底缘至少让出 60px(标题栏可见) */
    if let Ok(Some(monitor)) = ww.monitor_from_point(gx, gy) {
        let mp = monitor.position();
        let ms = monitor.size();
        let (mx, my) = (mp.x as f64 / sf, mp.y as f64 / sf);
        let (mw, mh) = (ms.width as f64 / sf, ms.height as f64 / sf);
        let (ww_l, _wh_l) = ww
            .inner_size()
            .map(|s| (s.width as f64 / sf, s.height as f64 / sf))
            .unwrap_or((1000.0, 640.0));
        wx = wx.clamp(mx + 8.0, (mx + mw - ww_l - 8.0).max(mx + 8.0));
        wy = wy.clamp(my + 8.0, (my + mh - 60.0).max(my + 8.0));
    }
    Some(tauri::LogicalPosition::new(wx, wy))
}

/// 建窗 + 定位(先隐藏,定位后显示,避免在旧位置闪一帧)。
/// place = Some((光标全局物理坐标, 抓取偏移x, 抓取偏移y)):新窗标签条对准光标释放点;
/// None:沿用 builder 的继承+级联位置(会话恢复)。
fn build_and_place(
    app: &AppHandle,
    window: &WebviewWindow,
    payload: Value,
    place: Option<(tauri::PhysicalPosition<f64>, f64, f64)>,
) -> Result<(String, WebviewWindow), String> {
    /* label 取最小空闲 win-N:数值稳定 → window-state 插件按 label 还原上次几何 */
    let existing = app.webview_windows();
    let mut n = 1;
    while existing.contains_key(&format!("win-{n}")) {
        n += 1;
    }
    let label = format!("win-{n}");

    /* 先存载荷再建窗:新窗口加载完成即会来取,不能让它在挂载时扑空 */
    if let Ok(mut map) = app.state::<WindowBootstrap>().0.lock() {
        map.insert(label.clone(), payload);
    }

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("H.I.D.E")
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .min_inner_size(720.0, 480.0)
        /* 先隐藏:定位到释放点后再显示 */
        .visible(false);

    /* 几何继承源窗口(最大化源给默认尺寸居中),位置按现存窗口数级联偏移,
       避免连拖多个标签时新窗完全叠在源窗上;有释放点时由 place_at_cursor 覆盖 */
    let source = existing.get(window.label());
    let source_maximized = source.and_then(|w| w.is_maximized().ok()).unwrap_or(false);
    let cascade = 36.0 * existing.len() as f64;
    match source.filter(|_| !source_maximized) {
        Some(src) => {
            let size = src.inner_size().map_err(|e| e.to_string())?;
            let pos = src.outer_position().map_err(|e| e.to_string())?;
            let sf = src.scale_factor().unwrap_or(1.0);
            builder = builder
                .inner_size(size.width as f64 / sf, size.height as f64 / sf)
                .position(
                    (pos.x as f64 + cascade * sf) / sf,
                    (pos.y as f64 + cascade * sf) / sf,
                );
        }
        None => {
            builder = builder.inner_size(1000.0, 640.0).center();
        }
    }

    let ww = builder.build().map_err(|e| {
        /* 建窗失败清掉暂存载荷,避免泄漏 */
        if let Ok(mut map) = app.state::<WindowBootstrap>().0.lock() {
            map.remove(&label);
        }
        e.to_string()
    })?;

    /* 定位:拖拽释放点优先(标签落点即新窗标签条);无释放点(会话恢复)沿用
       builder 的继承+级联位置——window-state 插件在 on_window_ready 阶段
       已按 label 恢复过历史几何,无释放点时不覆盖 */
    if let Some((cursor, grab_dx, grab_dy)) = &place {
        if let Some(pos) = place_at_cursor(&ww, *cursor, *grab_dx, *grab_dy) {
            let _ = ww.set_position(pos);
        }
    }
    let _ = ww.show();

    /* 任务栏图标跟随当前主题(主窗口由 theme_icon::setup 常驻监听,新窗口创建时套用一次) */
    let _ = super::theme_icon::apply_current(&ww);

    Ok((label, ww))
}

/// 创建文档窗口。必须为 async 命令(见模块注释)。
#[tauri::command]
pub async fn create_document_window(
    app: AppHandle,
    window: WebviewWindow,
    payload: Value,
    drop: Option<DropPoint>,
) -> Result<String, String> {
    /* 释放点(客户端逻辑坐标)换算为全局物理坐标:内容区原点 + 客户端×缩放 */
    let place = match &drop {
        Some(d) => {
            let sf = window.scale_factor().map_err(|e| e.to_string())?;
            let inner = window.inner_position().map_err(|e| e.to_string())?;
            Some((
                tauri::PhysicalPosition::new(
                    inner.x as f64 + d.client_x * sf,
                    inner.y as f64 + d.client_y * sf,
                ),
                d.grab_dx,
                d.grab_dy,
            ))
        }
        None => None,
    };
    let (label, _ww) = build_and_place(&app, &window, payload, place)?;
    Ok(label)
}

/// 新窗口前端挂载后取走自己的启动载荷(按调用者 label,取后清空)
#[tauri::command]
pub fn take_window_bootstrap(window: WebviewWindow) -> Option<Value> {
    let state = window.app_handle().state::<WindowBootstrap>();
    let mut map = state.0.lock().ok()?;
    map.remove(window.label())
}

/// 拖拽开始:源窗口登记标签载荷(整包 TabTransferPayload 形状)
#[tauri::command]
pub fn begin_tab_drag(app: AppHandle, payload: Value) {
    if let Ok(mut slot) = app.state::<PendingTabDrag>().0.lock() {
        *slot = Some(payload);
    }
}

/// 目标窗口 drop 时消费暂存载荷(取后即清;None = 无进行中的拖拽/已被收下)
#[tauri::command]
pub fn consume_pending_drag(window: WebviewWindow) -> Option<Value> {
    let state = window.app_handle().state::<PendingTabDrag>();
    let mut slot = state.0.lock().ok()?;
    slot.take()
}

/// 源窗口 dragend 且标签未落在自己标签条上时收尾:
/// 载荷未被其它窗口消费 → 脱离成窗到光标位置;已被消费 → 目标的 ack 负责源侧收尾。
/// 必须为 async 命令(建窗,同 create_document_window)。
#[tauri::command]
pub async fn finish_tab_drag(
    app: AppHandle,
    window: WebviewWindow,
    grab_dx: f64,
    grab_dy: f64,
) -> Result<Value, String> {
    let pending = {
        let state = app.state::<PendingTabDrag>();
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        slot.take()
    };
    let Some(payload) = pending else {
        /* 已被目标窗口消费:它的 ack 会通知源窗口移除标签 */
        return Ok(serde_json::json!({ "action": "consumed" }));
    };

    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let (label, _ww) = build_and_place(&app, &window, payload, Some((cursor, grab_dx, grab_dy)))?;
    let _ = &label;
    Ok(serde_json::json!({ "action": "detached" }))
}

/// 跨窗口事件白名单:仅放行标签传输回执事件(tabTransfer.ts 定义)
const FORWARDABLE_EVENTS: [&str; 1] = ["heid-tab-adopted"];

#[tauri::command]
pub fn send_to_window(
    app: AppHandle,
    label: String,
    event: String,
    payload: Value,
) -> Result<(), String> {
    if !FORWARDABLE_EVENTS.contains(&event.as_str()) {
        return Err(format!("event not allowed: {event}"));
    }
    app.emit_to(label, &event, payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_count(app: AppHandle) -> usize {
    app.webview_windows().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwardable_events_cover_protocol() {
        for ev in FORWARDABLE_EVENTS {
            assert!(ev.starts_with("heid-tab-"));
        }
    }

    #[test]
    fn window_bootstrap_take_removes_entry() {
        let state = WindowBootstrap::default();
        let mut map = state.0.lock().unwrap();
        map.insert("win-1".to_string(), serde_json::json!({ "kind": "tab" }));
        drop(map);
        let mut map = state.0.lock().unwrap();
        let taken = map.remove("win-1");
        assert!(taken.is_some());
        assert!(map.remove("win-1").is_none());
    }

    #[test]
    fn pending_tab_drag_take_clears_slot() {
        let state = PendingTabDrag::default();
        *state.0.lock().unwrap() = Some(serde_json::json!({ "kind": "tab" }));
        assert!(state.0.lock().unwrap().take().is_some());
        assert!(state.0.lock().unwrap().take().is_none());
    }
}
