//! 外部链接打开：交给系统默认浏览器，仅 http/https（复用 http::validate_url）。
//! Windows 走 explorer 而非 `cmd /c start`——不经过 cmd 解析，URL 中的
//! `&` 等元字符不会被截断；macOS open / Linux xdg-open 同为单参数传递。

use crate::http::validate_url;

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate_url(&url)?;
    let url = url.trim();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_http_urls() {
        // open_external 复用 validate_url，协议白名单由其测试覆盖；
        // 这里只确认引用未断（移动端空实现也保留同一校验入口）。
        for u in ["javascript:alert(1)", "file:///C:/x", ""] {
            assert!(crate::http::validate_url(u).is_err(), "should reject: {u}");
        }
    }
}
