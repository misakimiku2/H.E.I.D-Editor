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

/// 去掉 # 锚点段：锚点是纯客户端概念，抓取无需发送（含编码锚点亦不例外）
pub fn strip_fragment(url: &str) -> &str {
    match url.find('#') {
        Some(i) => &url[..i],
        None => url,
    }
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

/// 单次抓取（阻塞式，仅供 spawn_blocking 调用）
fn fetch_once(url: &str) -> Result<HttpGetResult, String> {
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

/// 抓取网页。async 命令 + spawn_blocking：阻塞请求不得占用主线程（同步命令
/// 在主线程执行，15s 超时会把整个窗口冻成「未响应」）。传输类错误（连接超时、
/// 重置等，非 HTTP 状态错误）自动重试一次；# 锚点段不发送。
#[tauri::command]
pub async fn http_get(url: String) -> Result<HttpGetResult, String> {
    validate_url(&url)?;
    let target = strip_fragment(url.trim()).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut last_err: Option<String> = None;
        for attempt in 0..2 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(800));
            }
            match fetch_once(&target) {
                Ok(res) => return Ok(res),
                Err(e) => {
                    // HTTP 状态错误（4xx/5xx）重试无意义，直接返回
                    if e.starts_with("服务器返回 HTTP") {
                        return Err(e);
                    }
                    last_err = Some(if attempt == 0 {
                        format!("{e}（已自动重试）")
                    } else {
                        e
                    });
                }
            }
        }
        Err(last_err.unwrap_or_else(|| "抓取失败".into()))
    })
    .await
    .map_err(|e| format!("抓取任务失败：{e}"))?
}

#[derive(serde::Serialize)]
pub struct HttpBinaryResult {
    /// 响应体（base64）：图片本地化用，前端解码后写盘
    pub base64: String,
    pub content_type: String,
}

/// 抓取二进制资源（图片本地化）：与 http_get 同一护栏（仅 http/https、超时、5MB 上限）。
/// 文本内容（检测不含 NUL）视为失败——本命令只面向二进制资源。
#[tauri::command]
pub async fn http_get_binary(url: String) -> Result<HttpBinaryResult, String> {
    validate_url(&url)?;
    let target = strip_fragment(url.trim()).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
            .build();
        let res = match agent.get(&target).call() {
            Ok(res) => res,
            Err(ureq::Error::Status(code, _)) => return Err(format!("服务器返回 HTTP {code}")),
            Err(e) => return Err(format!("下载失败：{e}")),
        };
        let content_type = res.header("content-type").unwrap_or("").to_string();
        let mut body = Vec::new();
        res.into_reader()
            .take(MAX_BODY_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|e| format!("读取响应失败：{e}"))?;
        if body.len() as u64 > MAX_BODY_BYTES {
            return Err("图片超过 5MB 上限".into());
        }
        // 纯文本大概率不是图片（如错误页），与 http_get 的二进制判定相反使用
        if !body.contains(&0u8) {
            return Err("响应不是二进制内容（疑似非图片）".into());
        }
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
        Ok(HttpBinaryResult { base64: b64, content_type })
    })
    .await
    .map_err(|e| format!("下载任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::{strip_fragment, validate_url};

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

    #[test]
    fn strips_fragment_including_encoded_one() {
        assert_eq!(strip_fragment("https://a.com/p#sec1"), "https://a.com/p");
        assert_eq!(
            strip_fragment("https://a.com/p#.E4.BA.BA.E7.89.A9"),
            "https://a.com/p"
        );
        assert_eq!(strip_fragment("https://a.com/p?q=1#x"), "https://a.com/p?q=1");
        assert_eq!(strip_fragment("https://a.com/p"), "https://a.com/p");
    }
}
