//! 配对凭证的纯逻辑（v1.5 阶段 1）：一次性配对票、长期链路密钥 LS、keyId、二维码载荷、落盘存储。
//!
//! 三条彼此独立、都必须成立的性质，各归一处，别混：
//! - **票**（[`crate::link::new_ticket`] 出的 32 hex）只在配对那一次用，且从不上网，只当 HKDF 的 salt；
//! - **LS** 是配对成功后两端各自从「本次握手的 ECDH 共享密钥」派生出的一把长期密钥，
//!   存下来供以后免扫重连（[`derive_link_secret`]）——它只依赖 ECDH 共享、不依赖票，
//!   所以无论走扫码还是走 6 位短码配对，得到的 LS 都是同一把；
//! - **keyId** 是 LS 的一个公开、不可反推的标识（[`key_id`]），重连时明文带过去，让桌面认出「用哪把 LS」。

use std::time::{Duration, Instant};

use ring::digest;
use ring::hkdf::Salt;
use ring::hkdf::HKDF_SHA256;
use serde::{Deserialize, Serialize};

use super::identity;

/// 一次性配对票的有效期（设计稿 §7.1 第 2 条：票 2 分钟有效）。超时得让桌面重开一次配对。
pub const PAIRING_TTL: Duration = Duration::from_secs(120);

/// 一张票挂多久就该换：留出 50 秒的余量，别让手机上正对着的码在有效期内最后一秒还被人去扫。
/// **换码这件事只在服务端判**（`link_pair_info` 一次调用里判完换完），前端只管按时来问 ——
/// 两个面板各起一个定时器换码，就会出现「屏幕上这张已经不是当前那张」。
pub const REFRESH_AFTER: Duration = Duration::from_secs(70);

const LS_INFO: &[u8] = b"heid-link-ls-v1";
const CODE_PREFIX: &[u8] = b"heid-link-shortcode-v1";

/// 从 ECDH 共享密钥派生长期链路密钥。**不掺票** —— 掺了就随票作废而变，撑不起「重启免扫重连」。
/// 与配对手握手的会话密钥用同一份 shared、不同的 info/salt，二者互不推导得出。
pub fn derive_link_secret(shared: &[u8]) -> [u8; 32] {
    // 空 salt 走 HKDF 规范里的全零 salt；这里要的是「同 shared 必得同 LS」的确定性，不是抗注册攻击。
    let salt = Salt::new(HKDF_SHA256, b"");
    let prk = salt.extract(shared);
    let mut ls = [0u8; 32];
    prk.expand(&[LS_INFO], HKDF_SHA256)
        .and_then(|okm| okm.fill(&mut ls))
        .expect("HKDF 输出 32 字节不会超过可扩展上限");
    ls
}

