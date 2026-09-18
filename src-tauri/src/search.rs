//! 跨文件搜索（桌面）：按需递归扫描用户选定的根目录，逐文件解码后按行匹配。
//! 无索引、无常驻后台：一次命令调用完成一次全量扫描（async 命令 + rayon 并行
//! 扫描，不占主线程）。护栏：黑名单目录（依赖/构建产物/VCS）与隐藏目录跳过、
//! symlink 跳过、单文件 >32MB 跳过（与编辑层一致）、二进制（头部 8KB 采样，
//! BOM 优先——UTF-16 文本遍布 NUL，NUL 判定必须让位于 BOM）跳过、
//! 扫描文本文件数上限 2 万（filesCapped，并行下允许 ≤ 线程数的少量越界）、
//! 结果收集上限 2 万条（计数仍全量，truncated；前端分页展示）。
//! 性能关键点：头部采样先行——二进制文件（游戏提取目录常见数十 GB 音频）不再
//! 整读进内存即被跳过；大小写不敏感字面量经转义后走正则（内部 Aho-Corasick），
//! 免去逐行 to_lowercase 的堆分配。
//! 两遍扫描：第一遍并行只统计各文件命中数（不携带行文本，内存与命中总量解耦），
//! 第二遍沿枚举顺序对命中文件重读，物化前 result_cap 条片段——输出顺序确定、
//! 内存有界；两遍之间文件变化时片段以第二遍读取为准（计数来自第一遍）。
//! 进度与取消：扫描层限频更新进度快照（searchId 关联，前端轮询
//! search_in_dir_progress 读取已处理文件数与实时命中数）；取消经登记表按 id
//! 置位 AtomicBool，并行任务逐文件检查快速排空，结果带 cancelled 标记（不完整）。
//! 刻意不用 tauri 事件/句柄：AppHandle 会把窗口运行时链进单测二进制（缺
//! comctl32 v6 清单加载即失败），轮询协议让搜索模块保持 tauri 类型无关。
//! 正则按行匹配（^ $ 为行首行尾，与编辑器内全文语义略有差异）；regex crate
//! 不支持 lookaround，用户正则含 (?= 等时经 error 字段回传编译错误。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use crate::encoding::detect_and_decode;

/// 单文件尺寸上限：与编辑层一致（前端 lib/largeFile.ts LARGE_FILE_EDIT_MAX_BYTES）
pub const SEARCH_FILE_SIZE_CAP: u64 = 32 * 1024 * 1024;
/// 扫描文本文件数上限（并行下允许少量越界，filesCapped 置位）
pub const SEARCH_FILE_COUNT_CAP: usize = 20_000;
/// 结果收集上限（matchTotal 仍统计全量；前端分页展示）
pub const SEARCH_RESULT_CAP: usize = 20_000;
/// 二进制判定的头部采样字节数（与 encoding.rs is_binary 的 8KB 一致）
const BINARY_PROBE_BYTES: u64 = 8192;
/// 行片段长度上限（字符）
const SNIPPET_CHARS: usize = 200;
/// 进度事件名与限频间隔（多线程扫描下每 100ms 至多一条）
const PROGRESS_SNAPSHOT_MIN_MS: u64 = 100;

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

/// 扫描进度快照（前端按 searchId 轮询 search_in_dir_progress 读取）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub id: u64,
    /// 已处理文件数（含二进制/超限跳过）
    pub files_done: usize,
    /// 枚举出的文件总数
    pub files_total: usize,
    /// 实时累计命中数（第一遍统计）
    pub match_total: usize,
}

/// 一次搜索的运行态：取消标志 + 限频更新的进度快照。
/// 刻意不持有任何 tauri 类型（AppHandle/Emitter 会把 tao/tauri-runtime 链进
/// 单测二进制，缺 comctl32 v6 清单导致加载失败）：进度由前端按 searchId
/// 轮询 search_in_dir_progress 读取，取消经 search_in_dir_cancel 置位。
pub struct SearchRun {
    cancel: AtomicBool,
    progress: Mutex<SearchProgress>,
}

