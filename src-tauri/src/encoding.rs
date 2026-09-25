//! 文本编码检测与转换（桌面端读写文件命令的后端实现）。
//!
//! 检测阶梯与前端 `lib/encoding.ts` 保持一致：
//! BOM → 二进制判定（前 8KB 含 NUL，须先于严格 UTF-8 校验）→ 严格 UTF-8
//! → GBK / GB18030 / Big5 / Shift_JIS 无损认定 → 回退 GBK（lossy）。
//! 编码 id 使用 WHATWG label，与 encoding_rs 的 for_label 及前端 TextDecoder 双侧兼容。

use encoding_rs::{BIG5, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8};

/// 解码结果（text 不含 BOM；bom 表示文件带 BOM，保存时写回）
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    /// 解码存在无法映射的字节（已用 U+FFFD 替代）
    pub lossy: bool,
    /// 疑似二进制，text 仅供查看
    pub binary: bool,
}

const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];

fn starts_with(b: &[u8], prefix: &[u8]) -> bool {
    b.len() >= prefix.len() && &b[..prefix.len()] == prefix
}

/// 二进制判定（头部采样含 NUL）。命令面里别处也要按同一判据说话，故对整个 crate 可见
pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    head.contains(&0)
}

/// 用指定编码严格解码（无损时返回 Some）
fn lossless_decode(encoding: &'static encoding_rs::Encoding, bytes: &[u8]) -> Option<String> {
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        None
    } else {
        Some(text.into_owned())
    }
}

/// 按调用方指定的编码解码（「以该编码重新打开」），BOM（UTF-8 / UTF-16）剥离并回传
pub fn decode_as(bytes: &[u8], label: &str) -> (String, bool, bool) {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(UTF_8);
    let mut bom = false;
    let mut data = bytes;
    if std::ptr::eq(encoding, UTF_8) && starts_with(bytes, &BOM_UTF8) {
        bom = true;
        data = &bytes[3..];
    } else if std::ptr::eq(encoding, UTF_16LE) && starts_with(bytes, &[0xFF, 0xFE]) {
        bom = true;
        data = &bytes[2..];
    } else if std::ptr::eq(encoding, UTF_16BE) && starts_with(bytes, &[0xFE, 0xFF]) {
        bom = true;
        data = &bytes[2..];
    }
    let (text, _, had_errors) = encoding.decode(data);
    (text.into_owned(), bom, had_errors)
}

/// 完整检测并解码
pub fn detect_and_decode(bytes: &[u8]) -> Decoded {
    if bytes.is_empty() {
        return Decoded {
            text: String::new(),
            encoding: "utf-8".into(),
            bom: false,
            lossy: false,
            binary: false,
        };
    }

    // 1. BOM 精确判定
    if starts_with(bytes, &BOM_UTF8) {
        let (text, bom, lossy) = decode_as(bytes, "utf-8");
        return Decoded { text, encoding: "utf-8".into(), bom, lossy, binary: false };
    }
    if starts_with(bytes, &[0xFF, 0xFE]) {
        return Decoded {
            text: decode_utf16(bytes, true),
            encoding: "utf-16le".into(),
            bom: true,
            lossy: false,
            binary: false,
        };
    }
    if starts_with(bytes, &[0xFE, 0xFF]) {
        return Decoded {
            text: decode_utf16(bytes, false),
            encoding: "utf-16be".into(),
            bom: true,
            lossy: false,
            binary: false,
        };
    }

    // 2. 二进制判定：NUL 是合法 UTF-8，必须先于严格校验
    if is_binary(bytes) {
        let (text, _, _) = UTF_8.decode(bytes);
        return Decoded { text: text.into_owned(), encoding: "utf-8".into(), bom: false, lossy: true, binary: true };
    }

    // 3. 严格 UTF-8
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Decoded {
            text: text.to_string(),
            encoding: "utf-8".into(),
            bom: false,
            lossy: false,
            binary: false,
        };
    }

    // 4. 常见编码无损认定（顺序面向中文用户：GBK → GB18030 → Big5 → Shift_JIS）
    for (encoding, label) in [
        (&GBK, "gbk"),
        (&GB18030, "gb18030"),
        (&BIG5, "big5"),
        (&SHIFT_JIS, "shift_jis"),
    ] {
        if let Some(text) = lossless_decode(encoding, bytes) {
            return Decoded { text, encoding: label.into(), bom: false, lossy: false, binary: false };
        }
    }

    // 5. 回退 GBK（lossy）
    let (text, _, _) = GBK.decode(bytes);
    Decoded { text: text.into_owned(), encoding: "gbk".into(), bom: false, lossy: true, binary: false }
}

