//! 阶段 4 工单第 1 条「先量，再写功能」的量测探针（`#[ignore]`，不进 CI）。
//!
//! 量的三件事按工单的字面顺序：一场大规模变更期间 **notify 原始事件条数** →
//! 过 [`watch`] 的逐层黑名单 / 链接点过滤之后剩多少 → **300ms 合并之后每秒几帧、每帧多少字节**。
//! 跑的就是生产那一份 `watch::Batch`，所以数字不是估的；六个场景的结论记在
//! `docs/ROADMAP.md`「阶段 4 前置量测」一节。
//!
//! 跑法（先起探针，再从别处制造变更 —— 变更源可以是 robocopy、npm install，
//! 也可以是用户在 IDE 里保存一片文件）：
//!
//! ```text
//! HEID_PROBE_ROOT='<当共享根的目录>' \
//! HEID_PROBE_TRIGGER='<根>/probe-trigger' \
//! cargo test --release --lib watch_probe -- --ignored --nocapture
//! # 等它打出 READY，另开终端：
//! touch '<根>/probe-trigger'
//! MSYS_NO_PATHCONV=1 robocopy '<根>/node_modules' '<根>/probe-churn/node_modules' /E /MT:16 /NFL /NDL /NJH /NJS /NP
//! ```
//!
//! 口径上的四条说明：
//! 1. 监听用 `RecommendedWatcher` + `RecursiveMode::Recursive`，**不带 debouncer** ——
//!    这就是 `watchImmediate` 走的那条路（`fileTree.ts:273-281` 记着为什么不能带：debouncer 的
//!    `watch()` 会在主线程同步扫全树建缓存，7.7 万文件实测冻结 4.7~8.5 s）。
//! 2. 合并窗口按**定周期** flush（攒够 300 ms 就发一帧），不是"最后一个事件之后再等 300 ms"的
//!    拖尾去抖 —— 后者在一次持续几秒的安装期间永远等不到那 300 ms 的安静。两种都量（报表第 5 段），
//!    实测拖尾式在六个场景里全部只发 1 帧。
//! 3. 计数从 READY 之后开始；触发文件与探针自己的目录本身按精确路径排除，排除到什么打什么。
//!    它们的**子条目**照常计数 —— 那才是要量的东西。
//! 4. 帧的"延迟"这里量不了：探针记的是事件时间戳。定周期 flush 的墙上延迟 = 合并窗口 +
//!    泵线程的 `POLL`（20 ms），那是按构造界定的，不冒充实测。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::watch::{Batch, Signal};

/// 退化成一帧不带载荷的粗信号时线上大概多少字节（够写下 type 与空 data 就报这个数）
const COARSE_FRAME_BYTES: usize = 40;

/// 探针自己的产物：触发文件与变更目录本身
fn is_probe_noise(path: &Path, trigger: &Path, churn: &Path) -> bool {
    path == trigger || path == churn
}

/// notify 的事件种类 → 协议侧的信号种类。除 Windows 改名事件的前半之外全算 Change：
/// 手机端的动作是"重列那一层"与"该看一眼的就 stat"，多算一次不会错，漏算才会。
fn signal_of(kind: &EventKind) -> Signal {
    match kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Signal::RenameFrom,
        _ => Signal::Change,
    }
}

/// 只为打表时看得懂来源
fn action_of(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Remove(_) => "remove",
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => "rename-from",
        EventKind::Modify(ModifyKind::Name(_)) => "rename-to",
        EventKind::Modify(_) => "modify",
        EventKind::Access(_) => "access",
        _ => "other",
    }
}

/// 一帧（一个合并窗口）的汇总
struct Frame {
    at: Duration,
    /// 这一窗口的原始条数与过滤后条数
    seen: usize,
    kept: usize,
    dirs: usize,
    /// 这一帧实际推出去的字节（退化时按粗信号算）
    bytes: usize,
    coarse: bool,
    /// 去重 + 序列化这一帧花了多久
    cost_ms: f64,
}

/// 一条原始事件的精简记录，只为"不过滤会是什么样"那份对照分析留底
struct Raw {
    at: Duration,
    rel: String,
}

#[derive(Default)]
struct Stats {
    raw_events: usize,
    raw_paths: usize,
    noise: usize,
    by_action: HashMap<&'static str, usize>,
    noise_samples: Vec<String>,
    frames: Vec<Frame>,
    /// 对照：拖尾式去抖攒出来的帧（起始时刻, 合并条数）
    trailing: Vec<(Duration, usize)>,
}

