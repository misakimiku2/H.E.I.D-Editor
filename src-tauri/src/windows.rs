//! 多窗口支持(桌面):标签拖出脱离成窗与跨窗口合并的 Rust 桥。
//! - create_document_window:`win-N` 取最小空闲 label(稳定 label 供 window-state
//!   插件按窗恢复几何),启动载荷暂存,新窗口前端挂载后经 take_window_bootstrap 取走;
//! - window_under_cursor:全局光标对全部窗口内容区做命中,返回窗口内逻辑坐标
//!   (拖拽指针被源窗口捕获后,源窗口据此定位悬停的目标窗口);
//! - send_to_window:跨窗口事件统一经 emit_to 转发,前端无需为每个窗口标签
//!   单独授予事件权限;白名单防止被当成通用桥;
//! - window_count:关闭规则(是否最后一个窗口)判断。
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 新窗口启动载荷(标签传输 / 会话恢复),按 label 暂存,取后即清
#[derive(Default)]
pub struct WindowBootstrap(Mutex<HashMap<String, Value>>);

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

/// 依据释放点计算新窗口外框位置(逻辑坐标):全局点 = 源窗内容区原点 + 客户端坐标,
/// 再减去抓取偏移,使标签落点即新窗标签条位置;并夹紧到该点所在显示器内
fn drop_position(window: &WebviewWindow, ww: &WebviewWindow, drop: &DropPoint) -> Option<tauri::LogicalPosition<f64>> {
    let sf = window.scale_factor().ok()?;
    let inner = window.inner_position().ok()?;
    let gx = inner.x as f64 / sf + drop.client_x;
    let gy = inner.y as f64 / sf + drop.client_y;
    let mut wx = gx - drop.grab_dx;
    let mut wy = gy - drop.grab_dy;

    /* 夹紧到释放点所在显示器:窗口右缘留 8px、顶缘留 8px、底缘至少让出 60px(标题栏可见) */
    if let Ok(Some(monitor)) = ww.monitor_from_point(gx * sf, gy * sf) {
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

/// 创建文档窗口。必须为 async 命令:同步命令在主线程执行,
/// WebviewWindowBuilder::build() 要等主线程事件循环处理建窗消息,会自死锁
/// (Windows 上表现为窗口壳出现但 webview 永远白屏)。
#[tauri::command]
pub async fn create_document_window(
    app: AppHandle,
    window: WebviewWindow,
    payload: Value,
    drop: Option<DropPoint>,
) -> Result<String, String> {
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

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("H.I.D.E")
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .min_inner_size(720.0, 480.0)
        /* 先隐藏:定位到释放点后再显示,避免在旧位置闪一帧 */
        .visible(false);

    /* 几何继承源窗口(最大化源给默认尺寸居中),位置按现存窗口数级联偏移,
       避免连拖多个标签时新窗完全叠在源窗上 */
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

    let ww = builder
        .build()
        .map_err(|e| {
            /* 建窗失败清掉暂存载荷,避免泄漏 */
            if let Ok(mut map) = app.state::<WindowBootstrap>().0.lock() {
                map.remove(&label);
            }
            e.to_string()
        })?;

    /* 定位:拖拽释放点优先(标签落点即新窗标签条),无释放点(会话恢复)沿用
       builder 的继承+级联位置——window-state 插件在 on_window_ready 阶段
       已按 label 恢复过历史几何,无 drop 时不覆盖 */
    if let Some(drop) = &drop {
        if let Some(pos) = drop_position(&window, &ww, drop) {
            let _ = ww.set_position(pos);
        }
    }
    let _ = ww.show();

    /* 任务栏图标跟随当前主题(主窗口由 theme_icon::setup 常驻监听,新窗口创建时套用一次) */
    let _ = super::theme_icon::apply_current(&ww);

    Ok(label)
}

/// 新窗口前端挂载后取走自己的启动载荷(按调用者 label,取后清空)
#[tauri::command]
pub fn take_window_bootstrap(window: WebviewWindow) -> Option<Value> {
    let state = window.app_handle().state::<WindowBootstrap>();
    let mut map = state.0.lock().ok()?;
    map.remove(window.label())
}

#[derive(serde::Serialize)]
pub struct CursorHit {
    pub label: String,
    /// 光标在该窗口内容区内的逻辑坐标(px)
    pub x: f64,
    pub y: f64,
}

/// 全局光标命中测试:返回光标所在窗口与其内容区逻辑坐标;不在任何窗口上返回 None。
/// 源窗口自身也在候选内,由前端按 label 过滤。
#[tauri::command]
pub fn window_under_cursor(app: AppHandle) -> Option<CursorHit> {
    let cur = app.cursor_position().ok()?;
    for (label, w) in app.webview_windows() {
        let Ok(inner) = w.inner_position() else { continue };
        let Ok(size) = w.inner_size() else { continue };
        let dx = cur.x - inner.x as f64;
        let dy = cur.y - inner.y as f64;
        if dx >= 0.0 && dy >= 0.0 && dx <= size.width as f64 && dy <= size.height as f64 {
            let sf = w.scale_factor().unwrap_or(1.0);
            return Some(CursorHit {
                label,
                x: dx / sf,
                y: dy / sf,
            });
        }
    }
    None
}

/// 跨窗口事件白名单:仅放行标签拖拽/传输协议事件(tabTransfer.ts 定义)
const FORWARDABLE_EVENTS: [&str; 4] = [
    "heid-tab-drag-hover",
    "heid-tab-drag-leave",
    "heid-tab-transfer",
    "heid-tab-adopted",
];

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
}
