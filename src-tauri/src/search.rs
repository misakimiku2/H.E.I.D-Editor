//! 跨文件搜索（桌面）：按需递归扫描用户选定的根目录，逐文件解码后按行匹配。
//! 无索引、无常驻后台：一次命令调用完成一次全量扫描（async 命令 + 阻塞线程池，
//! 不占主线程）。护栏：黑名单目录（依赖/构建产物/VCS）与隐藏目录跳过、symlink 跳过、
//! 单文件 >32MB 跳过（与编辑层一致）、二进制（NUL 采样）跳过、
//! 扫描文件数上限 2 万（filesCapped）、结果收集上限 5000 条（计数仍全量，truncated；
//! 前端分页展示）。
//! 正则按行匹配（^ $ 为行首行尾，与编辑器内全文语义略有差异）；regex crate
//! 不支持 lookaround，用户正则含 (?= 等时经 error 字段回传编译错误。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::encoding::detect_and_decode;

/// 单文件尺寸上限：与编辑层一致（前端 lib/largeFile.ts LARGE_FILE_EDIT_MAX_BYTES）
pub const SEARCH_FILE_SIZE_CAP: u64 = 32 * 1024 * 1024;
/// 扫描文件数上限（到达即停，filesCapped 置位）
pub const SEARCH_FILE_COUNT_CAP: usize = 20_000;
/// 结果收集上限（matchTotal 仍统计全量；前端分页展示）
pub const SEARCH_RESULT_CAP: usize = 5_000;
/// 行片段长度上限（字符）
const SNIPPET_CHARS: usize = 200;

/// 跳过的目录名（依赖 / 构建产物 / VCS / IDE）
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "vendor",
    ".git", ".svn", ".hg", ".idea", ".vs", ".vscode", ".gradle",
    "__pycache__", "venv", ".venv", "coverage",
];

pub struct SearchParams {
    pub query: String,
    pub case_sensitive: bool,
    pub regexp: bool,
    pub whole_word: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    /// 1-based 行号
    pub line: u32,
    /// 1-based 字符列
    pub col: u32,
    /// 匹配字符数
    pub len: u32,
    /// 行片段（≤200 字符，命中可见）
    pub text: String,
    /// 片段在原行内的字符起点（前端高亮定位用）
    pub offset: u32,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirSearchResult {
    pub matches: Vec<FileHit>,
    /// 实际解码并参与匹配的文本文件数
    pub files_scanned: usize,
    pub files_matched: usize,
    /// 全量命中数（可能 > matches.len()）
    pub match_total: usize,
    /// 结果条数达到收集上限
    pub truncated: bool,
    pub skipped_large: usize,
    pub skipped_binary: usize,
    /// 跳过的黑名单/隐藏目录数
    pub skipped_dirs: usize,
    /// 文件数达到扫描上限提前停止
    pub files_capped: bool,
    /// 正则非法等
    pub error: Option<String>,
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

/// 词边界判定：命中区间 [start, end)（字节下标）两侧均为非词字符
fn word_bounded(line: &str, start: usize, end: usize) -> bool {
    let before = line[..start].chars().next_back();
    let after = line[end..].chars().next();
    before.map_or(true, |c| !is_word_char(c)) && after.map_or(true, |c| !is_word_char(c))
}

/// 目录是否跳过：黑名单或隐藏（. 开头）
pub fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

fn compile_regex(params: &SearchParams) -> Result<Option<regex::Regex>, String> {
    if !params.regexp {
        return Ok(None);
    }
    regex::RegexBuilder::new(&params.query)
        .case_insensitive(!params.case_sensitive)
        .build()
        .map(Some)
        .map_err(|e| e.to_string())
}

/// 单行普通文本匹配：行内全部命中的（起点字节, 终点字节）
fn find_literal(line: &str, needle: &str, case_sensitive: bool, whole_word: bool) -> Vec<(usize, usize)> {
    if needle.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    if case_sensitive {
        let mut from = 0;
        while let Some(rel) = line[from..].find(needle) {
            let start = from + rel;
            let end = start + needle.len();
            if !whole_word || word_bounded(line, start, end) {
                out.push((start, end));
            }
            from = start + needle.len().max(1);
        }
    } else {
        /* 大小写折叠可能改变长度（İ 等），极端字符下列号有偏差，可接受 */
        let hay = line.to_lowercase();
        let nee = needle.to_lowercase();
        let mut from = 0;
        while let Some(rel) = hay[from..].find(&nee) {
            let start = from + rel;
            let end = start + nee.len();
            if !whole_word || word_bounded(&hay, start, end) {
                out.push((start, end));
            }
            from = start + nee.len().max(1);
        }
    }
    out
}

struct LineHit {
    line: u32,
    col: u32,
    len: u32,
    /// 命中行文本（CRLF 已剥 \r）
    text: String,
}

/// 单文件全部命中：逐行匹配（正则的 ^ $ 即行首行尾）
fn search_text(text: &str, params: &SearchParams, re: Option<&regex::Regex>) -> Vec<LineHit> {
    let mut out = vec![];
    if !params.regexp && params.query.is_empty() {
        return out;
    }
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let line_no = (i + 1) as u32;
        let hits: Vec<(usize, usize)> = if let Some(re) = re {
            re.find_iter(line)
                .filter(|m| !m.as_str().is_empty())
                .filter(|m| !params.whole_word || word_bounded(line, m.start(), m.end()))
                .map(|m| (m.start(), m.end()))
                .collect()
        } else {
            find_literal(line, &params.query, params.case_sensitive, params.whole_word)
        };
        for (start, end) in hits {
            let col = line[..start].chars().count() as u32 + 1;
            let len = line[start..end].chars().count() as u32;
            out.push(LineHit { line: line_no, col, len, text: line.to_string() });
        }
    }
    out
}

/// 行片段：≤200 字符且命中可见的窗口，返回（片段, 片段起点字符下标）
fn snippet(line: &str, hit_col: u32, hit_len: u32) -> (String, u32) {
    let chars: Vec<char> = line.chars().collect();
    let total = chars.len();
    if total <= SNIPPET_CHARS {
        return (line.to_string(), 0);
    }
    let hit_start = (hit_col - 1) as usize;
    let hit_end = hit_start + hit_len as usize;
    let window_start = if hit_end <= SNIPPET_CHARS {
        0
    } else {
        /* 命中尽量靠前并留 40 字符前文 */
        hit_start.saturating_sub(40).min(total - SNIPPET_CHARS)
    };
    let window_end = (window_start + SNIPPET_CHARS).min(total);
    (chars[window_start..window_end].iter().collect(), window_start as u32)
}

fn scan_file(
    path: &Path,
    params: &SearchParams,
    re: Option<&regex::Regex>,
    result_cap: usize,
    size_cap: u64,
    result: &mut DirSearchResult,
) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() > size_cap {
        result.skipped_large += 1;
        return;
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return,
    };
    let decoded = detect_and_decode(&bytes);
    if decoded.binary {
        result.skipped_binary += 1;
        return;
    }
    result.files_scanned += 1;
    let hits = search_text(&decoded.text, params, re);
    if hits.is_empty() {
        return;
    }
    result.files_matched += 1;
    for hit in hits {
        result.match_total += 1;
        if result.matches.len() < result_cap {
            let (text, offset) = snippet(&hit.text, hit.col, hit.len);
            result.matches.push(FileHit {
                path: path.to_string_lossy().into_owned(),
                line: hit.line,
                col: hit.col,
                len: hit.len,
                text,
                offset,
            });
        }
    }
}