/// keyId = SHA-256(LS) 前 8 字节的十六进制（16 字符）。公开、可放进二维码/重连帧，
/// 但从它推不出 LS；换一台设备或重新配对就是一把新 LS、一个新 keyId。
pub fn key_id(ls: &[u8; 32]) -> String {
    let d = digest::digest(&digest::SHA256, ls);
    d.as_ref()[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// 6 位数字短码，由配对票确定性地导出（同一张票 → 同一个码）。桌面把它显示在二维码下面，
/// 相机坏了 / 权限被拒时手机手输（设计稿 §7.3）。
///
/// 诚实的强度差：票有 128 bit、短码只有约 20 bit，所以**走短码这一条的初次配对**强度低于扫码那条。
/// 兜住它的是「单张票 2 分钟 + 用后即废 + 只在局域网 + 一旦成功立刻升级到 256 bit 的 LS」，
/// 而不是短码本身；这也是为什么短码是兜底、扫码才是主路。
pub fn short_code(secret: &str) -> String {
    let mut buf = Vec::with_capacity(CODE_PREFIX.len() + secret.len());
    buf.extend_from_slice(CODE_PREFIX);
    buf.extend_from_slice(secret.as_bytes());
    let d = digest::digest(&digest::SHA256, &buf);
    let n = u32::from_be_bytes([d.as_ref()[0], d.as_ref()[1], d.as_ref()[2], d.as_ref()[3]]);
    format!("{:06}", n % 1_000_000)
}

/* --------------------------------------------------------------- 二维码载荷 */

/// 自定义 scheme：系统相机不认它，所以扫码必须在应用内做（这也是相机要 CAMERA 权限的原因）。
/// 手填/粘贴路径同样解析这一串，两条入口共用一种格式。
pub const PAIR_SCHEME: &str = "hide-link://pair";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PairingPayload {
    pub host: String,
    pub port: u16,
    /// 一次性配对票（扫码路径）。走 6 位短码手输时这一项为空，改填 [`Self::code`]。
    pub ticket: String,
    pub name: String,
    /// 桌面长期身份公钥指纹（base32 13 字符）。手机扫码即校验对端，防同网段抢答（§12.1 第 5 条）。
    pub fp: String,
}

impl PairingPayload {
    /// 拼成 `hide-link://pair?...`。值做最小 percent 编码：只转 `& = # % ?` 与空格，
    /// 这几字符会破坏 query 结构；host/ticket/fp 本身不含其它特殊字符。
    pub fn to_uri(&self) -> String {
        format!(
            "{PAIR_SCHEME}?host={}&port={}&ticket={}&name={}&fp={}",
            enc(&self.host),
            self.port,
            enc(&self.ticket),
            enc(&self.name),
            enc(&self.fp),
        )
    }

    /// 从扫码/粘贴得到的一串里解出载荷。解不出 host、端口越界、票既非空又形状不对，都返回错误
    /// —— 手机据此提示「这不是本应用的配对码」，而不是拿半截参数去连。
    pub fn parse(s: &str) -> Result<PairingPayload, String> {
        let s = s.trim();
        let rest = s
            .strip_prefix(PAIR_SCHEME)
            .or_else(|| s.strip_prefix(&format!("{PAIR_SCHEME}/")))
            .ok_or_else(|| "不是 hide-link 配对码".to_string())?;
        let query = rest.split_once('?').map(|(_, q)| q).unwrap_or(rest);
        let mut host = String::new();
        let mut port = 0u16;
        let mut ticket = String::new();
        let mut name = String::new();
        let mut fp = String::new();
        for kv in query.split('&') {
            if kv.is_empty() {
                continue;
            }
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            let v = dec(v);
            match k {
                "host" => host = v,
                "port" => port = v.parse().unwrap_or(0),
                "ticket" => ticket = v.to_lowercase(),
                "name" => name = v,
                "fp" => fp = v,
                _ => {} // 未知键忽略：前向兼容，多出来的字段不该让旧版解不动
            }
        }
        if host.is_empty() {
            return Err("配对码缺少地址".to_string());
        }
        if !(1024..=65535).contains(&port) {
            return Err(format!("配对码端口非法：{port}"));
        }
        if !(ticket.is_empty() || crate::link::is_valid_ticket(&ticket)) {
            return Err("配对码里的配对票形状不对".to_string());
        }
        Ok(PairingPayload {
            host,
            port,
            ticket,
            name,
            fp,
        })
    }
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '&' => out.push_str("%26"),
            '=' => out.push_str("%3D"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '%' => out.push_str("%25"),
            _ => out.push(c),
        }
    }
    out
}

fn dec(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* --------------------------------------------------------------- 一次性配对票 */

/// 当前有效的一张配对票 + 它的过期与「已用」状态。票是配对期的入口凭证，配对成功即作废并换新的。
pub struct PairingTicket {
    value: String,
    created: Instant,
    used: bool,
}

impl PairingTicket {
    pub fn new(value: String) -> Self {
        PairingTicket { value, created: Instant::now(), used: false }
    }
    pub fn value(&self) -> &str {
        &self.value
    }
    pub fn code(&self) -> String {
        short_code(&self.value)
    }
    /// 这张票的公开标识，用来在配对窗里指认是哪一张（见 [`PairingWindow::select`]）
    pub fn tag(&self) -> String {
        slot_tag(&self.value)
    }
    fn expired(&self) -> bool {
        self.created.elapsed() > PAIRING_TTL
    }
    /// 这张票现在还能不能用（没被用过、没过期）。
    pub fn usable(&self) -> bool {
        !self.used && !self.expired()
    }
    /// 挂出来多久了（决定要不要换一张，见 [`REFRESH_AFTER`]）
    pub fn age(&self) -> Duration {
        self.created.elapsed()
    }
    /// 消费一次：成功配对后调用，把它置为已用；同时返回是否本来可用。用后即废在这里落实。
    pub fn consume(&mut self) -> bool {
        if self.usable() {
            self.used = true;
            true
        } else {
            false
        }
    }
}

/// 票值的公开标识：SHA-256(票值) 前 3 字节的十六进制（6 字符）。
///
/// 它解决的是「一次配对窗里同时活着两张票，手机扫的是哪一张」这一件事 —— 从票值算得出、
/// 从它推不回票值（还差 2^104），所以可以放进握手帧而不改变「票从不上网」这条。
pub fn slot_tag(value: &str) -> String {
    let d = digest::digest(&digest::SHA256, value.as_bytes());
    d.as_ref()[..3].iter().map(|b| format!("{b:02x}")).collect()
}

/// `hello.slot` 的形态：`ticket` / `code`，或带上票标识的 `ticket:<tag>` / `code:<tag>`。
/// 带标识用来指认配对窗里的哪一张；**旧版手机不带**，按当前那张处理（见 [`PairingWindow::select`]）。
fn split_slot(slot: &str) -> (&str, Option<&str>) {
    match slot.split_once(':') {
        Some((kind, tag)) if !tag.is_empty() => (kind, Some(tag)),
        _ => (slot, None),
    }
}

/// 桌面此刻开放的配对窗：**当前显示的那张票** + **刚被换下、仍在自身有效期内的那张**。
///
/// 为什么留旧票：开着共享时桌面前端会按小于有效期的间隔自动换码，好让屏幕上永远有一张能扫的。
/// 换码即作废旧票的话，手机上相机正对着的那张会在拨过去的一瞬间变成「配对码已过期」——
/// 一种每次都可能撞上、撞上要回电脑前重扫的偶发失败最难查。
///
/// 旧票不累积：只留最后换下的那一张，且它照样受自身 [`PAIRING_TTL`] 与「用后即废」约束。
#[derive(Default)]
pub struct PairingWindow {
    /// 最后一个是当前显示的那张
    slots: Vec<PairingTicket>,
}

impl PairingWindow {
    pub fn new(t: PairingTicket) -> Self {
        PairingWindow { slots: vec![t] }
    }

    /// 换一张新码进窗：被换下的那张留到它自己过期为止。
    pub fn rotate(&mut self, t: PairingTicket) {
        self.slots.retain(|s| s.usable());
        self.slots.push(t);
        if self.slots.len() > 2 {
            let extra = self.slots.len() - 2;
            self.slots.drain(0..extra);
        }
    }

    /// 当前显示的那张（二维码、短码、界面上那行配对码都取自它）
    pub fn current(&self) -> Option<&PairingTicket> {
        self.slots.last()
    }

    /// 当前那张是不是该换了（没开窗、过期、用过、或挂够久了都算）
    pub fn stale(&self) -> bool {
        match self.current() {
            Some(t) => !t.usable() || t.age() >= REFRESH_AFTER,
            None => true,
        }
    }

    /// 按 `hello.slot` 指认这次配对用的是窗里的哪一张，返回下标。
    /// 拒因串必须含「配对」字样，才能被 `refuse_code` 归成稳定的 `ticket` 码。
    pub fn select(&self, slot: &str) -> Result<usize, String> {
        match split_slot(slot).1 {
            Some(want) => self
                .slots
                .iter()
                .rposition(|t| t.usable() && t.tag() == want)
                .ok_or_else(|| "这个配对码刚被换掉，请扫桌面上当前那张".to_string()),
            None => match self.current() {
                Some(t) if t.usable() => Ok(self.slots.len() - 1),
                Some(_) => Err("配对码已过期，请在桌面上换一个".to_string()),
                None => Err("当前没有开放的配对码，请先在桌面上打开共享".to_string()),
            },
        }
    }

    /// 这趟 `slot` 走的是不是 6 位短码那扇门（只有那扇门需要失败限速，见 `link::GATE_LIMIT`）
    pub fn slot_is_code(slot: &str) -> bool {
        split_slot(slot).0 == "code"
    }

    /// 指认出来的那张票给出 salt：`slot` 的种别决定取票值还是取 6 位短码
    pub fn salt_of(&self, idx: usize, slot: &str) -> String {
        match self.slots.get(idx) {
            Some(t) if split_slot(slot).0 == "code" => t.code(),
            Some(t) => t.value().to_string(),
            None => String::new(),
        }
    }

    pub fn tag_of(&self, idx: usize) -> String {
        self.slots.get(idx).map(|t| t.tag()).unwrap_or_default()
    }

    /// 成功配对后把命中的那张作废（用后即废）。按票标识而不是下标 —— 握手与登记之间
    /// 前端可能又换了一次码，下标会漂。
    pub fn consume_tag(&mut self, tag: &str) -> bool {
        match self.slots.iter_mut().rposition(|t| t.tag() == tag) {
            Some(i) => self.slots[i].consume(),
            None => false,
        }
    }
}

/* --------------------------------------------------------------- 落盘存储 */

/// 一台已配对手机。`ls` 是那把长期链路密钥（十六进制，32 字节 → 64 字符）。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PairedDevice {
    pub key_id: String,
    pub ls: String,
    pub name: String,
    /// 配对成功那天的 Unix 毫秒；只给「已配对设备」列表显示与排序用，不参与协议。
    pub paired_at: i64,
    /// 手机侧才会用到：它把桌面的身份指纹钉在这，重连时再验一次「还是这台」。
    #[serde(default)]
    pub peer_fp: String,
}

/// 跨重启存下来的东西：桌面长期身份（PKCS#8）+ 已配对设备集。两端各存各的、字段同构，
/// 但语义不同——桌面存「我信任了哪些手机」（多台），手机存「我信任这一台桌面」（一条）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Store {
    /// base64(PKCS#8)；手机侧也用同一字段存它自己的身份（便于对端来验，尽管本版桌面不反向验手机身份）。
    #[serde(default)]
    pub identity_pkcs8: String,
    #[serde(default)]
    pub devices: Vec<PairedDevice>,
}

