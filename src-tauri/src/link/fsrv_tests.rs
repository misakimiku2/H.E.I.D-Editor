//! 远程文件命令面的单测（阶段 2 的读写 + 阶段 3 的标签与白名单）。不开 socket ——
//! 帧与加密链路另有 `tests.rs` 里那条真实 TCP 往返，这里只盯命令自身的语义：
//! 与桌面同源的解码、基线判定的两种结局、以及超限与拒绝的稳定错误码。

use super::board::{open_id, Board, Scope, TabReport};
use super::fsrv::{handle, sha256_hex, MAX_LIST_ENTRIES, MAX_REMOTE_FILE_BYTES};
use super::roots_tests::Temp;
use serde_json::Value;
use std::path::Path;

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