/// 递归扫描（栈式遍历；子项按名称排序保证确定性）
pub fn walk_dir(
    root: &Path,
    params: &SearchParams,
    file_cap: usize,
    result_cap: usize,
    size_cap: u64,
) -> DirSearchResult {
    let mut result = DirSearchResult::default();
    let re = match compile_regex(params) {
        Ok(r) => r,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    if !params.regexp && params.query.is_empty() {
        return result;
    }
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            if result.files_scanned >= file_cap {
                result.files_capped = true;
                break;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ft.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if is_skipped_dir(&name) {
                    result.skipped_dirs += 1;
                } else {
                    stack.push(path);
                }
            } else if ft.is_file() {
                scan_file(&path, params, re.as_ref(), result_cap, size_cap, &mut result);
            }
        }
        if result.files_capped {
            break;
        }
    }
    result.truncated = result.match_total > result.matches.len();
    result
}

#[tauri::command]
#[cfg(desktop)]
pub async fn search_in_dir(
    root: String,
    query: String,
    case_sensitive: bool,
    regexp: bool,
    whole_word: bool,
) -> DirSearchResult {
    /* 同步命令跑在主线程，两万文件的全量扫描会把整窗拖到未响应；
       改 async 并挪进阻塞线程池，扫描期间 UI 与输入保持响应 */
    let params = SearchParams { query, case_sensitive, regexp, whole_word };
    tauri::async_runtime::spawn_blocking(move || {
        walk_dir(
            Path::new(&root),
            &params,
            SEARCH_FILE_COUNT_CAP,
            SEARCH_RESULT_CAP,
            SEARCH_FILE_SIZE_CAP,
        )
    })
    .await
    .unwrap_or_else(|e| DirSearchResult { error: Some(e.to_string()), ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(query: &str) -> SearchParams {
        SearchParams { query: query.into(), case_sensitive: false, regexp: false, whole_word: false }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("heid-search-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn skipped_dirs() {
        assert!(is_skipped_dir("node_modules"));
        assert!(is_skipped_dir(".git"));
        assert!(is_skipped_dir("__pycache__"));
        assert!(!is_skipped_dir("src"));
        assert!(!is_skipped_dir("My Project"));
    }

    #[test]
    fn literal_matches_per_line() {
        let text = "foo bar foo\nbaz\nfoo";
        let hits = search_text(text, &params("foo"), None);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[0].col, 1);
        assert_eq!(hits[2].line, 3);
    }

    #[test]
    fn case_insensitive_by_default() {
        let hits = search_text("Hello hello", &params("hello"), None);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn case_sensitive() {
        let p = SearchParams { case_sensitive: true, ..params("hello") };
        let hits = search_text("Hello hello", &p, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].col, 7);
    }

    #[test]
    fn whole_word_bounds() {
        let p = SearchParams { whole_word: true, ..params("foo") };
        let hits = search_text("foo foobar barfoo foo", &p, None);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].col, 1);
        assert_eq!(hits[1].col, 19);
    }

    #[test]
    fn crlf_and_unicode_cols() {
        /* CRLF 行尾剥 \r；中文按字符计列 */
        let text = "你好world\r\n世界 hello";
        let hits = search_text(text, &params("hello"), None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].col, 4);
        assert_eq!(hits[0].len, 5);
        assert_eq!(hits[0].text, "世界 hello");
    }

    #[test]
    fn regexp_mode() {
        let p = SearchParams { regexp: true, ..params("f\\w+") };
        let re = compile_regex(&p).unwrap().unwrap();
        let hits = search_text("foo bar far", &p, Some(&re));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].len, 3);
        assert_eq!(hits[1].len, 3);
    }

    #[test]
    fn regexp_invalid_reports_error() {
        let p = SearchParams { regexp: true, ..params("(unclosed") };
        let re = compile_regex(&p);
        assert!(re.is_err());
    }

    #[test]
    fn snippet_short_line_verbatim() {
        let (text, off) = snippet("abc", 1, 2);
        assert_eq!((text.as_str(), off), ("abc", 0));
    }

    #[test]
    fn snippet_long_line_window_keeps_hit() {
        let line: String = std::iter::repeat('x').take(500).collect();
        /* 命中在 300 字符处（col 301）：窗口起点 = 300-40 = 260 */
        let (text, off) = snippet(&line, 301, 3);
        assert_eq!(off, 260);
        assert_eq!(text.chars().count(), 200);
        assert!(text.chars().all(|c| c == 'x'));
    }

    #[test]
    fn walk_dir_finds_matches_and_skips() {
        let dir = temp_dir("walk");
        fs::write(dir.join("a.txt"), "hello world\nhello again").unwrap();
        fs::write(dir.join("b.md"), "# hello\nnothing").unwrap();
        fs::create_dir(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules").join("c.txt"), "hello inside").unwrap();
        fs::write(dir.join("bin.dat"), vec![b'h', 0, b'i']).unwrap();
        let result = walk_dir(&dir, &params("hello"), 100, 100, SEARCH_FILE_SIZE_CAP);
        assert_eq!(result.error, None);
        assert_eq!(result.files_scanned, 2);
        assert_eq!(result.files_matched, 2);
        assert_eq!(result.match_total, 3);
        assert_eq!(result.skipped_dirs, 1);
        assert_eq!(result.skipped_binary, 1);
        assert_eq!(result.skipped_large, 0);
        assert!(!result.truncated);
        /* 命中按文件名排序：a.txt 在前 */
        assert!(result.matches[0].path.ends_with("a.txt"));
        assert_eq!(result.matches[0].line, 1);
        assert_eq!(result.matches[1].line, 2);
        assert!(result.matches[2].path.ends_with("b.md"));
    }

    #[test]
    fn walk_dir_result_cap_truncates_but_counts_all() {
        let dir = temp_dir("cap");
        fs::write(dir.join("a.txt"), "hit\nhit\nhit\nhit").unwrap();
        let result = walk_dir(&dir, &params("hit"), 100, 2, SEARCH_FILE_SIZE_CAP);
        assert_eq!(result.match_total, 4);
        assert_eq!(result.matches.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn walk_dir_size_cap_skips_large() {
        let dir = temp_dir("size");
        fs::write(dir.join("big.txt"), "needle").unwrap();
        let result = walk_dir(&dir, &params("needle"), 100, 100, 3);
        assert_eq!(result.skipped_large, 1);
        assert_eq!(result.match_total, 0);
    }

    #[test]
    fn walk_dir_empty_query_noop() {
        let dir = temp_dir("empty");
        fs::write(dir.join("a.txt"), "anything").unwrap();
        let result = walk_dir(&dir, &params(""), 100, 100, SEARCH_FILE_SIZE_CAP);
        assert!(result.matches.is_empty());
        assert_eq!(result.files_scanned, 0);
    }
}
