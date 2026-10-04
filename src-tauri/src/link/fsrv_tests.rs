//! 远程文件命令面的单测（阶段 2 的读写 + 阶段 3 的标签与白名单）。不开 socket ——
//! 帧与加密链路另有 `tests.rs` 里那条真实 TCP 往返，这里只盯命令自身的语义：
//! 与桌面同源的解码、基线判定的两种结局、以及超限与拒绝的稳定错误码。

use super::board::{open_id, Board, Scope, TabReport};
use super::fsrv::{handle, sha256_hex, MAX_LIST_ENTRIES, MAX_REMOTE_FILE_BYTES};
use super::roots_tests::Temp;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 只暴露一个共享根（阶段 2 的老用例都走这一份，白名单为空）
fn scope_of(root: &Path) -> Scope {
    Scope::root_only(root)
}

/// 调一次命令并断言成功，返回解析后的 JSON
fn ok(root: &Path, method: &str, params: &str) -> Value {
    let data = handle(&scope_of(root), method, params)
        .unwrap_or_else(|(code, msg)| panic!("{method}({params}) 不该失败：{code} {msg}"));
    serde_json::from_str(&data).expect("结果应是合法 JSON")
}

/// 调一次命令并断言失败，返回稳定错误码
fn code(root: &Path, method: &str, params: &str) -> String {
    handle(&scope_of(root), method, params)
        .err()
        .unwrap_or_else(|| panic!("{method}({params}) 本该失败"))
        .0
}

fn call(scope: &Scope, method: &str, params: &str) -> Result<String, (String, String)> {
    handle(scope, method, params)
}

/// 写回参数：手机端保存时带上的就是这一组字段
fn write_params(rel: &str, text: &str, base: &str, encoding: &str) -> String {
    serde_json::json!({
        "relPath": rel, "text": text, "encoding": encoding, "bom": false, "baseHash": base
    })
    .to_string()
}

#[test]
fn 没有共享根时所有命令都拒绝() {
    for method in ["list", "stat", "read"] {
        let (c, _) = call(&Scope::default(), method, "{}").err().expect("没根必须拒");
        assert_eq!(c, "noroot", "{method} 的拒绝码应是 noroot，前端才能说清是桌面没选目录");
    }
    // `write` 的 `{}` 先倒在「基线必填」那道门上 —— 那是比「有没有根」更早的校验，
    // 单独钉一下，免得后来人把这条当成漏判
    let (c, _) = call(&Scope::default(), "write", "{}").err().expect("没根必须拒");
    assert_eq!(c, "badparams");
    let (c, _) = call(&Scope::default(), "write", &write_params("a.md", "x", "deadbeef", "utf-8"))
        .err()
        .expect("有基线也照样没根");
    assert_eq!(c, "noroot");
}

#[test]
fn 未知命令有稳定码() {
    let t = Temp::new("fsrv-unknown");
    assert_eq!(code(&t.root(), "delete", "{}"), "unknown");
}

/* ------------------------------------------------------------------ list */

