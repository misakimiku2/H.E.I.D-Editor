//! Phase 2：大文档只读极速预览的 Markdown → 安全 HTML。
//!
//! 解析用与检索投影相同的 `pulldown-cmark` 选项（GFM 表格/任务列表/删除线/脚注、
//! 上下标、公式），输出 HTML 后交给 `ammonia` 按 allowlist 清洗：
//! - 脚本/事件属性/`javascript:`/危险协议一律去掉；`style` 标签连内容丢弃；
//! - 对齐 `src/lib/markdownRawHtml.ts`：补 u/mark/small/big/font 等无害排版标签，
//!   `mark` 只保留 `md-mark-*` 类名，`code` 只保留 `language-*` 类名；
//! - 相对链接原样保留（本地 .md 链接仍由前端全局导航守卫接管）。
//!
//! 第一版只做**静态**展示：表格/页签/代码块可看不可编辑；Mermaid、KaTeX、
//! 本地图片加载、`==高亮==` 等前端扩展不在 Rust 侧渲染（各自有已知差异，见计划 §5.2）。

use std::sync::OnceLock;
use std::time::Instant;

use pulldown_cmark::{html, Parser};

use crate::md_index::markdown_options;

/// 单次 IPC 最多渲染的分块数（前端一次取 8 块）
pub const MD_RENDER_MAX_CHUNKS: usize = 16;
/// 单次 IPC 的 Markdown 总字节上限（防失控调用）
pub const MD_RENDER_MAX_BYTES: usize = 2 * 1024 * 1024;

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static SANITIZER: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    SANITIZER.get_or_init(|| {
        let defaults: ammonia::Builder<'static> = ammonia::Builder::default();
        let mut tags = defaults.clone_tags();
        for tag in ["big", "font", "input"] {
            tags.insert(tag);
        }
        let mut tag_attributes = defaults.clone_tag_attributes();
        tag_attributes
            .entry("input")
            .or_default()
            .extend(["type", "checked", "disabled"]);
        tag_attributes
            .entry("details")
            .or_default()
            .insert("open");
        let mut generic_attributes = defaults.clone_generic_attributes();
        /* class 只放开给下面 attribute_filter 认可的元素/值 */
        generic_attributes.insert("class");

        let mut builder = ammonia::Builder::default();
        builder
            .tags(tags)
            .tag_attributes(tag_attributes)
            .generic_attributes(generic_attributes)
            .attribute_filter(|element, attribute, value| match attribute {
                "class" => {
                    let allowed = match element {
                        "mark" => value
                            .split_whitespace()
                            .all(|c| c.starts_with("md-mark-")),
                        "code" => value
                            .split_whitespace()
                            .all(|c| c.starts_with("language-")),
                        "span" => value.split_whitespace().all(|c| {
                            c == "math" || c.starts_with("math-") || c.starts_with("katex")
                        }),
                        _ => false,
                    };
                    if allowed {
                        Some(value.into())
                    } else {
                        None
                    }
                }
                "type" if element == "input" => {
                    if value.eq_ignore_ascii_case("checkbox") {
                        Some(value.into())
                    } else {
                        None
                    }
                }
                _ => Some(value.into()),
            })
            .strip_comments(true)
            .link_rel(Some("noopener noreferrer"))
            .url_relative(ammonia::UrlRelative::PassThrough);
        builder
    })
}

/// 渲染一段 Markdown 为清洗后的 HTML（纯函数，便于单测）
pub fn render_markdown_html(markdown: &str) -> String {
    let mut raw = String::with_capacity(markdown.len().saturating_mul(2).max(64));
    html::push_html(&mut raw, Parser::new_ext(markdown, markdown_options()));
    sanitizer().clean(&raw).to_string()
}

