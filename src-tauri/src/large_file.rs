//! 大文件只读分块预览（第二层 32~512MB）：
//! probe 单次顺扫统计行数并构建自适应稀疏行偏移表（条目上限 2M，超限步长翻倍稀释），
//! read_line_window 按行窗口读取并对齐行边界（CRLF 剥离、超长行截断、窗口字节预算），
//! read_byte_window 供十六进制视图按字节区间读取。
//! 内存约束：偏移表 ≤ 16MB、单行截断 1MB、单窗口累计 4MB——内存中永远只有可视窗口。
//! UTF-16 按码元扫描换行（字节级扫描会把 U+400A 的低字节 0x0A 误判为换行）。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::encoding;

/// 拒绝探测的硬上限（与前端 lib/largeFile.ts 的 LARGE_FILE_MAX_BYTES 一致）
pub const LARGE_FILE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 行偏移表条目上限（超限步长翻倍稀释，条目 i 始终对应第 i*step 行）
const OFFSET_CAP: usize = 2_000_000;
/// 单窗口累计字节预算：完成后停止开始新行
const WINDOW_BYTE_BUDGET: usize = 4 * 1024 * 1024;
/// 单行字节截断阈值（超长行只保留开头，truncated 标记）
const LINE_BYTE_CAP: usize = 1024 * 1024;
/// 编码探测采样长度（二进制判定同步采样前 16KB）
const PROBE_SAMPLE: u64 = 16 * 1024;
const READ_BUF: usize = 256 * 1024;

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileInfo {
    pub size_bytes: u64,
    pub total_lines: u64,
    pub encoding: String,
    pub bom: bool,
    pub binary: bool,
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineWindow {
    pub start_line: u64,
    pub lines: Vec<String>,
    /// 与 lines 等长：该行超过字节截断阈值被截断
    pub truncated: Vec<bool>,
    /// 下一窗口起始字节偏移（行边界对齐；EOF 即文件大小）
    pub end_offset: u64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum U16Mode {
    None,
    Le,
    Be,
}

#[derive(Debug)]
pub struct FileEntry {
    pub size: u64,
    pub total_lines: u64,
    pub encoding: String,
    pub bom: bool,
    pub binary: bool,
    bom_len: u64,
    utf16: U16Mode,
    /// offsets[i] = 第 i*step 行的字节偏移；长度 = ceil(total_lines / step)
    step: u64,
    offsets: Vec<u64>,
}

/// 已探测文件的偏移表缓存（最多 4 个，按插入序淘汰）
#[derive(Default)]
pub struct LargeFileIndex {
    inner: Mutex<IndexInner>,
}

#[derive(Default)]
struct IndexInner {
    entries: HashMap<PathBuf, Arc<FileEntry>>,
    order: Vec<PathBuf>,
}

impl LargeFileIndex {
    pub fn insert(&self, path: PathBuf, entry: Arc<FileEntry>) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.entries.contains_key(&path) {
            inner.order.push(path.clone());
        }
        inner.entries.insert(path, entry);
        while inner.order.len() > 4 {
            let oldest = inner.order.remove(0);
            inner.entries.remove(&oldest);
        }
    }

    pub fn get(&self, path: &PathBuf) -> Option<Arc<FileEntry>> {
        let inner = self.inner.lock().unwrap();
        inner.entries.get(path).cloned()
    }
}

fn u16_mode(label: &str) -> U16Mode {
    use encoding_rs::{Encoding, UTF_16BE, UTF_16LE};
    match Encoding::for_label(label.as_bytes()) {
        Some(e) if std::ptr::eq(e, UTF_16LE) => U16Mode::Le,
        Some(e) if std::ptr::eq(e, UTF_16BE) => U16Mode::Be,
        _ => U16Mode::None,
    }
}

/// 从 from 开始扫描换行符：8 位编码找字节 0x0A（GBK/Big5/Shift_JIS 的 trail 字节
/// 均不小于 0x40，字节扫描安全）；UTF-16 按 16 位码元找 U+000A（跨 chunk 奇字节结转）。
/// 每个换行回调 (token 绝对起始偏移, token 字节长)；回调返回 false 时停止。
/// 返回停止时的绝对流位置（EOF 即文件大小）。
fn scan_newlines<F>(f: &mut File, from: u64, utf16: U16Mode, mut on: F) -> Result<u64, String>
where
    F: FnMut(u64, u32) -> bool,
{
    f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(READ_BUF, &mut *f);
    let mut buf = vec![0u8; READ_BUF];
    let mut abs = from;
    let mut carry: Option<u8> = None;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let mut data: &[u8] = &buf[..n];
        let mut pos = abs;
        if let (Some(c), true) = (carry.take(), !data.is_empty()) {
            let unit = match utf16 {
                U16Mode::Le => u16::from_le_bytes([c, data[0]]),
                U16Mode::Be => u16::from_be_bytes([c, data[0]]),
                U16Mode::None => unreachable!("carry 只在 UTF-16 模式产生"),
            };
            if unit == 0x000A && !on(pos - 1, 2) {
                return Ok(pos + 1);
            }
            data = &data[1..];
            pos += 1;
        }
        if utf16 != U16Mode::None {
            if data.len() % 2 == 1 {
                carry = Some(data[data.len() - 1]);
                data = &data[..data.len() - 1];
            }
            for (i, pair) in data.chunks_exact(2).enumerate() {
                let unit = match utf16 {
                    U16Mode::Le => u16::from_le_bytes([pair[0], pair[1]]),
                    U16Mode::Be => u16::from_be_bytes([pair[0], pair[1]]),
                    U16Mode::None => unreachable!(),
                };
                if unit == 0x000A {
                    let t = pos + (i as u64) * 2;
                    if !on(t, 2) {
                        return Ok(t + 2);
                    }
                }
            }
            abs = pos + data.len() as u64;
        } else {
            for (i, &b) in data.iter().enumerate() {
                if b == b'\n' {
                    let t = pos + i as u64;
                    if !on(t, 1) {
                        return Ok(t + 1);
                    }
                }
            }
            abs = pos + data.len() as u64;
        }
    }
    Ok(abs + if carry.is_some() { 1 } else { 0 })
}

