//! 大文档 Markdown 全文检索索引（Phase 1）：Rust 侧解析一次 Markdown，投影出
//! 「渲染后可见文本」并保留到源码的偏移映射；查找在后台线程完成，前端只拿
//! 命中总数、源码偏移与片段，不必为了 Ctrl+F 把整篇文档渲染进 DOM。
//!
//! 投影规则（对齐 react-markdown 预览的可见文本）：
//! - 标题/列表/引用/表格的前缀标记去掉，块之间补 `\n`；
//! - 加粗/斜体/删除线/行内代码/上下标去掉标记保留内容；`==高亮==` 与
//!   `==red:文字==` 的颜色前缀在投影阶段剥离；emoji 短代码按「不命中」处理；
//! - 链接保留文字、丢弃目标地址；图片连同 alt 一起丢弃（预览不显示 alt）；
//! - HTML 注释丢弃；原始 HTML 标签去掉、保留可见文字；script/style 内容丢弃；
//! - 围栏代码保留代码内容（去掉围栏与 info string）；公式保留源码文本；
//! - 脚注引用标记不进投影，脚注定义正文照常进入。
//!
//! 语义差异（有意接受，见计划 §4.6）：emoji 短代码不做 gemoji 表校验，
//! 形如 `:smile:` 的文本一律跳过；HTML 实体不做解码（搜索 `&amp;` 仍按原文）。
//!
//! 偏移约定：`source_start/source_end` 是 **UTF-16 下标**（JS 字符串下标），
//! 与 remark 的 `position.start.offset`、`markdownChunks` 的块起点同一坐标系。

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};

/// 单文档索引上限：与编辑层 32MB 分级一致，超限由前端回退整篇渲染
pub const MD_INDEX_MAX_CONTENT_BYTES: usize = 32 * 1024 * 1024;
/// 常驻索引份数（LRU）：多标签页来回切换时不至于反复重建
pub const MD_INDEX_CACHE_MAX: usize = 3;
/// 命中数组上限：total 仍全量统计，导航只在前 5000 条里循环
pub const MD_SEARCH_MAX_RESULTS: usize = 5_000;
/// 片段最大字符数（含命中）
const SNIPPET_CHARS: usize = 160;
/// 命中原文最大字符数（前端局部高亮用，超长截断）
const MATCH_TEXT_CHARS: usize = 120;
/// `==red:文字==` 支持的颜色（与 src/lib/remarkExt.ts 的 MARK_COLORS 对齐）
const MARK_COLORS: &[&str] = &["yellow", "red", "orange", "green", "blue", "purple"];

/// 投影文本中的一段：文本与源码在该段内按字符线性对应
#[derive(Debug, Clone, PartialEq)]
struct TextSegment {
    /// 投影文本中的字节起点/终点
    text_start: usize,
    text_end: usize,
    /// 该段在源码中的起点（UTF-16 下标）
    source_utf16: u32,
}

/// 大小写不敏感查找用的折叠文本。`map` 逐字节记录折叠文本字节 → 原文本字节，
/// 末尾补一项原文本长度；ASCII 折叠与原文本等长时 `map` 为空（恒等映射）
struct FoldedText {
    text: String,
    map: Vec<u32>,
    identity: bool,
}

impl FoldedText {
    fn text_offset_start(&self, folded_byte: usize) -> usize {
        if self.identity {
            folded_byte
        } else {
            self.map.get(folded_byte).copied().unwrap_or(0) as usize
        }
    }

    /// 折叠文本终点 → 原文本终点：取终点前一个字节的原字符，再加该字符的字节长度
    fn text_offset_end(&self, folded_byte: usize, original: &str) -> usize {
        if self.identity {
            return folded_byte;
        }
        if folded_byte == 0 {
            return 0;
        }
        let orig = self.map.get(folded_byte - 1).copied().unwrap_or(0) as usize;
        let char_len = original[orig..].chars().next().map(char::len_utf8).unwrap_or(0);
        (orig + char_len).min(original.len())
    }
}

pub struct MdIndex {
    /// 投影后的可搜索文本（保留原始大小写）
    text: String,
    segments: Vec<TextSegment>,
    built_ms: u32,
    ascii_folded: OnceLock<String>,
    unicode_folded: OnceLock<FoldedText>,
}

impl MdIndex {
    #[cfg(test)]
    pub fn text(&self) -> &str {
        &self.text
    }

    fn ascii_folded(&self) -> &str {
        self.ascii_folded.get_or_init(|| self.text.to_ascii_lowercase())
    }