/// 批量渲染（极速预览按可见块取 HTML）：在阻塞线程池执行，避免占 UI 线程
#[tauri::command]
pub async fn md_render_html_chunks(chunks: Vec<String>) -> Result<Vec<String>, String> {
    if chunks.len() > MD_RENDER_MAX_CHUNKS {
        return Err(format!(
            "单次最多渲染 {MD_RENDER_MAX_CHUNKS} 个 Markdown 分块"
        ));
    }
    let total: usize = chunks.iter().map(String::len).sum();
    if total > MD_RENDER_MAX_BYTES {
        return Err(format!(
            "单次渲染内容超过 {} MB",
            MD_RENDER_MAX_BYTES / (1024 * 1024)
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        chunks
            .into_iter()
            .map(|chunk| render_markdown_html(&chunk))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn 基础结构与代码() {
        let html = render_markdown_html(
            "# 标题\n\n**粗体** 与 *斜体*、~~删除~~、`行内码`。\n\n```rust\nfn main() {}\n```\n",
        );
        assert!(html.contains("<h1>标题</h1>"), "{html}");
        assert!(html.contains("<strong>粗体</strong>"), "{html}");
        assert!(html.contains("<em>斜体</em>"), "{html}");
        assert!(html.contains("<del>删除</del>"), "{html}");
        assert!(html.contains("<code>行内码</code>"), "{html}");
        assert!(html.contains("<pre><code class=\"language-rust\">"), "{html}");
    }

    #[test]
    fn gfm表格与任务列表() {
        let html = render_markdown_html(
            "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 完成\n- [ ] 待办\n",
        );
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("<th>甲</th>"), "{html}");
        assert!(html.contains("type=\"checkbox\""), "{html}");
        assert!(html.contains("disabled"), "{html}");
        assert!(html.contains("checked"), "{html}");
    }

    #[test]
    fn 数学与上下标() {
        let html = render_markdown_html("$x^2$\n\nH~2~O 与 x^2^\n");
        assert!(html.contains("class=\"math math-inline\""), "{html}");
        assert!(html.contains("x^2"), "{html}");
        /* 上下标按 pulldown 原生语义（词边界）渲染；贴近词内时可能保留源码文本 */
        assert!(html.contains("H~2~O") || html.contains("<sub>2</sub>"), "{html}");
    }

    #[test]
    fn xss脚本事件与危险协议被清除() {
        let html = render_markdown_html(
            "脚本<script>alert(1)</script>\n\n\
             <img src=\"x\" onerror=\"alert(2)\">\n\n\
             [点我](javascript:alert(3))\n\n\
             <style>body{display:none}</style>\n\n\
             <iframe src=\"https://evil\"></iframe>\n\n\
             <div style=\"background:url(javascript:alert(4))\">x</div>\n\n\
             <svg onload=\"alert(5)\"></svg>\n",
        );
        for bad in [
            "<script", "alert(1)", "onerror", "alert(2)", "javascript:", "alert(3)",
            "display:none", "<iframe", "onload", "alert(5)", "<svg",
        ] {
            assert!(!html.contains(bad), "XSS 残留 {bad:?}: {html}");
        }
        assert!(html.contains("点我"), "{html}");
    }

    #[test]
    fn html白名单与mark类名() {
        let html = render_markdown_html(
            "<u>下划线</u> <mark class=\"md-mark-red\">红</mark> <mark class=\"evil\">坏类</mark> \
             <font color=\"red\">字</font> <small>小</small> <big>大</big> <cite>引用</cite>",
        );
        assert!(html.contains("<u>下划线</u>"), "{html}");
        assert!(html.contains("class=\"md-mark-red\""), "{html}");
        assert!(html.contains("红"), "{html}");
        assert!(!html.contains("evil"), "{html}");
        assert!(html.contains("<font>字</font>"), "{html}");
        assert!(!html.contains("color="), "{html}");
        assert!(html.contains("<small>小</small>"), "{html}");
        assert!(html.contains("<big>大</big>"), "{html}");
        assert!(html.contains("<cite>引用</cite>"), "{html}");
    }

    #[test]
    fn html注释与style内容丢弃() {
        let html = render_markdown_html("前<!-- group: x -->后\n\n<style>.x{color:red}</style>\n");
        assert!(html.contains("前后") || (html.contains("前") && html.contains("后")), "{html}");
        assert!(!html.contains("<!--"), "{html}");
        assert!(!html.contains("color:red"), "{html}");
    }

    #[test]
    fn 相对链接保留而远程图片保留() {
        let html = render_markdown_html(
            "[第01章](第01章.md) 与 [官网](https://example.com) 与 ![图](https://example.com/a.png)",
        );
        /* pulldown 会把非 ASCII 路径百分号编码；前端导航守卫会 decodeURIComponent */
        assert!(html.contains("href=\"%E7%AC%AC01%E7%AB%A0.md\""), "{html}");
        assert!(html.contains("href=\"https://example.com\""), "{html}");
        assert!(html.contains("src=\"https://example.com/a.png\""), "{html}");
    }

    #[test]
    fn 首版不放行本地与data协议图片() {
        let html = render_markdown_html(
            "![本地](file:///C:/a.png) ![内嵌](data:image/png;base64,AAAA)",
        );
        assert!(!html.contains("file:"), "{html}");
        assert!(!html.contains("data:"), "{html}");
    }

    #[test]
    fn 非checkbox输入只保留标签() {
        let html = render_markdown_html("<input type=\"text\" value=\"x\">");
        assert!(html.contains("<input"), "{html}");
        assert!(!html.contains("type=\"text\""), "{html}");
        assert!(!html.contains("value="), "{html}");
    }

    #[test]
    fn 脚注与删除线静态保留() {
        let html = render_markdown_html("正文[^1]\n\n[^1]: 脚注定义\n\n~~删除~~\n");
        assert!(html.contains("脚注定义"), "{html}");
        assert!(html.contains("<del>删除</del>"), "{html}");
    }

    #[test]
    fn 原始details与summary保留() {
        let html = render_markdown_html("<details open><summary>标题</summary>内容</details>");
        assert!(html.contains("<details open"), "{html}");
        assert!(html.contains("<summary>标题</summary>"), "{html}");
        assert!(html.contains("内容"), "{html}");
    }

    #[test]
    fn 高亮等前端扩展第一版不渲染() {
        let html = render_markdown_html("==高亮== 与 ==red:红字==");
        /* 已知差异：Rust 侧没有 remarkInlineExt，第一版按源码文本显示 */
        assert!(html.contains("==高亮=="), "{html}");
    }

    /// 本机基准：3.7MB 剧情全本 → 首个 24k 字块与 8 块批量的渲染耗时
    #[test]
    #[ignore = "真实文件基准，需本机存在剧情文件"]
    fn bench_render_large_document() {
        let path = r"C:\Users\misakimiku\Documents\主线剧情_全本.md";
        let Ok(content) = std::fs::read_to_string(path) else {
            eprintln!("跳过：基准文件不存在 {path}");
            return;
        };
        let mut chunks: Vec<String> = Vec::new();
        let mut current = String::new();
        for line in content.lines() {
            if !current.is_empty() && current.len() + line.len() + 1 > 24_000 {
                chunks.push(std::mem::take(&mut current));
            }
            current.push_str(line);
            current.push('\n');
        }
        if !current.is_empty() {
            chunks.push(current);
        }
        let first_started = Instant::now();
        let first = render_markdown_html(&chunks[0]);
        let first_ms = first_started.elapsed().as_millis();
        let batch: Vec<String> = chunks.iter().take(8).cloned().collect();
        let batch_started = Instant::now();
        let rendered: Vec<String> = batch
            .iter()
            .map(|chunk| render_markdown_html(chunk))
            .collect();
        println!(
            "chunks={} first_chunk_md_bytes={} first_chunk_html_bytes={} first_ms={} batch8_ms={} batch8_html_bytes={}",
            chunks.len(),
            chunks[0].len(),
            first.len(),
            first_ms,
            batch_started.elapsed().as_millis(),
            rendered.iter().map(String::len).sum::<usize>(),
        );
    }
}
