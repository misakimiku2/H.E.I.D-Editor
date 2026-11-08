//! 文件树管理操作（桌面）：新建目录 / 重命名（移动）/ 复制 / 删除 / 资源管理器中显示。
//! 仅桌面使用 —— 安卓文件操作走 SAF 桥（MainActivity），桥未提供这些能力时前端隐藏入口。
//! 路径来自应用自身文件树（用户主动选择的根目录之下），不额外做根外限制：
//! 与 plugin-fs 现有 `**` 全放行策略一致，命令只负责幂等与跨目录复制的自包含防护。

use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 保存中途的临时文件后缀（见 `write_atomic`）。
/// 前端文件树按扩展名黑名单把它滤掉（`src/lib/fileTree.ts` 的 `UNSUPPORTED_EXTS`），
/// 桌面全盘搜索也跳过它（`search.rs`）——慢盘上 rename 前的一瞬会被枚举到。
pub const TMP_SUFFIX: &str = "heidtmp";

/// 进程内自增序号：同一份文件可能在两个窗口里各开一张标签，
/// 两边并发保存不能共用同一个临时文件（共名会串内容）。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 是不是本软件保存中途的临时文件名。
pub fn is_tmp_save_name(name: &OsStr) -> bool {
    let suffix = format!(".{TMP_SUFFIX}");
    name.to_string_lossy().ends_with(&suffix)
}

/// 原子写：内容先落同目录的临时文件并 fsync，再 rename 覆盖目标。
///
/// 为什么不能用裸 `fs::write`：它先把目标截断再往里写，崩在中间或撞上掉电，留下的就是
/// 一份**被截断的真实文件**——比「这次保存没成功」严重得多（原本存着的那份也没了）。
///
/// 三种情况退回直接写，退回的那条路径与改动前逐字一致：
/// - 目标是符号链接：rename 会把链接本身换成普通文件，直接写才是「穿过链接」；
/// - 临时文件写不出来（目录不允许额外创建 / 路径超长 / 磁盘满）；
/// - rename 失败（目标被别的进程按着：杀软、同步盘、别的编辑器）。
/// 两次都失败时报直接写那次的错——保存失败的语义没有变坏，只是多套了一层保护。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let is_symlink = fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_symlink && rename_from_tmp(path, bytes).is_ok() {
        return Ok(());
    }
    fs::write(path, bytes)
}

/// 写临时文件 → fsync → rename；任何一步失败都顺手删掉临时文件。
/// rename 之后不再 fsync 目录项（Windows 没有对应 API）：那一瞬断电的话，改名可能丢，
/// 但目标仍是改写前的完整一份——丢的是这次保存，不是文件本身，方向是安全的。
fn rename_from_tmp(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_path_for(path);
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        // 数据先落到磁盘再改名：只写进页缓存的话，掉电时改名后的目标可能是个空文件
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 临时文件名：`<原名>.<pid>.<序号>.heidtmp`，与目标同目录（跨盘的 rename 不原子）。
fn tmp_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.with_file_name(format!("{name}.{}.{}.{}", std::process::id(), seq, TMP_SUFFIX))
}

/// 递归新建目录（已存在时成功返回，便于「新建文件夹」重试语义）
#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// 重命名 / 移动（同盘 rename，跨盘由前端改走复制+删除）
#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 复制文件或目录（目录递归）；目标不能位于源目录内部，否则自我嵌套无限递归
#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    let (from, to) = (Path::new(&from), Path::new(&to));
    if from.is_dir() {
        let from_canon = from.canonicalize().map_err(|e| e.to_string())?;
        if let Ok(to_canon) = to.canonicalize() {
            if to_canon.starts_with(&from_canon) {
                return Err("cannot copy a directory into itself".into());
            }
        }
    }
    copy_any(from, to).map_err(|e| e.to_string())
}

/// 删除文件或目录（目录整树删除，调用前由前端确认）
#[tauri::command]
pub fn fs_delete(path: String, is_dir: bool) -> Result<(), String> {
    let result = if is_dir {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    result.map_err(|e| e.to_string())
}

/// 在系统文件管理器中显示该条目（Windows 选中条目；macOS Reveal；Linux 打开父目录）
#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer /select, 与路径须同参传递；路径含空格时该形式也由 explorer 自行解析
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{e}"))?;
    }
    Ok(())
}

fn copy_any(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_any(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("heid-fsops-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn write_atomic_overwrites_and_leaves_no_tmp() {
        let dir = temp_dir("overwrite");
        let f = dir.join("notes.md");
        fs::write(&f, b"old content").unwrap();
        write_atomic(&f, b"new content").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"new content");
        /* 目录里只剩目标本身：临时文件要么被 rename 带走，要么失败时删干净 */
        assert_eq!(entries(&dir), vec!["notes.md".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_creates_missing_file() {
        let dir = temp_dir("create");
        let f = dir.join("fresh.txt");
        write_atomic(&f, b"hello").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"hello");
        assert_eq!(entries(&dir), vec!["fresh.txt".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tmp_names_are_unique_and_recognisable() {
        let dir = temp_dir("names");
        let f = dir.join("notes.md");
        /* 两次保存排在同一毫秒也要拿到不同的临时文件：同一路径可能在两个窗口各开一张标签 */
        let a = tmp_path_for(&f);
        let b = tmp_path_for(&f);
        assert_ne!(a, b);
        for p in [&a, &b] {
            assert!(p.starts_with(&dir), "临时文件必须与目标同目录（跨盘 rename 不原子）");
            assert!(is_tmp_save_name(&p.file_name().unwrap()));
        }
        assert!(!is_tmp_save_name(OsStr::new("notes.md")));
        assert!(!is_tmp_save_name(OsStr::new("pair.tmp")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 原子写开销观测（不进 CI；debug 档偏慢，只看量级）：
    /// cargo test --lib fsops -- --ignored --nocapture
    #[test]
    #[ignore = "本机磁盘性能观测"]
    fn write_atomic_cost_vs_plain() {
        for kb in [200usize, 1024, 4096] {
            let dir = temp_dir(&format!("perf-{kb}"));
            let f = dir.join("notes.md");
            let bytes = vec![b'a'; kb * 1024];
            fs::write(&f, &bytes).unwrap();
            let t0 = std::time::Instant::now();
            for _ in 0..20 {
                fs::write(&f, &bytes).unwrap();
            }
            let plain = t0.elapsed();
            let t1 = std::time::Instant::now();
            for _ in 0..20 {
                write_atomic(&f, &bytes).unwrap();
            }
            let atomic = t1.elapsed();
            eprintln!("{kb} KB：裸写 {:?}/次 → 原子写 {:?}/次", plain / 20, atomic / 20);
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn write_atomic_writes_through_symlink() {
        let dir = temp_dir("symlink");
        let real = dir.join("real.md");
        fs::write(&real, b"old").unwrap();
        let link = dir.join("link.md");
        #[cfg(target_os = "windows")]
        let made = std::os::windows::fs::symlink_file(&real, &link).is_ok();
        #[cfg(not(target_os = "windows"))]
        let made = std::os::unix::fs::symlink(&real, &link).is_ok();
        if !made {
            // Windows 上建符号链接需要开发者模式/管理员权限：环境不允许时跳过，不报假失败
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        write_atomic(&link, b"new").unwrap();
        /* 穿过链接写进真实文件，链接本身仍然是链接（rename 会把它换成普通文件） */
        assert_eq!(fs::read(&real).unwrap(), b"new");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        let _ = fs::remove_dir_all(&dir);
    }
}
