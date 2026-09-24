//! 桌面标签看板与**根外文件白名单**（设计稿 §6.1 / §6.3，v1.5 阶段 3）。
//!
//! 服务端是进程级单例（一个端口），但标签页状态活在**各窗口的前端**里。
//! 所以这里是一份「每个窗口报上来的那一份状态」，命令面按聚焦窗口取列表、
//! 按所有活窗口取白名单（两者的取舍理由见 [`Board::scope`] 与 [`Board::set_tabs`]）。
//!
//! 白名单是共享根之外的第二道暴露面，判据只有一句：**桌面上确实开着这个标签**。
//! 与 `roots.rs` 同级，四条规则各配测试且测试先行：
//! 1. 条目是**具体文件的规范化绝对路径** —— 不给目录、不给通配、不给前缀匹配；
//! 2. 每次 `read` / `write` / `stat` 都**重新 canonicalize 再比对白名单**，
//!    登记那一刻安全不代表现在安全（文件可能被换成指向别处的链接）；
//! 3. 关标签即失效（下一次上报里没有它，条目当场消失）；
//! 4. 引用形态是保留前缀 `@w/<id>/<name>`，**不退回根内解析** ——
//!    语法接缝若"没命中就当普通路径再试一次"，就是一条绕过。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::roots::{self, Reject};

/// 白名单引用的保留首段。协议里的 `relPath` 若以它开头，走白名单而不是走共享根。
pub const OPEN_HEAD: &str = "@w";
/// 引用里的文件标识长度（id 的十六进制位数）。够短到能塞进路径，够长到不必担心撞名。
const OPEN_ID_HEX: usize = 12;

/// 一个窗口报上来的一个标签。`path` 为 None 是「新建还没保存」——
/// 它进列表（用户要看得见桌面上开着什么）但不进白名单（磁盘上根本没有它）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TabReport {
    pub path: Option<String>,
    pub title: String,
    pub language: String,
    pub md_view: String,
    pub dirty: bool,
    pub read_only: bool,
    /// 光标只在激活标签上有值（编辑器只报当前那份），供手机端打开后定位一次
    pub line: u32,
    pub col: u32,
}

/// 一个窗口的上报槽
#[derive(Clone, Debug, Default)]
struct Slot {
    /// 该窗口文件树的根（已 canonicalize 由命令面负责，这里只存不用）
    root: Option<PathBuf>,
    tabs: Vec<TabReport>,
}

/// 一条白名单引用解析出来的两部分
#[derive(Clone, Debug, PartialEq)]
pub struct OpenRef {
    pub id: String,
    /// 只用于展示与语言判定，**不参与解析**
    pub name: String,
}

/// 一次命令面请求所见的暴露面：一个共享根 + 一批白名单文件 + 聚焦窗口的标签列表。
/// 三者都没有时它是默认值，此时所有路径都以 `noroot` / `notopen` 被拒、`tabs` 给一份空列表 ——
/// 不存在「没设根也能读」这条通道。
#[derive(Clone, Debug, Default)]
pub struct Scope {
    pub root: Option<PathBuf>,
    pub opens: HashMap<String, PathBuf>,
    /// 聚焦窗口的标签列表（已按能不能打开标好）。`tabs` 命令直接序列化这一份
    pub tabs: Vec<TabView>,
}

impl Scope {
    /// 只有共享根、没有白名单也没有标签 —— 给命令面的单测用最省事的一份
    pub fn root_only(root: &Path) -> Scope {
        Scope { root: Some(root.to_path_buf()), ..Default::default() }
    }

    /// **共享根之外**还暴露了多少文件。
    ///
    /// 白名单按「桌面上开着什么」登记，与某个具体根无关（根内的文件本来就能通过
    /// `list`/`read` 走到），所以条目里两者混在一起。桌面那行「另外还暴露了 N 个」
    /// 说的必须是根外那部分 —— 把根内的也算进去，明示的数字就比真实情况大，
    /// 而这行存在的目的正是让用户知道自己交出去了几分。
    pub fn outside_open_count(&self) -> usize {
        let Some(root) = self.root.as_deref() else { return self.opens.len() };
        self.opens.values().filter(|p| !roots::is_within(root, p)).count()
    }
}

