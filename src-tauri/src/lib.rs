mod encoding;
mod external;
mod fsops;
mod http;
#[cfg(desktop)]
mod large_file;
mod render;
#[cfg(desktop)]
mod search;
#[cfg(desktop)]
mod windows;

/// 单实例与文件关联的启动路径：首实例从 argv 收集（NSIS「打开方式」/ 拖到快捷方式传入），
/// 二次启动经 single-instance 回调转发给已运行实例（聚焦窗口 + heid-open-paths 事件）。
#[cfg(desktop)]
mod launch {
    use std::sync::Mutex;
    use tauri::{Emitter, Manager, State};

    #[derive(Default)]
    pub struct LaunchPaths(Mutex<Vec<String>>);

    impl LaunchPaths {
        /// 取走暂存的启动路径（取后清空，前端挂载时调用一次）
        pub fn take(&self) -> Vec<String> {
            self.0
                .lock()
                .map(|mut p| std::mem::take(&mut *p))
                .unwrap_or_default()
        }

        pub fn extend(&self, paths: &[String]) {
            if let Ok(mut p) = self.0.lock() {
                p.extend(paths.iter().cloned());
            }
        }
    }

    /// 从 argv 提取真实存在的文件路径（跳过程序名与选项参数）
    fn file_args(argv: &[String]) -> Vec<String> {
        argv.iter()
            .skip(1)
            .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
            .cloned()
            .collect()
    }

    /// 首实例 setup：记录启动参数里的文件路径，前端就绪后经 take_launch_paths 取走
    pub fn collect_argv(app: &tauri::AppHandle) {
        let argv: Vec<String> = std::env::args().collect();
        let paths = file_args(&argv);
        if !paths.is_empty() {
            let state: State<LaunchPaths> = app.state();
            state.extend(&paths);
        }
    }

    /// 单实例回调：二次启动不开启新进程，聚焦已有窗口并转发待打开路径
    /// （argv 由 single-instance 插件以 Vec<String> 传入；
    ///   多窗口下 main 可能已被关闭，回退聚焦任一现存窗口）
    pub fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>, _cwd: String) {
        let target = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next());
        if let Some(w) = target {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let paths = file_args(&argv);
        if !paths.is_empty() {
            let _ = app.emit_to("main", "heid-open-paths", paths);
        }
    }
}

/// 首实例启动路径（文件关联「打开方式」）。仅桌面：安卓经 SAF content URI 打开，无 argv
#[cfg(desktop)]
#[tauri::command]
fn take_launch_paths(state: tauri::State<launch::LaunchPaths>) -> Vec<String> {
    state.take()
}

/// 文本文件读取：自动检测编码（BOM / UTF-8 / GBK 系）并解码。
/// force 传入编码 label 时按该编码解码（「以该编码重新打开」）。
#[tauri::command]
fn read_text_file(path: String, force: Option<String>) -> Result<encoding::Decoded, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(match force.as_deref() {
        Some(label) => {
            let (text, bom, lossy) = encoding::decode_as(&bytes, label);
            encoding::Decoded {
                text,
                encoding: label.to_string(),
                bom,
                lossy,
                binary: false,
            }
        }
        None => encoding::detect_and_decode(&bytes),
    })
}

/// 文本文件写入：按指定编码编码文本（UTF-8 / UTF-16 可带 BOM）
#[tauri::command]
fn write_text_file(path: String, content: String, encoding: String, bom: Option<bool>) -> Result<(), String> {
    let bytes = encoding::encode_text(&content, &encoding, bom.unwrap_or(false))?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// 任务栏/窗口图标跟随系统深浅色主题（仅桌面：移动端无 set_icon / ThemeChanged API）
#[cfg(desktop)]
mod theme_icon {
    use tauri::{Manager, WindowEvent};

    const ICON_DARK: &[u8] = include_bytes!("../icons/icon-dark.png");
    const ICON_LIGHT: &[u8] = include_bytes!("../icons/icon-light.png");

    fn apply(window: &tauri::WebviewWindow, dark: bool) -> tauri::Result<()> {
        // 资源按图标自身配色命名（dark=深色底）：深色主题应使用浅色底图标保证可见性
    let bytes: &[u8] = if dark { ICON_LIGHT } else { ICON_DARK };
        window.set_icon(tauri::image::Image::from_bytes(bytes)?)?;
        Ok(())
    }

    /// 按窗口当前主题套用任务栏图标（新窗口创建时调用一次；主窗口另有常驻监听）
    pub fn apply_current(window: &tauri::WebviewWindow) -> tauri::Result<()> {
        let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
        apply(window, dark)
    }

    pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
        let window = app.get_webview_window("main").expect("main window missing");
        let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
        apply(&window, dark)?;
        let themed = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::ThemeChanged(theme) = event {
                let _ = apply(&themed, *theme == tauri::Theme::Dark);
            }
        });
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    /* 桌面专属：单实例必须最先注册（官方要求），启动路径状态供文件关联命令读取 */
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(launch::on_second_instance))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        /* 窗口状态记忆：窗口创建时恢复上次的位置/尺寸/最大化，应用退出时自动保存 */
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(launch::LaunchPaths::default())
        .manage(large_file::LargeFileIndex::default())
        .manage(windows::WindowBootstrap::default())
        .manage(windows::PendingTabDrag::default());

    builder
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            http::http_get,
            http::http_get_binary,
            external::open_external,
            render::render_page,
            render::render_result,
            fsops::fs_mkdir,
            fsops::fs_rename,
            fsops::fs_copy,
            fsops::fs_delete,
            fsops::fs_reveal,
            #[cfg(desktop)]
            take_launch_paths,
            #[cfg(desktop)]
            windows::create_document_window,
            #[cfg(desktop)]
            windows::take_window_bootstrap,
            #[cfg(desktop)]
            #[cfg(desktop)]
            windows::send_to_window,
            #[cfg(desktop)]
            windows::window_count,
            #[cfg(desktop)]
            windows::begin_tab_drag,
            #[cfg(desktop)]
            windows::consume_pending_drag,
            #[cfg(desktop)]
            windows::finish_tab_drag,
            #[cfg(desktop)]
            large_file::probe_large_file,
            #[cfg(desktop)]
            large_file::read_line_window,
            #[cfg(desktop)]
            large_file::read_byte_window,
            #[cfg(desktop)]
            large_file::file_size,
            #[cfg(desktop)]
            search::search_in_dir
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                theme_icon::setup(app.handle())?;
                launch::collect_argv(app.handle());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