/// 稀疏偏移表定位行首字节偏移：先查表再向前补扫不足 step 的换行
fn offset_of(entry: &FileEntry, path: &PathBuf, line: u64) -> Result<u64, String> {
    let idx = ((line / entry.step) as usize).min(entry.offsets.len().saturating_sub(1));
    let base = entry.offsets[idx];
    let need = line - (idx as u64) * entry.step;
    if need == 0 {
        return Ok(base);
    }
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut remaining = need;
    let mut result = entry.size;
    scan_newlines(&mut f, base, entry.utf16, |token_start, token_len| {
        remaining -= 1;
        if remaining == 0 {
            result = token_start + token_len as u64;
            false
        } else {
            true
        }
    })?;
    Ok(result)
}

/// 探测大文件：尺寸硬上限校验 → 头部采样判定编码/二进制 → 顺扫建行偏移表。
/// 错误串 "FILE_TOO_LARGE:{size}" 供前端识别为第三层拒绝。
pub fn probe_entry(path: &PathBuf, force: Option<&str>, size_cap: u64) -> Result<Arc<FileEntry>, String> {
    probe_entry_with_offset_cap(path, force, size_cap, OFFSET_CAP)
}

/// 同 probe_entry，但偏移表条目上限可调（测试用小值触发步长翻倍路径）
fn probe_entry_with_offset_cap(
    path: &PathBuf,
    force: Option<&str>,
    size_cap: u64,
    offset_cap: usize,
) -> Result<Arc<FileEntry>, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > size_cap {
        return Err(format!("FILE_TOO_LARGE:{size}"));
    }
    let mut f = File::open(path).map_err(|e| e.to_string())?;

    let sample_len = size.min(PROBE_SAMPLE) as usize;
    let mut sample = vec![0u8; sample_len];
    if sample_len > 0 {
        f.read_exact(&mut sample).map_err(|e| e.to_string())?;
    }

    let (label, bom, binary) = match force {
        Some(l) => {
            if !encoding::is_known_label(l) {
                return Err(format!("UNKNOWN_ENCODING:{l}"));
            }
            let (_, bom, _) = encoding::decode_as(&sample, l);
            (l.to_string(), bom, false)
        }
        None => encoding::detect_label(&sample),
    };
    let utf16 = u16_mode(&label);
    let bom_len: u64 = if bom {
        if utf16 != U16Mode::None { 2 } else { 3 }
    } else {
        0
    };

    f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut offsets = vec![bom_len];
    let mut step: u64 = 1;
    let mut newline_count: u64 = 0;
    scan_newlines(&mut f, bom_len, utf16, |token_start, token_len| {
        newline_count += 1;
        if newline_count % step == 0 {
            offsets.push(token_start + token_len as u64);
            if offsets.len() > offset_cap {
                let mut i = 0;
                offsets.retain(|_| {
                    i += 1;
                    i % 2 == 1
                });
                step *= 2;
            }
        }
        true
    })?;

    let token_len: u64 = if utf16 == U16Mode::None { 1 } else { 2 };
    let mut ends_with_nl = false;
    if size >= bom_len + token_len {
        let mut tail = vec![0u8; token_len as usize];
        f.seek(SeekFrom::End(-(token_len as i64))).map_err(|e| e.to_string())?;
        f.read_exact(&mut tail).map_err(|e| e.to_string())?;
        ends_with_nl = match utf16 {
            U16Mode::None => tail == b"\n",
            U16Mode::Le => tail == [0x0A, 0x00],
            U16Mode::Be => tail == [0x00, 0x0A],
        };
    }
    let total_lines = if size <= bom_len {
        0
    } else {
        newline_count + if ends_with_nl { 0 } else { 1 }
    };

    Ok(Arc::new(FileEntry {
        size,
        total_lines,
        encoding: label,
        bom,
        binary,
        bom_len,
        utf16,
        step,
        offsets,
    }))
}

