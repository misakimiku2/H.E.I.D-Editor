//! 桌面 → 手机的文件变更推送内容（v1.5 阶段 4，仅桌面）。
//!
//! 这一层只有**纯逻辑**：一条路径该不该报、报出去长什么样、一帧装不装得下。
//! 监听线程在 `link.rs`；量测探针在 `watch_probe.rs`。
//! 阶段 4 工单第 1 条「先量再写」就是拿这一份代码量的，六个场景的数字与由它定的三条口径
//! 记在 `docs/ROADMAP.md` 的「阶段 4 前置量测」一节 —— 其中最重要的一条：
//! **载荷只列「哪些目录的内容变了」，不列文件**。
//!
//! 为什么不列文件（都是实测，不是偏好）：
//! - Windows 的通知分不出一个名字是文件还是目录，要给手机端一份可信的文件清单就得逐条
//!   `stat`：实测一次合并 364.8 ms 里 stat 占 364.8 ms、序列化占 0.1 ms，
//!   一场 15.7 万条的变更累计 3.8 秒全花在这上面；
//! - 体积也全来自文件条目：同一场变更，目录条目 7~80 条对文件条目最多 508 条，字节合计差 4~9 倍；
//! - 而手机端要做的两件事都不需要文件清单 —— 树按「展开着的层在不在 dirs 里」重列，
//!   「我打开着的这个文件被桌面改了没」按「它的父目录在不在 dirs 里」判，命中再去 `stat` 比哈希，
//!   与阶段 2 的写冲突同一套判据（内容哈希才是权威，事件只是"该去看一眼"的提示）。
//!
//! 与阶段 2 命令面的接缝：`dirs` 里的路径与 `list` / `read` 用的是同一套 `/` 分隔相对路径，
//! `""` 表示共享根自己。过滤只按**名字**判断、不对每条事件 canonicalize —— 一次 `npm install`
//! 是十万级事件，逐条解析路径等于给逃逸防护乘上十万倍开销；而这里放过去也不构成逃逸，
//! 真去读的时候 [`roots::resolve_rel`] 仍会逐次 canonicalize（阶段 2 那道规则没动）。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::search::is_skipped_dir;

/// 合并窗口。300 ms 是量测定的：日常保存时它与拖尾式去抖发出同样多的帧，
/// 而持续变更时拖尾式一帧都不发（`docs/ROADMAP.md` 阶段 4 量测一节第 3 条）。
pub const FLUSH_EVERY: Duration = Duration::from_millis(300);
/// 监听线程观察停止位的轮询粒度，与链路泵 `POLL` 同一量级
const TICK: Duration = Duration::from_millis(20);

/// 一帧 `fs` 推送的目录条数与字节上限。单帧目录数实测峰值 80（把 13.4 万文件的变更全塞进
/// 一个不在黑名单的目录里那种压力场景），这里留三倍余量。
/// 超了就退化成**不带载荷**的 `event{type:'fs'}` —— 也就是阶段 3 那条「变了，去重取」的语义，
/// 手机端本来就会重取它在看的那几层，比推一份它消化不完的清单更稳。
pub const MAX_PUSH_DIRS: usize = 256;
pub const MAX_PUSH_PAYLOAD_BYTES: usize = 32 * 1024;

/// 监听侧递过来的一条变更。协议里不需要分创建/修改/删除，所以这里只保留一个判据：
/// `RenameFrom` 是 Windows 改名事件的前半，后半（`To`）才带着最终名字 ——
/// 前半直接丢，否则手机上会先闪一次「消失」再闪一次「出现」。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Change,
    RenameFrom,
}

/// notify 的事件种类 → 这里的两种信号。**协议侧不区分创建/修改/删除**（见 [`Signal`]），
/// 因为手机端的动作对三者是同一个：重列那一层、并去 `stat` 一下它正看着的文件。
/// 唯一要分开的是 Windows 改名事件的前半 —— 它带着旧名字，而旧名字从这一刻起已经不存在了。
pub fn signal_of(kind: &EventKind) -> Signal {
    use notify::event::{ModifyKind, RenameMode};
    match kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Signal::RenameFrom,
        _ => Signal::Change,
    }
}