impl Store {
    pub fn load(path: &std::path::Path) -> Store {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            // 读坏/版本对不上就当空的重来：互联这块任何一次脏数据都不该让开关打不开
            .unwrap_or_default()
    }

    /// 原子写：先写同目录临时文件再 rename，避免崩在写一半时留下截断的 JSON 把身份弄丢。
    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("建数据目录失败：{e}"))?;
        }
        let json = serde_json::to_vec(self).map_err(|e| format!("存储序列化失败：{e}"))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &json).map_err(|e| format!("写临时文件失败：{e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("落盘失败：{e}"))
    }

    /// 按 keyId 取一把 LS（重连用）。十六进制解回 32 字节。
    pub fn find_ls(&self, key_id: &str) -> Option<[u8; 32]> {
        let dev = self.devices.iter().find(|d| d.key_id == key_id)?;
        let raw = hex_to_32(&dev.ls)?;
        Some(raw)
    }

    /// 登记/更新一台设备（按 keyId 去重）。多台并存，但同一时刻只服务一台（在 link.rs 的握手处把）。
    pub fn upsert(&mut self, dev: PairedDevice) {
        self.devices.retain(|d| d.key_id != dev.key_id);
        self.devices.push(dev);
    }

    pub fn revoke(&mut self, key_id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|d| d.key_id != key_id);
        self.devices.len() != before
    }
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = (b[i * 2] as char).to_digit(16)?;
        let lo = (b[i * 2 + 1] as char).to_digit(16)?;
        *byte = (hi * 16 + lo) as u8;
    }
    Some(out)
}