/// UTF-16 解码（消费 BOM；无 BOM 的剩余字节按给定端序处理）
fn decode_utf16(bytes: &[u8], little: bool) -> String {
    let encoding = if little { UTF_16LE } else { UTF_16BE };
    let (text, _, _) = encoding.decode(&bytes[2..]);
    text.into_owned()
}

/// 大文件探测用的采样检测：只看头部样本判定编码 label / BOM / 二进制，
/// 阶梯与 detect_and_decode 一致（BOM → NUL → 严格 UTF-8 → GBK 系无损 → 回退 GBK）。
pub fn detect_label(sample: &[u8]) -> (String, bool, bool) {
    if sample.is_empty() {
        return ("utf-8".into(), false, false);
    }
    if starts_with(sample, &BOM_UTF8) {
        return ("utf-8".into(), true, false);
    }
    if starts_with(sample, &[0xFF, 0xFE]) {
        return ("utf-16le".into(), true, false);
    }
    if starts_with(sample, &[0xFE, 0xFF]) {
        return ("utf-16be".into(), true, false);
    }
    if sample.contains(&0) {
        return ("utf-8".into(), false, true);
    }
    if std::str::from_utf8(sample).is_ok() {
        return ("utf-8".into(), false, false);
    }
    for (encoding, label) in [
        (&GBK, "gbk"),
        (&GB18030, "gb18030"),
        (&BIG5, "big5"),
        (&SHIFT_JIS, "shift_jis"),
    ] {
        if lossless_decode(encoding, sample).is_some() {
            return (label.into(), false, false);
        }
    }
    ("gbk".into(), false, false)
}

/// 编码 label 是否可被 encoding_rs 识别（大文件强制编码前校验）
pub fn is_known_label(label: &str) -> bool {
    encoding_rs::Encoding::for_label(label.as_bytes()).is_some()
}

/// UTF-16 手动编码：Encoding Standard 规定 encode() 对纯 ASCII 输入直接返回 ASCII 字节，
/// 因此 UTF-16 必须自行展开为 16 位单元（含可选 BOM）
fn encode_utf16_units(text: &str, little: bool, bom: bool) -> Vec<u8> {
    let mut units: Vec<u16> = Vec::with_capacity(text.len() + 1);
    if bom {
        units.push(0xFEFF);
    }
    units.extend(text.encode_utf16());
    let mut out = Vec::with_capacity(units.len() * 2);
    for unit in units {
        if little {
            out.extend_from_slice(&unit.to_le_bytes());
        } else {
            out.extend_from_slice(&unit.to_be_bytes());
        }
    }
    out
}