/// 一帧的载荷：`{"dirs":[…]}`，排序是为了同一份变化在任何时候序列化出来都一样。
/// 超出 [`MAX_PUSH_DIRS`] 或 [`MAX_PUSH_PAYLOAD_BYTES`] 返回 None，由调用方退化成粗信号。
pub fn payload_of<'a, I: Iterator<Item = &'a str>>(dirs: I) -> Option<String> {
    let sorted: Vec<&str> = {
        let mut v: Vec<&str> = dirs.collect();
        if v.len() > MAX_PUSH_DIRS {
            return None;
        }
        v.sort_unstable();
        v
    };
    serde_json::to_string(&FsPayload { dirs: &sorted })
        .ok()
        .filter(|s| s.len() <= MAX_PUSH_PAYLOAD_BYTES)
}

/// 一个合并窗口攒下来的：**哪些目录的内容变了**。
#[derive(Default)]
pub struct Batch {
    dirs: HashSet<String>,
    /// 某个目录（相对共享根）是否落在链接点之下 —— 按目录缓存，一个窗口里同一个目录只问一次
    links: HashMap<String, bool>,
    /// 收到的条数（含被过滤的），只给量测与日志用
    pub seen: usize,
    /// 被过滤掉的条数
    pub dropped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsPayload<'a> {
    dirs: &'a [&'a str],
}

impl Batch {
    /// 记下一条变更。根外 / 任一祖先层命中 `is_skipped_dir` / 链接点之下 / 名字进不了 JSON 的，
    /// 只递增 [`Batch::dropped`]，不进列表。
    pub fn add(&mut self, root: &Path, path: &Path, sig: Signal) {
        self.seen += 1;
        if sig == Signal::RenameFrom {
            self.dropped += 1;
            return;
        }
        let Ok(rest) = path.strip_prefix(root) else {
            self.dropped += 1;
            return;
        };
        let mut parts: Vec<&str> = Vec::with_capacity(rest.components().count());
        for c in rest.components() {
            match c {
                // 组件不是合法 UTF-8 就进不了 JSON，与 `fsrv::list` 跳过这类条目同一口径
                Component::Normal(os) => match os.to_str() {
                    Some(s) => parts.push(s),
                    None => {
                        self.dropped += 1;
                        return;
                    }
                },
                // 规范化过的根 + 系统通知里的相对名字，正常不会出别的成分；
                // 真出了说明这条路径没法照字面表达，丢掉比猜一个安全
                _ => {
                    self.dropped += 1;
                    return;
                }
            }
        }
        if parts.is_empty() {
            // 根本身变了 —— 与 dirs 里的 `""` 同一语义：手机端重列根
            self.dirs.insert(String::new());
            return;
        }
        // 逐层判，不只判第一层：`npm install` 写进共享根时第一层是 `node_modules`，
        // 但共享根本身往往是个包名之外的目录（实测只判第一层，保留比例从 0.17% 涨到 53%）
        for name in &parts[..parts.len() - 1] {
            if is_skipped_dir(name) {
                self.dropped += 1;
                return;
            }
        }
        // 最后一层单独判，且**要问过文件系统才算**：Windows 在一个目录里建/删条目时，
        // 会把「那个目录本身」也通知一次，于是 `<根>\node_modules` 这一条的 parent 恰好是根 ——
        // 只看祖先的话，一次 `npm install` 仍会漏出「重列根」的帧（2026-09-25 I 段抓到 1 帧 `[""]`）。
        // 不能顺手把所有黑名单**名字**都按字面丢掉：`.gitignore` / `.env` 这类点文件是文本编辑器
        // 真要改的东西，它们的名字也以 `.` 开头，按字面判会让这些变更从此不再产生提示。
        // 所以这里只在"它确实是个目录"时丢，代价是一条名字命中黑名单的事件多问一次 `is_dir()`
        // （npm install 期间也就是 `node_modules` 这一条反复被通知，量级上完全够）。
        // 目录被删掉的那一刻 `is_dir()` 为假 → 照旧报根，而那正是根的内容变了，该让手机重列。
        if is_skipped_dir(parts[parts.len() - 1]) && path.is_dir() {
            self.dropped += 1;
            return;
        }
        let parent = parts[..parts.len() - 1].join("/");
        if self.link_ancestor(root, &parent) {
            self.dropped += 1;
            return;
        }
        self.dirs.insert(parent);
    }

