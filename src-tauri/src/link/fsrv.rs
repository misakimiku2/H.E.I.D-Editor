//! 远程文件命令（阶段 2）：`list` / `stat` / `read` / `write`。
//!
//! 服务端**不重写文件逻辑**（设计稿 §4.2）：解码走 [`encoding::detect_and_decode`]、
//! 编码写回走 [`encoding::encode_text`]。手机因此拿到与桌面逐字一致的编码 / BOM /
//! 二进制判定，不必退回 `fileIO.ts` 里那条 JS 启发式检测的降级路径。
//!
//! 一条与 §4.2 有出入的定稿（2026-09-24 实测后记在 ROADMAP）：
//! **换行符不进协议**。桌面侧 eol 的权威判据本就是前端的
//! [`lineEndings.detectLineEnding`] + 落盘前 [`lineEndings.applyLineEnding`]，
//! 远程读取走的是同一个 `openedFromDecoded`，所以服务端再算一份只会多出第二个口径。
//! 同理 `write` 收到的 `text` 已是调用方按 eol 还原过的最终字节序列，服务端只负责编码与落盘。
//!
//! 基线判定也只用内容哈希、不用 mtime：同秒内的两次保存 mtime 分得出来但粒度不可信，
//! 拿它判等会在桌面刚改过的瞬间静默覆盖掉桌面的改动。`mtimeMs` 只用于展示。

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::encoding;

use super::board::{self, Scope};

/// 不远程打开的上限。设计稿写的是 32MB（那是桌面「可读但只读」的分块预览线），
/// 但远程通道没有分块协议（§5.3 明确不做），而整份内容要走完两个更硬的天花板：
/// 单帧上限 [`MAX_FRAME_BYTES`]，以及编辑器自身的 200 万字符可编辑线
/// （`tabModel.ts` 之上只读，而只读的分块预览在手机上不存在）。
/// 6MB 正好是 200 万字符的最坏情况（CJK 一字 3 字节），超过它，
/// 手机即使拿到内容也只能进一个既不能编辑又不能分块预览的死角。
pub const MAX_REMOTE_FILE_BYTES: u64 = 6 * 1024 * 1024;
/// 一次 `list` 返回的条目上限。共享根可能就是 `node_modules`，
/// 全量返回既撑爆帧也让手机侧栏白屏一次；超限如实标 `truncated`。
pub const MAX_LIST_ENTRIES: usize = 3000;

/// 请求处理结果：`Ok(JSON)` 直接作为响应 `data`；`Err((稳定码, 给人看的原因))`。
pub type Handled = Result<String, (String, String)>;

pub fn err(code: &str, msg: impl Into<String>) -> (String, String) {
    (code.to_string(), msg.into())
}

/* ------------------------------------------------------------------ 参数与结果 */

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ListParams {
    pub rel_dir: String,
}

/// 目录条目。`relPath` 由手机侧按「请求的目录 + 名字」自己拼，
/// 服务端不重复发一份完整相对路径，省帧也省掉两处拼法不一致的可能。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResult {
    entries: Vec<Entry>,
    truncated: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PathParams {
    pub rel_path: String,
    /// 与桌面「以编码重新打开」同一语义：指定后不再检测
    pub force_encoding: Option<String>,
    /// 写回用的内容基线：`read` 时拿到的那一份哈希
    pub base_hash: String,
    pub text: String,
    pub encoding: String,
    pub bom: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatResult {
    size: u64,
    mtime_ms: i64,
    is_dir: bool,
    /// 目录与超限文件为空串（超限文件哈希没意义，也别为它读一遍全文件）
    hash: String,
}

/// `read` 的载荷：`Decoded` 摊平 + 基线三元组，前端直接喂给 `openedFromDecoded`
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    #[serde(flatten)]
    decoded: encoding::Decoded,
    hash: String,
    size: u64,
    mtime_ms: i64,
}

/// `write` 的两种结局走同一个结构：`conflict` 为真时带服务端当前内容，
/// 前端据此进既有 diff 时间线逐条采纳（不做自动三方合并）。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct WriteResult {
    conflict: bool,
    hash: String,
    size: u64,
    mtime_ms: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    server_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_encoding: Option<String>,
    server_bom: bool,
    server_binary: bool,
}

/* ------------------------------------------------------------------ 分发 */

