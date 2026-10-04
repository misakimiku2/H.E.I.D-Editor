//! 路径逃逸防护测试（设计稿 §4.3）。**先于实现**写好，是 ROADMAP 阶段 2 的硬顺序：
//! 这一层写错就等于把整个磁盘暴露给局域网，所以四类逃逸各一条，另加两条
//! 「看着安全其实不安全」的（同前缀兄弟目录、绕过 canonicalize 的 symlink）。
//!
//! 这些测试都只在临时目录里建文件，且把「根外」的目录做成根目录的**兄弟**，
//! 这样符号链接的目标也在同一个待清理的临时子树内，不会碰到真实用户文件。
//!
//! `resolve_new`（新建那条路）与它共用这批靶子：要新建的目标本来就不存在，
//! canonicalize 只能作用在**父目录**上，所以四类逃逸在这里必须一条都不少地重跑一遍。

use super::roots::{canonical_root, is_within, resolve_new, resolve_rel, validate_new_name};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static SEQ: AtomicUsize = AtomicUsize::new(0);

/// 一个临时子树：`base/shared`（共享根）+ `base/outside`（根外，用来当逃逸靶子）。
pub(crate) struct Temp {
    pub(crate) base: PathBuf,
}

impl Temp {
    pub(crate) fn new(tag: &str) -> Self {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("heid-roots-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("shared/sub")).expect("建临时根失败");
        std::fs::create_dir_all(base.join("outside")).expect("建临时靶子失败");
        std::fs::write(base.join("shared/readme.md"), b"# hi").expect("建临时文件失败");
        std::fs::write(base.join("shared/sub/notes.txt"), b"notes").expect("建临时文件失败");
        std::fs::write(base.join("outside/secret.txt"), b"secret").expect("建靶子文件失败");
        Temp { base }
    }

    /// 已 canonicalize 的共享根 —— 服务端实际存的就是这一份
    pub(crate) fn root(&self) -> PathBuf {
        canonical_root(&self.base.join("shared")).expect("canonicalize 临时根失败")
    }

    /// 在共享根里写一个文件（`rel` 用 `/` 分隔），返回 canonicalize 之后的路径
    pub(crate) fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let p = self.root().join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).expect("建子目录失败");
        }
        std::fs::write(&p, bytes).expect("写文件失败");
        p
    }

    /// 共享根里某个文件的当前字节
    pub(crate) fn read(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.root().join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).expect("读文件失败")
    }

    fn touch_outside(&self, name: &str) -> PathBuf {
        let p = self.base.join("outside").join(name);
        std::fs::write(&p, b"x").expect("写靶子文件失败");
        p
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        // 符号链接按普通条目删除，remove_dir_all 不会跟进去删真实目标
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// 造一个「根内指向根外」的链接。没有建链权限（Windows 未开开发者模式）时跳过该用例
/// 并返回 `None`——跳过要显眼，别让它静默变成一条通过的空测试。
/// 只规范化、不做「必须是目录」的判断（测试里拿它算期望值）
pub(crate) fn canon(p: impl AsRef<Path>) -> PathBuf {
    p.as_ref().canonicalize().expect("canonicalize 期望值失败")
}

pub(crate) fn link(src_dir: &Path, target_dir: &Path, name: &str) -> Option<PathBuf> {
    let link = src_dir.join(name);
    let r = std::fs::remove_file(&link).or_else(|_| std::fs::remove_dir(&link));
    let _ = r;
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(target_dir, &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target_dir, &link);
    #[cfg(not(any(windows, unix)))]
    let made: Result<(), std::io::Error> = Err(std::io::Error::other("本平台不支持建符号链接"));
    match made {
        Ok(()) => Some(link),
        Err(e) => {
            eprintln!("跳过符号链接用例（无法创建链接：{e}）。这条防护在该次运行里未被检验。");
            None
        }
    }
}

/* ------------------------------------------------------------ 合法路径 */

#[test]
fn 根内相对路径解析到根内的绝对路径() {
    let t = Temp::new("ok");
    let got = resolve_rel(&t.root(), "sub/notes.txt").expect("合法路径不该被拒");
    assert_eq!(got, canon(t.base.join("shared/sub/notes.txt")));
    // 反斜杠同样当分隔符（手机与桌面的输入法都可能给出）
    assert_eq!(resolve_rel(&t.root(), r"sub\notes.txt").unwrap(), got);
}

#[test]
fn 空相对路径就是共享根本身() {
    let t = Temp::new("empty");
    assert_eq!(resolve_rel(&t.root(), "").unwrap(), t.root());
    assert_eq!(resolve_rel(&t.root(), ".").unwrap(), t.root());
}

#[test]
fn 点号与重复分隔符被规范化后仍在根内() {
    let t = Temp::new("dots");
    let want = canon(t.base.join("shared/sub/notes.txt"));
    for rel in ["./sub/notes.txt", "sub/./notes.txt", "sub//notes.txt", "sub/../sub/notes.txt"] {
        // 注意最后一条含 `..`，必须被拒；其余三条应解析成功
        if rel.contains("..") {
            assert!(resolve_rel(&t.root(), rel).is_err(), "{rel} 不该放行");
        } else {
            assert_eq!(resolve_rel(&t.root(), rel).unwrap(), want, "{rel} 解析错了");
        }
    }
}

/* ------------------------------------------------------------ 四类逃逸 */

#[test]
fn 穿越到根外被拒() {
    let t = Temp::new("traverse");
    t.touch_outside("more.txt");
    for rel in [
        "../outside/secret.txt",
        "sub/../../outside/secret.txt",
        "..",
        "..\\",
        "a/../..",
    ] {
        assert_eq!(
            resolve_rel(&t.root(), rel).err().map(|r| r.code()),
            Some("badpath"),
            "`{rel}` 应被拒，却放行或返回了别的错误码"
        );
    }
}

#[test]
fn 绝对路径与盘符切换被拒() {
    let t = Temp::new("absolute");
    #[cfg(windows)]
    let cases = ["C:\\Windows\\win.ini", "C:Windows\\win.ini", "D:/x", "C:/", "\\:\\evil"];
    #[cfg(not(windows))]
    let cases = ["/etc/passwd", "C:Windows", "/"];
    for rel in cases {
        assert_eq!(
            resolve_rel(&t.root(), rel).err().map(|r| r.code()),
            Some("absolute"),
            "`{rel}` 是绝对路径特征，必须以 absolute 拒掉"
        );
    }
    // 前导分隔符（含单反斜杠开头的 Windows UNC 尾巴）也算绝对
    assert_eq!(resolve_rel(&t.root(), "/etc/passwd").err().map(|r| r.code()), Some("absolute"));
}

#[test]
fn unc路径被拒() {
    let t = Temp::new("unc");
    for rel in [
        r"\\server\share\secret.txt",
        "//server/share/secret.txt",
        r"\\?\C:\Windows\win.ini",
        r"\\.\PhysicalDrive0",
    ] {
        assert_eq!(
            resolve_rel(&t.root(), rel).err().map(|r| r.code()),
            Some("absolute"),
            "`{rel}` 是 UNC / 设备命名空间，必须以 absolute 拒掉"
        );
    }
}

#[test]
fn symlink指向根外被拒() {
    let t = Temp::new("symlink");
    let root = t.root();
    if link(&root, &t.base.join("outside"), "escape").is_none() {
        return;
    }
    t.touch_outside("via-link.txt");
    for rel in ["escape/via-link.txt", "escape"] {
        let err = resolve_rel(&root, rel).err();
        assert!(
            matches!(err.as_ref().map(|r| r.code()), Some("outside") | Some("notfound")),
            "穿过指向根外的链接 `{rel}` 必须被拒，实际：{err:?}"
        );
    }
    // 同一条链接若指向根内，则应当放行（证明拒绝的是「出去」而不是「链接本身」）
    if link(&root, &root.join("sub"), "inside-link").is_some() {
        assert!(resolve_rel(&root, "inside-link/notes.txt").is_ok(), "根内链接不该被误杀");
    }
}

#[test]
fn 符号链接逃逸的判定来自磁盘真实形态而非字面() {
    // 这一条专门盯住「只查字面就以为安全」的实现：
    // 字面 `escape/../shared/readme.md` 里有 `..`，会被语法层先拒；
    // 真目标则靠 canonicalize 后的组件比较兜住。
    let t = Temp::new("real-form");
    let root = t.root();
    if link(&root, &t.base.join("outside"), "out").is_none() {
        return;
    }
    assert_eq!(resolve_rel(&root, "out/../out/secret.txt").err().map(|r| r.code()), Some("badpath"));
    assert_eq!(resolve_rel(&root, "out/secret.txt").err().map(|r| r.code()), Some("outside"));
}

/* ------------------------------------------------------------ 前缀判定 */

#[test]
fn 同前缀的兄弟目录不算根内() {
    let t = Temp::new("prefix");
    let sibling = t.base.join("shared_evil");
    std::fs::create_dir_all(&sibling).unwrap();
    std::fs::write(sibling.join("x.txt"), b"x").unwrap();
    let root = t.root();
    let other = canon(sibling.join("x.txt"));
    assert!(
        !is_within(&root, &other),
        "`{}` 与 `{}` 只是字符串前缀关系，不是根内关系",
        root.display(),
        other.display()
    );
    assert!(is_within(&root, &root), "根本身算根内（list 根目录要用）");
    let inner = canon(root.join("sub"));
    assert!(is_within(&root, &inner));
}

#[test]
fn 非法成分被拒() {
    let t = Temp::new("illegal");
    // NUL：防止把 `notes.txt\0evil` 之类的截断手法送进文件系统
    assert_eq!(resolve_rel(&t.root(), "notes.txt\0.md").err().map(|r| r.code()), Some("badpath"));
    // 冒号：Windows 的盘符与交替数据流分隔符，一律不允许出现在相对路径里
    assert_eq!(resolve_rel(&t.root(), "sub:x.txt").err().map(|r| r.code()), Some("absolute"));
}

/* ------------------------------------------------------------ 新建（目标还不存在） */

#[test]
fn 新建能解析出还不存在的路径() {
    let t = Temp::new("new-ok");
    let root = t.root();
    // 子目录里新建：父目录 canonicalize，末段原样附加
    let sub = canon(t.base.join("shared/sub"));
    assert_eq!(resolve_new(&root, "sub/new.md").expect("合法的新建不该被拒"), sub.join("new.md"));
    // 直接在根下新建（只有一段）
    assert_eq!(resolve_new(&root, "new.md").unwrap(), root.join("new.md"));
    // 反斜杠同样当分隔符（手机输入法与桌面都可能给出）
    assert_eq!(resolve_new(&root, r"sub\new.md").unwrap(), sub.join("new.md"));
    // **这一条就是 resolve_new 存在的全部理由**：同一条路径走老路必然失败
    assert!(resolve_rel(&root, "sub/new.md").is_err(), "老路对还不存在的路径必须判失败");
    // 解析出来的路径按老规矩仍在根内
    assert!(is_within(&root, &resolve_new(&root, "sub/new.md").unwrap()));
    // 拼出来的是**真能写**的路径（防「解析对了但拼不出可用形态」）
    std::fs::write(resolve_new(&root, "sub/writable.md").unwrap(), b"ok").expect("按解析结果写盘失败");
    assert_eq!(t.read("sub/writable.md"), b"ok");
}

#[test]
fn 新建的父目录不存在或不是目录时明确拒绝() {
    let t = Temp::new("new-parent");
    let root = t.root();
    assert_eq!(resolve_new(&root, "nope/new.md").err().map(|r| r.code()), Some("notfound"));
    // 再深一层：只有中间那段不存在也是同一句「那个文件夹不在」
    assert_eq!(resolve_new(&root, "nope/deep/new.md").err().map(|r| r.code()), Some("notfound"));
    // 拿文件当父目录：`canonicalize` 对文件是**成功**的，所以这一种必须由「上一层是目录」
    // 这一道单独挡掉（老路 canonicalize 的是整条路径，系统调用那一步就断了）
    assert_eq!(
        resolve_new(&root, "readme.md/new.md").err().map(|r| r.code()),
        Some("badpath"),
        "上一层是文件时不能给出一句「写入失败：…」"
    );
}

#[test]
fn 新建要给出名字() {
    let t = Temp::new("new-name");
    // 切完段什么都不剩 = 没有要建的那个名字
    for rel in ["", ".", "./", "sub/.."] {
        let got = resolve_new(&t.root(), rel).err().map(|r| r.code());
        // `sub/..` 里带 `..`，字面那道就先拒了；另三条倒在「要给一个名字」
        assert_eq!(got, Some("badpath"), "`{rel}` 里根本没有要建的那个名字，实际：{got:?}");
    }
    // 前导分隔符是绝对路径特征，走的是另一条码
    for rel in ["/", "//"] {
        assert_eq!(
            resolve_new(&t.root(), rel).err().map(|r| r.code()),
            Some("absolute"),
            "`{rel}` 必须以 absolute 拒掉"
        );
    }
}

#[test]
fn 新建也挡得住那四类逃逸() {
    let t = Temp::new("new-escape");
    let root = t.root();
    for rel in ["../outside/new.txt", "sub/../../outside/new.txt", "..", "..\\", "a/../.."] {
        assert_eq!(
            resolve_new(&root, rel).err().map(|r| r.code()),
            Some("badpath"),
            "`{rel}` 有向上跳的段，必须以 badpath 拒掉"
        );
    }
    #[cfg(windows)]
    let absolutes = ["C:\\Windows\\new.ini", "D:/new", r"\\server\share\new.txt", r"\\?\C:\x"];
    #[cfg(not(windows))]
    let absolutes = ["/etc/new.passwd", r"\\server\share\new.txt"];
    for rel in absolutes {
        assert_eq!(
            resolve_new(&root, rel).err().map(|r| r.code()),
            Some("absolute"),
            "`{rel}` 是绝对路径特征，必须以 absolute 拒掉"
        );
    }
    // 根内指向根外的链接当父目录：字面看不出来，靠父目录那一次 canonicalize 兜住
    if link(&root, &t.base.join("outside"), "escape").is_some() {
        assert_eq!(resolve_new(&root, "escape/new.txt").err().map(|r| r.code()), Some("outside"));
    }
}

/* ------------------------------------------------------------ 名字校验（服务端权威） */

#[test]
fn 名字校验与前端同一口径并多挡控制字符() {
    // 与 fileTree.ts 的 isValidEntryName 同一条：分隔符与 Windows 保留字符
    for bad in ["a*b.md", "a?b", "a<b>", "a>b", "a|b", "a\"b", "a:b"] {
        assert_eq!(
            validate_new_name(bad).err().map(|r| r.code()),
            Some("badpath"),
            "`{bad}` 含不允许的字符"
        );
    }
    // 首尾空格与结尾的点（Windows 会把它们吃掉，落盘的名字与用户敲的不是一个）
    for bad in ["a.", "a ", " a", ""] {
        assert_eq!(validate_new_name(bad).err().map(|r| r.code()), Some("badpath"), "`{bad:?}`");
    }
    // 控制字符：`check_rel` 只禁了 NUL，其余的送进文件系统会留下删不掉的名字
    assert_eq!(validate_new_name("a\u{1}.md").err().map(|r| r.code()), Some("badpath"));
    // 合法名字原样返回，不做任何"顺手清理"（改了名就等于存到别处去了）
    for good in ["a.md", "第 1 篇.md", "a-b_c.d.tar.gz", "note"] {
        assert_eq!(validate_new_name(good).ok().as_deref(), Some(good), "`{good}` 不该被拒");
    }
    // 走完整条解析也是同一判据（手机只发 relPath，名字校验不能只存在于单测里）
    let t = Temp::new("name-through-resolve");
    assert_eq!(resolve_new(&t.root(), "sub/a*b.md").err().map(|r| r.code()), Some("badpath"));
}

#[test]
fn windows_保留设备名被拒而合法编号不误杀() {
    // 非 Windows 桌面上 `CON.md` 是普通文件名，这一条只在该平台上成立
    if !cfg!(windows) {
        assert!(validate_new_name("CON.md").is_ok());
        return;
    }
    for bad in ["CON.md", "con", "CoN.txt", "nul", "PRN.log", "LPT1.md", "AUX.txt"] {
        assert_eq!(
            validate_new_name(bad).err().map(|r| r.code()),
            Some("badpath"),
            "`{bad}` 是保留设备名，建出来就是一颗写进去找不到的文件"
        );
    }
    // COM10 及以后不在保留名单里，别把它们一起杀掉
    assert!(validate_new_name("COM10.md").is_ok());
    assert!(validate_new_name("CONSOLE.md").is_ok());
}