pub fn ls_to_hex(ls: &[u8; 32]) -> String {
    ls.iter().map(|b| format!("{b:02x}")).collect()
}

/// base64（PKCS#8 用）——复用 link.rs 里同一套 base64 engine，别引入第二个。
pub fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// 从存储里的 base64 私钥恢复身份对象；缺失或损坏返回错误。
pub fn identity_from_store(store: &Store) -> Result<identity::Identity, String> {
    let bytes = b64_decode(&store.identity_pkcs8).ok_or("桌面身份不是合法 base64")?;
    identity::Identity::from_pkcs8(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn LS_只依赖共享_与票无关() {
        let shared = [0x33u8; 32];
        let a = derive_link_secret(&shared);
        let b = derive_link_secret(&shared);
        assert_eq!(a, b, "同一份 ECDH 共享必须得同一把 LS");
        let c = derive_link_secret(&[0x34u8; 32]);
        assert_ne!(a, c, "不同共享得不同 LS");
    }

    #[test]
    fn keyId_稳定_可反查_且不像LS() {
        let ls = derive_link_secret(&[0x11u8; 32]);
        let k = key_id(&ls);
        assert_eq!(k.len(), 16);
        assert_ne!(k, key_id(&derive_link_secret(&[0x99u8; 32])));
        // LS 前 8 字节的 hex 不等于 keyId（证明 keyId 是哈希过、不是 LS 前缀直读）
        assert_ne!(k, ls_to_hex(&ls)[..16]);
    }

    #[test]
    fn 短码是六位数字且由票确定() {
        let t = "00112233445566778899aabbccddeeff";
        let c = short_code(t);
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|d| d.is_ascii_digit()), "短码要能手输：{c}");
        assert_eq!(c, short_code(t), "同票同码");
        assert_ne!(c, short_code("ffffffffffffffffffffffffffffffff"));
    }

    #[test]
    fn 二维码载荷往返() {
        let p = PairingPayload {
            host: "192.168.1.20".into(),
            port: 47123,
            ticket: "00112233445566778899aabbccddeeff".into(),
            name: "MISAKI-PC".into(),
            fp: "ABCDEFGHJKLMNO".into(),
        };
        let uri = p.to_uri();
        assert!(uri.starts_with("hide-link://pair?"));
        let back = PairingPayload::parse(&uri).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn 载荷对设备名里的空格与符号做转义() {
        let p = PairingPayload {
            host: "my-laptop".into(),
            port: 50000,
            ticket: "00112233445566778899aabbccddeeff".into(),
            name: "张三 & 李四=王五#?".into(),
            fp: "AAA".into(),
        };
        let back = PairingPayload::parse(&p.to_uri()).unwrap();
        assert_eq!(back.name, p.name, "带空格与 query 分隔符的名字要原样往返");
    }

    #[test]
    fn 载荷解析挡掉坏输入() {
        assert!(PairingPayload::parse("http://example.com").is_err());
        assert!(PairingPayload::parse("hide-link://pair?port=47123").is_err(), "缺 host");
        assert!(PairingPayload::parse("hide-link://pair?host=1.2.3.4&port=80").is_err(), "端口越界");
        assert!(
            PairingPayload::parse("hide-link://pair?host=1.2.3.4&port=47123&ticket=zz")
                .is_err(),
            "票形状不对"
        );
        // 票为空是合法的（6 位短码手输路径没有票）
        assert!(PairingPayload::parse("hide-link://pair?host=1.2.3.4&port=47123").is_ok());
    }

    #[test]
    fn 一次性票_用后即废且会过期() {
        let mut t = PairingTicket::new("00112233445566778899aabbccddeeff".into());
        assert!(t.usable());
        assert_eq!(t.code(), short_code(t.value()));
        assert!(t.consume(), "第一次消费应成功");
        assert!(!t.usable(), "用过就不能再用");
        assert!(!t.consume(), "二次消费失败");
    }

    #[test]
    fn 存储往返与LS反查() {
        let dir = std::env::temp_dir().join(format!("heid-link-store-{}", std::process::id()));
        let path = dir.join("link.json");
        let mut s = Store::default();
        let ls = derive_link_secret(&[0x77u8; 32]);
        s.identity_pkcs8 = b64_encode(b"fake-pkcs8-bytes");
        s.upsert(PairedDevice {
            key_id: key_id(&ls),
            ls: ls_to_hex(&ls),
            name: "SM-X808U".into(),
            paired_at: 123,
            peer_fp: "ABC".into(),
        });
        s.save(&path).unwrap();
        let back = Store::load(&path);
        assert_eq!(back.identity_pkcs8, s.identity_pkcs8);
        assert_eq!(back.devices.len(), 1);
        assert_eq!(back.find_ls(&key_id(&ls)).unwrap(), ls, "存进去的 LS 要能按 keyId 原样取回");
        assert!(back.find_ls("deadbeefdeadbeef").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 旧存储里多出来的字段不影响读取() {
        // 拆掉「测试配对模式」之前存下来的 `link.json` 每行都带着 `via_test`。
        // 升级之后那个字段不存在了 —— 旧文件必须照样读得开，否则一升级就把人配对好的设备全丢掉。
        let dir = std::env::temp_dir().join(format!("heid-link-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("link.json");
        let ls = derive_link_secret(&[0x33u8; 32]);
        std::fs::write(
            &path,
            format!(
                r#"{{"identity_pkcs8":"","devices":[{{"key_id":"{}","ls":"{}","name":"NOH-AL00","paired_at":9,"peer_fp":"","via_test":true}}]}}"#,
                key_id(&ls),
                ls_to_hex(&ls)
            ),
        )
        .unwrap();
        let back = Store::load(&path);
        assert_eq!(back.devices.len(), 1, "旧那份配对记录要原样读回来");
        assert_eq!(back.devices[0].name, "NOH-AL00");
        assert_eq!(back.find_ls(&key_id(&ls)).unwrap(), ls, "LS 不能因为多认不出一个字段就丢");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 撤销与去重登记() {
        let mut s = Store::default();
        let ls = derive_link_secret(&[0x01u8; 32]);
        let kid = key_id(&ls);
        s.upsert(PairedDevice { key_id: kid.clone(), ls: ls_to_hex(&ls), name: "a".into(), paired_at: 1, peer_fp: String::new() });
        s.upsert(PairedDevice { key_id: kid.clone(), ls: ls_to_hex(&ls), name: "b".into(), paired_at: 2, peer_fp: String::new() });
        assert_eq!(s.devices.len(), 1, "同 keyId 重复登记要覆盖不是追加");
        assert_eq!(s.devices[0].name, "b");
        assert_eq!(s.devices[0].paired_at, 2, "覆盖登记时新那份的字段要整个替换，别拿旧行的凑数");
        assert!(s.revoke(&kid));
        assert!(!s.revoke(&kid), "撤销不存在的设备返回 false");
        assert!(s.devices.is_empty());
    }

    #[test]
    fn 坏存储文件当作空的() {
        let dir = std::env::temp_dir().join(format!("heid-link-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("link.json");
        std::fs::write(&path, b"{ not json").unwrap();
        let s = Store::load(&path);
        assert!(s.devices.is_empty() && s.identity_pkcs8.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ------------------------------------------------------------ 一次配对窗 */

    const TICKET_A: &str = "00112233445566778899aabbccddeeff";
    const TICKET_B: &str = "112233445566778899aabbccddeeff00";

    #[test]
    fn 自动换码后正对着的那张旧码还配得上() {
        // 桌面每 70 秒换一张码。手机扫的是屏幕上的图像，从入镜到拨过去有一两秒，
        // 换码若当场作废旧票，这一两秒就是「每次都可能撞上、撞上又说不清」的偶发失败。
        let mut w = PairingWindow::new(PairingTicket::new(TICKET_A.into()));
        let old_tag = w.current().unwrap().tag();
        w.rotate(PairingTicket::new(TICKET_B.into()));
        assert_eq!(w.current().unwrap().value(), TICKET_B, "换进来的那张是当前显示的那张");

        let slot = format!("ticket:{old_tag}");
        let idx = w.select(&slot).expect("刚换下的那张还在窗里");
        assert_eq!(w.salt_of(idx, &slot), TICKET_A, "salt 取的是扫的那张，不是屏幕上现在这张");
        assert!(w.consume_tag(&old_tag));
        assert!(w.select(&slot).is_err(), "用后即废：旧票配过一次就再也配不上");
        // 当前那张不受影响
        assert_eq!(w.salt_of(w.select("ticket").unwrap(), "ticket"), TICKET_B);
    }

    #[test]
    fn 只有短码那扇门算试错() {
        // 失败限速只数这一种口（`link::GATE_LIMIT`）：票与 LS 都猜不出来，
        // 把它们算进去会把"拿着旧码来扫"的正常用户关在门外
        assert!(PairingWindow::slot_is_code("code"));
        assert!(!PairingWindow::slot_is_code("ticket"), "扫码那趟不该计数");
        assert!(!PairingWindow::slot_is_code("ticket:0a1b2c"), "带标识的票也不计数");
        assert!(!PairingWindow::slot_is_code(""), "缺字段兜底成不计数");
    }

    #[test]
    fn 不带票标识按当前那张认_旧版手机与短码都走这条() {
        let mut w = PairingWindow::new(PairingTicket::new(TICKET_A.into()));
        w.rotate(PairingTicket::new(TICKET_B.into()));
        // 手输 6 位短码那趟手里没有票值、算不出标识；旧版手机也从来只发 "ticket"/"code"。
        assert_eq!(w.salt_of(w.select("ticket").unwrap(), "ticket"), TICKET_B);
        assert_eq!(w.salt_of(w.select("code").unwrap(), "code"), short_code(TICKET_B));
    }

    #[test]
    fn 该不该换码只由窗自己判() {
        // 前端定时器只是按时来问一句，"换不换"在这里判：两处各判一次就会出现
        // 「屏幕上这张已经不是当前那张」（2026-09-27 他那次重配撞上的就是这个）
        assert!(PairingWindow::default().stale(), "没开窗就该换");
        let w = PairingWindow::new(PairingTicket::new(TICKET_A.into()));
        assert!(!w.stale(), "刚挂出来的票不该被立刻换掉");
    }

    #[test]
    fn 票标识对不上就是拒_且拒因归得成稳定码() {
        let w = PairingWindow::new(PairingTicket::new(TICKET_A.into()));
        let e = w.select("ticket:deadbe").unwrap_err();
        // `refuse_code` 按「配对/票」字样归类，串里必须带着这两个字之一
        assert!(e.contains("配对"), "拒因串要能被归成 ticket 稳定码：{e}");
    }

    #[test]
    fn 窗里最多两张_且没开窗时拒因说的是没开启() {
        let mut w = PairingWindow::default();
        let e = w.select("ticket").unwrap_err();
        assert!(e.contains("配对"), "没开窗的拒因也要归成 ticket：{e}");
        assert!(w.stale(), "没开窗当然算该换一张");
        for i in 0..5u8 {
            w.rotate(PairingTicket::new(format!("{:0>32x}", i)));
        }
        assert_eq!(w.slots.len(), 2, "换掉的码不能一张张攒着，最多留刚换下的那一张");
    }
}