/// 执行一条远程文件命令。`scope` 是这一刻的暴露面（[`board::Board::scope`]）：
/// 聚焦窗口的共享根 + 所有活窗口的白名单 + 聚焦窗口的标签列表。
/// 根与白名单都没有时，文件类命令以 `noroot` / `notopen` 拒绝。
///
/// 这里**不碰网络也不碰会话**：给什么参数就返回什么结果，
/// 因此单测可以不开一个 socket 就把命令面全部跑完。
pub fn handle(scope: &Scope, method: &str, params: &str) -> Handled {
    match method {
        "list" => {
            let p: ListParams = parse(params)?;
            list(scope, &p.rel_dir)
        }
        "stat" => {
            let p: PathParams = parse(params)?;
            stat(scope, &p.rel_path)
        }
        "read" => {
            let p: PathParams = parse(params)?;
            read(scope, &p.rel_path, p.force_encoding.as_deref())
        }
        "write" => {
            let p: PathParams = parse(params)?;
            write(scope, p)
        }
        // 桌面正打开着哪些标签：无参，内容已由看板算好（能不能打开、为什么不能都在里面）
        "tabs" => serde_json::to_string(&scope.tabs)
            .map_err(|e| err("io", format!("标签列表序列化失败：{e}"))),
        other => Err(err("unknown", format!("桌面不支持的命令 {other}"))),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: &str) -> Result<T, (String, String)> {
    serde_json::from_str(params).map_err(|e| err("badparams", format!("参数解析失败：{e}")))
}

/* ------------------------------------------------------------------ 各命令 */

fn list(scope: &Scope, rel_dir: &str) -> Handled {
    let dir = resolve_dir(scope, rel_dir)?;
    let mut entries: Vec<Entry> = Vec::new();
    let mut truncated = false;
    let read_dir = std::fs::read_dir(&dir).map_err(|e| err("io", format!("列目录失败：{e}")))?;
    for item in read_dir {
        let Ok(item) = item else { continue }; // 单项读不到（竞态删除）跳过，不因此废整次列举
        let name = match item.file_name().to_str() {
            Some(s) => s.to_string(),
            // 路径成分不是合法 UTF-8 时无法进 JSON，跳过它比塞一份有损的名字诚实
            None => continue,
        };
        let meta = item.metadata().map_err(|e| err("io", format!("读属性失败：{e}")))?;
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(Entry {
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime_ms: mtime_of(&meta),
            name,
        });
    }
    // 与桌面文件树同一排序口径：目录在前、名字不区分大小写
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| cmp_name(&a.name, &b.name)));
    serde_json::to_string(&ListResult { entries, truncated })
        .map_err(|e| err("io", format!("结果序列化失败：{e}")))
}