/// 按指定编码把文本编码为字节；UTF-8 / UTF-16 按 bom 参数写入 BOM
pub fn encode_text(text: &str, label: &str, bom: bool) -> Result<Vec<u8>, String> {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("未知编码：{label}"))?;
    if std::ptr::eq(encoding, UTF_16LE) {
        return Ok(encode_utf16_units(text, true, bom));
    }
    if std::ptr::eq(encoding, UTF_16BE) {
        return Ok(encode_utf16_units(text, false, bom));
    }
    let (bytes, _, _) = encoding.encode(text);
    let mut out = bytes.into_owned();
    if bom && std::ptr::eq(encoding, UTF_8) && !starts_with(&out, &BOM_UTF8) {
        let mut with_bom = BOM_UTF8.to_vec();
        with_bom.append(&mut out);
        out = with_bom;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_bytes() {
        let d = detect_and_decode(&[]);
        assert_eq!(d.encoding, "utf-8");
        assert!(!d.bom);
    }

    #[test]
    fn utf8_plain() {
        let d = detect_and_decode("你好, world".as_bytes());
        assert_eq!(d.encoding, "utf-8");
        assert_eq!(d.text, "你好, world");
        assert!(!d.bom && !d.lossy);
    }

    #[test]
    fn utf8_with_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("hello".as_bytes());
        let d = detect_and_decode(&bytes);
        assert_eq!(d.encoding, "utf-8");
        assert!(d.bom);
        assert_eq!(d.text, "hello");
    }

    #[test]
    fn gbk_chinese() {
        // 「你好」GBK = C4E3 BAC3
        let bytes = [0xC4, 0xE3, 0xBA, 0xC3];
        let d = detect_and_decode(&bytes);
        assert_eq!(d.encoding, "gbk");
        assert_eq!(d.text, "你好");
        assert!(!d.lossy);
    }

    #[test]
    fn utf16le_with_bom() {
        let bytes = [0xFF, 0xFE, 0x68, 0x00];
        let d = detect_and_decode(&bytes);
        assert_eq!(d.encoding, "utf-16le");
        assert!(d.bom);
        assert_eq!(d.text, "h");
    }

    #[test]
    fn utf16be_with_bom() {
        let bytes = [0xFE, 0xFF, 0x00, 0x68];
        let d = detect_and_decode(&bytes);
        assert_eq!(d.encoding, "utf-16be");
        assert_eq!(d.text, "h");
    }

    #[test]
    fn binary_detected_before_utf8() {
        let mut bytes = vec![0u8; 16];
        bytes[5] = 0x41;
        let d = detect_and_decode(&bytes);
        assert!(d.binary);
        assert!(d.lossy);
    }

    #[test]
    fn invalid_bytes_fallback_gbk_lossy() {
        let bytes = [0x81, 0xFF, 0x81, 0xFE];
        let d = detect_and_decode(&bytes);
        assert_eq!(d.encoding, "gbk");
        assert!(d.lossy);
    }

    #[test]
    fn roundtrip_gbk() {
        let encoded = encode_text("你好，世界", "gbk", false).unwrap();
        let d = detect_and_decode(&encoded);
        assert_eq!(d.text, "你好，世界");
        assert_eq!(d.encoding, "gbk");
    }

    #[test]
    fn roundtrip_utf8_bom() {
        let encoded = encode_text("content", "utf-8", true).unwrap();
        assert_eq!(&encoded[..3], &[0xEF, 0xBB, 0xBF]);
        let d = detect_and_decode(&encoded);
        assert!(d.bom);
        assert_eq!(d.text, "content");
    }

    #[test]
    fn roundtrip_utf16le() {
        let encoded = encode_text("abc", "utf-16le", true).unwrap();
        assert_eq!(&encoded[..2], &[0xFF, 0xFE]);
        let d = detect_and_decode(&encoded);
        assert_eq!(d.text, "abc");
        assert_eq!(d.encoding, "utf-16le");
    }

    #[test]
    fn unknown_label_errors() {
        assert!(encode_text("x", "not-a-encoding", false).is_err());
    }

    #[test]
    fn detect_label_bom_variants() {
        let (label, bom, binary) = detect_label(&[0xEF, 0xBB, 0xBF, b'a']);
        assert_eq!(label, "utf-8");
        assert!(bom && !binary);
        let (label, bom, _) = detect_label(&[0xFF, 0xFE, b'a', 0]);
        assert_eq!(label, "utf-16le");
        assert!(bom);
        let (label, _, _) = detect_label(&[0xFE, 0xFF, 0, b'a']);
        assert_eq!(label, "utf-16be");
    }

    #[test]
    fn detect_label_binary_and_plain_utf8() {
        assert!(detect_label(&[b'a', 0, b'b']).2);
        let (label, bom, binary) = detect_label("plain 中文".as_bytes());
        assert_eq!(label, "utf-8");
        assert!(!bom && !binary);
    }

    #[test]
    fn detect_label_gbk_sample() {
        let (label, _, binary) = detect_label(&[0xC4, 0xE3, 0xBA, 0xC3]);
        assert_eq!(label, "gbk");
        assert!(!binary);
    }

    #[test]
    fn known_label_check() {
        assert!(is_known_label("gbk"));
        assert!(is_known_label("utf-8"));
        assert!(!is_known_label("nope-enc"));
    }
}

