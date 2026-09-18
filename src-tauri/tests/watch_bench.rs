//! 目录监听/读取基准（桌面，不进 CI）：复现 tauri-plugin-fs watch 命令在
//! 主线程上做的全部动作（notify 8 RecommendedWatcher / notify-debouncer-full
//! 0.6 递归监听 + 根目录 read_dir）。
//! 结论（2026-09 实测 E:\test\GF2_extract\output，7.7 万文件）：
//!   debouncer.watch(recursive) ≈ 4.7s —— 插件 delayMs 路径在主线程同步扫全树
//!   建状态缓存，即「打开文件树整窗冻结数秒」的元凶；纯 notify 递归 watch
//!   ≈ 0.3ms。修复 = 插件调用不带 delayMs，去抖在 JS 侧完成。
//! 本文件保留该结论的复现手段。
//! 运行：cargo test --release watch_bench -- --ignored --nocapture
use std::time::Instant;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};

const ROOT: &str = r"E:\test\GF2_extract\output";

#[test]
#[ignore = "真实目录基准，需本机存在该目录"]
fn watch_bench() {
    let root = std::path::Path::new(ROOT);
    if !root.is_dir() {
        eprintln!("skip: {ROOT} 不存在");
        return;
    }

    /* 0) 根目录 read_dir（对照） */
    let t0 = Instant::now();
    let n = std::fs::read_dir(root).map(|it| it.count()).unwrap_or(0);
    eprintln!("[0] read_dir(root)          : {:>10.1?}  entries={n}", t0.elapsed());

    /* 1) RecommendedWatcher::new（对照） */
    let t0 = Instant::now();
    let mut watcher =
        RecommendedWatcher::new(Box::new(|_| {}), Config::default()).expect("new watcher");
    eprintln!("[1] watcher::new            : {:>10.1?}", t0.elapsed());

    /* 2) 递归 watch（非 debouncer，纯 notify） */
    let t0 = Instant::now();
    watcher.watch(root, RecursiveMode::Recursive).expect("watch");
    eprintln!("[2] watch(recursive)        : {:>10.1?}", t0.elapsed());
    watcher.unwatch(root).ok();

    /* 3) debouncer::new —— tauri-plugin-fs delayMs 路径 */
    let t0 = Instant::now();
    let mut debouncer = new_debouncer(
        std::time::Duration::from_millis(400),
        None,
        move |events: DebounceEventResult| {
            let _ = events;
        },
    )
    .expect("new debouncer");
    eprintln!("[3] debouncer::new          : {:>10.1?}", t0.elapsed());

    /* 4) debouncer.watch(recursive) —— 主线程同步执行的就是这一步 */
    let t0 = Instant::now();
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .expect("debouncer watch");
    eprintln!("[4] debouncer.watch(rec)    : {:>10.1?}", t0.elapsed());

    /* 5) 二次 watch（排除首次冷缓存的影响） */
    let dir2 = root.join("剧情文本");
    let t0 = Instant::now();
    debouncer.watch(&dir2, RecursiveMode::Recursive).ok();
    eprintln!("[5] debouncer.watch(subdir) : {:>10.1?}", t0.elapsed());
}
