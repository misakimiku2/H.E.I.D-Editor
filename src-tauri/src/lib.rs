use tauri::{Manager, WindowEvent};

const ICON_DARK: &[u8] = include_bytes!("../icons/icon-dark.png");
const ICON_LIGHT: &[u8] = include_bytes!("../icons/icon-light.png");

/// 任务栏/窗口图标跟随系统深浅色主题
fn apply_theme_icon(window: &tauri::WebviewWindow, dark: bool) -> tauri::Result<()> {
    let bytes: &[u8] = if dark { ICON_DARK } else { ICON_LIGHT };
    window.set_icon(tauri::image::Image::from_bytes(bytes)?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window missing");
            let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
            apply_theme_icon(&window, dark)?;
            let themed = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::ThemeChanged(theme) = event {
                    let _ = apply_theme_icon(&themed, *theme == tauri::Theme::Dark);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