/// 进程级单例看板。不含锁：外层 `LinkState` 持 `Mutex<Board>`，
/// 这里的每个方法都返回「要不要给对端推一帧」，好让调用方把推送与状态变更放在同一次加锁里。
#[derive(Default)]
pub struct Board {
    windows: HashMap<String, Slot>,
    /// 上报顺序，最后一个是「最近动过的窗口」：没收到焦点事件时按它兜底
    order: Vec<String>,
    focused: Option<String>,
}

/* ------------------------------------------------------------------ 白名单解析 */

/// 白名单标识：规范化路径的 SHA-256 前 12 位十六进制。
/// 由路径决定而不是随机 —— 桌面重启后同一份文件仍是同一个引用，
/// 手机上已打开的标签不会因为一次重启变成孤儿。
pub fn open_id(path: &Path) -> String {
    use ring::digest::{digest, SHA256};
    let bytes = digest(&SHA256, path.as_os_str().as_encoded_bytes());
    bytes
        .as_ref()
        .iter()
        .take(OPEN_ID_HEX / 2)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 这条 `relPath` 是不是白名单引用。只认严格形态：`@w/<12 位小写十六进制>/<名字>`，
/// 三段、顺序固定、名字里不许再带分隔符。任何一点不合就返回 None，
/// 由调用方按普通相对路径处理（那条路会被 `roots::check_rel` 拦住）。
pub fn parse_open_rel(rel: &str) -> Option<OpenRef> {
    let parts: Vec<&str> = rel.split(['/', '\\']).collect();
    if parts.len() != 3 || parts[0] != OPEN_HEAD {
        return None;
    }
    let id = parts[1];
    if id.len() != OPEN_ID_HEX || !id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return None;
    }
    let name = parts[2];
    if name.is_empty() || name.bytes().all(|b| b == b'.') {
        return None;
    }
    Some(OpenRef { id: id.to_string(), name: name.to_string() })
}

/// 白名单引用 → 该文件（已重新 canonicalize 并比对过白名单）。
///
/// 关键是**这一步每次都重新解析**：登记时它是个普通文件，现在它可能已经是
/// 一个指向 `C:\Windows\…` 的符号链接，或者被删了，或者标签早关掉了。
fn resolve_open(scope: &Scope, r: &OpenRef) -> Result<PathBuf, Reject> {
    let stored = scope.opens.get(&r.id).ok_or(Reject::NotOpen)?;
    let canon = match stored.canonicalize() {
        Ok(c) => c,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound) => return Err(Reject::NotOpen),
        Err(e) => return Err(Reject::Io(e.to_string())),
    };
    // 被换成指向别处的链接时，解析结果不再是白名单里的任何一条
    if !scope.opens.values().any(|p| same_path(p, &canon)) {
        return Err(Reject::NotOpen);
    }
    if !canon.is_file() {
        return Err(Reject::Illegal("白名单里的这个条目现在是一个文件夹"));
    }
    Ok(canon)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let (x, y) = (a.as_os_str().as_encoded_bytes(), b.as_os_str().as_encoded_bytes());
    if cfg!(windows) {
        x.eq_ignore_ascii_case(y)
    } else {
        x == y
    }
}

/// 前端报来的路径要成为白名单条目，必须过三道：**是绝对路径**、**能规范化**、**现在是个文件**。
///
/// 绝对性这一道不能省：`canonicalize` 对相对路径是按**进程当前目录**解析的，
/// 一条 `../../Windows/win.ini` 就会绕过整个白名单语义。
/// 驱动器相对写法（`C:tmp\x.md`）也不算绝对，一并拒掉。
fn listed(p: &str) -> Option<PathBuf> {
    let raw = Path::new(p);
    if !raw.is_absolute() {
        return None;
    }
    let canon = raw.canonicalize().ok()?;
    if !canon.is_file() {
        return None;
    }
    Some(canon)
}

