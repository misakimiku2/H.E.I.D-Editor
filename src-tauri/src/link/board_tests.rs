//! 桌面标签看板与**根外文件白名单**（设计稿 §6.1 / §6.3）。
//!
//! 和阶段 2 的 `roots_tests.rs` 同一条纪律：**测试先于实现**。白名单是第二道暴露面 ——
//! 共享根之外的文件也进了局域网，判据只有一句「桌面上确实开着这个标签」。
//! 四组拒绝各一条：命中 / 目录冒充文件 / 条目被换成指向别处的符号链接 / 关标签后失效，
//! 另加「保留前缀不能被当成普通相对路径」这条 —— 它是新语法与旧语法之间唯一的接缝。
//!
//! 涉及符号链接的用例在没有建链权限时** loudly 跳过**并返回，不静默变成空测试
//! （沿用 `roots_tests::link` 的处理）。

use std::path::{Path, PathBuf};

use super::board::{open_id, parse_open_rel, rel_from_root, resolve_in_scope, Board, TabReport};
use super::roots::Reject;
use super::roots_tests::{canon, Temp};

fn file(path: &str) -> TabReport {
    TabReport {
        path: Some(path.to_string()),
        title: "todo.md".to_string(),
        language: "markdown".to_string(),
        ..Default::default()
    }
}

/// 在临时子树里造一个文件并返回它自己（不 canonicalize：模拟前端报来的原始路径）
fn make(path: &Path, bytes: &[u8]) -> PathBuf {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).expect("建目录失败");
    }
    std::fs::write(path, bytes).expect("写文件失败");
    path.to_path_buf()
}

/// 白名单条被换成指向别处的链接时，拒绝；无权限时返回 None 表示这条没验到
fn symlink_file(target: &Path, link: &Path) -> Option<()> {
    let _ = std::fs::remove_file(link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(not(any(windows, unix)))]
    let made: Result<(), std::io::Error> = Err(std::io::Error::other("本平台不支持建符号链接"));
    match made {
        Ok(()) => Some(()),
        Err(e) => {
            eprintln!("跳过符号链接用例（无法创建链接：{e}）。这条防护在该次运行里未被检验。");
            None
        }
    }
}

/* ------------------------------------------------------------ 白名单四组 */

#[test]
fn 白名单命中时解析到该文件本身() {
    let t = Temp::new("wl-hit");
    let todo = make(&t.base.join("open/todo.md"), b"# todo");
    let mut b = Board::default();
    b.set_tabs("main", vec![file(todo.to_str().unwrap())]);
    let scope = b.scope();
    let id = open_id(&canon(&todo));
    let got = resolve_in_scope(&scope, &format!("@w/{id}/todo.md")).expect("白名单内的文件该放行");
    assert_eq!(got, canon(&todo));
    // 引用里的名字只是给人看的（语言判定、标签标题），不参与解析：换个名字仍是同一个文件
    assert_eq!(
        resolve_in_scope(&scope, &format!("@w/{id}/别的名字.txt")).unwrap(),
        got
    );
}

#[test]
fn 白名单里的目录冒充文件被拒() {
    let t = Temp::new("wl-dir");
    let dir = t.base.join("open/adir");
    std::fs::create_dir_all(&dir).unwrap();
    let mut b = Board::default();
    b.set_tabs("main", vec![file(dir.to_str().unwrap())]);
    let scope = b.scope();
    // 目录根本不该进白名单（手机上没有「打开一个目录」这个动作）
    assert!(scope.opens.is_empty(), "目录条目不该被登记：{:?}", scope.opens.keys());
    // 而拿它的规范路径硬造一个引用也进不来
    let id = open_id(&canon(&dir));
    assert_eq!(
        resolve_in_scope(&scope, &format!("@w/{id}/adir")).err().map(|r| r.code()),
        Some("notopen")
    );
}

#[test]
fn 白名单条目被换成指向别处的链接后被拒() {
    let t = Temp::new("wl-symlink");
    let todo = make(&t.base.join("open/todo.md"), b"# todo");
    let secret = make(&t.base.join("outside/secret.txt"), b"secret");
    let mut b = Board::default();
    b.set_tabs("main", vec![file(todo.to_str().unwrap())]);
    let scope = b.scope();
    let id = open_id(&canon(&todo));
    assert!(resolve_in_scope(&scope, &format!("@w/{id}/todo.md")).is_ok());
    if symlink_file(&secret, &todo).is_none() {
        return;
    }
    // 同一个 id、同一个名字，但磁盘上它已经指向白名单之外 —— 每次访问重新 canonicalize
    // 正是为了这一刻：登记时它是安全的并不保证现在还是
    let err = resolve_in_scope(&scope, &format!("@w/{id}/todo.md")).err();
    assert!(
        matches!(err.as_ref().map(|r| r.code()), Some("notopen") | Some("outside")),
        "穿过被替换的链接必须被拒，实际：{err:?}"
    );
}