/// 按行窗口读取：start_line 起 max_lines 行（对齐行边界，超预算在完成当前行后停止）。
/// 文件尺寸与探测时不符返回 Err（前端据此重新 probe）。
pub fn read_window(entry: &FileEntry, path: &PathBuf, start_line: u64, max_lines: u32) -> Result<LineWindow, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size != entry.size {
        return Err("FILE_CHANGED".into());
    }
    if entry.total_lines == 0 || start_line >= entry.total_lines {
        return Ok(LineWindow {
            start_line: entry.total_lines,
            lines: vec![],
            truncated: vec![],
            end_offset: size,
        });
    }
    let max_lines = max_lines.max(1) as usize;
    let base = offset_of(entry, path, start_line)?;

    /* 第一遍：扫描行区间 [line_start, token_start)，完成当前行后按上限/预算停止 */
    let mut ranges: Vec<(u64, u64)> = vec![];
    let mut cumulative: usize = 0;
    let mut end_offset = size;
    let stop_pos;
    {
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        let mut line_start = base;
        stop_pos = scan_newlines(&mut f, base, entry.utf16, |token_start, token_len| {
            cumulative += (token_start - line_start) as usize;
            ranges.push((line_start, token_start));
            line_start = token_start + token_len as u64;
            end_offset = line_start;
            ranges.len() < max_lines && cumulative <= WINDOW_BYTE_BUDGET
        })?;
        /* 扫描自然到 EOF 且尾部有未完结行（无尾换行的最后一行） */
        if stop_pos >= size && line_start < size {
            ranges.push((line_start, size));
            end_offset = size;
        }
    }

    /* 第二遍：逐行按需读取并解码（超长行只取前 LINE_BYTE_CAP 字节） */
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut lines = Vec::with_capacity(ranges.len());
    let mut truncated = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        let full_len = (end - start) as usize;
        let take = full_len.min(LINE_BYTE_CAP);
        let mut bytes = vec![0u8; take];
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        f.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        let (mut text, _, _) = encoding::decode_as(&bytes, &entry.encoding);
        if text.ends_with('\r') {
            text.pop();
        }
        lines.push(text);
        truncated.push(full_len > LINE_BYTE_CAP);
    }
    Ok(LineWindow { start_line, lines, truncated, end_offset })
}

/// 按字节区间读取（十六进制视图）
pub fn byte_window(path: &PathBuf, offset: u64, max_bytes: u32) -> Result<Vec<u8>, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if offset >= size || max_bytes == 0 {
        return Ok(vec![]);
    }
    let n = (size - offset).min(max_bytes as u64) as usize;
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; n];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// 探测大文件（行数/编码/二进制判定），缓存行偏移表供 read_line_window 使用
#[tauri::command]
#[cfg(desktop)]
pub fn probe_large_file(
    path: String,
    force: Option<String>,
    state: tauri::State<'_, LargeFileIndex>,
) -> Result<LargeFileInfo, String> {
    let p = PathBuf::from(&path);
    let entry = probe_entry(&p, force.as_deref(), LARGE_FILE_MAX_BYTES)?;
    state.insert(p, entry.clone());
    Ok(LargeFileInfo {
        size_bytes: entry.size,
        total_lines: entry.total_lines,
        encoding: entry.encoding.clone(),
        bom: entry.bom,
        binary: entry.binary,
    })
}

