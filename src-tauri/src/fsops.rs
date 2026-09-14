//! 文件树管理操作（桌面）：新建目录 / 重命名（移动）/ 复制 / 删除 / 资源管理器中显示。
//! 仅桌面使用 —— 安卓文件操作走 SAF 桥（MainActivity），桥未提供这些能力时前端隐藏入口。
//! 路径来自应用自身文件树（用户主动选择的根目录之下），不额外做根外限制：
//! 与 plugin-fs 现有 `**` 全放行策略一致，命令只负责幂等与跨目录复制的自包含防护。

use std::fs;
use std::path::Path;

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
