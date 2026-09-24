//! 路径逃逸防护测试（设计稿 §4.3）。**先于实现**写好，是 ROADMAP 阶段 2 的硬顺序：
//! 这一层写错就等于把整个磁盘暴露给局域网，所以四类逃逸各一条，另加两条
//! 「看着安全其实不安全」的（同前缀兄弟目录、绕过 canonicalize 的 symlink）。
//!
//! 这些测试都只在临时目录里建文件，且把「根外」的目录做成根目录的**兄弟**，
//! 这样符号链接的目标也在同一个待清理的临时子树内，不会碰到真实用户文件。

use super::roots::{canonical_root, is_within, resolve_rel};
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

fn link(src_dir: &Path, target_dir: &Path, name: &str) -> Option<PathBuf> {
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
