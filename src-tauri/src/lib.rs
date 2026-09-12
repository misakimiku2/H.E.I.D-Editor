mod encoding;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_text_file, write_text_file])
        .setup(|app| {
            #[cfg(desktop)]
            theme_icon::setup(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