#[tauri::command]
#[cfg(desktop)]
pub fn read_line_window(
    path: String,
    start_line: u64,
    max_lines: u32,
    state: tauri::State<'_, LargeFileIndex>,
) -> Result<LineWindow, String> {
    let p = PathBuf::from(&path);
    let entry = state.get(&p).ok_or_else(|| "NOT_PROBED".to_string())?;
    read_window(&entry, &p, start_line, max_lines)
}

#[tauri::command]
#[cfg(desktop)]
pub fn read_byte_window(path: String, offset: u64, max_bytes: u32) -> Result<Vec<u8>, String> {
    byte_window(&PathBuf::from(&path), offset, max_bytes)
}

#[tauri::command]
#[cfg(desktop)]
pub fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, content: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("heid-largefile-{}-{name}", std::process::id()));
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn probe_counts_lines_without_trailing_newline() {
        let p = temp_file("a", b"a\nb\nc");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.total_lines, 3);
        assert_eq!(e.size, 5);
        assert_eq!(e.encoding, "utf-8");
        assert!(!e.bom && !e.binary);
    }

    #[test]
    fn probe_counts_trailing_newline() {
        let p = temp_file("b", b"a\nb\n");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.total_lines, 2);
    }

    #[test]
    fn probe_empty_file() {
        let p = temp_file("c", b"");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.total_lines, 0);
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert!(w.lines.is_empty());
        assert_eq!(w.end_offset, 0);
    }

    #[test]
    fn probe_rejects_over_cap() {
        let p = temp_file("d", b"0123456789");
        let err = probe_entry(&p, None, 5).unwrap_err();
        assert!(err.starts_with("FILE_TOO_LARGE:"), "got {err}");
    }

    #[test]
    fn force_unknown_label_errors() {
        let p = temp_file("e", b"a\n");
        assert!(probe_entry(&p, Some("nope-enc"), LARGE_FILE_MAX_BYTES).is_err());
    }

    #[test]
    fn force_label_used_for_decode() {
        let p = temp_file("f", &[0xC4, 0xE3, 0xBA, 0xC3, b'\n']);
        let e = probe_entry(&p, Some("gbk"), LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.encoding, "gbk");
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert_eq!(w.lines, vec!["你好"]);
    }

    #[test]
    fn window_reads_first_lines() {
        let p = temp_file("g", b"one\ntwo\nthree\nfour\n");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        let w = read_window(&e, &p, 0, 2).unwrap();
        assert_eq!(w.start_line, 0);
        assert_eq!(w.lines, vec!["one", "two"]);
        assert_eq!(w.truncated, vec![false, false]);
        assert_eq!(w.end_offset, 8);
    }

    #[test]
    fn window_reads_middle_lines() {
        let p = temp_file("h", b"one\ntwo\nthree\nfour\nfive\n");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        let w = read_window(&e, &p, 2, 2).unwrap();
        assert_eq!(w.start_line, 2);
        assert_eq!(w.lines, vec!["three", "four"]);
        assert_eq!(w.end_offset, 19);
    }

    #[test]
    fn window_last_line_without_newline() {
        let p = temp_file("i", b"a\nb\nc");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        let w = read_window(&e, &p, 2, 5).unwrap();
        assert_eq!(w.lines, vec!["c"]);
        assert_eq!(w.end_offset, 5);
    }

    #[test]
    fn window_beyond_eof_is_empty() {
        let p = temp_file("j", b"a\nb\n");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        let w = read_window(&e, &p, 5, 10).unwrap();
        assert!(w.lines.is_empty());
    }

    #[test]
    fn crlf_lines_stripped() {
        let p = temp_file("k", b"a\r\nb\r\n");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert_eq!(w.lines, vec!["a", "b"]);
    }

    #[test]
    fn gbk_decoded() {
        // 「你好」GBK = C4E3 BAC3
        let p = temp_file("l", &[0xC4, 0xE3, 0xBA, 0xC3, b'\n', 0xC4, 0xE3]);
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.encoding, "gbk");
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert_eq!(w.lines, vec!["你好", "你"]);
    }

    #[test]
    fn utf16le_bom_lines() {
        let content: Vec<u8> = vec![0xFF, 0xFE, b'a', 0, 0x0A, 0, b'b', 0];
        let p = temp_file("m", &content);
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.encoding, "utf-16le");
        assert!(e.bom);
        assert_eq!(e.total_lines, 2);
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert_eq!(w.lines, vec!["a", "b"]);
        let w2 = read_window(&e, &p, 1, 5).unwrap();
        assert_eq!(w2.lines, vec!["b"]);
    }

    #[test]
    fn utf16_high_byte_newline_ignored() {
        // "a" + U+400A + "\n" + "b"：U+400A 的 LE 编码为 0A 40，字节级扫描会误判换行
        let content: Vec<u8> = vec![
            0xFF, 0xFE,  // BOM
            b'a', 0,     // 'a'
            0x0A, 0x40,  // U+400A（低字节 0x0A，不是换行）
            0x0A, 0x00,  // U+000A 真换行
            b'b', 0,     // 'b'
        ];
        let p = temp_file("n", &content);
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.total_lines, 2);
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert_eq!(w.lines.len(), 2);
        assert_eq!(w.lines[0], "a\u{400A}");
        assert_eq!(w.lines[1], "b");
    }

    #[test]
    fn utf16be_bom_lines() {
        let content: Vec<u8> = vec![0xFE, 0xFF, 0, b'a', 0, 0x0A, 0, b'b'];
        let p = temp_file("o", &content);
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.encoding, "utf-16be");
        assert_eq!(e.total_lines, 2);
        let w = read_window(&e, &p, 0, 10).unwrap();
        assert_eq!(w.lines, vec!["a", "b"]);
    }

    #[test]
    fn binary_flag_from_sample() {
        // NUL 藏在 9KB 处：8KB 采样会漏判，16KB 采样能抓到
        let mut content = vec![b'x'; 9 * 1024];
        content.push(0);
        content.extend_from_slice(b"\nrest\n");
        let p = temp_file("p", &content);
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert!(e.binary);
    }

    #[test]
    fn giant_line_truncated_but_alignment_kept() {
        let mut content = vec![b'\n'];
        content.extend(std::iter::repeat(b'x').take(LINE_BYTE_CAP + 10));
        content.push(b'\n');
        content.extend_from_slice(b"tail");
        let p = temp_file("q", &content);
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        assert_eq!(e.total_lines, 3);
        let w = read_window(&e, &p, 1, 1).unwrap();
        assert_eq!(w.lines.len(), 1);
        assert!(w.truncated[0]);
        assert_eq!(w.lines[0].len(), LINE_BYTE_CAP);
        assert_eq!(w.end_offset, (content.len() - 4) as u64);
        let w2 = read_window(&e, &p, 2, 10).unwrap();
        assert_eq!(w2.lines, vec!["tail"]);
    }

    #[test]
    fn sparse_index_doubling_keeps_lookup_exact() {
        let mut content = Vec::new();
        for i in 0..40 {
            content.extend_from_slice(format!("L{i}\n").as_bytes());
        }
        let p = temp_file("r", &content);
        let e = probe_entry_with_offset_cap(&p, None, LARGE_FILE_MAX_BYTES, 8).unwrap();
        assert!(e.step > 1, "step should have doubled, got {}", e.step);
        for line in [0usize, 7, 15, 23, 39] {
            let w = read_window(&e, &p, line as u64, 1).unwrap();
            assert_eq!(w.lines[0], format!("L{line}"), "line {line} mismatch");
        }
    }

    #[test]
    fn size_change_invalidates_entry() {
        let p = temp_file("s", b"a\nb\n");
        let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
        std::fs::write(&p, b"a\nb\nc\n").unwrap();
        assert!(read_window(&e, &p, 0, 10).is_err());
    }

    #[test]
    fn index_evicts_oldest_beyond_four() {
        let idx = LargeFileIndex::default();
        let mut paths = vec![];
        for i in 0..5 {
            let p = temp_file(&format!("t{i}"), b"a\n");
            let e = probe_entry(&p, None, LARGE_FILE_MAX_BYTES).unwrap();
            idx.insert(p.clone(), e);
            paths.push(p);
        }
        assert!(idx.get(&paths[0]).is_none());
        assert!(idx.get(&paths[4]).is_some());
    }

    #[test]
    fn byte_window_reads_range() {
        let p = temp_file("u", b"0123456789");
        assert_eq!(byte_window(&p, 2, 4).unwrap(), b"2345");
        assert_eq!(byte_window(&p, 8, 10).unwrap(), b"89");
        assert!(byte_window(&p, 20, 4).unwrap().is_empty());
    }
}