    /// `parent`（相对共享根，`""` 是根）本身或它的任一层祖先是不是链接点。
    ///
    /// 为什么跳：链接点指向根外时，报出去的名字手机端读不到（命令面会拒），白推；
    /// 指向根内时更糟 —— 同一份内容会以两个不同的 `rel` 报两遍。
    /// 从根往下逐层缓存，所以一个窗口里每个目录最多问文件系统一次。
    fn link_ancestor(&mut self, root: &Path, parent: &str) -> bool {
        if parent.is_empty() {
            return false;
        }
        if let Some(&known) = self.links.get(parent) {
            return known;
        }
        let mut hit = false;
        let mut cur = String::new();
        for name in parent.split('/') {
            if !cur.is_empty() {
                cur.push('/');
            }
            cur.push_str(name);
            if hit {
                // 祖先已经是链接点了，下面每一层都算，不必再问文件系统
                self.links.insert(cur.clone(), true);
                continue;
            }
            hit = match self.links.get(&cur) {
                Some(&known) => known,
                None => {
                    let now = root.join(&cur).is_symlink();
                    self.links.insert(cur.clone(), now);
                    now
                }
            };
        }
        hit
    }

    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty()
    }

    /// 只给量测与单测看
    #[cfg(test)]
    pub fn dirs_count(&self) -> usize {
        self.dirs.len()
    }

    #[cfg(test)]
    pub fn dirs_sorted(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.dirs.iter().map(|s| s.as_str()).collect();
        v.sort_unstable();
        v
    }

    /// 这一帧的载荷；超上限返回 None，由调用方退化成不带载荷的粗信号。
    /// 生产路径不经过这里 —— 出口在 `Push::take`，那里还要把几个窗口的集合先并起来。
    #[cfg(test)]
    pub fn payload(&self) -> Option<String> {
        payload_of(self.dirs.iter().map(|s| s.as_str()))
    }

    /// 交出去这一帧：排空自己，返回要推的目录（相对共享根）。空 = 没什么可推。
    pub fn take_dirs(&mut self) -> Vec<String> {
        if self.dirs.is_empty() {
            return Vec::new();
        }
        std::mem::take(&mut self.dirs).into_iter().collect()
    }
}

/* ------------------------------------------------------------------ 监听线程 */

/// 一个跑着的递归监听。丢掉它（或调 [`Handle::stop`]）就是停：停止位一置，
/// 线程退出并把 `RecommendedWatcher` 随栈析构 —— 「断开即释放监听」由所有权保证，
/// 不需要调用方管顺序。
pub struct Handle {
    stop: Arc<AtomicBool>,
    root: PathBuf,
}