/// 命令面唯一的解析入口：白名单引用走 [`resolve_open`]，其余走共享根。
/// 两条路**互斥**：`@w/…` 绝不退回根内解析（见模块注释第 4 条）。
pub fn resolve_in_scope(scope: &Scope, rel: &str) -> Result<PathBuf, Reject> {
    if let Some(r) = parse_open_rel(rel) {
        return resolve_open(scope, &r);
    }
    let root = scope.root.as_deref().ok_or(Reject::NoRoot)?;
    roots::resolve_rel(root, rel)
}

/// 根内文件 → 协议里那种 `/` 分隔的相对路径。根外返回 None（那条路走白名单引用）。
pub fn rel_from_root(root: &Path, target: &Path) -> Option<String> {
    if !roots::is_within(root, target) {
        return None;
    }
    let rest: Vec<String> = target
        .components()
        .skip(root.components().count())
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    Some(rest.join("/"))
}

/* ------------------------------------------------------------------ 看板 */

impl Board {
    /// 记下某个窗口最新的上报，并把它挪到「最近动过」那一位
    fn touch(&mut self, label: &str) -> &mut Slot {
        self.order.retain(|l| l != label);
        self.order.push(label.to_string());
        self.windows.entry(label.to_string()).or_default()
    }

    /// 某窗口的共享根变了没有。根是整棵树的面子，动一下就该让对端重取。
    pub fn set_root(&mut self, label: &str, root: Option<PathBuf>) -> bool {
        let slot = self.touch(label);
        if slot.root != root {
            slot.root = root;
            return true;
        }
        false
    }

    /// 某窗口的标签列表。返回值是「要不要推一帧」，判据是**手机上那份列表看起来变了没**：
    /// 光标不进判据 —— 否则每敲一个字就给对端发一帧，而那正是列表上唯一不变的东西。
    pub fn set_tabs(&mut self, label: &str, tabs: Vec<TabReport>) -> bool {
        let changed = {
            let slot = self.touch(label);
            visible(&slot.tabs) != visible(&tabs)
        };
        // 光标仍然照收：下一次 `tabs` 的响应里要带上它
        if let Some(slot) = self.windows.get_mut(label) {
            slot.tabs = tabs;
        }
        changed
    }

    /// 焦点事件。只有"换了一个窗口"才算变化：聚焦窗口决定列表与共享根，
    /// 这一换可能对端该整个重取，哪怕列表内容恰好一样。
    pub fn focus(&mut self, label: &str) -> bool {
        if !self.windows.contains_key(label) {
            return false;
        }
        if self.focused.as_deref() == Some(label) {
            return false;
        }
        self.focused = Some(label.to_string());
        true
    }

    /// 窗口关掉了：它报的那一份（含根与标签）就此作废
    pub fn close_window(&mut self, label: &str) -> bool {
        let removed = self.windows.remove(label).is_some();
        self.order.retain(|l| l != label);
        if self.focused.as_deref() == Some(label) {
            self.focused = None;
        }
        removed
    }

    /// 当前生效的窗口：聚焦优先；没收到过焦点事件（或聚焦的那个已经关了）时
    /// 取最近动过的那个。一个窗口都没上报过时返回 None。
    pub fn active_label(&self) -> Option<&str> {
        if let Some(f) = self.focused.as_deref() {
            if self.windows.contains_key(f) {
                return Some(f);
            }
        }
        self.order.last().map(|s| s.as_str())
    }

    fn active(&self) -> Option<&Slot> {
        self.active_label().and_then(|l| self.windows.get(l))
    }

    /// 聚焦窗口的共享根。桌面没开文件树 → None → 只暴露白名单里的标签
    /// （设计稿 §2 决策 3 的「没开树就只给当前打开的标签」）。
    pub fn root(&self) -> Option<PathBuf> {
        self.active().and_then(|s| s.root.clone())
    }