#[test]
fn 关掉标签即从白名单失效() {
    let t = Temp::new("wl-close");
    let a = make(&t.base.join("open/a.md"), b"a");
    let b_ = make(&t.base.join("open/b.md"), b"b");
    let mut b = Board::default();
    b.set_tabs("main", vec![file(a.to_str().unwrap()), file(b_.to_str().unwrap())]);
    let scope = b.scope();
    assert_eq!(scope.opens.len(), 2, "两个标签该登记两条：{:?}", scope.opens.keys());
    let id_a = open_id(&canon(&a));
    // 用户把 a.md 的标签关掉：下一次上报就只有 b.md，a 的引用当场失效
    b.set_tabs("main", vec![file(b_.to_str().unwrap())]);
    let after = b.scope();
    assert!(!after.opens.contains_key(&id_a), "关标签后 id {id_a} 仍在白名单里");
    assert_eq!(
        resolve_in_scope(&after, &format!("@w/{id_a}/a.md")).err().map(|r| r.code()),
        Some("notopen")
    );
    // 没关的那条不受影响
    assert!(resolve_in_scope(&after, &format!("@w/{}/b.md", open_id(&canon(&b_)))).is_ok());
    // 整个窗口关掉（标签随之消失）也是失效
    b.close_window("main");
    assert!(b.scope().opens.is_empty());
}

/* ------------------------------------------------------------ 保留前缀 */

#[test]
fn 保留前缀的引用不会退回共享根解析() {
    let t = Temp::new("wl-prefix");
    // 共享根里真的存在一个叫 @w/<12位hex>/x.md 的路径：它必须**进不去**，
    // 而不是「白名单没命中就按普通相对路径再试一次」——那等于把语法接缝变成绕过的口子。
    let real = make(&t.root().join("@w/000000000000/x.md"), b"real");
    let mut b = Board::default();
    b.set_root("main", Some(t.root()));
    let scope = b.scope();
    assert_eq!(
        resolve_in_scope(&scope, "@w/000000000000/x.md").err().map(|r| r.code()),
        Some("notopen"),
        "`{}` 不该被当成根内文件",
        real.display()
    );
    // 根内的普通路径不受影响（证明拒的是这个语法，不是「根内有个怪名字」）
    assert_eq!(
        resolve_in_scope(&scope, "sub/notes.txt").err().map(|r| r.code()),
        None::<&'static str>
    );
}

/// `parse_open_rel` 只认严格形态，任何多余的分隔符都掉回根内解析（进而被 `check_rel` 拦住）
#[test]
fn 引用形态不合法时不当作白名单请求() {
    for bad in [
        "@w",
        "@w/",
        "@w//name.md",
        "@w/../name.md",
        "@w/00000000000", // 11 位
        "@w/00000000000g/x.md", // 非 hex
        "@w/000000000000", // 没有名字
        "@w/000000000000/a/b.md", // 名字里带分隔符
        "@W/000000000000/x.md", // 大小写敏感的保留段
        "sub/@w/000000000000/x.md", // 不是首段
        "@w/000000000000/x.md/",
    ] {
        assert!(parse_open_rel(bad).is_none(), "`{bad}` 不是合法的白名单引用");
    }
    let ok = parse_open_rel("@w/0a1b2c3d4e5f/x.md").expect("合法形态应被识别");
    assert_eq!((ok.id.as_str(), ok.name.as_str()), ("0a1b2c3d4e5f", "x.md"));
}

/* ------------------------------------------------------------ 看板与聚焦 */

