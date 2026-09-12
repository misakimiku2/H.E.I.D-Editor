//! 网页抓取（仅 HTTP GET）：供「网址导入 Markdown」使用。
//! 原生无 CORS，桌面 / 安卓通用；仅 http/https、超时 + 大小上限，
//! 非 UTF-8 页面复用 encoding::detect_and_decode 的既有检测链。

use std::io::Read;
use std::time::Duration;

/// 全局超时（连接 + 读取）
const FETCH_TIMEOUT_SECS: u64 = 15;
/// 响应体大小上限（5MB），超出即放弃
const MAX_BODY_BYTES: u64 = 5 * 1024 * 1024;

/// 仅允许 http/https 且带主机名的 URL（scheme 大小写不敏感）
pub fn validate_url(url: &str) -> Result<(), String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("URL 不能为空".into());
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("仅支持 http/https 链接".into());
    }
    let scheme_end = lower.find("://").unwrap() + 3;
    let rest = &u[scheme_end..];
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err("URL 缺少主机名".into());
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct HttpGetResult {
    pub status: u16,
    /// 重定向后的最终 URL（图片相对地址按它补全）
    pub final_url: String,
    pub content_type: String,
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub lossy: bool,
}

#[tauri::command]
pub fn http_get(url: String) -> Result<HttpGetResult, String> {
    validate_url(&url)?;
    let url = url.trim();
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build();
    let res = match agent.get(url).call() {
        Ok(res) => res,
        Err(ureq::Error::Status(code, _)) => return Err(format!("服务器返回 HTTP {code}")),
        Err(e) => return Err(format!("抓取失败：{e}")),
    };
    let status = res.status();
    let final_url = res.get_url().to_string();
    let content_type = res.header("content-type").unwrap_or("").to_string();
    let mut body = Vec::new();
    res.into_reader()
        .take(MAX_BODY_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if body.len() as u64 > MAX_BODY_BYTES {
        return Err("网页内容超过 5MB 上限".into());
    }
    let decoded = crate::encoding::detect_and_decode(&body);
    if decoded.binary {
        return Err("网页疑似二进制内容".into());
    }
    Ok(HttpGetResult {
        status,
        final_url,
        content_type,
        text: decoded.text,
        encoding: decoded.encoding,
        bom: decoded.bom,
        lossy: decoded.lossy,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_url;

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_url("https://example.com/a?b=1").is_ok());
        assert!(validate_url("http://example.com").is_ok());
        assert!(validate_url("  HTTPS://Example.COM/x  ").is_ok());
    }

    #[test]
    fn rejects_other_schemes_and_garbage() {
        for u in ["ftp://example.com", "example.com", "javascript:alert(1)", "file:///C:/x", ""] {
            assert!(validate_url(u).is_err(), "should reject: {u}");
        }
    }

    #[test]
    fn rejects_missing_host() {
        assert!(validate_url("https://").is_err());
        assert!(validate_url("https:///path").is_err());
    }
}