impl Handle {
    /// 现在盯的是哪棵树。换根要重建监听，故留着这一份，比让调用方重新问一遍看板省事
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 起一份递归监听：变更按 [`FLUSH_EVERY`] 定周期合并成一帧目录，交给 `on_frame`。
///
/// 三点设计上的为什么：
/// - **只在有设备在线时才有这份监听**（建与拆由 `link.rs` 负责），无连接时桌面零成本；
/// - 用 notify 的 `RecommendedWatcher` + `RecursiveMode::Recursive`，**不带 debouncer** ——
///   与 `watchImmediate` 同一条路。debouncer 的 `watch()` 会在调用线程上同步扫全树建缓存
///   （`fileTree.ts:273-281`：7.7 万文件实测冻结 4.7~8.5 s），本仓量测里递归 watch 建立 0.23~0.31 ms；
/// - 通知回调只做「塞进 channel」，过滤与合并都留在本线程：回调跑在 notify 自己的线程上，
///   在那里做文件系统调用会把后面的事件堵在驱动的缓冲区里。
pub fn spawn(
    root: PathBuf,
    mut on_frame: impl FnMut(&[String]) + Send + 'static,
) -> Result<Handle, String> {
    let (tx, rx) = mpsc::channel::<(PathBuf, Signal)>();
    let mut watcher = RecommendedWatcher::new(
        Box::new(move |ev: notify::Result<Event>| {
            if let Ok(ev) = ev {
                let sig = signal_of(&ev.kind);
                for path in ev.paths {
                    let _ = tx.send((path, sig));
                }
            }
        }),
        notify::Config::default(),
    )
    .map_err(|e| format!("建监听失败：{e}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("监听 {root:?} 失败：{e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_root = root.clone();
    let name = format!("heid-fs-watch:{}", root.display());
    std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            // 句柄的所有权跟着线程走：线程 return 的那一刻监听才释放
            let _watcher = watcher;
            let mut batch = Batch::default();
            let mut since = Instant::now();
            loop {
                if thread_stop.load(Ordering::SeqCst) {
                    return;
                }
                match rx.recv_timeout(TICK) {
                    Ok((path, sig)) => {
                        batch.add(&thread_root, &path, sig);
                        if since.elapsed() >= FLUSH_EVERY {
                            let dirs = batch.take_dirs();
                            eprintln!(
                                "[heid-fsDBG] 一个窗口结束：收到 {} 条、丢弃 {} 条、目录 {:?}",
                                batch.seen, batch.dropped, dirs
                            );
                            if !dirs.is_empty() {
                                on_frame(&dirs);
                            }
                            since = Instant::now();
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // 没有新事件但手里还攒着半帧：到点也得发，否则最后一次保存会一直等下去
                        if since.elapsed() >= FLUSH_EVERY && !batch.is_empty() {
                            let dirs = batch.take_dirs();
                            if !dirs.is_empty() {
                                on_frame(&dirs);
                            }
                            since = Instant::now();
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .map_err(|e| format!("监听线程起不来：{e}"))?;
    Ok(Handle { stop, root })
}

/* ------------------------------------------------------------------ 测试 */

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    const ROOT: &str = r"C:\share\repo";

    fn p(rel: &str) -> PathBuf {
        Path::new(ROOT).join(rel.replace('/', "\\"))
    }

    /// 一帧里装了哪些目录
    fn dirs_of(batch: &Batch) -> Vec<String> {
        batch.dirs_sorted().iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 黑名单目录自身的变更也不报_但点文件照报() {
        // Windows 在一个目录里建/删条目时会把「那个目录本身」也通知一次。
        // `<根>\node_modules` 这一条按祖先判是漏网的（它没有祖先层），而它的 parent 恰好是根 →
        // 于是 `npm install` 期间手机端还会收到"重列根"的帧。2026-09-25 I 段稳定复现的那 1 帧 `[""]` 就是它。
        //
        // 这条判据要问文件系统，所以用真目录测；同时钉住反方向：
        // `.gitignore` 这种**名字**也进黑名单的文件，绝不能被按字面吃掉 ——
        // 那是文本编辑器真要改的东西，吞掉就等于它们的变更从此没有提示。
        let dir = std::env::temp_dir().join(format!("heid-watch-blacklist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules").join("pkg")).unwrap();
        std::fs::write(dir.join(".gitignore"), "target\n").unwrap();
        std::fs::write(dir.join("node_modules").join("pkg").join("i.js"), "1\n").unwrap();

        let mut b = Batch::default();
        b.add(&dir, &dir.join("node_modules"), Signal::Change);
        assert_eq!(b.dropped, 1, "node_modules 自己变了也不该报");
        assert!(b.is_empty());
        // 点文件：报的是它所在的那一层（这里就是根 → `""`），不能因为名字进黑名单就连文件一起丢
        b.add(&dir, &dir.join(".gitignore"), Signal::Change);
        assert_eq!(dirs_of(&b), vec![String::new()], "点文件是用户真会改的东西，提示要留着");
        // 依赖树内部照旧整棵滤掉
        let before = b.dropped;
        b.add(&dir, &dir.join("node_modules").join("pkg").join("i.js"), Signal::Change);
        assert_eq!(b.dropped, before + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 黑名单按整条路径的每一层判而不是只判第一层() {
        // 共享根是 `C:\Users\x\proj`，`npm install` 写进 `proj\node_modules\<包>\…`：
        // 第一层祖先是被共享的目录名，只有逐层判才会把整棵依赖树滤掉（实测差 0.17% vs 53%）
        let root = p("");
        let mut b = Batch::default();
        b.add(&root, &p("node_modules/react/index.js"), Signal::Change);
        b.add(&root, &p("deep/nested/.cache/x/y.js"), Signal::Change);
        b.add(&root, &p("src/App.tsx"), Signal::Change);
        assert_eq!(b.seen, 3);
        assert_eq!(b.dropped, 2, "node_modules 与隐藏目录 .cache 里的一整棵子树都不该报");
        assert_eq!(dirs_of(&b), vec!["src"]);
    }

    #[test]
    fn 根外与根自身() {
        let root = p("");
        let mut b = Batch::default();
        // 根外：共享根之外的通知一律不报，不靠"反正命令面会拒"就顺手推出去
        b.add(&root, Path::new(r"D:\elsewhere\notes.md"), Signal::Change);
        assert_eq!(b.dropped, 1);
        assert!(b.is_empty());
        // 根自己：报的是"重列根"，在载荷里就是空串
        b.add(&root, &root, Signal::Change);
        assert_eq!(dirs_of(&b), vec![String::new()]);
    }

    #[test]
    fn 改名只留带最终名字的那一半() {
        let root = p("");
        let mut b = Batch::default();
        b.add(&root, &p("docs/a.md"), Signal::RenameFrom);
        b.add(&root, &p("docs/b.md"), Signal::Change);
        assert_eq!(b.dropped, 1, "from 那半会先让手机上闪一次「消失」");
        assert_eq!(dirs_of(&b), vec!["docs"]);
    }

    #[test]
    fn 同一目录的多条变更合成一条() {
        let root = p("");
        let mut b = Batch::default();
        for name in ["a.ts", "b.ts", "c.ts"] {
            b.add(&root, &p(&format!("src/{name}")), Signal::Change);
        }
        b.add(&root, &p("src/sub/x.ts"), Signal::Change);
        assert_eq!(b.seen, 4);
        assert_eq!(b.dropped, 0);
        assert_eq!(dirs_of(&b), vec!["src", "src/sub"], "手机端要重列的是这两层，不是四个名字");
    }

    #[test]
    fn 链接点之下的目录不报() {
        // 真正的 symlink 判定要问文件系统，这里验的是那之后的传播与逐层缓存：
        // 已知 `mount` 是链接点，它下面的每一层都该跟着不报，且不必再问一次文件系统。
        // 目录名别取 `out`/`dist` 之类 —— 它们本来就被黑名单挡在前面，走不到这一步
        let root = p("");
        let mut b = Batch::default();
        b.links.insert("mount".to_string(), true);
        b.add(&root, &p("mount/inside/x.md"), Signal::Change);
        b.add(&root, &p("mount/inside/deeper/y.md"), Signal::Change);
        assert_eq!(b.dropped, 2);
        assert!(b.is_empty());
        assert_eq!(b.links.get("mount/inside/deeper"), Some(&true), "子层按祖先的结论直接记账");
        assert_eq!(b.links.get("mount/inside"), Some(&true));
    }

    #[test]
    fn 超上限退化成不带载荷的粗信号() {
        let root = p("");
        let mut b = Batch::default();
        for i in 0..=MAX_PUSH_DIRS {
            b.add(&root, &p(&format!("d{i}/x.md")), Signal::Change);
        }
        assert_eq!(b.dirs_count(), MAX_PUSH_DIRS + 1);
        assert!(b.payload().is_none(), "一帧装不下就该改发「变了，去重取」而不是丢变化");
    }

    #[test]
    fn 载荷是相对路径且与命令面同一套分隔符() {
        let root = p("");
        let mut b = Batch::default();
        b.add(&root, &p("docs/指南/说明.md"), Signal::Change);
        let json = b.payload().unwrap();
        assert_eq!(json, r#"{"dirs":["docs/指南"]}"#, "手机端拿到就能直接喂给 list");
    }
}