#[test]
fn 标签列表取聚焦窗口那一份() {
    let t = Temp::new("board-focus");
    let a = make(&t.base.join("open/a.md"), b"a");
    let b_ = make(&t.base.join("open/b.md"), b"b");
    let mut b = Board::default();
    b.set_tabs("main", vec![file(a.to_str().unwrap())]);
    b.set_root("main", Some(canon(&t.base.join("shared"))));
    // 一次焦点事件都没收到（手机连上时桌面可能刚起来）：兜底用最近上报的那个窗口
    assert_eq!(b.active_label(), Some("main"));
    assert_eq!(b.tabs().len(), 1);

    b.set_tabs("win-1", vec![file(b_.to_str().unwrap()), file(b_.to_str().unwrap())]);
    assert_eq!(b.active_label(), Some("win-1"), "没有焦点事件时按最近上报的窗口兜底");
    assert_eq!(b.tabs().len(), 2);

    b.focus("main");
    assert_eq!(b.active_label(), Some("main"));
    assert_eq!(b.tabs().len(), 1);
    assert_eq!(b.root(), Some(canon(&t.base.join("shared"))), "共享根也按聚焦窗口取");

    // 聚焦的那个窗口被关掉：回落到还活着的那个，而不是返回空列表
    b.close_window("main");
    assert_eq!(b.active_label(), Some("win-1"));
    assert!(b.root().is_none(), "win-1 没开文件树，共享根应为空");
    // 全部窗口都没了才真的空
    b.close_window("win-1");
    assert_eq!(b.active_label(), None);
    assert!(b.tabs().is_empty());
}

/// 推送时机：手机上那份列表**看起来**变了才推。只在光标移动时推一次，
/// 等于每敲一个字就给对端发一帧 —— 而那正是列表上唯一不变的东西。
#[test]
fn 只在可见变化时判定为有变化() {
    let t = Temp::new("board-dirty");
    let p = make(&t.base.join("open/a.md"), b"a");
    let mut b = Board::default();
    assert!(!b.focus("main"), "没有这个窗口时焦点事件不该判成变化");
    assert!(b.set_tabs("main", vec![file(p.to_str().unwrap())]), "首个标签是变化");
    assert!(!b.set_tabs("main", vec![file(p.to_str().unwrap())]), "同样的列表重报不算变化");

    // 光标移动（内容没动）：列表上看不到，不推
    let mut moved = file(p.to_str().unwrap());
    moved.line = 42;
    moved.col = 7;
    assert!(!b.set_tabs("main", vec![moved]), "只有光标变了不该推");

    // 但脏标记、标题、开关标签都要推
    let mut dirty = file(p.to_str().unwrap());
    dirty.dirty = true;
    assert!(b.set_tabs("main", vec![dirty]), "脏标记变了要推");
    assert!(b.set_tabs("main", vec![]), "标签全关要推");
    assert!(b.set_root("main", Some(canon(&t.base.join("shared")))), "换共享根要推");
    assert!(!b.set_root("main", Some(canon(&t.base.join("shared")))), "重复设同一个根不算变化");
    assert!(b.focus("main"), "焦点落到别的窗口要推");
    assert!(!b.focus("main"), "重复聚焦同一个窗口不算变化");
}

/// 白名单是**所有活窗口**的并集：手机上正在编辑的文件不该因为用户在桌面上切了个窗口
/// 就被抽掉（列表仍只给聚焦窗口那一份，见上一条）。
#[test]
fn 白名单跨窗口取并集() {
    let t = Temp::new("board-union");
    let a = make(&t.base.join("open/a.md"), b"a");
    let c = make(&t.base.join("open/c.md"), b"c");
    let mut b = Board::default();
    b.set_tabs("main", vec![file(a.to_str().unwrap())]);
    b.set_tabs("win-1", vec![file(c.to_str().unwrap())]);
    b.focus("win-1");
    let scope = b.scope();
    assert_eq!(scope.opens.len(), 2, "两个窗口各开一个根外文件：{:?}", scope.opens.keys());
    // 聚焦窗口（win-1）报的列表里没有 a.md，但它仍在白名单里
    assert_eq!(b.tabs().len(), 1);
    assert!(resolve_in_scope(&scope, &format!("@w/{}/a.md", open_id(&canon(&a)))).is_ok());
    // 关掉其中一个，另一个不受影响
    b.close_window("main");
    let after = b.scope();
    assert_eq!(after.opens.len(), 1, "{:?}", after.opens.keys());
    assert!(resolve_in_scope(&after, &format!("@w/{}/c.md", open_id(&canon(&c)))).is_ok());
}

