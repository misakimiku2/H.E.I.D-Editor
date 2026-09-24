//! 远程文件命令面的单测（阶段 2）。不开 socket —— 帧与加密链路另有
//! `tests.rs` 里那条真实 TCP 往返，这里只盯命令自身的语义：
//! 与桌面同源的解码、基线判定的两种结局、以及超限与拒绝的稳定错误码。

use super::fsrv::{handle, sha256_hex, MAX_LIST_ENTRIES, MAX_REMOTE_FILE_BYTES};
use super::roots_tests::Temp;
use serde_json::Value;
use std::path::Path;

/// 调一次命令并断言成功，返回解析后的 JSON
fn ok(root: &Path, method: &str, params: &str) -> Value {
    let data = handle(Some(root), method, params)
        .unwrap_or_else(|(code, msg)| panic!("{method}({params}) 不该失败：{code} {msg}"));
    serde_json::from_str(&data).expect("结果应是合法 JSON")
}

/// 调一次命令并断言失败，返回稳定错误码
fn code(root: &Path, method: &str, params: &str) -> String {
    handle(Some(root), method, params)
        .err()
        .unwrap_or_else(|| panic!("{method}({params}) 本该失败"))
        .0
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
    for method in ["list", "stat", "read", "write"] {
        let (c, _) = handle(None, method, "{}").err().expect("没根必须拒");
        assert_eq!(c, "noroot", "{method} 的拒绝码应是 noroot，前端才能说清是桌面没选目录");
    }
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