/// 运行中搜索的登记表（id → 运行态）
static SEARCH_REGISTRY: OnceLock<Mutex<HashMap<u64, Arc<SearchRun>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u64, Arc<SearchRun>>> {
    SEARCH_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 扫描层的进度推进与取消检查（登记在 Arc<SearchRun> 上共享给命令层）
pub struct ScanControl {
    run: Arc<SearchRun>,
    files_total: AtomicUsize,
    files_done: AtomicUsize,
    match_total: AtomicUsize,
    last_snapshot_ms: AtomicU64,
    start: Instant,
}

impl ScanControl {
    pub fn new(id: u64) -> Self {
        Self {
            run: Arc::new(SearchRun {
                cancel: AtomicBool::new(false),
                progress: Mutex::new(SearchProgress { id, files_done: 0, files_total: 0, match_total: 0 }),
            }),
            files_total: AtomicUsize::new(0),
            files_done: AtomicUsize::new(0),
            match_total: AtomicUsize::new(0),
            last_snapshot_ms: AtomicU64::new(0),
            start: Instant::now(),
        }
    }

    pub fn run(&self) -> Arc<SearchRun> {
        self.run.clone()
    }

    pub fn cancelled(&self) -> bool {
        self.run.cancel.load(Ordering::Relaxed)
    }

    /// 单文件处理完成：推进计数并按需更新快照
    fn file_done(&self, match_total: usize) {
        self.files_done.fetch_add(1, Ordering::Relaxed);
        if match_total > 0 {
            self.match_total.fetch_add(match_total, Ordering::Relaxed);
        }
        self.maybe_snapshot();
    }

    /// 限频更新快照：距上次不足 100ms 时丢弃（CAS 保证多线程下只有一条通过）
    fn maybe_snapshot(&self) {
        let now_ms = self.start.elapsed().as_millis() as u64;
        let last = self.last_snapshot_ms.load(Ordering::Relaxed);
        if now_ms < last + PROGRESS_SNAPSHOT_MIN_MS {
            return;
        }
        if self
            .last_snapshot_ms
            .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        self.snapshot();
    }

    /// 第一遍结束兜底更新一次（不受限频），轮询立即可见完整计数
    fn snapshot_final(&self) {
        self.snapshot();
    }

    fn snapshot(&self) {
        let mut p = self.run.progress.lock().unwrap();
        p.files_done = self.files_done.load(Ordering::Relaxed);
        p.files_total = self.files_total.load(Ordering::Relaxed);
        p.match_total = self.match_total.load(Ordering::Relaxed);
    }
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
    /// 收到取消请求提前结束（结果不完整，前端应丢弃）
    pub cancelled: bool,
    /// 正则非法等
    pub error: Option<String>,
}

/// 行匹配器：字面量（大小写敏感直查）或正则（用户表达式 / 大小写不敏感转义字面量）
struct Matcher {
    kind: MatcherKind,
    whole_word: bool,
}

enum MatcherKind {
    /// 大小写敏感字面量：str::find 直查，零分配
    LiteralCs(String),
    /// 用户正则原样；大小写不敏感字面量转义后编译（简单大小写折叠与全文
    /// 小写映射在极端字符（İ 等）上的差异与旧实现同样可接受）
    Regex(regex::Regex),
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

/// 编译匹配器。大小写不敏感字面量转义后走正则：内部 Aho-Corasick / memmem
/// 免分配，且不再逐行 to_lowercase（旧实现每行两次堆分配）。
fn build_matcher(params: &SearchParams) -> Result<Matcher, String> {
    let kind = if params.regexp {
        MatcherKind::Regex(
            regex::RegexBuilder::new(&params.query)
                .case_insensitive(!params.case_sensitive)
                .build()
                .map_err(|e| e.to_string())?,
        )
    } else if params.case_sensitive {
        MatcherKind::LiteralCs(params.query.clone())
    } else {
        MatcherKind::Regex(
            regex::RegexBuilder::new(&regex::escape(&params.query))
                .case_insensitive(true)
                .build()
                .map_err(|e| e.to_string())?,
        )
    };
    Ok(Matcher { kind, whole_word: params.whole_word })
}

/// 单行匹配：行内全部命中的（起点字节, 终点字节）
fn line_hits(line: &str, matcher: &Matcher) -> Vec<(usize, usize)> {
    match &matcher.kind {
        MatcherKind::LiteralCs(needle) => {
            if needle.is_empty() {
                return vec![];
            }
            let mut out = vec![];
            let mut from = 0;
            while let Some(rel) = line[from..].find(needle.as_str()) {
                let start = from + rel;
                let end = start + needle.len();
                if !matcher.whole_word || word_bounded(line, start, end) {
                    out.push((start, end));
                }
                from = start + needle.len().max(1);
            }
            out
        }
        MatcherKind::Regex(re) => re
            .find_iter(line)
            .filter(|m| !m.as_str().is_empty())
            .filter(|m| !matcher.whole_word || word_bounded(line, m.start(), m.end()))
            .map(|m| (m.start(), m.end()))
            .collect(),
    }
}

/// 逐行执行匹配并回调（行文本, 行号, 列, 长），返回命中总数（正则的 ^ $ 即行首行尾）
fn for_each_line_hit<F: FnMut(&str, u32, u32, u32)>(text: &str, matcher: &Matcher, mut on_hit: F) -> usize {
    let mut total = 0;
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        for (start, end) in line_hits(line, matcher) {
            let col = line[..start].chars().count() as u32 + 1;
            let len = line[start..end].chars().count() as u32;
            on_hit(line, (i + 1) as u32, col, len);
            total += 1;
        }
    }
    total
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

/// 头部采样二进制判定（与 detect_and_decode 阶梯一致：BOM 优先于 NUL——
/// UTF-16 文本字节流遍布 NUL，不能凭 NUL 判二进制；无 BOM 时头部含 NUL 即二进制）
fn head_is_binary(head: &[u8]) -> bool {
    if head.starts_with(&[0xEF, 0xBB, 0xBF])
        || head.starts_with(&[0xFF, 0xFE])
        || head.starts_with(&[0xFE, 0xFF])
    {
        return false;
    }
    head.contains(&0)
}

/// 第一遍单文件结果
enum FileScan {
    /// 读取失败（与旧行为一致：静默跳过）
    IoError,
    /// 超过单文件尺寸上限
    TooLarge,
    /// 头部采样判定为二进制（不整读文件）
    Binary,
    /// 文本文件数到达扫描上限，未解码
    Capped,
    /// 收到取消请求，未处理
    Cancelled,
    /// 已解码并匹配：全量命中数
    Scanned { match_total: usize },
}

/// 第一遍：读文件并统计命中数（不物化片段）。
/// 头部 8KB 采样先行——游戏提取目录常见数十 GB 音频，逐文件整读是旧版搜索
/// 近半小时的根源；采样判二进制后跳过，仅文本文件才读入剩余部分。
fn scan_file_stats(
    path: &Path,
    matcher: &Matcher,
    size_cap: u64,
    file_cap: usize,
    scanned: &AtomicUsize,
    capped: &AtomicBool,
) -> FileScan {
    use std::io::Read;
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return FileScan::IoError,
    };
    if meta.len() > size_cap {
        return FileScan::TooLarge;
    }
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return FileScan::IoError,
    };
    /* 采样读容忍文件并发缩短（read_exact 会误报），读满或 EOF 为止 */
    let probe_len = meta.len().min(BINARY_PROBE_BYTES) as usize;
    let mut head = vec![0u8; probe_len];
    let mut filled = 0;
    while filled < probe_len {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return FileScan::IoError,
        }
    }
    head.truncate(filled);
    if head_is_binary(&head) {
        return FileScan::Binary;
    }
    /* 文件数上限在解码前预检：并行下越界量至多为线程数，量级无害 */
    if scanned.load(Ordering::Relaxed) >= file_cap {
        capped.store(true, Ordering::Relaxed);
        return FileScan::Capped;
    }
    let mut bytes = head;
    if file.read_to_end(&mut bytes).is_err() {
        return FileScan::IoError;
    }
    let decoded = detect_and_decode(&bytes);
    if decoded.binary {
        return FileScan::Binary;
    }
    scanned.fetch_add(1, Ordering::Relaxed);
    let match_total = for_each_line_hit(&decoded.text, matcher, |_, _, _, _| {});
    FileScan::Scanned { match_total }
}