/// 无路径标签（新建还没保存）与读不动的路径都不进白名单，但要在列表里看得见
#[test]
fn 无路径标签不进白名单() {
    let t = Temp::new("board-virtual");
    let a = make(&t.base.join("open/a.md"), b"a");
    let mut b = Board::default();
    b.set_tabs(
        "main",
        vec![
            file(a.to_str().unwrap()),
            TabReport { title: "未命名".into(), dirty: true, ..Default::default() },
            file("Z:\\这种盘现在不在机器上.md"),
        ],
    );
    assert_eq!(b.tabs().len(), 3, "三个标签都要列出来，手机上才看得懂桌面上有什么");
    assert_eq!(b.scope().opens.len(), 1, "只有真存在的那条进白名单：{:?}", b.scope().opens.keys());
}

/// 上报的规矩只有一句「绝对路径」：`canonicalize` 对相对路径是按**进程当前目录**解析的，
/// 一条 `../../Windows/win.ini` 就能把白名单语义整个绕过去。
#[test]
fn 非绝对路径不进白名单() {
    let mut reports = vec![file("../../outside/secret.txt"), file("relative.md"), file("")];
    #[cfg(windows)]
    reports.push(file("C:tmp\\x.md")); // 驱动器相对写法：is_absolute() 为 false
    let mut b = Board::default();
    b.set_tabs("main", reports.clone());
    assert!(b.scope().opens.is_empty(), "非绝对路径不该被登记：{:?}", b.scope().opens);
    // 列表里仍然看得见它们（桌面上确实开着），但每一条都标着打不开
    assert_eq!(b.scope().tabs.len(), reports.len());
    assert!(
        b.scope().tabs.iter().all(|v| v.rel.is_empty() && v.reason == "missing"),
        "{:?}",
        b.scope().tabs
    );
}

/// 桌面那行「另外还暴露了 N 个」只数根外的：把根内的也算进去，明示的数字就虚高。
#[test]
fn 额外暴露数只算共享根之外的条目() {
    let t = Temp::new("board-extra");
    let inside = canon(t.base.join("shared/readme.md"));
    let outside = make(&t.base.join("open/todo.md"), b"x");
    let mut b = Board::default();
    b.set_root("main", Some(t.root()));
    b.set_tabs("main", vec![file(inside.to_str().unwrap()), file(outside.to_str().unwrap())]);
    let scope = b.scope();
    assert_eq!(scope.opens.len(), 2, "根内根外都登记，引用才不会随聚焦窗口漂移");
    assert_eq!(scope.outside_open_count(), 1, "对用户报数时只报根外那一个");
    // 没设根时全都算额外暴露：此时手机上连"根内"这条路都没有，两条都是多交出去的
    b.set_root("main", None);
    assert_eq!(b.scope().outside_open_count(), 2);
}

/* ------------------------------------------------------------ 相对路径回传 */

#[test]
fn 根内标签以斜杠分隔的相对路径回传() {
    let t = Temp::new("board-rel");
    let root = t.root();
    let target = canon(t.base.join("shared/sub/notes.txt"));
    assert_eq!(rel_from_root(&root, &target).as_deref(), Some("sub/notes.txt"));
    assert_eq!(rel_from_root(&root, &root).as_deref(), Some(""));
    // 根外没有相对路径可给（走白名单引用），返回 None 由调用方决定怎么标
    assert_eq!(rel_from_root(&root, &canon(t.base.join("outside/secret.txt"))), None);
}

/// `Scope::default()` 意味着「什么都没暴露」：根为 None、白名单为空，
/// 所有命令都以 noroot / notopen 拒绝 —— 别留出一条「没设根也能读」的路。
#[test]
fn 空看板不暴露任何路径() {
    let scope = Board::default().scope();
    assert!(scope.root.is_none());
    assert!(scope.opens.is_empty());
    assert_eq!(resolve_in_scope(&scope, "readme.md").err().map(|r| r.code()), Some("noroot"));
    assert_eq!(
        resolve_in_scope(&scope, "@w/000000000000/x.md").err().map(|r| r.code()),
        Some("notopen")
    );
}

/* ------------------------------------------------------------ 小工具断言 */

#[test]
fn 白名单标识由路径决定且稳定() {
    let p = Path::new("C:\\tmp\\a.md");
    let q = Path::new("C:\\tmp\\b.md");
    assert_eq!(open_id(p), open_id(p));
    assert_ne!(open_id(p), open_id(q));
    let id = open_id(p);
    assert!(
        id.len() == 12 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "id 应是 12 位小写十六进制，实际 `{id}`"
    );
    // Reject 的码是协议面，这里钉住一条：白名单专用的那个码不能被别的码顶掉
    assert_eq!(Reject::NotOpen.code(), "notopen");
}