#[test]
fn 列根目录按桌面同一口径排序() {
    let t = Temp::new("fsrv-list");
    t.write("B.md", b"b");
    t.write("a.md", b"a");
    let r = ok(&t.root(), "list", r#"{"relDir":""}"#);
    let names: Vec<&str> =
        r["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    // 目录在前、其余按不区分大小写的名字（与桌面文件树同一口径）
    assert_eq!(names, vec!["sub", "a.md", "B.md", "readme.md"], "实际：{names:?}");
    assert_eq!(r["truncated"], false);
    let sub = &r["entries"][0];
    assert_eq!(sub["isDir"], true, "目录条目的 isDir 必须为真，侧栏才知道它可以展开");
    assert_eq!(sub["size"], 0, "目录不报尺寸（报假数字不如给 0）");
}

#[test]
fn 列子目录用相对路径而不是绝对路径() {
    let t = Temp::new("fsrv-sub");
    t.write("sub/deep.txt", b"deep");
    let r = ok(&t.root(), "list", r#"{"relDir":"sub"}"#);
    let names: Vec<&str> =
        r["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"deep.txt"), "实际：{names:?}");
}

#[test]
fn 列举条目超上限时如实标注() {
    let t = Temp::new("fsrv-cap");
    let dir = t.write("many", b"");
    std::fs::remove_file(&dir).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..MAX_LIST_ENTRIES + 5 {
        std::fs::write(dir.join(format!("f{i:05}.txt")), b"x").unwrap();
    }
    let r = ok(&t.root(), "list", r#"{"relDir":"many"}"#);
    assert_eq!(r["entries"].as_array().unwrap().len(), MAX_LIST_ENTRIES);
    assert_eq!(r["truncated"], true, "截断了必须说，否则手机会以为目录就只有这些");
}

/// 手机上的树根是 `hide-remote://<设备>`，按尾段取名就是一串 keyId。那一行要显示人话，
/// 名字只能由桌面给 —— 随 `list` 给而不单开一条命令：树要显示根节点，本来就得先列一次根。
#[test]
fn 列目录时把共享根那层文件夹名一起给出去() {
    let t = Temp::new("fsrv-rootname");
    std::fs::create_dir_all(t.root().join("sub")).unwrap();
    let want = t.root().file_name().unwrap().to_str().unwrap().to_string();
    let r = ok(&t.root(), "list", r#"{"relDir":""}"#);
    assert_eq!(r["rootName"], want.as_str());
    let s = ok(&t.root(), "list", r#"{"relDir":"sub"}"#);
    assert_eq!(s["rootName"], want.as_str(), "给的是共享根那一层，不是本次列的那层");
}

/* ------------------------------------------------------------------ stat / read */

#[test]
fn stat报出尺寸时间与哈希() {
    let t = Temp::new("fsrv-stat");
    let r = ok(&t.root(), "stat", r#"{"relPath":"readme.md"}"#);
    assert_eq!(r["size"], 4);
    assert_eq!(r["hash"], sha256_hex(b"# hi"));
    assert_eq!(r["isDir"], false);
    assert!(r["mtimeMs"].as_i64().unwrap() > 0);
}

#[test]
fn 读取的解码结果与桌面逐字一致() {
    let t = Temp::new("fsrv-read");
    // GBK 中文：桌面走 encoding_rs 无损认定，手机必须拿到同一份判定，
    // 不能退回 fileIO.ts 里那条 JS 启发式（这正是设计稿 §4.2 强调复用服务端解码的理由）
    let gbk: Vec<u8> = encoding_rs::GBK.encode("设备互联测试").0.into_owned();
    t.write("gbk.txt", &gbk);
    let r = ok(&t.root(), "read", r#"{"relPath":"gbk.txt"}"#);
    assert_eq!(r["text"], "设备互联测试");
    assert_eq!(r["encoding"], "gbk");
    assert_eq!(r["bom"], false);
    assert_eq!(r["lossy"], false);
    assert_eq!(r["binary"], false);
    assert_eq!(r["hash"], sha256_hex(&gbk), "基线哈希按磁盘字节算，不是按解码后的字符数");
}

#[test]
fn 指定编码时不再自动检测() {
    let t = Temp::new("fsrv-force");
    t.write("gbk.txt", &encoding_rs::GBK.encode("设备互联").0.into_owned());
    let r = ok(&t.root(), "read", r#"{"relPath":"gbk.txt","forceEncoding":"utf-8"}"#);
    assert_eq!(r["encoding"], "utf-8");
    assert_eq!(r["lossy"], true, "按 UTF-8 硬解 GBK 字节必然有损，这一位不得撒谎");
}

#[test]
fn 换行符原样带回不在服务端归一() {
    let t = Temp::new("fsrv-eol");
    t.write("crlf.txt", b"one\r\ntwo\r\n");
    let r = ok(&t.root(), "read", r#"{"relPath":"crlf.txt"}"#);
    assert_eq!(r["text"], "one\r\ntwo\r\n", "eol 的判定与归一是前端 openedFromDecoded 的事");
}

#[test]
fn 超过远程上限的文件不打开() {
    let t = Temp::new("fsrv-big");
    let p = t.write("huge.bin", b"");
    // 稀疏置长：不真写 6MB 字节也能测出闸门
    std::fs::File::options().write(true).open(&p).unwrap().set_len(MAX_REMOTE_FILE_BYTES + 1).unwrap();
    assert_eq!(code(&t.root(), "read", r#"{"relPath":"huge.bin"}"#), "toobig");
    let s = ok(&t.root(), "stat", r#"{"relPath":"huge.bin"}"#);
    assert_eq!(s["size"], MAX_REMOTE_FILE_BYTES + 1, "stat 仍要报得出尺寸，前端才能说清为什么打不开");
    assert_eq!(s["hash"], "", "超限文件不该为算哈希读一遍全文件");
}

/// 尺寸只有一个口径：前端 `largeFile.formatBytes`。
/// 服务端原先自己按 `bytes/1024/1024` 取整，于是 7,000,000 字节的文件被报成
/// 「这个文件 6 MB，超过远程打开上限 6 MB」—— 实测值与上限显示成同一个数，
/// 用户既看不出超了多少，也不知道是不是量错了（2026-09-25 跨机实测的 (d)）。
/// 数字由 `stat` 那份 `size` 带出去、由手机端那句 `remote.errTooLarge` 说，这里一个字节数都不许出现。
#[test]
fn 超限文案不自己报尺寸() {
    let t = Temp::new("fsrv-toobig-text");
    let p = t.write("blob.dat", b"");
    std::fs::File::options().write(true).open(&p).unwrap().set_len(7_000_000).unwrap();
    let (c, msg) = call(&scope_of(&t.root()), "read", r#"{"relPath":"blob.dat"}"#)
        .err()
        .expect("超限必须拒");
    assert_eq!(c, "toobig");
    assert!(
        !msg.chars().any(|ch| ch.is_ascii_digit()),
        "尺寸数字只有前端那一个口径，服务端这句里不该出现任何数字：{msg}"
    );
}

#[test]
fn 读不存在的目标报notfound() {
    let t = Temp::new("fsrv-missing");
    assert_eq!(code(&t.root(), "read", r#"{"relPath":"没有这个文件.md"}"#), "notfound");
}

/* ------------------------------------------------------------------ write */

#[test]
fn 基线一致才落盘() {
    let t = Temp::new("fsrv-write");
    let base = ok(&t.root(), "read", r#"{"relPath":"readme.md"}"#)["hash"].as_str().unwrap().to_string();
    let r = ok(&t.root(), "write", &write_params("readme.md", "# 从手机改的", &base, "utf-8"));
    assert_eq!(r["conflict"], false);
    assert_eq!(t.read("readme.md"), "# 从手机改的".as_bytes());
    assert_eq!(r["hash"], sha256_hex("# 从手机改的".as_bytes()), "回传的哈希应是刚落盘的那一份");
}

#[test]
fn 桌面期间改过则返回冲突与服务端最新内容() {
    let t = Temp::new("fsrv-conflict");
    let stale = sha256_hex("桌面已经不是这一份了".as_bytes());
    std::fs::write(t.root().join("readme.md"), "# 桌面上改过".as_bytes()).unwrap();
    let r = ok(&t.root(), "write", &write_params("readme.md", "# 手机上改的", &stale, "utf-8"));
    assert_eq!(r["conflict"], true);
    assert_eq!(r["serverText"], "# 桌面上改过", "冲突必须把桌面最新内容一并带回，否则前端进不了 diff 时间线");
    assert_eq!(r["serverHash"], sha256_hex("# 桌面上改过".as_bytes()));
    assert_eq!(t.read("readme.md"), "# 桌面上改过".as_bytes(), "判成冲突时一个字都不许落盘");
}

#[test]
fn 冲突时超过远程上限就不带正文() {
    /* 阶段 5 补的闸门：离线队列重连回放走的就是这条 write，而冲突回包与正文共用一帧通道
       （单帧上限 8 MB）。桌面把一个文件改到 40 MB 之后再带上正文，等于让手机的一条
       待回放把整条链路撑断 —— 后面所有条目一起失败，比报一次冲突严重得多。 */
    let t = Temp::new("fsrv-conflict-big");
    let big = vec![b'x'; (MAX_REMOTE_FILE_BYTES + 1024) as usize];
    std::fs::write(t.root().join("readme.md"), &big).unwrap();
    let stale = sha256_hex("手机上那份的基线".as_bytes());
    let r = ok(&t.root(), "write", &write_params("readme.md", "# 手机上改的", &stale, "utf-8"));
    assert_eq!(r["conflict"], true);
    assert!(r.get("serverText").is_none(), "超限的桌面正文不许进这一帧：{r:?}");
    assert_eq!(r["size"], big.len() as u64, "尺寸照实报，前端才说得出为什么给不了差异");
    assert_eq!(r["serverHash"], sha256_hex(&big), "哈希仍然有效：判据没丢，只是给不出正文");
    assert_eq!(t.read("readme.md"), big, "判成冲突时一个字都不许落盘");
}

#[test]
fn 没有基线的写入被拒而不是静默覆盖() {
    let t = Temp::new("fsrv-nobase");
    std::fs::write(t.root().join("readme.md"), "# 桌面上改过".as_bytes()).unwrap();
    assert_eq!(code(&t.root(), "write", &write_params("readme.md", "# 手机上改的", "", "utf-8")), "badparams");
    assert_eq!(t.read("readme.md"), "# 桌面上改过".as_bytes(), "缺基线时覆盖就是毁数据");
}

#[test]
fn 按原编码写回() {
    let t = Temp::new("fsrv-encoding");
    t.write("gbk.txt", &encoding_rs::GBK.encode("旧内容").0.into_owned());
    let base = ok(&t.root(), "read", r#"{"relPath":"gbk.txt"}"#)["hash"].as_str().unwrap().to_string();
    ok(&t.root(), "write", &write_params("gbk.txt", "新内容", &base, "gbk"));
    assert_eq!(
        t.read("gbk.txt"),
        encoding_rs::GBK.encode("新内容").0.into_owned(),
        "写回必须是 GBK 字节，不能悄悄变成 UTF-8"
    );
}

#[test]
fn 目录与逃逸路径都不能写() {
    let t = Temp::new("fsrv-write-reject");
    assert_eq!(code(&t.root(), "write", &write_params("sub", "x", "deadbeef", "utf-8")), "badpath");
    assert_eq!(code(&t.root(), "write", &write_params("../outside/secret.txt", "x", "deadbeef", "utf-8")), "badpath");
    assert_eq!(code(&t.root(), "write", &write_params("..", "x", "deadbeef", "utf-8")), "badpath");
    assert_eq!(code(&t.root(), "read", r#"{"relPath":"sub/../../outside/secret.txt"}"#), "badpath");
    // 靶子文件本身没被碰过
    assert_eq!(std::fs::read(t.base.join("outside/secret.txt")).unwrap(), b"secret");
}

/* ------------------------------------------------------------------ create / mkdir */

/// 新建参数：手机上「存到电脑」发出去的就是这一组（没有基线，因为那份东西还不存在）
fn create_params(rel: &str, text: &str) -> String {
    serde_json::json!({ "relPath": rel, "text": text, "encoding": "utf-8", "bom": false }).to_string()
}

/// 用户在手机上明确选了「覆盖桌面上那一份」时发的那一趟
fn create_overwrite_params(rel: &str, text: &str, base: &str) -> String {
    serde_json::json!({
        "relPath": rel, "text": text, "encoding": "utf-8", "bom": false,
        "overwrite": true, "baseHash": base
    })
    .to_string()
}

/// 根内放一个**指向根外文件**的链接。没有建链权限时返回 None，用例就地跳过。
/// （`roots_tests::link` 只会建目录链接，而末段是文件链接这一种要走的是另一条判据）
fn link_to_file(src_dir: &Path, target_file: &Path, name: &str) -> Option<PathBuf> {
    let link = src_dir.join(name);
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_dir(&link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target_file, &link);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target_file, &link);
    #[cfg(not(any(windows, unix)))]
    let made: Result<(), std::io::Error> = Err(std::io::Error::other("本平台不支持建符号链接"));
    match made {
        Ok(()) => Some(link),
        Err(e) => {
            eprintln!("跳过文件符号链接用例（{e}）。这条防护在该次运行里未被检验。");
            None
        }
    }
}

#[test]
fn 新建落进一个还不存在的位置并把内容原样写下去() {
    let t = Temp::new("fsrv-create");
    let r = ok(&t.root(), "create", &create_params("sub/新文件.md", "# 手机上写的\n"));
    assert!(r.get("exists").is_none(), "建成功时 `exists` 整个不进帧（write 的应答形状不能因此变）：{r:?}");
    assert_eq!(r["conflict"], false);
    assert_eq!(t.read("sub/新文件.md"), "# 手机上写的\n".as_bytes());
    assert_eq!(r["hash"], sha256_hex("# 手机上写的\n".as_bytes()), "回传的哈希要能直接当基线用");
    assert_eq!(r["size"], "# 手机上写的\n".len() as u64);
    // 带回来的那一份哈希，紧接着就能喂给 write —— 新建之后继续编辑是同一条通道
    let base = r["hash"].as_str().unwrap().to_string();
    ok(&t.root(), "write", &write_params("sub/新文件.md", "# 改第二遍", &base, "utf-8"));
    assert_eq!(t.read("sub/新文件.md"), "# 改第二遍".as_bytes());
}

#[test]
fn 新建走与桌面同源的编码与换行() {
    let t = Temp::new("fsrv-create-encoding");
    ok(&t.root(), "create", &serde_json::json!({
        "relPath": "gbk-new.txt", "text": "设备互联", "encoding": "gbk", "bom": false
    }).to_string());
    assert_eq!(t.read("gbk-new.txt"), encoding_rs::GBK.encode("设备互联").0.into_owned());
    // CRLF：手机上按标签的 eol 还原之后才发过来，服务端一个字都不动
    ok(&t.root(), "create", &create_params("crlf-new.txt", "one\r\ntwo\r\n"));
    assert_eq!(t.read("crlf-new.txt"), "one\r\ntwo\r\n".as_bytes());
}

#[test]
fn 新建之后能在列目录里看见它() {
    let t = Temp::new("fsrv-create-list");
    ok(&t.root(), "create", &create_params("sub/deep.md", "x"));
    let r = ok(&t.root(), "list", r#"{"relDir":"sub"}"#);
    let names: Vec<&str> =
        r["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"deep.md"), "手机上建完就该在树里看见，实际：{names:?}");
}

#[test]
fn 位置被占时不覆盖而是把那一份带回去() {
    let t = Temp::new("fsrv-create-exists");
    let r = ok(&t.root(), "create", &create_params("readme.md", "# 手机上写的"));
    assert_eq!(r["exists"], true, "同名不静默覆盖：与 write 的基线判定同一个立场");
    assert_eq!(r["hash"], sha256_hex(b"# hi"));
    assert_eq!(r["size"], 4);
    assert_eq!(t.read("readme.md"), b"# hi", "占位时一个字都不许动");
}

#[test]
fn 明确覆盖才写已存在的那一份() {
    let t = Temp::new("fsrv-create-overwrite");
    let cur = ok(&t.root(), "create", &create_params("readme.md", "x"))["hash"]
        .as_str()
        .unwrap()
        .to_string();
    ok(&t.root(), "create", &create_overwrite_params("readme.md", "# 覆盖掉它", &cur));
    assert_eq!(t.read("readme.md"), "# 覆盖掉它".as_bytes());
}

#[test]
fn 覆盖时桌面又改过就转成冲突且一个字不写() {
    // 手机上「问要不要覆盖」与「真正写下去」之间隔着一次用户点按，桌面完全可能在这中间改过。
    // 带回来的基线就是为这一眼而存在的：问的那一份必须等于写的这一份。
    let t = Temp::new("fsrv-create-conflict");
    let cur = ok(&t.root(), "create", &create_params("readme.md", "x"))["hash"]
        .as_str()
        .unwrap()
        .to_string();
    std::fs::write(t.root().join("readme.md"), "# 桌面刚又改的").unwrap();
    let r = ok(&t.root(), "create", &create_overwrite_params("readme.md", "# 手机上覆盖", &cur));
    assert_eq!(r["conflict"], true);
    assert!(r.get("exists").is_none(), "冲突与占位是两回事：这一趟是「桌面那份不是我们问过的那份」");
    assert_eq!(r["serverText"], "# 桌面刚又改的");
    assert_eq!(t.read("readme.md"), "# 桌面刚又改的".as_bytes());
}

#[test]
fn 超限的占位文件既给不出基线也不允许覆盖() {
    // 读一遍 40 MB 只为算哈希不值，所以占位响应里哈希是空串；
    // 相应地这条覆盖必须拒 —— 没有基线的覆盖等于「确认过一次就能盖掉任意大文件」。
    let t = Temp::new("fsrv-create-exists-big");
    let big = vec![b'x'; (MAX_REMOTE_FILE_BYTES + 1024) as usize];
    std::fs::write(t.root().join("readme.md"), &big).unwrap();
    let r = ok(&t.root(), "create", &create_params("readme.md", "x"));
    assert_eq!(r["exists"], true);
    assert_eq!(r["hash"], "", "超限那份不读、也不算哈希");
    assert_eq!(r["size"], big.len() as u64, "尺寸照实报，前端才说得出那是多大一个东西");
    assert_eq!(code(&t.root(), "create", &create_overwrite_params("readme.md", "y", "")), "toobig");
    assert_eq!(std::fs::read(t.root().join("readme.md")).unwrap(), big);
}

#[test]
fn 新建的内容超过上限就拒而不是写一半() {
    let t = Temp::new("fsrv-create-toobig");
    let big = "x".repeat(MAX_REMOTE_FILE_BYTES as usize + 1);
    assert_eq!(code(&t.root(), "create", &create_params("big.txt", &big)), "toobig");
    assert!(!t.root().join("big.txt").exists(), "拒了就不该在桌面上留下一个空文件");
}

#[test]
fn 占位的末段是文件夹时报exists而冲突另说() {
    let t = Temp::new("fsrv-create-dir");
    // 同名是个目录：不是「换名字能解决」的那种冲突，报 exists 让前端说「换个名字或选别处」
    assert_eq!(code(&t.root(), "create", &create_params("sub", "x")), "exists");
    // 反过来，拿已存在的文件去 mkdir 也是同一句
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":"readme.md"}"#), "exists");
}

#[test]
fn 新建也服从逃逸与名字判据() {
    let t = Temp::new("fsrv-create-reject");
    let root = t.root();
    assert_eq!(code(&root, "create", &create_params("../outside/x.md", "x")), "badpath");
    assert_eq!(code(&root, "create", &create_params("..", "x")), "badpath");
    assert_eq!(code(&root, "create", &create_params("", "x")), "badpath");
    assert_eq!(code(&root, "create", &create_params("a*b.md", "x")), "badpath");
    assert_eq!(code(&root, "create", &create_params(r"C:\Windows\x.ini", "x")), "absolute");
    assert_eq!(code(&root, "create", &create_params("nope/deep/x.md", "x")), "notfound");
    // 靶子文件没被碰过，根外也没有多出什么来
    assert_eq!(std::fs::read(t.base.join("outside/secret.txt")).unwrap(), b"secret");
    assert!(!t.base.join("outside/x.md").exists());
}

#[test]
fn 指向根外的链接末段既报不出占位也不许覆盖() {
    // resolve_new 保住的是**父目录**的根内性；末段本来还不存在，所以没人替它看过真实形态。
    // 桌面上有个 `link.md -> ../outside/secret.txt` 时，`fs::write` 会跟着链接跑出根外，
    // 而「先问一句要不要覆盖」那一趟同样是在往根外看 —— 两道都得拒，且拒在同一处。
    let t = Temp::new("fsrv-create-symlink");
    let root = t.root();
    let target = t.base.join("outside/secret.txt");
    if link_to_file(&root, &target, "link.md").is_none() {
        return;
    }
    assert_eq!(code(&root, "create", &create_params("link.md", "x")), "outside", "占位查询这一步就该拒");
    assert_eq!(code(&root, "create", &create_overwrite_params("link.md", "# 想出去", "deadbeef")), "outside");
    assert_eq!(std::fs::read(&target).unwrap(), b"secret", "根外的靶子一个字都不许被写");
}

#[test]
fn 没有共享根时新建一律noroot而白名单引用不能当落点() {
    // 判据来自 `resolve_new_in_scope`：新建只认共享根，`@w/…` 绝不退回按根内路径再试一次。
    let t = Temp::new("fsrv-create-noroot");
    let scope = Scope::default();
    for method in ["create", "mkdir"] {
        let (c, _) = call(&scope, method, &create_params("x.md", "x")).err().expect("没根必须拒");
        assert_eq!(c, "noroot", "{method} 的拒绝码应是 noroot");
    }
    let todo = t.base.join("open/todo.md");
    std::fs::create_dir_all(t.base.join("open")).unwrap();
    std::fs::write(&todo, b"x").unwrap();
    let mut b = Board::default();
    b.set_tabs("main", vec![tab(todo.to_str(), "todo.md", false)]);
    let rel = format!("@w/{}/todo.md", open_id(&todo.canonicalize().unwrap()));
    assert_eq!(
        call(&b.scope(), "create", &create_params(&rel, "x")).err().map(|(c, _)| c),
        Some("badpath".to_string()),
        "白名单条目既不是目录也不该成为写入落点"
    );
    assert_eq!(
        call(&b.scope(), "mkdir", &create_params(&rel, "x")).err().map(|(c, _)| c),
        Some("badpath".to_string())
    );
}

#[test]
fn 建文件夹只建一层且同名不顶掉() {
    let t = Temp::new("fsrv-mkdir");
    let r = ok(&t.root(), "mkdir", r#"{"relPath":"来自手机"}"#);
    assert!(r.get("exists").is_none(), "建成功时不带 exists：{r:?}");
    assert!(t.root().join("来自手机").is_dir(), "没建出目录等于手机上白点一下");
    // 同名（且是目录）→ exists：手机上「换个名字」就是下一步，不必把目录顶掉
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":"来自手机"}"#), "exists");
    // 只建一层：中间那层不在就要人先把那层建出来，而不是悄悄在桌面上长出三棵树
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":"a/b/c"}"#), "notfound");
    let list = ok(&t.root(), "list", r#"{"relDir":"来自手机"}"#);
    assert_eq!(list["entries"].as_array().unwrap().len(), 0, "新建的目录是空的，前端据此收起展开态");
}

#[test]
fn 文件夹名也过同一道名字校验() {
    let t = Temp::new("fsrv-mkdir-name");
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":"a*b"}"#), "badpath");
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":"trail."}"#), "badpath");
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":""}"#), "badpath");
    assert_eq!(code(&t.root(), "mkdir", r#"{"relPath":"sub/.."}"#), "badpath");
}

/* ---------------------------------------------------- 阶段 3：标签与白名单引用 */

fn tab(path: Option<&str>, title: &str, dirty: bool) -> TabReport {
    TabReport {
        path: path.map(|p| p.to_string()),
        title: title.to_string(),
        language: "markdown".to_string(),
        md_view: "edit".to_string(),
        dirty,
        ..Default::default()
    }
}

/// 白名单文件走的是和根内文件**同一条**读写通道：解码同源、基线判定也同源。
/// 这条盯的是「新加的那条路有没有把冲突判定绕过去」。
#[test]
fn 白名单文件读写与冲突判定同一条通道() {
    let t = Temp::new("fsrv-open");
    let todo = t.base.join("open/todo.md");
    std::fs::create_dir_all(t.base.join("open")).unwrap();
    std::fs::write(&todo, "# 桌面上那份").unwrap();
    let mut b = Board::default();
    b.set_root("main", Some(t.root()));
    b.set_tabs("main", vec![tab(todo.to_str(), "todo.md", false)]);
    let scope = b.scope();
    let rel = format!("@w/{}/todo.md", open_id(&todo.canonicalize().unwrap()));

    let r = call(&scope, "read", &format!(r#"{{"relPath":"{rel}"}}"#)).expect("白名单内的文件该能读");
    let v: Value = serde_json::from_str(&r).unwrap();
    assert_eq!(v["text"], "# 桌面上那份");
    let base = v["hash"].as_str().unwrap().to_string();

    // 基线一致 → 落盘
    call(&scope, "write", &write_params(&rel, "# 手机上改的", &base, "utf-8")).expect("该写得过");
    assert_eq!(std::fs::read(&todo).unwrap(), "# 手机上改的".as_bytes());

    // 基线过期 → 冲突，且一个字都不写（和根内文件同一套行为）
    std::fs::write(&todo, "# 桌面上又改了一次").unwrap();
    let c: Value = serde_json::from_str(&call(&scope, "write", &write_params(&rel, "# 手机上再改", &base, "utf-8")).unwrap())
        .unwrap();
    assert_eq!(c["conflict"], true);
    assert_eq!(c["serverText"], "# 桌面上又改了一次");
    assert_eq!(std::fs::read(&todo).unwrap(), "# 桌面上又改了一次".as_bytes());

    // 关掉标签：同一条引用当场失效，而不是「还能读最后一次」
    b.set_tabs("main", vec![]);
    let gone = b.scope();
    assert_eq!(
        call(&gone, "read", &format!(r#"{{"relPath":"{rel}"}}"#)).err().map(|(c, _)| c),
        Some("notopen".to_string())
    );
}

#[test]
fn 白名单条目不能当目录列举() {
    let t = Temp::new("fsrv-open-list");
    let todo = t.base.join("open/todo.md");
    std::fs::create_dir_all(t.base.join("open")).unwrap();
    std::fs::write(&todo, b"x").unwrap();
    let mut b = Board::default();
    b.set_root("main", Some(t.root()));
    b.set_tabs("main", vec![tab(todo.to_str(), "todo.md", false)]);
    let rel = format!("@w/{}/todo.md", open_id(&todo.canonicalize().unwrap()));
    assert_eq!(
        call(&b.scope(), "list", &format!(r#"{{"relDir":"{rel}"}}"#)).err().map(|(c, _)| c),
        Some("badpath".to_string()),
        "白名单里只有文件；拿它当目录列是误用，不该含糊地过去"
    );
}

/// `tabs` 的响应形状就是手机端那份列表：能不能打开由服务端定，
/// 不靠手机自觉 —— 手机上把脏标签置灰只是同一政策的展示层。
#[test]
fn 标签列表如实标出能不能打开() {
    let t = Temp::new("fsrv-tabs");
    let inside = t.root().join("readme.md"); // 根内
    let outside = t.base.join("open/todo.md"); // 根外，但在桌面开着
    std::fs::create_dir_all(t.base.join("open")).unwrap();
    std::fs::write(&outside, "# todo").unwrap();
    let mut b = Board::default();
    b.set_root("main", Some(t.root()));
    b.set_tabs(
        "main",
        vec![
            tab(inside.to_str(), "readme.md", false),
            tab(outside.to_str(), "todo.md", false),
            tab(outside.to_str(), "todo.md", true),
            tab(None, "未命名", true),
            tab(Some("Z:\\不存在的盘.md"), "没了.md", false),
        ],
    );
    let v: Value = serde_json::from_str(&call(&b.scope(), "tabs", "{}").expect("tabs 不该失败")).unwrap();
    assert_eq!(v.as_array().map(|a| a.len()), Some(5), "五都要列出来，手机上才看得懂桌面上开着什么");
    // 根内：给相对路径
    assert_eq!(v[0]["rel"], "readme.md");
    assert_eq!(v[0]["reason"], "");
    // 根外：给白名单引用
    assert_eq!(v[1]["rel"], format!("@w/{}/todo.md", open_id(&outside.canonicalize().unwrap())));
    // 同一个文件但桌面这份是脏的：不接管（§2 决策 5）
    assert_eq!(v[2]["rel"], "");
    assert_eq!(v[2]["reason"], "dirty");
    assert_eq!(v[2]["dirty"], true);
    // 无路径标签：列出来但说清移交还没做（阶段 6）
    assert_eq!(v[3]["reason"], "novirtual");
    // 路径现在读不到：如实标 missing，而不是给一个打不开的引用
    assert_eq!(v[4]["reason"], "missing");
    assert_eq!(v[4]["rel"], "");
}

/// 桌面上「正看着哪一张」是手机端连上那一刻的落地依据，它得随 `tabs` 一起出去。
/// 判据是**恰有一张**：两张都真就等于手机不知道该先摊开哪一份。
#[test]
fn 标签列表里正看着的那一张只有一张() {
    let t = Temp::new("fsrv-tabs-active");
    let inside = t.base.join("shared/readme.md");
    std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
    std::fs::write(&inside, "x").unwrap();
    let mut b = Board::default();
    b.set_root("main", Some(t.root()));
    let mut on = tab(inside.to_str(), "readme.md", false);
    on.active = true;
    b.set_tabs("main", vec![tab(None, "未命名", true), on, tab(Some("Z:\\没了.md"), "没了.md", false)]);
    let v: Value = serde_json::from_str(&call(&b.scope(), "tabs", "{}").expect("tabs 不该失败")).unwrap();
    let flagged: Vec<usize> = v
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, x)| x["active"] == true)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(flagged, vec![1], "只有桌面上那一张带 active：{flagged:?}");
    assert_eq!(v[0]["active"], false, "没标的行要显式给 false，别整个字段不见了");
}

/// 手机连上时问一声「桌面上那棵树在不在」，好决定是把文件夹树换成电脑的还是保留自己那棵。
/// 只要一个布尔：不去试列一次根目录撞 `noroot` 反推，那条路要把整层目录搬过一遍局域网，
/// 而共享根可能就是 `node_modules`。
#[test]
fn 问一声桌面上有没有共享根() {
    let t = Temp::new("fsrv-scope");
    let yes: Value =
        serde_json::from_str(&call(&scope_of(&t.root()), "scope", "{}").expect("有根时该成功")).unwrap();
    assert_eq!(yes["hasRoot"], true);
    // 桌面没开文件树：白名单可能有一串标签，但树那一侧没有起点
    let no: Value = serde_json::from_str(&call(&Board::default().scope(), "scope", "{}").expect("没根也不是错误"))
        .unwrap();
    assert_eq!(no["hasRoot"], false);
}