    /// 聚焦窗口的标签列表
    pub fn tabs(&self) -> Vec<TabReport> {
        self.active().map(|s| s.tabs.clone()).unwrap_or_default()
    }

    /// 这次请求看到的暴露面。
    ///
    /// 根按聚焦窗口取（用户在哪台窗口上开着树，手机上就是那棵树）；
    /// 白名单按**所有活窗口**取并集 —— 它凭的是「桌面上确实开着这个文件」，
    /// 与哪个窗口聚焦无关。若也按聚焦窗口取，用户在桌面 alt-tab 一下
    /// 就会把手机上正在编辑的那份文件当场抽走。
    pub fn scope(&self) -> Scope {
        let mut opens: HashMap<String, PathBuf> = HashMap::new();
        for slot in self.windows.values() {
            for tab in &slot.tabs {
                let Some(p) = tab.path.as_deref() else { continue };
                // 登记时就规范化：大小写、`\\?\` 前缀、根自身的符号链接都在这一步定形
                let Some(canon) = listed(p) else { continue };
                opens.insert(open_id(&canon), canon);
            }
        }
        let root = self.root();
        let views = self
            .tabs()
            .iter()
            .map(|t| TabView::of(t, root.as_deref(), &opens))
            .collect();
        Scope { root, opens, tabs: views }
    }

}

/// 手机上看到的一行。`rel` 与 `reason` 是一对互斥的输出：
/// 能打开就给引用（根内是相对路径，根外是 `@w/…`），不能打开就给稳定原因码。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabView {
    pub title: String,
    pub language: String,
    pub md_view: String,
    pub dirty: bool,
    pub read_only: bool,
    pub line: u32,
    pub col: u32,
    pub rel: String,
    /// `''`（能打开）| `dirty`（桌面有未保存的修改）| `novirtual`（还没保存到磁盘）
    /// | `missing`（桌面上这个路径现在读不到）
    pub reason: String,
}

impl TabView {
    fn of(t: &TabReport, root: Option<&Path>, opens: &HashMap<String, PathBuf>) -> Self {
        let mut v = TabView {
            title: t.title.clone(),
            language: t.language.clone(),
            md_view: t.md_view.clone(),
            dirty: t.dirty,
            read_only: t.read_only,
            line: t.line,
            col: t.col,
            rel: String::new(),
            reason: String::new(),
        };
        // 无路径优先判：一个「新建还没保存」的标签必然也是脏的，此时说「桌面上有未保存的
        // 修改」会让人以为去存一下就能接管 —— 它压根还没落到磁盘上，要走的是移交语义（阶段 6）。
        let Some(p) = t.path.as_deref() else {
            v.reason = "novirtual".to_string();
            return v;
        };
        // 桌面脏标签不跨设备接管（§2 决策 5）：两端永远只有一份「正在改的内容」。
        // 这里由服务端把 rel 留空，而不是只在手机上置灰 —— 政策要落在能拦住的这一侧。
        if t.dirty {
            v.reason = "dirty".to_string();
            return v;
        }
        let Some(canon) = listed(p) else {
            v.reason = "missing".to_string();
            return v;
        };
        if let Some(root) = root {
            if let Some(rel) = rel_from_root(root, &canon) {
                v.rel = rel;
                return v;
            }
        }
        let id = open_id(&canon);
        if opens.contains_key(&id) {
            let name = canon
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            v.rel = format!("{OPEN_HEAD}/{id}/{name}");
            return v;
        }
        v.reason = "missing".to_string();
        v
    }
}

/// 「看起来变了没」的比较口径：光标不参与。
fn visible(tabs: &[TabReport]) -> Vec<(&Option<String>, &str, &str, &str, bool, bool)> {
    tabs.iter()
        .map(|t| (&t.path, t.title.as_str(), t.language.as_str(), t.md_view.as_str(), t.dirty, t.read_only))
        .collect()
}