/// 第二遍：对命中文件重读并物化至多 remaining 条片段（返回实际收集数）。
/// 两遍之间文件可能变化：片段与列号以本次读取为准，计数仍来自第一遍。
fn collect_file_hits(path: &Path, matcher: &Matcher, out: &mut Vec<FileHit>, remaining: usize) -> usize {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => return 0,
    };
    let decoded = detect_and_decode(&bytes);
    if decoded.binary {
        return 0;
    }
    let path_str = path.to_string_lossy().into_owned();
    let mut appended = 0usize;
    for (i, raw) in decoded.text.split('\n').enumerate() {
        if appended >= remaining {
            break;
        }
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        for (start, end) in line_hits(line, matcher) {
            let col = line[..start].chars().count() as u32 + 1;
            let len = line[start..end].chars().count() as u32;
            let (text, offset) = snippet(line, col, len);
            out.push(FileHit {
                path: path_str.clone(),
                line: (i + 1) as u32,
                col,
                len,
                text,
                offset,
            });
            appended += 1;
            if appended >= remaining {
                break;
            }
        }
    }
    appended
}

/// 递归枚举全部文件（栈式 DFS；文件与子目录均按名称升序，输出顺序确定）。
/// 黑名单/隐藏目录计入 skipped_dirs；symlink（目录与文件）跳过。
fn enumerate_files(root: &Path, skipped_dirs: &mut usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        items.sort_by_key(|e| e.file_name());
        let mut subdirs = Vec::new();
        for entry in items {
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
                    *skipped_dirs += 1;
                } else {
                    subdirs.push(path);
                }
            } else if ft.is_file() {
                files.push(path);
            }
        }
        /* 逆序压栈使 pop 顺序保持名称升序 */
        for d in subdirs.into_iter().rev() {
            stack.push(d);
        }
    }
    files
}