fn cmp_name(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

fn stat(scope: &Scope, rel: &str) -> Handled {
    let path = resolve(scope, rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| err("io", format!("读属性失败：{e}")))?;
    let is_dir = meta.is_dir();
    let size = meta.len();
    let hash = if is_dir || size > MAX_REMOTE_FILE_BYTES { String::new() } else { hash_file(&path)? };
    serde_json::to_string(&StatResult { size, mtime_ms: mtime_of(&meta), is_dir, hash })
        .map_err(|e| err("io", e.to_string()))
}

fn read(scope: &Scope, rel: &str, force: Option<&str>) -> Handled {
    let path = resolve(scope, rel)?;
    let bytes = std::fs::read(&path).map_err(|e| err("io", format!("读取失败：{e}")))?;
    if (bytes.len() as u64) > MAX_REMOTE_FILE_BYTES {
        /* 这里**不报尺寸**：整除出来的 MB 会把"7,000,000 字节的文件"和"6 MB 的上限"
           显示成同一个数（2026-09-25 实测的 (d)：「这个文件 6 MB，超过上限 6 MB」）。
           尺寸只有一个口径 —— 前端 `largeFile.formatBytes`，
           打开路径上的那份预检（`useFileActions` 的 remote.errTooLarge）才是带数字的那句。 */
        return Err(err("toobig", "这个文件超过手机可远程打开的上限，桌面没有读取它"));
    }
    let decoded = match force {
        Some(label) => {
            let (text, bom, lossy) = encoding::decode_as(&bytes, label);
            encoding::Decoded { text, encoding: label.to_string(), bom, lossy, binary: false }
        }
        None => encoding::detect_and_decode(&bytes),
    };
    let hash = sha256_hex(&bytes);
    let mtime_ms = file_mtime(&path)?;
    serde_json::to_string(&ReadResult { decoded, hash, size: bytes.len() as u64, mtime_ms })
        .map_err(|e| err("io", e.to_string()))
}

fn write(scope: &Scope, p: PathParams) -> Handled {
    // 基线必填。留空即跳判等于给出一条「手机没说基线 → 桌面内容被静默覆盖」的通道，
    // 而这条链路上每次 `read` 都会带回哈希，不存在 legitimately 没有基线的写。
    if p.base_hash.is_empty() {
        return Err(err("badparams", "缺少内容基线（read 返回的 hash）"));
    }
    let path = resolve(scope, &p.rel_path)?;
    if path.is_dir() {
        return Err(err("badpath", "这是一个文件夹，不能当作文件保存"));
    }
    let current = std::fs::read(&path).map_err(|e| err("io", format!("读取失败：{e}")))?;
    let cur_hash = sha256_hex(&current);
    if cur_hash != p.base_hash {
        // 桌面在这期间改过：把服务端最新内容一并回传，前端进 diff 时间线由用户逐条采纳。
        // 但**超过远程上限的那一份不带正文**（阶段 5 补的）：冲突回包要走同一帧通道，
        // 而单帧上限 8 MB —— 桌面把一个 6 MB 的文件改到 40 MB 之后，带上正文就等于
        // 「手机的一条待回放把整条链路撑断」，剩下所有条目一起失败。
        // 没有正文不影响裁决：手机知道冲突存在，尺寸与哈希也照报。
        let fits = current.len() as u64 <= MAX_REMOTE_FILE_BYTES;
        let d = fits.then(|| encoding::detect_and_decode(&current));
        return serde_json::to_string(&WriteResult {
            conflict: true,
            server_hash: cur_hash.clone(),
            server_text: d.as_ref().map(|x| x.text.clone()),
            server_encoding: d.as_ref().map(|x| x.encoding.clone()),
            server_bom: d.map(|x| x.bom).unwrap_or(false),
            server_binary: encoding::is_binary(&current),
            hash: cur_hash,
            size: current.len() as u64,
            mtime_ms: file_mtime(&path).unwrap_or(0),
        })
        .map_err(|e| err("io", e.to_string()));
    }
    let bytes = encoding::encode_text(&p.text, &p.encoding, p.bom).map_err(|e| err("io", e))?;
    if (bytes.len() as u64) > MAX_REMOTE_FILE_BYTES {
        return Err(err("toobig", "内容超过远程写入上限".to_string()));
    }
    std::fs::write(&path, &bytes).map_err(|e| err("io", format!("写入失败：{e}")))?;
    let hash = sha256_hex(&bytes);
    serde_json::to_string(&WriteResult {
        conflict: false,
        size: bytes.len() as u64,
        mtime_ms: file_mtime(&path).unwrap_or(0),
        hash,
        server_hash: String::new(),
        ..Default::default()
    })
    .map_err(|e| err("io", e.to_string()))
}

/* ------------------------------------------------------------------ 工具 */

/// 解析 + 逃逸校验（[`board::resolve_in_scope`] 是命令面唯一的入口：
/// 白名单引用与共享根两条路在那里分岔，且互斥）。
fn resolve(scope: &Scope, rel: &str) -> Result<std::path::PathBuf, (String, String)> {
    board::resolve_in_scope(scope, rel).map_err(|r| err(r.code(), r.message()))
}

/// 只有目录类命令（`list`）用它：白名单条目凭定义是**文件**，拿它当目录列举是误用，
/// 与其让 `read_dir` 抛一个含糊的 io 错误，不如在这里按同一套码说清。
fn resolve_dir(scope: &Scope, rel: &str) -> Result<std::path::PathBuf, (String, String)> {
    if board::parse_open_rel(rel).is_some() {
        return Err(err("badpath", "桌面上打开的这个标签是一个文件，不能当目录列举"));
    }
    resolve(scope, rel)
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn file_mtime(path: &Path) -> Result<i64, (String, String)> {
    std::fs::metadata(path)
        .map(|m| mtime_of(&m))
        .map_err(|e| err("io", format!("读时间戳失败：{e}")))
}

/// 内容基线：SHA-256 十六进制。`ring::digest` 已在依赖里（随 `ring` 的 AEAD 一起编进包），
/// 不新增 crate。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use ring::digest::{digest, SHA256};
    digest(&SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_file(path: &Path) -> Result<String, (String, String)> {
    let bytes = std::fs::read(path).map_err(|e| err("io", format!("读取失败：{e}")))?;
    Ok(sha256_hex(&bytes))
}