fn env_path(key: &str, default: impl Into<PathBuf>) -> PathBuf {
    match std::env::var_os(key) {
        Some(v) => PathBuf::from(v),
        None => default.into(),
    }
}

fn env_dur(key: &str, default: Duration) -> Duration {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(default)
}

#[test]
#[ignore = "真实目录量测：需指定 HEID_PROBE_ROOT，并从另一个终端制造变更"]
fn watch_probe() {
    let default_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let root = env_path("HEID_PROBE_ROOT", default_root);
    let root = match root.canonicalize() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("skip: 共享根 {} 不可用：{e}", root.display());
            return;
        }
    };
    let trigger = env_path("HEID_PROBE_TRIGGER", root.join("probe-trigger"));
    let churn = env_path("HEID_PROBE_CHURN", root.join("probe-churn"));
    let window = Duration::from_millis(
        std::env::var("HEID_PROBE_WINDOW_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300),
    );
    let idle_out = env_dur("HEID_PROBE_IDLE_SECS", Duration::from_secs(6));
    let max_secs = env_dur("HEID_PROBE_MAX_SECS", Duration::from_secs(1800));
    let label = std::env::var("HEID_PROBE_LABEL").unwrap_or_else(|_| "churn".to_string());
    let _ = std::fs::remove_file(&trigger);

    /* 监听：与生产同一条路（纯 notify 递归，不带 debouncer） */
    let (tx, rx) = mpsc::channel::<(Instant, Event)>();
    let t_new = Instant::now();
    let mut watcher = RecommendedWatcher::new(
        Box::new(move |ev| {
            if let Ok(ev) = ev {
                let _ = tx.send((Instant::now(), ev));
            }
        }),
        notify::Config::default(),
    )
    .expect("watcher");
    let t_watch = Instant::now();
    watcher.watch(&root, RecursiveMode::Recursive).expect("递归监听建不起来");
    eprintln!(
        "READY pid={} root={} trigger={}\n        watcher::new {:?}  watch(recursive) {:?}  window={:?}",
        std::process::id(),
        root.display(),
        trigger.display(),
        t_new.elapsed(),
        t_watch.elapsed(),
        window
    );

    /* 等触发文件；这期间到的事件只计数不分析（暖机） */
    let mut warmup = 0usize;
    let t_wait = Instant::now();
    while !trigger.exists() {
        while let Ok((_, ev)) = rx.try_recv() {
            warmup += ev.paths.len();
        }
        if t_wait.elapsed() > max_secs {
            eprintln!("超时：{} 内没等到触发文件，什么都没量到", max_secs.as_secs());
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    while rx.try_recv().is_ok() {}

    /* 主循环：定周期 flush 的合并窗口 + 一份原始留底 */
    let t0 = Instant::now();
    let mut st = Stats::default();
    let mut raw: Vec<Raw> = Vec::with_capacity(1 << 16);
    let mut batch = Batch::default();
    let mut win_start = t0;
    let mut win_seen = 0usize;
    let mut last_ev: Option<Instant> = None;
    let mut trail_start = t0;
    let mut trail_count = 0usize;

    loop {
        if t0.elapsed() > max_secs {
            eprintln!("到达 HEID_PROBE_MAX_SECS，提前收工");
            break;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok((at, ev)) => {
                let sig = signal_of(&ev.kind);
                *st.by_action.entry(action_of(&ev.kind)).or_default() += 1;
                st.raw_events += 1;
                for path in &ev.paths {
                    st.raw_paths += 1;
                    if is_probe_noise(path, &trigger, &churn) {
                        st.noise += 1;
                        if st.noise_samples.len() < 4 {
                            st.noise_samples.push(path.to_string_lossy().to_string());
                        }
                        continue;
                    }
                    raw.push(Raw {
                        at: at - t0,
                        rel: path.strip_prefix(&root).map(rel_of).unwrap_or_default(),
                    });
                    win_seen += 1;
                    trail_count += 1;
                    batch.add(&root, path, sig);
                }
                if last_ev.is_none() {
                    win_start = at;
                    trail_start = at;
                }
                let prev = last_ev.replace(at);
                /* 对照：拖尾式去抖要"距上一个事件安静满一个窗口"才发帧 */
                if prev.is_some_and(|p| at - p > window) {
                    st.trailing.push((trail_start - t0, trail_count));
                    trail_start = at;
                    trail_count = 0;
                }
                if at - win_start >= window {
                    if let Some(f) = settle(&batch, at - t0, win_seen) {
                        st.frames.push(f);
                    }
                    batch = Batch::default();
                    win_start = at;
                    win_seen = 0;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if last_ev.is_some_and(|l| l.elapsed() > idle_out) {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(f) = settle(&batch, last_ev.map(|l| l - t0).unwrap_or_default(), win_seen) {
        st.frames.push(f);
    }
    if trail_count > 0 {
        st.trailing.push((trail_start - t0, trail_count));
    }
    let span = last_ev.map(|l| l - t0).unwrap_or_default();
    report(&label, &root, span, window, warmup, &st, &raw);
}

/// `strip_prefix` 之后按组件拼成协议里那种 `/` 分隔相对路径
fn rel_of(rest: &Path) -> String {
    rest.components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 一个合并窗口结束时的快照。整窗都被过滤掉时返回 None —— 生产实现同样不该为此发帧，
/// "有多少窗口返回了 None"本身就是过滤狠不狠的答案。
fn settle(batch: &Batch, at: Duration, seen: usize) -> Option<Frame> {
    if batch.is_empty() {
        return None;
    }
    let t = Instant::now();
    let payload = batch.payload();
    let cost_ms = t.elapsed().as_secs_f64() * 1000.0;
    let bytes = payload.map(|s| s.len()).unwrap_or(COARSE_FRAME_BYTES);
    let coarse = bytes == COARSE_FRAME_BYTES;
    Some(Frame { at, seen, kept: batch.seen - batch.dropped, dirs: batch.dirs_count(), bytes, coarse, cost_ms })
}

/// 按秒分桶后的（峰值, 有活动的秒上的平均）
fn per_second(items: &[(Duration, usize)], span: Duration) -> (usize, f64) {
    let secs = (span.as_secs() as usize + 1).max(1);
    let mut buckets = vec![0usize; secs];
    for (at, w) in items {
        buckets[at.as_secs().min(secs as u64 - 1) as usize] += w;
    }
    let peak = buckets.iter().copied().max().unwrap_or(0);
    let busy = buckets.iter().filter(|&&v| v > 0).count().max(1);
    let total: usize = buckets.iter().sum();
    (peak, total as f64 / busy as f64)
}

fn report(
    label: &str,
    root: &Path,
    span: Duration,
    window: Duration,
    warmup: usize,
    st: &Stats,
    raw: &[Raw],
) {
    let secs = span.as_secs_f64().max(0.001);
    let kept: usize = st.frames.iter().map(|f| f.kept).sum();
    let coarse = st.frames.iter().filter(|f| f.coarse).count();
    let bytes_total: usize = st.frames.iter().map(|f| f.bytes).sum();

    println!("======== watch_probe: {label} ========");
    println!("共享根     : {}", root.display());
    println!("变更持续   : {secs:.2} s   合并窗口 : {window:?}");
    println!("暖机期丢弃 : {warmup} 条（等触发文件期间到的事件，不计入下面任何一项）");
    println!();

    println!("—— 1) notify 原始事件 ——");
    println!("事件条数   : {}", st.raw_events);
    println!("路径条数   : {}（改名事件一条带两个路径）", st.raw_paths);
    println!("探针自身   : {} 条，已排除", st.noise);
    for s in &st.noise_samples {
        println!("   样本：{s}");
    }
    let mut acts: Vec<(&&str, &usize)> = st.by_action.iter().collect();
    acts.sort_by_key(|(_, v)| std::cmp::Reverse(**v));
    for (a, c) in acts {
        println!("   {a:<12} : {c}");
    }
    let (peak_evps, avg_evps) = per_second(&raw.iter().map(|r| (r.at, 1)).collect::<Vec<_>>(), span);
    println!("平均       : {avg_evps:.0} 条/秒    峰值 : {peak_evps} 条/秒（整秒分桶）");
    println!();

    println!("—— 2) 过逐层黑名单 / 链接点过滤之后 ——");
    println!("送去合并   : {}", raw.len());
    println!("过滤后剩   : {kept}");
    if !raw.is_empty() {
        println!("保留比例   : {:.2}%", kept as f64 * 100.0 / raw.len() as f64);
    }
    println!();

    println!("—— 3) {window:?} 定周期合并之后的实际推送帧 ——");
    println!(
        "帧数       : {}（带载荷 {}，超上限退化成粗信号 {coarse}）",
        st.frames.len(),
        st.frames.len() - coarse
    );
    let (peak_f, avg_f) = per_second(&st.frames.iter().map(|f| (f.at, 1)).collect::<Vec<_>>(), span);
    let (peak_b, avg_b) = per_second(&st.frames.iter().map(|f| (f.at, f.bytes)).collect::<Vec<_>>(), span);
    println!("平均       : {avg_f:.2} 帧/秒 · {avg_b:.0} 字节/秒");
    println!("峰值       : {peak_f} 帧/秒 · {peak_b} 字节/秒");
    println!("字节合计   : {bytes_total}");
    let max_dirs = st.frames.iter().map(|f| f.dirs).max().unwrap_or(0);
    let max_cost = st.frames.iter().fold(0f64, |a, f| a.max(f.cost_ms));
    let sum_cost: f64 = st.frames.iter().map(|f| f.cost_ms).sum();
    println!("单帧最多   : {max_dirs} 个目录   合并耗时 : 最慢 {max_cost:.1} ms · 全程累计 {sum_cost:.0} ms");
    let mut top: Vec<&Frame> = st.frames.iter().collect();
    top.sort_by_key(|f| std::cmp::Reverse(f.bytes));
    for f in top.iter().take(5) {
        println!(
            "   @{:>7.2}s {:>8} B  dirs {:>4}  窗口内原始 {:>6}{}",
            f.at.as_secs_f64(),
            f.bytes,
            f.dirs,
            f.seen,
            if f.coarse { "  [退化粗信号]" } else { "" }
        );
    }
    println!();

    println!("—— 4) 对照：完全不过滤的话（同一批事件，同一套合并）——");
    let (nf, nb, nmax, nmax_at, nmax_dirs) = naive(&window, raw);
    println!("帧数       : {nf}");
    println!("字节合计   : {nb}");
    println!("最大一帧   : {nmax} 字节 @ {:.2}s（该帧 {nmax_dirs} 个目录）", nmax_at.as_secs_f64());
    if bytes_total > 0 && !st.frames.is_empty() {
        println!(
            "相对带过滤 : 帧数 {:.1}× · 字节 {:.1}×",
            nf as f64 / st.frames.len() as f64,
            nb as f64 / bytes_total as f64
        );
    }
    println!();

    println!("—— 5) 对照：拖尾式去抖（安静满 {window:?} 才发一帧）——");
    println!("帧数       : {}", st.trailing.len());
    for (at, c) in st.trailing.iter().take(6) {
        println!("   @{:>7.2}s  合并 {c} 条", at.as_secs_f64());
    }
    println!("（持续变更超过一个窗口的话，中途一帧都不发 —— 这就是用定周期 flush 的理由）");
    println!("======== end {label} ========");
}

/// 不过滤时同样的事件流会形成多大的帧。条目格式与 `watch::FsPayload` 一致，
/// 按 ASCII 名字精确算长度（这种目录里没有需要 JSON 转义的名字，真有的话只会让真实值更大）
fn naive(window: &Duration, raw: &[Raw]) -> (usize, usize, usize, Duration, usize) {
    use std::collections::{BTreeMap, HashSet};
    let w = window.as_micros().max(1) as u64;
    let mut buckets: BTreeMap<u64, Vec<&str>> = BTreeMap::new();
    for r in raw {
        buckets.entry(r.at.as_micros() as u64 / w).or_default().push(&r.rel);
    }
    let mut total = 0usize;
    let mut peak = 0usize;
    let mut peak_at = Duration::ZERO;
    let mut peak_dirs = 0usize;
    for (i, rels) in buckets.iter() {
        let mut dirs: HashSet<&str> = HashSet::new();
        for rel in rels {
            dirs.insert(match rel.rfind('/') {
                Some(c) => &rel[..c],
                None => "",
            });
        }
        let len = dirs.iter().fold(11usize, |n, d| n + d.len() + 3);
        total += len;
        if len > peak {
            peak = len;
            peak_at = Duration::from_micros(*i * w);
            peak_dirs = dirs.len();
        }
    }
    (buckets.len(), total, peak, peak_at, peak_dirs)
}