    fn unicode_folded(&self) -> &FoldedText {
        self.unicode_folded
            .get_or_init(|| build_unicode_folded(&self.text))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdSearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub regexp: bool,
    pub whole_word: bool,
    /// 前端展示/导航上限；total 仍全量统计
    pub max_results: Option<usize>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MdSearchMatch {
    pub source_start: u32,
    pub source_end: u32,
    /// 命中原文（可能被截断，前端据此做块内局部高亮）
    pub text: String,
    pub text_truncated: bool,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdSearchResult {
    pub total: u32,
    pub capped: bool,
    pub matches: Vec<MdSearchMatch>,
    pub index_ms: u32,
    pub search_ms: u32,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdIndexInfo {
    pub id: u32,
    pub index_ms: u32,
    pub reused: bool,
    pub content_hash: String,
}

/* ---------------- 投影 ---------------- */

struct Projector<'a> {
    content: &'a str,
    out: String,
    segments: Vec<TextSegment>,
    /// 代码/公式/HTML 文本区间：不参与 `==`/`^`/`~`/emoji 剥离
    protected: Vec<(usize, usize)>,
    /// 增量源码 UTF-16 游标：pulldown 的事件按文档顺序给出，游标只前进
    src_byte_cursor: usize,
    src_utf16_cursor: u32,
}

impl<'a> Projector<'a> {
    fn new(content: &'a str) -> Self {
        Self {
            content,
            out: String::with_capacity(content.len() / 2),
            segments: Vec::new(),
            protected: Vec::new(),
            src_byte_cursor: 0,
            src_utf16_cursor: 0,
        }
    }

    fn source_utf16_at(&mut self, byte: usize) -> u32 {
        let mut byte = byte.min(self.content.len());
        while byte > 0 && !self.content.is_char_boundary(byte) {
            byte -= 1;
        }
        if byte < self.src_byte_cursor {
            /* 正常不会发生（事件乱序兜底）：从头重数 */
            self.src_byte_cursor = 0;
            self.src_utf16_cursor = 0;
        }
        if byte > self.src_byte_cursor {
            let gap = &self.content[self.src_byte_cursor..byte];
            self.src_utf16_cursor += gap.encode_utf16().count() as u32;
            self.src_byte_cursor = byte;
        }
        self.src_utf16_cursor
    }

    fn push_text(&mut self, text: &str, source_byte: usize) {
        if text.is_empty() {
            return;
        }
        let text_start = self.out.len();
        self.out.push_str(text);
        let source_utf16 = self.source_utf16_at(source_byte);
        self.segments.push(TextSegment {
            text_start,
            text_end: self.out.len(),
            source_utf16,
        });
    }

    fn push_sep(&mut self) {
        if !self.out.is_empty() && !self.out.ends_with('\n') {
            self.out.push('\n');
        }
    }

    /// 按字面量保留的文本（代码/公式/HTML 可见文字）：后续不做行内标记剥离
    fn push_protected(&mut self, text: &str, source_byte: usize) {
        let start = self.out.len();
        self.push_text(text, source_byte);
        if self.out.len() > start {
            self.protected.push((start, self.out.len()));
        }
    }

    fn finish(self) -> (String, Vec<TextSegment>, Vec<(usize, usize)>) {
        (self.out, self.segments, self.protected)
    }
}

/// 普通文本里收集可见区间：剥离 `==高亮==`/`^上标^`/`~下标~` 与 emoji 短代码
fn collect_visible_spans(text: &str, base: usize, out: &mut Vec<(usize, usize)>) {
    let mut inline = Vec::new();
    split_inline_ext(text, 0, text.len(), &mut inline);
    for (start, end) in inline {
        let fragment = &text[start..end];
        for (emoji_start, emoji_end) in emoji_keep_spans(fragment) {
            if emoji_end > emoji_start {
                out.push((base + start + emoji_start, base + start + emoji_end));
            }
        }
    }
}

/// 整篇剥离行内标记与 emoji 短代码：pulldown 会把 `^2^` 的闭标记切到独立
/// Text 事件，逐事件剥离看不到配对；这里按保留区间重写投影文本并重建偏移段。
/// 代码/公式/HTML 区间原样保留，不参与剥离。
fn strip_marks(
    text: String,
    segments: Vec<TextSegment>,
    protected: Vec<(usize, usize)>,
) -> (String, Vec<TextSegment>) {
    let mut kept: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0;
    for (start, end) in protected {
        let start = start.max(cursor);
        if start > cursor {
            collect_visible_spans(&text[cursor..start], cursor, &mut kept);
        }
        if end > start {
            kept.push((start, end));
        }
        cursor = cursor.max(end);
    }
    if cursor < text.len() {
        collect_visible_spans(&text[cursor..], cursor, &mut kept);
    }

    let mut stripped = String::with_capacity(text.len());
    let mut kept_new_start = Vec::with_capacity(kept.len());
    for (start, end) in &kept {
        kept_new_start.push(stripped.len());
        stripped.push_str(&text[*start..*end]);
    }

    let mut new_segments = Vec::with_capacity(segments.len());
    let mut kept_idx = 0;
    for segment in segments {
        while kept_idx < kept.len() && kept[kept_idx].1 <= segment.text_start {
            kept_idx += 1;
        }
        let mut k = kept_idx;
        while k < kept.len() && kept[k].0 < segment.text_end {
            let start = kept[k].0.max(segment.text_start);
            let end = kept[k].1.min(segment.text_end);
            if end > start {
                let prefix = &text[segment.text_start..start];
                new_segments.push(TextSegment {
                    text_start: kept_new_start[k] + (start - kept[k].0),
                    text_end: kept_new_start[k] + (end - kept[k].0),
                    source_utf16: segment.source_utf16 + utf16_len(prefix),
                });
            }
            k += 1;
        }
    }
    (stripped, new_segments)
}

/// 事件文本在源码中的起点：优先在事件的源码区间里找同一串（处理转义/实体/围栏等），
/// 找不到就退回区间起点（映射可能偏差一两个字符，但不会跨块）
fn align_source(content: &str, range: &Range<usize>, text: &str) -> usize {
    let start = range.start.min(content.len());
    let end = range.end.min(content.len());
    if start >= end {
        return start;
    }
    let slice = &content[start..end];
    slice.find(text).map(|rel| start + rel).unwrap_or(start)
}

/// 解析选项：检索投影与极速预览共用，保证两边的 Markdown 语义一致
pub(crate) fn markdown_options() -> Options {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_MATH);
    options.insert(Options::ENABLE_SUPERSCRIPT);
    options.insert(Options::ENABLE_SUBSCRIPT);
    options.insert(Options::ENABLE_GFM);
    options
}

fn project(content: &str) -> (String, Vec<TextSegment>) {
    let mut projector = Projector::new(content);
    let options = markdown_options();

    let mut image_depth = 0usize;
    let mut code_depth = 0usize;
    let mut raw_skip_depth = 0usize;

    for (event, range) in Parser::new_ext(content, options).into_offset_iter() {
        match event {
            Event::Start(Tag::Image { .. }) => image_depth += 1,
            Event::End(TagEnd::Image) => image_depth = image_depth.saturating_sub(1),
            Event::Start(Tag::CodeBlock(_)) => code_depth += 1,
            Event::End(TagEnd::CodeBlock) => {
                code_depth = code_depth.saturating_sub(1);
                projector.push_sep();
            }
            Event::End(TagEnd::HtmlBlock) => projector.push_sep(),
            Event::Text(text) => {
                if image_depth == 0 && raw_skip_depth == 0 {
                    let source_byte = align_source(content, &range, &text);
                    if code_depth > 0 {
                        /* 围栏代码按字面量搜索，不剥 `==`/emoji */
                        projector.push_protected(&text, source_byte);
                    } else {
                        projector.push_text(&text, source_byte);
                    }
                }
            }
            Event::Code(code) => {
                if image_depth == 0 && raw_skip_depth == 0 {
                    let source_byte = align_source(content, &range, &code);
                    projector.push_protected(&code, source_byte);
                }
            }
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                if image_depth == 0 && raw_skip_depth == 0 {
                    let source_byte = align_source(content, &range, &math);
                    projector.push_protected(&math, source_byte);
                }
            }
            Event::Html(html) => {
                if image_depth == 0 && raw_skip_depth == 0 {
                    /* 去掉标签/注释，保留可见文字；HTML 文本不再参与 markdown 行内扩展 */
                    for (start, end) in html_text_spans(&html) {
                        projector.push_protected(&html[start..end], range.start + start);
                    }
                }
            }
            Event::InlineHtml(html) => {
                /* 只含标签本身；跟踪 script/style 以丢弃其内容（与清洗后的预览对齐） */
                if let Some(delta) = inline_raw_skip_delta(&html) {
                    if delta < 0 {
                        raw_skip_depth = raw_skip_depth.saturating_sub(1);
                    } else {
                        raw_skip_depth += 1;
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak | Event::Rule => projector.push_sep(),
            Event::FootnoteReference(_) | Event::TaskListMarker(_) => {}
            Event::Start(_) => {}
            Event::End(tag_end) => {
                if matches!(
                    tag_end,
                    TagEnd::Paragraph
                        | TagEnd::Heading(_)
                        | TagEnd::Item
                        | TagEnd::TableCell
                        | TagEnd::TableRow
                        | TagEnd::Table
                        | TagEnd::BlockQuote(_)
                        | TagEnd::FootnoteDefinition
                        | TagEnd::List(_)
                ) {
                    projector.push_sep();
                }
            }
        }
    }

    let (text, segments, protected) = projector.finish();
    strip_marks(text, segments, protected)
}

/// 内联 HTML 标签对 script/style 的开关（+1 进入、-1 退出、0 无关）
fn inline_raw_skip_delta(tag: &str) -> Option<i32> {
    let body = tag.trim_start();
    let closing = body.starts_with("</");
    let name = body
        .trim_start_matches('<')
        .trim_start_matches('/')
        .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if name != "script" && name != "style" {
        return None;
    }
    Some(if closing { -1 } else { 1 })
}

/// 行内扩展标记命中：（开标记起点, 闭标记终点, 保留内容起点, 保留内容终点）
type MarkerHit = (usize, usize, usize, usize);

/// `==高亮==`：内容不得含 `=`，首尾不得空白
fn find_highlight(text: &str) -> Option<MarkerHit> {
    let mut search_from = 0;
    while let Some(open_rel) = text[search_from..].find("==") {
        let open = search_from + open_rel;
        let content_start = open + 2;
        let Some(close_rel) = text[content_start..].find("==") else {
            return None;
        };
        let close = content_start + close_rel;
        let content = &text[content_start..close];
        let valid = !content.is_empty()
            && !content.contains('=')
            && !content.contains('\n')
            && !content.chars().next().unwrap().is_whitespace()
            && !content.chars().last().unwrap().is_whitespace();
        if valid {
            let (keep_start, keep_end) = highlight_keep_range(content_start, content);
            return Some((open, close + 2, keep_start, keep_end));
        }
        search_from = content_start;
    }
    None
}

/// 单字符定界符（`^` / `~`）：内容不得含该字符、首尾不得空白；
/// `~` 跳过双波浪线（删除线交给解析器），避免把 `~~删除~~` 的另一半当成下标
fn find_single_delim(text: &str, delim: char) -> Option<MarkerHit> {
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find(delim) {
        let open = search_from + rel;
        let bytes = text.as_bytes();
        if delim == '~' {
            let prev_tilde = open > 0 && bytes[open - 1] == b'~';
            let next_tilde = bytes.get(open + 1) == Some(&b'~');
            if prev_tilde || next_tilde {
                search_from = open + 1;
                continue;
            }
        }
        let content_start = open + delim.len_utf8();
        let Some(close_rel) = text[content_start..].find(delim) else {
            return None;
        };
        let close = content_start + close_rel;
        let content = &text[content_start..close];
        let valid = !content.is_empty()
            && !content.contains(delim)
            && !content.contains('\n')
            && !content.chars().next().unwrap().is_whitespace()
            && !content.chars().last().unwrap().is_whitespace()
            && !(delim == '~' && bytes.get(close + 1) == Some(&b'~'));
        if valid {
            return Some((open, close + 1, content_start, close));
        }
        search_from = content_start;
    }
    None
}

/// 最早的扩展标记（与 remarkExt 的 earliestHit 同序：高亮 > 上标 > 下标）
fn find_inline_marker(text: &str) -> Option<MarkerHit> {
    let mut best: Option<MarkerHit> = None;
    for hit in [
        find_highlight(text),
        find_single_delim(text, '^'),
        find_single_delim(text, '~'),
    ]
    .into_iter()
    .flatten()
    {
        if best.map_or(true, |current| hit.0 < current.0) {
            best = Some(hit);
        }
    }
    best
}

/// 高亮内容的「颜色:」前缀（只认 remarkExt 的色板；未知前缀按普通文本保留）
fn highlight_keep_range(content_start: usize, content: &str) -> (usize, usize) {
    if let Some(colon) = content.find(':') {
        let (color, rest) = content.split_at(colon);
        if MARK_COLORS.contains(&color) && !rest[1..].is_empty() {
            return (content_start + colon + 1, content_start + content.len());
        }
    }
    (content_start, content_start + content.len())
}

fn split_inline_ext(text: &str, from: usize, to: usize, out: &mut Vec<(usize, usize)>) {
    if from >= to {
        return;
    }
    let slice = &text[from..to];
    match find_inline_marker(slice) {
        Some((open, close_end, keep_start, keep_end)) => {
            let abs_open = from + open;
            if abs_open > from {
                out.push((from, abs_open));
            }
            if keep_end > keep_start {
                out.push((from + keep_start, from + keep_end));
            }
            split_inline_ext(text, from + close_end, to, out);
        }
        None => out.push((from, to)),
    }
}

/// emoji 短代码 `:smile:` 按渲染结果处理：跳过、不进入投影（不做 gemoji 表校验）
fn emoji_keep_spans(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut last = 0;
    let mut i = 0;
    while i < text.len() {
        if text.as_bytes()[i] == b':' {
            if let Some(len) = shortcode_len(&text[i..]) {
                if i > last {
                    out.push((last, i));
                }
                i += len;
                last = i;
                continue;
            }
        }
        i += text[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    if last < text.len() {
        out.push((last, text.len()));
    }
    out
}

/// `:name:` 形式的短代码字节长度；首字符必须是 ASCII 小写字母，
/// 避免把 `12:30:45` 这种时间串误判
fn shortcode_len(s: &str) -> Option<usize> {
    let mut chars = s.char_indices();
    let (_, first) = chars.next()?;
    if first != ':' {
        return None;
    }
    let (_, second) = chars.next()?;
    if !second.is_ascii_lowercase() {
        return None;
    }
    for (i, ch) in chars {
        if ch == ':' {
            return Some(i + 1);
        }
        if !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '+' || ch == '-') {
            return None;
        }
        if i > 34 {
            return None;
        }
    }
    None
}

/// HTML 文本中可见文字的字节区间：跳过注释与标签，script/style 内容整段丢弃
fn html_text_spans(html: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut i = 0;
    let mut text_start = 0;
    let mut skip_depth = 0usize;
    while i < html.len() {
        if html[i..].starts_with("<!--") {
            if skip_depth == 0 && i > text_start {
                spans.push((text_start, i));
            }
            let end = html[i + 4..]
                .find("-->")
                .map(|rel| i + 4 + rel + 3)
                .unwrap_or(html.len());
            i = end;
            text_start = i;
            continue;
        }
        if html[i..].starts_with('<') {
            if skip_depth == 0 && i > text_start {
                spans.push((text_start, i));
            }
            let end = find_tag_end(html, i).unwrap_or(html.len());
            let tag_body = &html[i + 1..end.saturating_sub(1)];
            let closing = tag_body.starts_with('/');
            let name = tag_body
                .trim_start_matches('/')
                .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if name == "script" || name == "style" {
                if closing {
                    skip_depth = skip_depth.saturating_sub(1);
                } else {
                    skip_depth += 1;
                }
            }
            i = end;
            text_start = i;
            continue;
        }
        i += html[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    if skip_depth == 0 && text_start < html.len() {
        spans.push((text_start, html.len()));
    }
    spans
}

/// 标签结束 `>` 的下标（跳过引号里的 `>`）
fn find_tag_end(s: &str, start: usize) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, ch) in s[start..].char_indices() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch == '>' {
            return Some(start + i + 1);
        }
    }
    None
}

/* ---------------- 折叠 ---------------- */

fn build_unicode_folded(text: &str) -> FoldedText {
    if text.is_ascii() {
        return FoldedText {
            text: text.to_ascii_lowercase(),
            map: Vec::new(),
            identity: true,
        };
    }
    let mut folded = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1);
    for (byte, ch) in text.char_indices() {
        for lower in ch.to_lowercase() {
            folded.push(lower);
            for _ in 0..lower.len_utf8() {
                map.push(byte as u32);
            }
        }
    }
    map.push(text.len() as u32);
    FoldedText { text: folded, map, identity: false }
}

/// 非 ASCII 的查询是否含有「带大小写」的字符：中文/日文等无大小写字符仍走
/// ASCII 折叠（逐字节等长、无需偏移映射），西里尔/希腊等才构建完整映射
fn query_needs_unicode_fold(query: &str) -> bool {
    query.chars().any(|ch| {
        if ch.is_ascii() {
            return false;
        }
        /* lowercase 与 uppercase 任一能改变字符，才说明它带大小写；
           中文/日文两边都不变，仍走逐字节等长的 ASCII 折叠 */
        let lower_changes = {
            let mut it = ch.to_lowercase();
            !(it.next() == Some(ch) && it.next().is_none())
        };
        let upper_changes = {
            let mut it = ch.to_uppercase();
            !(it.next() == Some(ch) && it.next().is_none())
        };
        lower_changes || upper_changes
    })
}

/* ---------------- 检索 ---------------- */

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

/// 命中两侧均为非词字符（与 searchCore.ts 的 `[\p{L}\p{N}_$]` 近似对齐）
fn word_bounded(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    before.map_or(true, |ch| !is_word_char(ch)) && after.map_or(true, |ch| !is_word_char(ch))
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

fn segment_index_for(text_byte: usize, segments: &[TextSegment]) -> Option<usize> {
    if segments.is_empty() {
        return None;
    }
    let idx = segments.partition_point(|seg| seg.text_end <= text_byte);
    Some(idx.min(segments.len() - 1))
}

/// 投影文本区间 → 源码 UTF-16 区间。段内按字符线性对应；
/// 命中落在块分隔的 `\n` 上时贴到相邻段的边界
fn map_text_range_to_source(index: &MdIndex, text_start: usize, text_end: usize) -> (u32, u32) {
    let Some(start_idx) = segment_index_for(text_start, &index.segments) else {
        return (0, 0);
    };
    let start_seg = &index.segments[start_idx];
    let source_start = if text_start >= start_seg.text_start && text_start <= start_seg.text_end {
        start_seg.source_utf16
            + utf16_len(&index.text[start_seg.text_start..text_start])
    } else {
        /* 命中起点落在块分隔的 \n 上：贴到该段起点 */
        start_seg.source_utf16
    };

    let Some(end_idx) = segment_index_for(text_end.saturating_sub(1), &index.segments) else {
        return (source_start, source_start);
    };
    let end_seg = &index.segments[end_idx];
    let end_offset = text_end.min(end_seg.text_end).max(end_seg.text_start);
    let source_end = end_seg.source_utf16
        + utf16_len(&index.text[end_seg.text_start..end_offset]) as u32;
    (source_start, source_end.max(source_start))
}

fn snippet_around(text: &str, start: usize, end: usize) -> String {
    let line_start = text[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = text[end..].find('\n').map(|i| end + i).unwrap_or(text.len());
    let chars: Vec<char> = text[line_start..line_end].chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return chars.into_iter().collect();
    }
    let hit_start = text[line_start..start].chars().count();
    let hit_len = text[start..end].chars().count();
    let window_start = if hit_start + hit_len <= SNIPPET_CHARS {
        0
    } else {
        hit_start
            .saturating_sub(40)
            .min(chars.len() - SNIPPET_CHARS)
    };
    chars[window_start..window_start + SNIPPET_CHARS].iter().collect()
}

fn push_match(
    index: &MdIndex,
    matches: &mut Vec<MdSearchMatch>,
    text_start: usize,
    text_end: usize,
) {
    let (source_start, source_end) = map_text_range_to_source(index, text_start, text_end);
    let full = &index.text[text_start..text_end];
    let mut matched: String = full.chars().take(MATCH_TEXT_CHARS).collect();
    let text_truncated = matched.chars().count() < full.chars().count();
    if text_truncated {
        matched.push('…');
    }
    matches.push(MdSearchMatch {
        source_start,
        source_end,
        text: matched,
        text_truncated,
        snippet: snippet_around(&index.text, text_start, text_end),
    });
}

#[cfg(desktop)]
fn collect_regex_hits(text: &str, opts: &MdSearchOptions) -> Result<Vec<(usize, usize)>, String> {
    let regex = regex::RegexBuilder::new(&opts.query)
        .case_insensitive(!opts.case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(regex
        .find_iter(text)
        .filter(|m| m.start() != m.end())
        .filter(|m| !opts.whole_word || word_bounded(text, m.start(), m.end()))
        .map(|m| (m.start(), m.end()))
        .collect())
}

#[cfg(not(desktop))]
fn collect_regex_hits(_text: &str, _opts: &MdSearchOptions) -> Result<Vec<(usize, usize)>, String> {
    Err("正则查找暂仅支持桌面端".to_string())
}

/// 在索引上执行一次查找（纯函数，便于单测）
pub fn search_index(index: &MdIndex, opts: &MdSearchOptions) -> MdSearchResult {
    let started = Instant::now();
    let max_results = opts
        .max_results
        .unwrap_or(MD_SEARCH_MAX_RESULTS)
        .clamp(1, 20_000);
    let mut result = MdSearchResult {
        total: 0,
        capped: false,
        matches: Vec::new(),
        index_ms: index.built_ms,
        search_ms: 0,
        error: None,
    };
    if opts.query.is_empty() {
        result.search_ms = started.elapsed().as_millis() as u32;
        return result;
    }

    let mut total: u32 = 0;
    if opts.regexp {
        match collect_regex_hits(&index.text, opts) {
            Ok(hits) => {
                for (start, end) in hits {
                    total = total.saturating_add(1);
                    if result.matches.len() < max_results {
                        push_match(index, &mut result.matches, start, end);
                    }
                }
            }
            Err(error) => {
                result.error = Some(error);
                result.search_ms = started.elapsed().as_millis() as u32;
                return result;
            }
        }
    } else {
        /* 大小写不敏感：普通 ASCII/无大小写查询走逐字节等长的 ASCII 折叠；
           西里尔等带大小写的非 ASCII 查询才构建完整折叠映射 */
        let unicode_fold = !opts.case_sensitive && query_needs_unicode_fold(&opts.query);
        let fold_map = if unicode_fold {
            Some(index.unicode_folded())
        } else {
            None
        };
        let haystack = if opts.case_sensitive {
            index.text.as_str()
        } else if unicode_fold {
            fold_map.unwrap().text.as_str()
        } else {
            index.ascii_folded()
        };
        let needle = if opts.case_sensitive {
            opts.query.clone()
        } else if unicode_fold {
            opts.query.to_lowercase()
        } else {
            opts.query.to_ascii_lowercase()
        };
        let mut from = 0;
        while from <= haystack.len() {
            let Some(rel) = haystack[from..].find(needle.as_str()) else {
                break;
            };
            let hstart = from + rel;
            let hend = hstart + needle.len();
            let (text_start, text_end) = match fold_map {
                Some(fold) => (
                    fold.text_offset_start(hstart),
                    fold.text_offset_end(hend, &index.text),
                ),
                None => (hstart, hend),
            };
            if !opts.whole_word || word_bounded(&index.text, text_start, text_end) {
                total = total.saturating_add(1);
                if result.matches.len() < max_results {
                    push_match(index, &mut result.matches, text_start, text_end);
                }
            }
            from = hend.max(hstart + 1);
        }
    }

    result.total = total;
    result.capped = total as usize > result.matches.len();
    result.search_ms = started.elapsed().as_millis() as u32;
    result
}

/* ---------------- 构建与缓存 ---------------- */

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 构建索引（同步；命令层放进 spawn_blocking）
pub fn build_index(content: &str) -> MdIndex {
    let started = Instant::now();
    let (text, segments) = project(content);
    MdIndex {
        text,
        segments,
        built_ms: started.elapsed().as_millis() as u32,
        ascii_folded: OnceLock::new(),
        unicode_folded: OnceLock::new(),
    }
}

struct CacheEntry {
    id: u32,
    cache_key: String,
    hash: u64,
    index: Arc<MdIndex>,
}

#[derive(Default)]
struct MdIndexCache {
    next_id: u32,
    /// LRU：末尾为最近使用
    entries: Vec<CacheEntry>,
}

static MD_INDEX_REGISTRY: OnceLock<Mutex<MdIndexCache>> = OnceLock::new();

fn registry() -> &'static Mutex<MdIndexCache> {
    MD_INDEX_REGISTRY.get_or_init(|| Mutex::new(MdIndexCache::default()))
}

/// 构建并登记索引；同 cacheKey + 同内容哈希时直接复用（不重复解析）
#[tauri::command]
pub async fn md_index_build(cache_key: String, content: String) -> Result<MdIndexInfo, String> {
    if content.len() > MD_INDEX_MAX_CONTENT_BYTES {
        return Err(format!(
            "文档超过 {} MB，Rust 查找索引已跳过",
            MD_INDEX_MAX_CONTENT_BYTES / (1024 * 1024)
        ));
    }
    let hash = fnv1a(content.as_bytes());
    let hash_hex = format!("{:016x}", hash);

    if let Ok(mut cache) = registry().lock() {
        if let Some(pos) = cache
            .entries
            .iter()
            .position(|e| e.cache_key == cache_key && e.hash == hash)
        {
            let entry = cache.entries.remove(pos);
            let info = MdIndexInfo {
                id: entry.id,
                index_ms: entry.index.built_ms,
                reused: true,
                content_hash: hash_hex,
            };
            cache.entries.push(entry);
            return Ok(info);
        }
    }

    let index = tauri::async_runtime::spawn_blocking(move || build_index(&content))
        .await
        .map_err(|e| e.to_string())?;
    let index = Arc::new(index);
    let mut cache = registry()
        .lock()
        .map_err(|_| "索引缓存不可用".to_string())?;
    let id = cache.next_id;
    cache.next_id = cache.next_id.wrapping_add(1);
    if cache.next_id == 0 {
        cache.next_id = 1;
    }
    cache.entries.push(CacheEntry {
        id,
        cache_key,
        hash,
        index: Arc::clone(&index),
    });
    while cache.entries.len() > MD_INDEX_CACHE_MAX {
        cache.entries.remove(0);
    }
    Ok(MdIndexInfo {
        id,
        index_ms: index.built_ms,
        reused: false,
        content_hash: hash_hex,
    })
}

/// 在已登记的索引上查找；索引不存在（被 LRU 淘汰/已释放）时返回错误由前端回退
#[tauri::command]
pub async fn md_search(
    index_id: u32,
    options: MdSearchOptions,
) -> Result<MdSearchResult, String> {
    let index = {
        let cache = registry()
            .lock()
            .map_err(|_| "索引缓存不可用".to_string())?;
        cache
            .entries
            .iter()
            .find(|e| e.id == index_id)
            .map(|e| Arc::clone(&e.index))
    }
    .ok_or_else(|| "查找索引已失效，请重新打开查找".to_string())?;
    tauri::async_runtime::spawn_blocking(move || search_index(&index, &options))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn md_index_release(index_id: u32) {
    if let Ok(mut cache) = registry().lock() {
        cache.entries.retain(|e| e.id != index_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(query: &str) -> MdSearchOptions {
        MdSearchOptions {
            query: query.to_string(),
            case_sensitive: true,
            regexp: false,
            whole_word: false,
            max_results: None,
        }
    }

    fn insensitive(query: &str) -> MdSearchOptions {
        MdSearchOptions {
            case_sensitive: false,
            ..options(query)
        }
    }

    fn whole(query: &str) -> MdSearchOptions {
        MdSearchOptions {
            whole_word: true,
            ..options(query)
        }
    }

    fn regex(query: &str) -> MdSearchOptions {
        MdSearchOptions {
            regexp: true,
            ..options(query)
        }
    }

    fn hit_source<'a>(md: &'a str, m: &MdSearchMatch) -> &'a str {
        let start = utf16_to_byte(md, m.source_start as usize);
        let end = utf16_to_byte(md, m.source_end as usize);
        &md[start..end]
    }

    fn utf16_to_byte(text: &str, offset: usize) -> usize {
        let mut units = 0;
        for (byte, ch) in text.char_indices() {
            if units >= offset {
                return byte;
            }
            units += ch.len_utf16();
        }
        text.len()
    }

    #[test]
    fn 投影去掉标记保留可见文字() {
        let md = "# 标题\n\n**粗体** 与 *斜体*、~~删除~~、`行内码`、[链接](https://example.com)、\
                   ![图片替代](a.png)、==高亮==、==red:红字==、H~2~O、x^2^。\n\n\
                   - 列表项\n\n> 引用\n\n```rust\nfn main() {}\n```\n\n\
                   | 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n\
                   <!-- group: 注释 -->\n\n**可见** <u>下划线</u>\n";
        let index = build_index(md);
        let text = index.text();
        for expected in [
            "标题", "粗体", "斜体", "删除", "行内码", "链接", "高亮", "红字",
            "H2O", "x2", "列表项", "引用", "fn main()", "甲", "乙", "可见", "下划线",
        ] {
            assert!(text.contains(expected), "投影缺少 {expected:?}: {text:?}");
        }
        for absent in [
            "https://example.com", "a.png", "图片替代", "==", "red:", "<!--", "group:",
            "rust", "---",
        ] {
            assert!(!text.contains(absent), "投影不应包含 {absent:?}: {text:?}");
        }
    }

    #[test]
    fn 表头分隔行不进入投影() {
        let index = build_index("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n");
        assert!(index.text().contains("甲"));
        assert!(!index.text().contains("---"));
    }

    #[test]
    fn 中文命中偏移能切回源码原文() {
        let md = "第一章\n\n前面一段话。\n\n**重点** 后面的内容，方舟升上地面了。\n\n结尾";
        let index = build_index(md);
        let result = search_index(&index, &options("方舟升上地面了。"));
        assert_eq!(result.total, 1);
        assert_eq!(hit_source(md, &result.matches[0]), "方舟升上地面了。");
        let strong = search_index(&index, &options("重点"));
        assert_eq!(hit_source(md, &strong.matches[0]), "重点");
        let heading = search_index(&index, &options("第一章"));
        assert_eq!(hit_source(md, &heading.matches[0]), "第一章");
    }

    #[test]
    fn 补充平面字符的偏移按utf16计算() {
        let md = "a😀前面\n\n**重点**\n\n😀😀结尾";
        let index = build_index(md);
        let result = search_index(&index, &options("结尾"));
        assert_eq!(result.total, 1);
        assert_eq!(hit_source(md, &result.matches[0]), "结尾");
        let second = search_index(&index, &options("重点"));
        assert_eq!(hit_source(md, &second.matches[0]), "重点");
    }

    #[test]
    fn 字面量大小写与整词语义() {
        let md = "Hello World HELLO catalog cat cat.";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("hello")).total, 0);
        assert_eq!(search_index(&index, &insensitive("hello")).total, 2);
        assert_eq!(search_index(&index, &options("cat")).total, 3);
        assert_eq!(search_index(&index, &whole("cat")).total, 2);
        assert_eq!(search_index(&index, &insensitive("HELLO")).total, 2);
    }

    #[test]
    fn total全量统计而结果数组有上限() {
        let md = (0..40).map(|_| "x").collect::<Vec<_>>().join(" ");
        let index = build_index(&md);
        let mut opts = options("x");
        opts.max_results = Some(3);
        let result = search_index(&index, &opts);
        assert_eq!(result.total, 40);
        assert_eq!(result.matches.len(), 3);
        assert!(result.capped);
    }

    #[test]
    fn 高亮标记与颜色前缀不参与搜索() {
        let md = "前 ==重要== 后 ==red:警告文字== 尾";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("==")).total, 0);
        assert_eq!(search_index(&index, &options("red:")).total, 0);
        let hit = search_index(&index, &options("重要"));
        assert_eq!(hit.total, 1);
        assert_eq!(hit_source(md, &hit.matches[0]), "重要");
        let warning = search_index(&index, &options("警告文字"));
        assert_eq!(hit_source(md, &warning.matches[0]), "警告文字");
    }

    #[test]
    fn emoji短代码不命中() {
        let md = "你好 :smile: 世界，时间 12:30:45";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("smile")).total, 0);
        assert_eq!(search_index(&index, &options("30")).total, 1);
        assert!(index.text().contains("你好"));
        assert!(index.text().contains("世界"));
    }

    #[test]
    fn 图片alt与链接地址不进入投影() {
        let md = "![一只猫](https://example.com/cat.png) 和 [文字](https://example.com/page)";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("猫")).total, 0);
        assert_eq!(search_index(&index, &options("example")).total, 0);
        assert_eq!(search_index(&index, &options("文字")).total, 1);
    }

    #[test]
    fn html标签剥离而可见文字保留() {
        let md = "<div>第一段</div>\n\n<!-- 秘密注释 -->\n\n<u>下划线</u> 与 <br> 换行\n\n\
                  <script>alert('坏东西')</script>\n\n<style>.x{color:red}</style>\n";
        let index = build_index(md);
        assert!(index.text().contains("第一段"));
        assert!(index.text().contains("下划线"));
        assert!(index.text().contains("换行"));
        assert_eq!(search_index(&index, &options("秘密注释")).total, 0);
        assert_eq!(search_index(&index, &options("坏东西")).total, 0);
        assert_eq!(search_index(&index, &options("color:red")).total, 0);
    }

    #[test]
    fn 围栏代码按内容搜索且不含围栏() {
        let md = "说明\n\n```rust\nlet x = 1;\n```\n";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("let x = 1")).total, 1);
        let hit = search_index(&index, &options("let x = 1"));
        assert_eq!(hit_source(md, &hit.matches[0]), "let x = 1");
        assert_eq!(search_index(&index, &options("rust")).total, 0);
    }

    #[test]
    fn 表格单元格之间不跨列匹配() {
        let md = "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("甲乙")).total, 0);
        assert_eq!(search_index(&index, &options("甲")).total, 1);
        assert_eq!(search_index(&index, &options("乙")).total, 1);
    }

    #[test]
    fn 行内标记跨段仍可连续匹配() {
        let md = "这是**粗体文字**和后续";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("粗体文字")).total, 1);
        assert_eq!(search_index(&index, &options("这是粗体文字和后续")).total, 1);
    }

    #[test]
    fn 上下标去标记保留内容() {
        let index = build_index("H~2~O 与 x^2^");
        assert!(index.text().contains("H2O"));
        assert!(index.text().contains("x2"));
        assert!(!index.text().contains('~'));
        assert!(!index.text().contains('^'));
    }

    #[test]
    fn 中文与英文大小写不敏感() {
        let md = "方舟 Ark ARK 方舟升上地面了。";
        let index = build_index(md);
        assert_eq!(search_index(&index, &insensitive("ark")).total, 2);
        assert_eq!(search_index(&index, &insensitive("方舟")).total, 2);
    }

    #[test]
    fn 非ascii带大小写字符走完整折叠() {
        let md = "Привет мир, İstanbul";
        let index = build_index(md);
        assert_eq!(search_index(&index, &insensitive("привет")).total, 1);
        let result = search_index(&index, &insensitive("привет"));
        assert_eq!(hit_source(md, &result.matches[0]), "Привет");
        let dotted = search_index(&index, &insensitive("İ"));
        assert_eq!(dotted.total, 1);
        assert_eq!(hit_source(md, &dotted.matches[0]), "İ");
    }

    #[cfg(desktop)]
    #[test]
    fn 正则查找与编译错误() {
        let md = "cat catalog Cat\n第二行 123";
        let index = build_index(md);
        assert_eq!(search_index(&index, &regex("(?i)c.t")).total, 3);
        assert_eq!(search_index(&index, &regex("(?i)cat")).total, 3);
        assert_eq!(search_index(&index, &regex("(?m)^第二行")).total, 1);
        let mut whole_regex = regex("(?i)cat");
        whole_regex.whole_word = true;
        assert_eq!(search_index(&index, &whole_regex).total, 2);
        let bad = search_index(&index, &regex("(?=cat)"));
        assert!(bad.error.is_some());
        assert_eq!(bad.total, 0);
    }

    #[test]
    fn 空查询直接返回空结果() {
        let index = build_index("内容");
        let result = search_index(&index, &options(""));
        assert_eq!(result.total, 0);
        assert!(result.matches.is_empty());
        assert!(!result.capped);
    }

    #[test]
    fn 段落之间不跨块匹配() {
        let md = "上一段\n\n下一段";
        let index = build_index(md);
        assert_eq!(search_index(&index, &options("上一段下一段")).total, 0);
        assert_eq!(search_index(&index, &options("上一段")).total, 1);
    }

    #[test]
    fn 代码与公式内的标记按字面量保留() {
        let md = "`==x==` 与 `H~2~O` 与 `a:smile:b`\n\n公式 $x^2$ 与 $$y==z$$\n";
        let index = build_index(md);
        for expected in ["==x==", "H~2~O", "a:smile:b", "x^2", "y==z"] {
            assert!(index.text().contains(expected), "受保护文本不应被剥离: {expected:?}: {:?}", index.text());
        }
    }

    /// 本机基准：读取剧情全本（不提交仓库），打印索引与查询耗时
    #[test]
    #[ignore = "真实文件基准，需本机存在剧情文件"]
    fn bench_large_document() {
        let path = r"C:\Users\misakimiku\Documents\主线剧情_全本.md";
        let Ok(content) = std::fs::read_to_string(path) else {
            eprintln!("跳过：基准文件不存在 {path}");
            return;
        };
        let started = Instant::now();
        let index = build_index(&content);
        let approx_bytes = index.text.len()
            + index.segments.len() * std::mem::size_of::<TextSegment>();
        println!(
            "file_bytes={} chars={} projected_chars={} projected_bytes={} segments={} approx_index_bytes={} build_ms={}",
            content.len(),
            content.chars().count(),
            index.text.chars().count(),
            index.text.len(),
            index.segments.len(),
            approx_bytes,
            started.elapsed().as_millis()
        );
        for (query, case_sensitive, regexp, whole_word) in [
            ("方舟升上地面了。", true, false, false),
            ("方舟", true, false, false),
            ("the", false, false, false),
            ("方舟\\S{0,8}地面", false, true, false),
        ] {
            let opts = MdSearchOptions {
                query: query.to_string(),
                case_sensitive,
                regexp,
                whole_word,
                max_results: Some(MD_SEARCH_MAX_RESULTS),
            };
            let started = Instant::now();
            let result = search_index(&index, &opts);
            println!(
                "query={query:?} total={} returned={} capped={} search_ms={} error={:?}",
                result.total,
                result.matches.len(),
                result.capped,
                started.elapsed().as_millis(),
                result.error
            );
        }
    }
}