/// 递归扫描（无进度/取消；测试入口）
pub fn walk_dir(
    root: &Path,
    params: &SearchParams,
    file_cap: usize,
    result_cap: usize,
    size_cap: u64,
) -> DirSearchResult {
    walk_dir_scanning(root, params, file_cap, result_cap, size_cap, None)
}

/// 递归扫描：枚举 → 并行统计 → 顺序物化片段。control 提供取消与限频进度事件。
pub fn walk_dir_scanning(
    root: &Path,
    params: &SearchParams,
    file_cap: usize,
    result_cap: usize,
    size_cap: u64,
    control: Option<&ScanControl>,
) -> DirSearchResult {
    let mut result = DirSearchResult::default();
    let matcher = match build_matcher(params) {
        Ok(m) => m,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    if !params.regexp && params.query.is_empty() {
        return result;
    }

    /* 1) 枚举：顺序 DFS、名称升序，保证确定性 */
    let mut skipped_dirs = 0usize;
    let files = enumerate_files(root, &mut skipped_dirs);
    result.skipped_dirs = skipped_dirs;

    /* 2) 第一遍并行扫描：只统计命中数，内存与命中总量解耦 */
    if let Some(c) = control {
        c.files_total.store(files.len(), Ordering::Relaxed);
    }
    let scanned = AtomicUsize::new(0);
    let capped = AtomicBool::new(false);
    let stats: Vec<(PathBuf, FileScan)> = files
        .into_par_iter()
        .map(|p| {
            let s = if control.is_some_and(|c| c.cancelled()) {
                FileScan::Cancelled
            } else {
                scan_file_stats(&p, &matcher, size_cap, file_cap, &scanned, &capped)
            };
            /* 进度计数覆盖全部文件（含二进制/超限跳过），取消后剩余任务快速排空 */
            if let Some(c) = control {
                let mt = if let FileScan::Scanned { match_total } = &s { *match_total } else { 0 };
                c.file_done(mt);
            }
            (p, s)
        })
        .collect();

    let mut matched_files: Vec<&Path> = Vec::new();
    for (path, s) in &stats {
        match s {
            FileScan::IoError => {}
            FileScan::TooLarge => result.skipped_large += 1,
            FileScan::Binary => result.skipped_binary += 1,
            FileScan::Capped => result.files_capped = true,
            FileScan::Cancelled => {}
            FileScan::Scanned { match_total } => {
                result.files_scanned += 1;
                if *match_total > 0 {
                    result.files_matched += 1;
                    result.match_total += *match_total;
                    matched_files.push(path);
                }
            }
        }
    }
    if let Some(c) = control {
        c.snapshot_final();
    }

    /* 3) 第二遍顺序物化：沿枚举顺序收集前 result_cap 条片段 */
    let mut remaining = result_cap;
    for path in matched_files {
        if remaining == 0 || control.is_some_and(|c| c.cancelled()) {
            break;
        }
        remaining -= collect_file_hits(path, &matcher, &mut result.matches, remaining);
    }
    result.cancelled = control.is_some_and(|c| c.cancelled());
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
    search_id: u64,
) -> DirSearchResult {
    /* 同步命令跑在主线程，两万文件的全量扫描会把整窗拖到未响应；
       改 async 并挪进阻塞线程池，扫描期间 UI 与输入保持响应。
       searchId 由前端生成：进度轮询与取消命令都以它关联 */
    let control = ScanControl::new(search_id);
    if let Ok(mut map) = registry().lock() {
        map.insert(search_id, control.run());
    }
    let params = SearchParams { query, case_sensitive, regexp, whole_word };
    let result = tauri::async_runtime::spawn_blocking(move || {
        walk_dir_scanning(
            Path::new(&root),
            &params,
            SEARCH_FILE_COUNT_CAP,
            SEARCH_RESULT_CAP,
            SEARCH_FILE_SIZE_CAP,
            Some(&control),
        )
    })
    .await
    .unwrap_or_else(|e| DirSearchResult { error: Some(e.to_string()), ..Default::default() });
    if let Ok(mut map) = registry().lock() {
        map.remove(&search_id);
    }
    result
}

/// 取消运行中的搜索：按 id 置位取消标志（扫描任务逐文件检查并快速排空）
#[tauri::command]
#[cfg(desktop)]
pub fn search_in_dir_cancel(search_id: u64) {
    if let Ok(map) = registry().lock() {
        if let Some(run) = map.get(&search_id) {
            run.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// 轮询运行中搜索的进度快照（id 不存在/已结束时返回 None）
#[tauri::command]
#[cfg(desktop)]
pub fn search_in_dir_progress(search_id: u64) -> Option<SearchProgress> {
    let map = registry().lock().ok()?;
    let run = map.get(&search_id)?;
    let progress = run.progress.lock().ok()?.clone();
    Some(progress)
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

    /// 文本直接物化命中（测试辅助）：逐行匹配返回 (行, 列, 长)
    fn text_hits(text: &str, p: &SearchParams) -> Vec<(u32, u32, u32)> {
        let m = build_matcher(p).unwrap();
        let mut out = Vec::new();
        for (i, raw) in text.split('\n').enumerate() {
            let line = raw.strip_suffix('\r').unwrap_or(raw);
            for (start, end) in line_hits(line, &m) {
                out.push((
                    (i + 1) as u32,
                    line[..start].chars().count() as u32 + 1,
                    line[start..end].chars().count() as u32,
                ));
            }
        }
        out
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
        let hits = text_hits("foo bar foo\nbaz\nfoo", &params("foo"));
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0], (1, 1, 3));
        assert_eq!(hits[2], (3, 1, 3));
    }

    #[test]
    fn case_insensitive_by_default() {
        /* 大小写不敏感字面量走转义正则路径：混合大小写宿主全部命中 */
        assert_eq!(text_hits("Hello hello", &params("hello")).len(), 2);
        assert_eq!(text_hits("HELLO HeLLo hello", &params("hello")).len(), 3);
    }

    #[test]
    fn cjk_query_via_ci_regex_path() {
        /* CJK 无大小写形态：「闪电」正走大小写不敏感免分配路径 */
        let hits = text_hits("这里有闪电\n没有雷\n闪电侠", &params("闪电"));
        assert_eq!(hits, vec![(1, 4, 2), (3, 1, 2)]);
    }

    #[test]
    fn case_sensitive() {
        let p = SearchParams { case_sensitive: true, ..params("hello") };
        let hits = text_hits("Hello hello", &p);
        assert_eq!(hits, vec![(1, 7, 5)]);
    }

    #[test]
    fn whole_word_bounds() {
        let p = SearchParams { whole_word: true, ..params("foo") };
        let hits = text_hits("foo foobar barfoo foo", &p);
        assert_eq!(hits, vec![(1, 1, 3), (1, 19, 3)]);
    }

    #[test]
    fn crlf_and_unicode_cols() {
        /* CRLF 行尾剥 \r；中文按字符计列 */
        let hits = text_hits("你好world\r\n世界 hello", &params("hello"));
        assert_eq!(hits, vec![(2, 4, 5)]);
    }

    #[test]
    fn regexp_mode() {
        let p = SearchParams { regexp: true, ..params("f\\w+") };
        let hits = text_hits("foo bar far", &p);
        assert_eq!(hits, vec![(1, 1, 3), (1, 9, 3)]);
    }

    #[test]
    fn regexp_case_flag_respected() {
        let p = SearchParams { regexp: true, case_sensitive: true, ..params("FOO") };
        assert_eq!(text_hits("foo FOO", &p).len(), 1);
    }

    #[test]
    fn regexp_invalid_reports_error() {
        let p = SearchParams { regexp: true, ..params("(unclosed") };
        assert!(build_matcher(&p).is_err());
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
    fn head_is_binary_respects_bom_before_nul() {
        /* UTF-16LE BOM 优先：文本遍布 NUL 不是二进制 */
        assert!(!head_is_binary(&[0xFF, 0xFE, 0x68, 0x00]));
        assert!(!head_is_binary(&[0xFE, 0xFF, 0x00, 0x68]));
        assert!(!head_is_binary(&[0xEF, 0xBB, 0xBF, b'a', 0]));
        /* 无 BOM：头部含 NUL 即二进制 */
        assert!(head_is_binary(&[b'a', 0, b'b']));
        assert!(!head_is_binary(b"plain text"));
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
    fn walk_dir_subdirs_ascending_order() {
        let dir = temp_dir("suborder");
        for name in ["b", "a"] {
            fs::create_dir(dir.join(name)).unwrap();
            fs::write(dir.join(name).join("f.txt"), "hit").unwrap();
        }
        let result = walk_dir(&dir, &params("hit"), 100, 100, SEARCH_FILE_SIZE_CAP);
        assert_eq!(result.matches.len(), 2);
        assert!(result.matches[0].path.ends_with("a\\f.txt") || result.matches[0].path.ends_with("a/f.txt"));
        assert!(result.matches[1].path.ends_with("b\\f.txt") || result.matches[1].path.ends_with("b/f.txt"));
    }

    #[test]
    fn walk_dir_utf16le_bom_text_is_searched() {
        /* 带 BOM 的 UTF-16 文本字节流遍布 NUL：BOM 判定优先于 NUL，不得按二进制跳过 */
        let dir = temp_dir("utf16");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "hello 闪电".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(dir.join("u16.txt"), &bytes).unwrap();
        let result = walk_dir(&dir, &params("闪电"), 100, 100, SEARCH_FILE_SIZE_CAP);
        assert_eq!(result.skipped_binary, 0);
        assert_eq!(result.files_scanned, 1);
        assert_eq!(result.match_total, 1);
        assert_eq!(result.matches[0].line, 1);
        assert!(result.matches[0].text.contains("闪电"));
    }

    #[test]
    fn walk_dir_binary_with_needle_inside_is_skipped() {
        /* 大块二进制（前 8KB 含 NUL）即使后段有文本样字节也跳过 */
        let dir = temp_dir("bigbin");
        let mut bytes = vec![0u8; 16384];
        bytes.extend_from_slice(b"needle");
        fs::write(dir.join("x.bin"), &bytes).unwrap();
        let result = walk_dir(&dir, &params("needle"), 100, 100, SEARCH_FILE_SIZE_CAP);
        assert_eq!(result.skipped_binary, 1);
        assert_eq!(result.match_total, 0);
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

    #[test]
    fn walk_dir_empty_file_counted_not_matched() {
        let dir = temp_dir("emptyfile");
        fs::write(dir.join("e.txt"), "").unwrap();
        let result = walk_dir(&dir, &params("x"), 100, 100, SEARCH_FILE_SIZE_CAP);
        assert_eq!(result.files_scanned, 1);
        assert_eq!(result.match_total, 0);
    }

    #[test]
    fn walk_dir_pre_cancelled_flags_and_scans_nothing() {
        let dir = temp_dir("cancel");
        fs::write(dir.join("a.txt"), "hit\nhit").unwrap();
        let control = ScanControl::new(1);
        control.run.cancel.store(true, Ordering::Relaxed);
        let result = walk_dir_scanning(&dir, &params("hit"), 100, 100, SEARCH_FILE_SIZE_CAP, Some(&control));
        assert!(result.cancelled);
        assert_eq!(result.match_total, 0);
        assert_eq!(result.matches.len(), 0);
        assert_eq!(result.files_scanned, 0);
    }

    #[test]
    fn walk_dir_with_control_counts_progress_over_all_files() {
        let dir = temp_dir("progress");
        fs::write(dir.join("a.txt"), "hit").unwrap();
        fs::write(dir.join("b.bin"), vec![b'x', 0, b'y']).unwrap();
        let control = ScanControl::new(2);
        let result = walk_dir_scanning(&dir, &params("hit"), 100, 100, SEARCH_FILE_SIZE_CAP, Some(&control));
        assert!(!result.cancelled);
        assert_eq!(result.match_total, 1);
        /* 进度计数覆盖全部枚举文件（含二进制跳过），快照与原子计数同源 */
        assert_eq!(control.files_total.load(Ordering::Relaxed), 2);
        assert_eq!(control.files_done.load(Ordering::Relaxed), 2);
        assert_eq!(control.match_total.load(Ordering::Relaxed), 1);
        let snapshot = control.run.progress.lock().unwrap();
        assert_eq!((snapshot.files_done, snapshot.files_total, snapshot.match_total), (2, 2, 1));
    }

    #[test]
    fn cancel_command_sets_flag_by_id() {
        let control = ScanControl::new(77);
        if let Ok(mut map) = registry().lock() {
            map.insert(77, control.run());
        }
        search_in_dir_cancel(77);
        assert!(control.cancelled());
        if let Ok(mut map) = registry().lock() {
            map.remove(&77);
        }
    }

    #[test]
    fn progress_command_returns_snapshot_or_none() {
        let control = ScanControl::new(78);
        assert_eq!(search_in_dir_progress(78), None);
        if let Ok(mut map) = registry().lock() {
            map.insert(78, control.run());
        }
        let p = search_in_dir_progress(78).expect("registered");
        assert_eq!((p.id, p.files_done, p.files_total), (78, 0, 0));
        if let Ok(mut map) = registry().lock() {
            map.remove(&78);
        }
    }

    #[test]
    fn cancel_command_unknown_id_is_noop() {
        search_in_dir_cancel(u64::MAX);
    }

    /// 真实目录性能观测（不进 CI）：
    /// cargo test --release search_real_dir_perf -- --ignored --nocapture
    #[test]
    #[ignore = "真实目录性能观测，需本机存在该目录"]
    fn search_real_dir_perf() {
        let root = Path::new(r"E:\test\GF2_extract\output");
        if !root.is_dir() {
            eprintln!("skip: {root:?} 不存在");
            return;
        }
        let t0 = std::time::Instant::now();
        let r = walk_dir(root, &params("闪电"), SEARCH_FILE_COUNT_CAP, SEARCH_RESULT_CAP, SEARCH_FILE_SIZE_CAP);
        eprintln!(
            "耗时 {:?} | 命中 {} 处 / {} 文件 | 扫描 {} 文件 | 跳过 二进制 {} 大文件 {} | truncated={} error={:?}",
            t0.elapsed(), r.match_total, r.files_matched, r.files_scanned,
            r.skipped_binary, r.skipped_large, r.truncated, r.error
        );
    }
}
