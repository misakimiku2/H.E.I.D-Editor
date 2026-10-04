//! 共享根与路径逃逸防护（设计稿 §4.3）。
//!
//! 这是整个设备互联里唯一「写错就等于把整个磁盘暴露给局域网」的地方，
//! 所以四条拒绝规则各配一条测试，且**测试先于实现**（ROADMAP 阶段 2 的硬顺序）：
//! `..` 穿越 / Windows 盘符切换 / UNC / symlink 指向根外。
//!
//! 规则只有一条主线：**协议里只允许出现相对路径**，服务端解析后一律
//! `canonicalize`，再按「组件」而不是按「字符串前缀」判断是否仍在根内。
//! 用字符串前缀判断会漏掉 `D:\notes` 与 `D:\notes_evil` 这种同前缀的兄弟目录。
//!
//! 两道检查各自都不够：
//! - 只做字面拒绝（`..` / 绝对路径）挡不住根内 symlink 外指；
//! - 只做 `canonicalize` 后比对，会在「目标不存在」时直接失败，也挡不住
//!   `escape/../secret` 这类先把解析器喂给别处的写法。
//! 所以顺序固定为：**字面拒绝 → join → canonicalize → 组件级前缀校验**。
//!
//! 「要新建的那个条目本来还不存在」是这条主线的唯一例外，见 [`resolve_new`]：
//! 那种情况下被 canonicalize 的是**父目录**，名字只当作单段附加 ——
//! 少任何一道都等于把逃逸让给客户端。

use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// 共享根自身必须先规范化一次（服务端存这一份，之后每个请求都拿它当前缀）。
/// 根是符号链接时存的是它指向的真实目录 —— 否则「根内」的判定基准会和对端看到的不一致。
pub fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    let canon = root.canonicalize().map_err(|e| format!("共享根不可用：{e}"))?;
    if !canon.is_dir() {
        return Err("共享根不是一个目录".to_string());
    }
    Ok(canon)
}

/// 把协议里的相对路径解析成根内的绝对路径（已 canonicalize）。
///
/// `root` 必须是 [`canonical_root`] 的返回值。空串表示根本身（`list` 根目录要用）。
pub fn resolve_rel(root: &Path, rel: &str) -> Result<PathBuf, Reject> {
    let parts = check_rel(rel)?;
    let mut joined = root.to_path_buf();
    for p in &parts {
        joined.push(p);
    }
    // reparse point 只有解析之后才露出真目标，所以前缀校验必须在 canonicalize 之后做
    let canon = match joined.canonicalize() {
        Ok(c) => c,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Err(Reject::NotFound)
        }
        Err(e) => return Err(Reject::Io(e.to_string())),
    };
    if !is_within(root, &canon) {
        return Err(Reject::Outside);
    }
    Ok(canon)
}

/// 把「要在根内新建的那个条目」解析成绝对路径（父目录已 canonicalize，末段是名字）。
///
/// 与 [`resolve_rel`] 只差一处、但正是这条路存在的原因：那条以 `canonicalize` 为权威，
/// 而**要新建的目标本来就不存在**，拿它去 canonicalize 必然 `NotFound` ——
/// 于是「手机上写的一份东西存不进电脑的文件夹」。
/// 所以这里的做法是：**父目录**照老规矩走完整四道
/// （字面拒绝 → join → canonicalize → 组件级根内校验，一道不少），**名字**当作单段附加。
/// 名字里不可能有分隔符或 `..`（`check_rel` 已按整串切过段，末段自己再过 [`validate_new_name`]），
/// 所以拼上去不会改变落点；能出去的唯一可能是父目录本身是根内指向根外的链接，
/// 而那正是父目录那一次 canonicalize 挡住的（与 [`resolve_rel`] 同一个论证）。
///
/// 返回的是「父目录（已规范化）+ 名字」拼出来的路径，**没有**对末段做 canonicalize：
/// 它现在还不存在。调用方若发现它其实已经存在（竞态、或桌面刚建了同名的），
/// 要自己按 [`resolve_rel`] 那条路重新解析一遍再看真实形态（见 `fsrv::create`）。
pub fn resolve_new(root: &Path, rel: &str) -> Result<PathBuf, Reject> {
    let parts = check_rel(rel)?;
    let Some((last, parents)) = parts.split_last() else {
        return Err(Reject::Illegal("新建要给出名字"));
    };
    let name = validate_new_name(last)?;
    let mut joined = root.to_path_buf();
    for p in parents {
        joined.push(p);
    }
    let parent = match joined.canonicalize() {
        Ok(c) => c,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Err(Reject::NotFound)
        }
        Err(e) => return Err(Reject::Io(e.to_string())),
    };
    /* `canonicalize` 对**文件**也成功，所以这一步不能省：拿 `readme.md/new.md` 这种写法过来时，
       父目录解析出来就是那份文件本身。老路（[`resolve_rel`]）不会遇到这一种，
       它 canonicalize 的是整条路径，`文件/子项` 在系统调用那一步就断了。
       留在这里的代价不是逃逸（拼出来仍在根内），而是一句谁也看不懂的「写入失败：…」——
       手机上那点保存撞到它，只会以为链路坏了。 */
    if !parent.is_dir() {
        return Err(Reject::Illegal("新建条目的上一层不是文件夹"));
    }
    if !is_within(root, &parent) {
        return Err(Reject::Outside);
    }
    Ok(parent.join(name))
}

/// 新建条目（文件与文件夹共用）的名字校验。**服务端这一份才是权威**：
/// 手机上的输入框不是安全边界，多设备里还有一台是别人写的客户端。
///
/// 口径与前端 `fileTree.ts` 的 `isValidEntryName` 对齐（路径分隔与 Windows 保留字符、
/// 不以点或空格结尾），另补两条前端没有的：控制字符，以及 Windows 的保留设备名 ——
/// `CON.md` 这类在资源管理器里建不出来，从这里建出去就是一颗「写进去了但找不到」的文件。
pub fn validate_new_name(raw: &str) -> Result<String, Reject> {
    if raw.is_empty() || raw != raw.trim() {
        return Err(Reject::Illegal("名字不能为空，首尾也不能是空格"));
    }
    if raw.chars().any(|c| (c as u32) < 0x20) {
        return Err(Reject::Illegal("名字含控制字符"));
    }
    // `:` 与两种分隔符按 `check_rel` 已经出不来了，留在这里是纵深防御：
    // 这个名字校验是独立入口（重命名类命令以后也走它），不依赖调用方先切过段。
    if raw.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(Reject::Illegal("名字含路径分隔符或 Windows 保留字符"));
    }
    if raw.ends_with('.') || raw.ends_with(' ') {
        return Err(Reject::Illegal("名字不能以点或空格结尾"));
    }
    if cfg!(windows) && is_windows_device_name(raw) {
        return Err(Reject::Illegal("名字是 Windows 的保留设备名"));
    }
    Ok(raw.to_string())
}

/// 保留设备名：看第一个点之前那一段，大小写不敏感（`con`、`CoN.txt`、`nul.md` 都不许）。
fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4"
            | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    // 数字后缀的写法（COM10、LPT10）不是保留名，别把它们一起杀了
    reserved
}

/// 第一道：字面检查。返回允许拼进根目录的路径成分。
fn check_rel(rel: &str) -> Result<Vec<&str>, Reject> {
    if rel.contains('\0') {
        return Err(Reject::Illegal("路径含空字符"));
    }
    // 冒号是 Windows 的盘符分隔符，也是 NTFS 交替数据流（`notes.txt:evil`）的分隔符。
    // 合法的相对路径里没有哪种写法需要它，所以整串一律不许出现。
    if rel.contains(':') {
        return Err(Reject::Absolute);
    }
    // 前导分隔符：`/etc/passwd`、`\server\share`、`\\?\C:\…` 都从这里出去
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(Reject::Absolute);
    }
    let mut parts = Vec::new();
    for raw in rel.split(['/', '\\']) {
        match raw {
            // 空段来自重复分隔符、`.` 来自显式的当前目录：都不改变落点
            "" | "." => continue,
            // 纯点段（`..` / `...` / `....`）是向上跳。Windows 语义下不止 `..`
            // 这一个写法，所以按「整段都是点」拒，而不是逐字比 `..`。
            _ if raw.bytes().all(|b| b == b'.') => return Err(Reject::Illegal("不允许上级目录")),
            _ => parts.push(raw),
        }
    }
    Ok(parts)
}

/// `target` 是否落在 `root` 内（含两者相等）。按**组件**比，不按字符串前缀比。
pub fn is_within(root: &Path, target: &Path) -> bool {
    let mut t = target.components();
    root.components().all(|rc| matches!(t.next(), Some(tc) if same_component(rc, tc)))
}

fn same_component(a: Component, b: Component) -> bool {
    let (x, y) = (a.as_os_str().as_encoded_bytes(), b.as_os_str().as_encoded_bytes());
    // Windows 路径不区分大小写；两边虽然都过了 canonicalize（大小写已归一到磁盘形态），
    // 仍按不敏感比，避免根目录被以另一种大小写重新设置时把整棵树判成根外。
    if cfg!(windows) {
        x.eq_ignore_ascii_case(y)
    } else {
        x == y
    }
}

/// 拒绝原因。[`Reject::code`] 是要上线的稳定标识，前端按它出文案。
#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    /// 相对路径里出现了绝对路径特征（盘符 / UNC / 前导分隔符）
    Absolute,
    /// 出现了不允许的成分（`..`、NUL…），值即原因
    Illegal(&'static str),
    /// 语法上没出去，但 canonicalize 之后在根外（symlink 外指）
    Outside,
    /// 根内没有这个目标
    NotFound,
    /// 解析时撞上了别的 I/O 错误（权限、卷离线…）
    Io(String),
    /// 桌面还没设共享根：根内这条路根本没有起点
    NoRoot,
    /// 白名单里没有这条（标签已关，或它已被换成指向别处的链接）
    NotOpen,
}

impl Reject {
    /// 协议里的稳定错误码
    pub fn code(&self) -> &'static str {
        match self {
            Reject::Absolute => "absolute",
            Reject::Illegal(_) => "badpath",
            Reject::Outside => "outside",
            Reject::NotFound => "notfound",
            Reject::Io(_) => "io",
            Reject::NoRoot => "noroot",
            Reject::NotOpen => "notopen",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Reject::Absolute => "路径必须是共享根内的相对路径".to_string(),
            Reject::Illegal(why) => format!("路径不合法：{why}"),
            Reject::Outside => "该路径经符号链接指向了共享范围之外，已拒绝".to_string(),
            Reject::NotFound => "共享根内没有这个文件".to_string(),
            Reject::Io(e) => format!("路径解析失败：{e}"),
            Reject::NoRoot => "桌面还没设置共享的文件夹".to_string(),
            // 这一条把两种成因并到一个码上：关标签（授权当场收回）与条目被换掉
            // （白名单里那个路径现在指向别处）。对端要做的都是同一件事 —— 别再重试。
            Reject::NotOpen => "桌面已不再把这个文件作为打开的标签暴露（标签关掉了，或它已被替换）".to_string(),
        }
    }
}
