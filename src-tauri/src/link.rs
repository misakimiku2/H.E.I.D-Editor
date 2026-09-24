//! 设备互联基座（v1.5 阶段 0）：局域网内桌面与手机之间的加密帧通道。
//!
//! 承载：TCP + `u32` 大端长度前缀 + JSON 帧。桌面恒为服务端、手机恒为客户端
//! （手机当服务端会被 Doze 杀后台监听，见设计稿 §2.1）。
//! 加密：X25519 临时密钥协商 → HKDF-SHA256(salt = 配对票) 派生**双向各一把**
//! ChaCha20-Poly1305 密钥；握手两帧明文（只有版本与公钥），其余全部 AEAD。
//!
//! 三处"改错了会出安全问题"的实现选择，理由写在对应位置：
//! - nonce 用每方向单调计数器，不用随机数（见 [`Session::nonce_of`]）；
//! - 配对票从不上网，只作为 HKDF 的 salt 参与派生（见 [`derive_keys`]）；
//! - 读超时与"半帧"必须分开处理，否则会在帧中间丢同步（见 [`Framer`]）。

use std::collections::{HashMap, VecDeque};
// 只有桌面侧的 `fs` 推送槽用得上（`Push::dirs` 本身是 desktop-only）
#[cfg(desktop)]
use std::collections::BTreeSet;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf::{Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// 桌面长期身份（Ed25519 密钥对 + 二维码指纹）——阶段 1「记住设备、免扫重连」的信任根。
mod identity;
/// 配对凭证纯逻辑：一次性票 / 长期链路密钥 LS / keyId / 6 位短码 / 二维码载荷 / 落盘存储。
mod pair;
/// 共享根与路径逃逸防护（阶段 2）：`relPath` 只能落在根内。
mod roots;
/// 桌面标签看板与根外文件白名单（阶段 3）：聚焦窗口决定列表，白名单决定 `@w/…` 能否解析。
mod board;
/// 远程文件命令面（阶段 2）：`list` / `stat` / `read` / `write`，不碰网络也不碰会话。
mod fsrv;
/// 桌面文件变更 → 手机的推送内容（阶段 4）。只有桌面有本地递归监听这回事，
/// 且它复用搜索侧的目录黑名单（`search` 本身就是 desktop-only）。
#[cfg(desktop)]
mod watch;

/// 协议版本。`hello` 里强校验：安卓侧载无静默更新，两端版本会长期不一致，
/// 不匹配必须明确拒绝而不是"尽力兼容"。
pub const PROTOCOL_VERSION: u32 = 1;
/// 单帧上限。阶段 2 的 `read` 响应会接近这个值（>32MB 的文件不远程打开）。
/// 长度前缀来自不可信的对端，必须先看上限再分配。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// 握手帧远小于数据帧，单独给一个小上限：握手期就收到巨帧只可能是攻击或跑偏
const MAX_HANDSHAKE_BYTES: usize = 64 * 1024;
/// 心跳间隔与判死次数（设计稿 §4.1：15s，两次失败判定断连）
const HEARTBEAT: Duration = Duration::from_secs(15);
const MAX_MISSES: u32 = 2;
/// accept 轮询与读超时粒度：停止开关要能被及时观察到
const POLL: Duration = Duration::from_millis(20);
/// 握手整体超时：对端半开时不能把连接线程吊死
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TICKET_BYTES: usize = 16;
const INFO_C2S: &[u8] = b"heid-link-v1 c2s";
const INFO_S2C: &[u8] = b"heid-link-v1 s2c";
/// bind 成功之后，多久没有任何连接尝试就提一次「可能被防火墙拦截」（设计稿 §11.1）
const BIND_QUIET_HINT: Duration = Duration::from_secs(15);
/// 前端订阅的状态事件名
pub const EVENT: &str = "heid-link";
/// 阶段 1 的配对请求（TOFU）事件名：桌面收到一个持票设备、等用户点允许/拒绝时推这个
pub const EVENT_PAIR: &str = "heid-link-pair";
/// 手机侧订阅的对端推送事件名（阶段 3 起）。载荷 [`RemoteEvent`]。
///
/// 单单一件事件而不是每种推送各开一个事件名：推送的"有哪些类型"是协议面的事，
/// 前端按 `typ` 分派一次即可，加一类事件不用改两端的事件名约定。
pub const EVENT_REMOTE: &str = "heid-link-event";

/* ------------------------------------------------------------------ 消息 */

/// 握手模式（阶段 1）：配对用一次性票当 salt、握手后登记 LS；重连用存下的 LS 当 salt。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Pair,
    Reconnect,
}

/// 帧内消息。阶段 0 只有握手与心跳；阶段 2 的 list/stat/read/write 在此扩展，
/// 版本不匹配会在握手期就被拒，所以不需要为旧版本留兼容分支。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    /// 握手第一帧（明文）：协议版本 + 本方 X25519 公钥 + 可读信息 + 配对模式。
    /// `mode=pair` 时 `key_id` 为空、`slot` 说明 salt 取票（`ticket`）还是取 6 位短码（`code`）；
    /// `mode=reconnect` 时 `key_id` 是要用的那把 LS 的公开标识，`slot` 忽略。
    Hello {
        ver: u32,
        #[serde(rename = "pub")]
        pub_key: String,
        agent: String,
        device: String,
        mode: Mode,
        key_id: String,
        slot: String,
    },
    /// 握手第二帧（明文）：服务端同意，带回自己的公钥
    Welcome {
        ver: u32,
        #[serde(rename = "pub")]
        pub_key: String,
    },
    /// 握手后服务端发的第一帧**密文**：桌面长期身份的公钥 + 对握手内容的签名。
    /// 手机据此校验指纹是否与码里/钉住的一致，从而挡住同网段抢答与"地址被换了机器"。
    Auth {
        id: String,
        sig: String,
    },
    Ping {},
    Pong {},
    /// 拒绝并关闭。`code` 是稳定标识（前端按它出文案），`reason` 给人看
    Refused { code: String, reason: String },
    /// 正常收尾
    Bye {},
    /// 应用层请求（阶段 2 起）。`id` 由发起方自增、只在本连接内有意义；
    /// `params` 是 JSON 文本而不是结构体 —— 命令面的形状归 `fsrv` 管，
    /// 帧层不认识任何具体命令，加命令不用动这里。
    Req { id: u64, method: String, params: String },
    /// 对 `Req` 的应答。`ok=false` 时 `code` 是稳定标识、`error` 给人看；
    /// `data` 同样是 JSON 文本。
    Res { id: u64, ok: bool, code: String, error: String, data: String },
    /// 服务端主动推送（无 id、不要求应答）。`typ` 是稳定标识（`tabs` / `fs` / `rootChanged`…），
    /// `data` 是 JSON 文本 —— 与 `Req`/`Res` 同一策略，帧层不认识任何具体事件。
    ///
    /// 只推「变了」这个事实而不把内容一起塞进帧：对端本来就要用它自己的 `id` 走一次请求，
    /// 内容跟着请求的基线走才不会推出半新半旧的两份。
    Event { #[serde(rename = "type")] typ: String, data: String },
}

/// 加密帧的信封。`seq` 与 nonce 计数器同值，作为协议层的顺序断言：
/// 解密成功但 seq 不对，说明流被拼接（例如把上一条连接的尾巴接了过来），判死。
#[derive(Serialize, Deserialize, Debug)]
struct Envelope {
    seq: u64,
    msg: Msg,
}

/* ------------------------------------------------------------------ 帧读写 */

/// 长度前缀帧的**增量**读取器。
///
/// 为什么需要它而不是 `read_exact`：socket 设了读超时之后，`read_exact`
/// 可能在读完半个长度前缀时才超时，那半个前缀留在内核缓冲区里，
/// 下一次调用会把它当新帧的开头 —— 从这一刻起整个流的帧边界全错。
/// 本结构把"已读到但还不够一帧"的字节存在用户态缓冲区里，超时只是
/// 返回 `None`，不丢任何字节。
#[derive(Default)]
pub struct Framer {
    buf: Vec<u8>,
}

/// 读帧的失败分类。**只有 `Peer` 之外的才允许继续读**：
/// 超限与协议错误之后流上还有未知长度的残留字节，必须断开。
#[derive(Debug)]
pub enum FrameError {
    /// 对端关掉了连接
    Eof,
    /// 长度前缀超限
    TooLarge { len: u32 },
    /// 流被中断/损坏
    Peer(String),
}

impl Framer {
    /// 从流里推进一次，能凑出完整帧就返回它，否则返回 `None`
    pub fn next_frame<R: Read>(&mut self, r: &mut R, max: usize) -> Result<Option<Vec<u8>>, FrameError> {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            if let Some(frame) = self.take_frame(max)? {
                return Ok(Some(frame));
            }
            match r.read(&mut chunk) {
                Ok(0) => return Err(FrameError::Eof),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None)
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(FrameError::Peer(e.to_string())),
            }
        }
    }

    /// 缓冲区里是否已有一个完整帧；有则取出
    fn take_frame(&mut self, max: usize) -> Result<Option<Vec<u8>>, FrameError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
        if len as usize > max {
            return Err(FrameError::TooLarge { len });
        }
        let end = 4 + len as usize;
        if self.buf.len() < end {
            return Ok(None);
        }
        let frame = self.buf[4..end].to_vec();
        self.buf.drain(..end);
        Ok(Some(frame))
    }

    /// 已缓冲但未成帧的字节数。只给测试用（"半帧不丢"那条断言要看的就是它），
    /// 运行时没有任何路径需要读它，所以不编进发布包。
    #[cfg(test)]
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }
}

pub fn write_frame<W: Write>(w: &mut W, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "帧超过长度前缀上限"))?;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

/* ------------------------------------------------------------------ 密钥 */

/// 配对票：128 bit 随机、32 个十六进制字符。**只在两端本地存在**，
/// 网络上从不发送它本身（见 [`derive_keys`]）。阶段 1 的二维码带它 + 地址。
pub fn new_ticket() -> String {
    let mut bytes = [0u8; TICKET_BYTES];
    // 随机源不可用就起不了服务：静默给一张弱票比不启动更糟
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("系统随机源不可用，无法生成配对票");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn is_valid_ticket(s: &str) -> bool {
    s.len() == TICKET_BYTES * 2 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn encode_pub(key: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(key)
}

fn decode_pub(s: &str) -> Result<[u8; 32], String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| "对端公钥不是合法 base64".to_string())?;
    <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| "对端公钥长度不是 32 字节".to_string())
}

/// HKDF-SHA256 派生双向密钥。salt = 配对票，所以**票不匹配的端会解不开对方的
/// 第一帧密文** —— 这就是隐式双向认证，不需要把票发出去（发出去等于任何嗅探者
/// 都能抢配对）。
fn derive_keys(shared: &[u8], ticket: &str) -> Result<([u8; 32], [u8; 32]), String> {
    let salt = Salt::new(HKDF_SHA256, ticket.as_bytes());
    let prk = salt.extract(shared);
    let mut c2s = [0u8; 32];
    let mut s2c = [0u8; 32];
    prk.expand(&[INFO_C2S], HKDF_SHA256)
        .and_then(|okm| okm.fill(&mut c2s))
        .map_err(|_| "发送密钥派生失败".to_string())?;
    prk.expand(&[INFO_S2C], HKDF_SHA256)
        .and_then(|okm| okm.fill(&mut s2c))
        .map_err(|_| "接收密钥派生失败".to_string())?;
    Ok((c2s, s2c))
}

/* ------------------------------------------------------------------ 会话 */

/// 一条已建立加密通道的一侧。两个方向各一把密钥、各一个帧计数器。
pub struct Session {
    seal: LessSafeKey,
    open: LessSafeKey,
    tx: u64,
    rx: u64,
    tag_len: usize,
}

impl Session {
    /// `we_initiate` = true 表示本端是客户端（发起 TCP 的一方）：
    /// 用 c2s 发送、s2c 接收。服务端相反。
    fn from_keys(c2s: [u8; 32], s2c: [u8; 32], we_initiate: bool) -> Result<Session, String> {
        let (seal_bytes, open_bytes) = if we_initiate { (c2s, s2c) } else { (s2c, c2s) };
        let seal = UnboundKey::new(&CHACHA20_POLY1305, &seal_bytes)
            .map_err(|_| "发送密钥长度不合法".to_string())?;
        let open = UnboundKey::new(&CHACHA20_POLY1305, &open_bytes)
            .map_err(|_| "接收密钥长度不合法".to_string())?;
        Ok(Session {
            seal: LessSafeKey::new(seal),
            open: LessSafeKey::new(open),
            tx: 0,
            rx: 0,
            tag_len: CHACHA20_POLY1305.tag_len(),
        })
    }

    /// nonce = 4 字节零 + 8 字节大端帧序号。
    ///
    /// 为什么不用随机 nonce：随机 96-bit nonce 的安全性靠生日界论证，需要
    /// "每密钥消息数远小于 2^32"这种前提；计数器由构造保证不重复。
    /// 代价是两端要同步计数，而在这条链路上同步是免费的：TCP 保序，
    /// 且任何一次解密失败都直接断开重连（见 [`Session::open_frame`]），
    /// 不存在"跳过一帧继续收"。
    /// 这也是设计稿 §2.8 原文「XChaCha20 的 192-bit 随机 nonce 天然规避计数器同步」
    /// 被替换掉的地方 —— 换成计数器之后帧体里连 nonce 都不用传，
    /// "线上没有 nonce"本身就少一个可被伪造的重放面。
    fn nonce_of(seq: u64) -> Nonce {
        let mut n = [0u8; NONCE_LEN];
        n[4..].copy_from_slice(&seq.to_be_bytes());
        Nonce::assume_unique_for_key(n)
    }

    /// 明文帧 → 密文帧字节（不含长度前缀）
    pub fn seal_frame(&self, seq: u64, msg: &Msg) -> Result<Vec<u8>, String> {
        let mut buf = serde_json::to_vec(&Envelope { seq, msg: msg.clone() })
            .map_err(|e| format!("帧序列化失败：{e}"))?;
        self.seal
            .seal_in_place_append_tag(Self::nonce_of(seq), Aad::empty(), &mut buf)
            .map_err(|_| "帧加密失败".to_string())?;
        Ok(buf)
    }

    /// 密文帧 → 明文消息。任何失败都是致命的，调用方必须断开：
    /// 此时流上的帧边界已不可信。
    pub fn open_frame(&mut self, payload: &[u8]) -> Result<Msg, String> {
        if payload.len() < self.tag_len {
            return Err("帧短于认证标签".to_string());
        }
        let seq = self.rx;
        let mut buf = payload.to_vec();
        // `open_in_place` 要的是「密文 + 标签」**整段**，明文就地写在返回的切片里。
        // 先把标签切掉再传是解不开的（本文件第一版就错在这里，且失败信息与
        // "配对票不匹配"完全相同 —— 这类错只能靠一条"成功解密"的用例兜住）。
        let plain = self
            .open
            .open_in_place(Self::nonce_of(seq), Aad::empty(), &mut buf)
            .map_err(|_| "帧解密失败：配对票不匹配，或链路已被截断".to_string())?
            .to_vec();
        let env: Envelope =
            serde_json::from_slice(&plain).map_err(|e| format!("帧解析失败：{e}"))?;
        if env.seq != seq {
            return Err(format!("帧序号不连续：期望 {seq}，收到 {}", env.seq));
        }
        self.rx += 1;
        Ok(env.msg)
    }

    pub fn send<W: Write>(&mut self, w: &mut W, msg: &Msg) -> Result<(), String> {
        let seq = self.tx;
        self.tx += 1;
        let frame = self.seal_frame(seq, msg)?;
        write_frame(w, &frame).map_err(|e| format!("帧写出失败：{e}"))
    }

    /// 非阻塞语义：`Ok(None)` = 这一轮没读到完整帧，继续
    pub fn recv<R: Read>(
        &mut self,
        r: &mut R,
        framer: &mut Framer,
    ) -> Result<Option<Msg>, String> {
        match framer.next_frame(r, MAX_FRAME_BYTES) {
            Ok(None) => Ok(None),
            Ok(Some(payload)) => self.open_frame(&payload).map(Some),
            Err(e) => Err(frame_err_text(e)),
        }
    }

    /// 已发出的帧数。同样只给测试用（nonce 与 seq 都由它推进，断言它=1 就是在
    /// 断言"下一帧的 nonce 不会重复"）。
    #[cfg(test)]
    pub fn tx_count(&self) -> u64 {
        self.tx
    }
}

fn frame_err_text(e: FrameError) -> String {
    match e {
        FrameError::Eof => "对端已关闭连接".to_string(),
        FrameError::TooLarge { len } => format!("对端帧超过 {len} 字节上限"),
        FrameError::Peer(s) => s,
    }
}

/* ------------------------------------------------------------------ 握手 */

/// 本方临时密钥对。私钥只能被 `agree_ephemeral` 消费一次，故协商必在换完明文帧之后。
fn gen_ephemeral() -> Result<(EphemeralPrivateKey, [u8; 32]), String> {
    let rng = SystemRandom::new();
    let priv_key =
        EphemeralPrivateKey::generate(&X25519, &rng).map_err(|_| "无法生成临时密钥".to_string())?;
    let pub_raw: [u8; 32] = priv_key
        .compute_public_key()
        .map_err(|_| "无法取到本方公钥".to_string())?
        .as_ref()
        .try_into()
        .map_err(|_| "本方公钥长度不是 32 字节".to_string())?;
    Ok((priv_key, pub_raw))
}

/// 用协商出的共享密钥同时得到「本会话密钥对」和「长期链路密钥 LS」。
/// 二者用同一份 shared、不同的 salt/info —— 会话密钥掺配对票（或上次的 LS），
/// LS 只掺 shared（见 [`pair::derive_link_secret`]），所以 LS 不随票作废而变，能撑起免扫重连。
fn agree_keys(
    priv_key: EphemeralPrivateKey,
    peer_pub_b64: &str,
    salt: &str,
    we_initiate: bool,
) -> Result<(Session, [u8; 32]), String> {
    let peer = UnparsedPublicKey::new(&X25519, decode_pub(peer_pub_b64)?);
    let (c2s, s2c, ls) = agree_ephemeral(priv_key, &peer, |shared| -> Result<([u8; 32], [u8; 32], [u8; 32]), String> {
        let (c2s, s2c) = derive_keys(shared, salt)?;
        Ok((c2s, s2c, pair::derive_link_secret(shared)))
    })
    .map_err(|_| "密钥协商失败".to_string())??;
    Ok((Session::from_keys(c2s, s2c, we_initiate)?, ls))
}

/// 服务端握手结果：会话 + 这次配对/重连算出的 LS + 对端设备名与模式。
pub struct ServerHandshake {
    pub session: Session,
    pub ls: [u8; 32],
    pub mode: Mode,
    pub peer_device: String,
}

/// 服务端握手：读 Hello（明文）→ 用 `resolve_salt` 选出 salt（票 / 短码 / 某把 LS）→ 换 Welcome →
/// 协商 → 用桌面长期身份对握手内容签名，作为第一帧密文发给对端。
///
/// `resolve_salt` 据模式选 salt、并在不该放行时返回 `Err(原因)`（原因串里带「配对/票」等，
/// 交给 [`refuse_code`] 归成稳定码）；一旦 Err，本函数直接返回，由 `serve_conn` 统一发一帧 Refused。
pub fn server_handshake<S: Read + Write>(
    s: &mut S,
    framer: &mut Framer,
    resolve_salt: &dyn Fn(Mode, &str, &str) -> Result<String, String>,
    id: &identity::Identity,
) -> Result<ServerHandshake, String> {
    let (priv_key, my_pub) = gen_ephemeral()?;
    let (peer_pub, peer_device, mode, key_id, slot) = match read_plain(s, framer)? {
        Msg::Hello { ver, pub_key, device, mode, key_id, slot, .. } => {
            check_version(ver)?;
            (pub_key, device, mode, key_id, slot)
        }
        other => return Err(format!("握手期望 hello，收到 {other:?}")),
    };
    let salt = resolve_salt(mode, &key_id, &slot)?;
    write_plain(
        s,
        &Msg::Welcome { ver: PROTOCOL_VERSION, pub_key: encode_pub(&my_pub) },
    )?;
    let (mut session, ls) = agree_keys(priv_key, &peer_pub, &salt, false)?;
    let id_pub = id.public_key();
    let msg = identity::auth_message(b"srv\0", &decode_pub(&peer_pub)?, &my_pub, &id_pub);
    let sig = id.sign(&msg);
    session.send(
        s,
        &Msg::Auth {
            id: encode_pub(&id_pub),
            sig: base64::engine::general_purpose::STANDARD.encode(&sig),
        },
    )?;
    Ok(ServerHandshake { session, ls, mode, peer_device })
}

/// 客户端握手：发 Hello（带模式与 keyId/slot）→ 收 Welcome（或对端的 Refused）→ 协商 →
/// 打开对端第一帧密文（`Auth`），校验桌面身份签名**与指纹**——指纹来源：配对取码里的、重连取本地钉住的。
/// 校验通过才回 `Pong`（完成对 salt 的双向证明）。
#[allow(clippy::too_many_arguments)]
pub fn client_handshake<S: Read + Write>(
    s: &mut S,
    framer: &mut Framer,
    salt: &str,
    mode: Mode,
    key_id: &str,
    slot: &str,
    agent: &str,
    device: &str,
    expected_fp: &str,
) -> Result<(Session, [u8; 32], Vec<u8>), String> {
    let (priv_key, my_pub) = gen_ephemeral()?;
    write_plain(
        s,
        &Msg::Hello {
            ver: PROTOCOL_VERSION,
            pub_key: encode_pub(&my_pub),
            agent: agent.to_string(),
            device: device.to_string(),
            mode,
            key_id: key_id.to_string(),
            slot: slot.to_string(),
        },
    )?;
    let server_pub = match read_plain(s, framer)? {
        Msg::Welcome { ver, pub_key } => {
            check_version(ver)?;
            pub_key
        }
        Msg::Refused { code, reason } => return Err(format!("对端拒绝（{code}）：{reason}")),
        other => return Err(format!("握手期望 welcome，收到 {other:?}")),
    };
    let (mut session, ls) = agree_keys(priv_key, &server_pub, salt, true)?;
    // 对端的第一帧必须是 Auth；解不开即 salt 不对（票/LS 不匹配）——与阶段 0 同一处暴露点。
    // 带截止时间循环收：真实链路上它会比 Welcome 晚几毫秒到。
    let auth = match recv_msg_deadline(s, &mut session, framer, Instant::now() + HANDSHAKE_DEADLINE)? {
        Msg::Auth { id, sig } => (id, sig),
        other => return Err(format!("握手期望 auth，收到 {other:?}")),
    };
    let id_pub = decode_pub(&auth.0)?;
    // 扫码路径带指纹（防抢答）；6 位短码手输没有码可校验，留空即跳过这一道——
    // 无论哪条，握手成功后都把真实指纹记下来，供以后重连钉住。
    if !expected_fp.is_empty() && identity::fingerprint(&id_pub) != expected_fp {
        return Err("对端身份与配对码里的指纹不符，已中止".to_string());
    }
    let sig = base64::engine::general_purpose::STANDARD
        .decode(&auth.1)
        .map_err(|_| "对端签名不是合法 base64".to_string())?;
    let msg =
        identity::auth_message(b"srv\0", &my_pub, &decode_pub(&server_pub)?, &id_pub);
    if !identity::verify(&id_pub, &msg, &sig) {
        return Err("对端身份签名校验失败".to_string());
    }
    // 通过：回 Pong 完成双向证明。
    session.send(s, &Msg::Pong {})?;
    Ok((session, ls, id_pub.to_vec()))
}

fn write_plain<W: Write>(w: &mut W, msg: &Msg) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| format!("握手序列化失败：{e}"))?;
    write_frame(w, &body).map_err(|e| format!("握手写出失败：{e}"))
}

fn read_plain<R: Read>(r: &mut R, framer: &mut Framer) -> Result<Msg, String> {
    let deadline = Instant::now() + HANDSHAKE_DEADLINE;
    loop {
        match framer.next_frame(r, MAX_HANDSHAKE_BYTES) {
            Ok(Some(body)) => {
                return serde_json::from_slice(&body)
                    .map_err(|e| format!("握手帧解析失败：{e}"))
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    return Err("握手超时".to_string());
                }
            }
            Err(e) => return Err(frame_err_text(e)),
        }
    }
}

fn check_version(ver: u32) -> Result<(), String> {
    if ver != PROTOCOL_VERSION {
        return Err(format!("协议版本不匹配：对端 {ver}，本端 {PROTOCOL_VERSION}"));
    }
    Ok(())
}

/// 在截止时间内收一个**密文**消息。`Session::recv` 单次可能返回 `Ok(None)`（读超时但帧还在路上），
/// 真实 TCP 上握手后的那一帧（Auth / Pong）常有几毫秒延迟，单次收会把它误判成失败 —— 所以这里循环等。
fn recv_msg_deadline<S: Read + Write>(
    s: &mut S,
    session: &mut Session,
    framer: &mut Framer,
    until: Instant,
) -> Result<Msg, String> {
    loop {
        match session.recv(s, framer) {
            Ok(Some(m)) => return Ok(m),
            Ok(None) => {
                if Instant::now() >= until {
                    return Err("握手超时".to_string());
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// 握手失败时回给对端的稳定错误码
fn refuse_code(err: &str) -> &'static str {
    if err.contains("协议版本") {
        "version"
    } else if err.contains("握手超时") {
        "timeout"
    } else if err.contains("指纹") || err.contains("签名") {
        "identity"
    } else if err.contains("配对") || err.contains("未登记") {
        "ticket"
    } else if err.contains("hello") || err.contains("welcome") || err.contains("auth") || err.contains("解析") {
        "protocol"
    } else {
        "handshake"
    }
}

/* ------------------------------------------------------------------ 状态 */

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    #[default]
    Off,
    Server,
    Client,
}

/// 推给前端的状态快照：`heid-link` 事件的载荷，也是 `link_status` 的返回。
/// 前端只认这一份，不在两端各维护一套"看起来一样"的状态机。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub role: Role,
    pub listening: bool,
    pub port: u16,
    pub connected: bool,
    pub peer_device: String,
    pub peer_addr: String,
    pub ticket: String,
    pub last_error: String,
    /// 本端协议版本（对端的那一份由握手校验，不匹配直接拒，不进这个快照）
    pub protocol: u32,
    /// 桌面当前的共享范围（人话形态，已去掉 `\\?\` 前缀）。手机侧恒为空。
    /// 这条是设计稿 §5.2 的硬要求：用户必须看得见手机端能读到哪些文件。
    pub root_display: String,
    /// 对端设备 id = 这次握手派生出的链路密钥 LS 的 keyId。
    /// 手机侧的 `hide-remote://<deviceId>/…` 用它当身份键（不是 IP —— 换网后 IP 会变，
    /// 已打开的标签就会指向另一台机器）。
    pub peer_key_id: String,
    /// bind 成功但迟迟没有任何连接尝试 → 提示「可能被 Windows 防火墙拦截」。
    /// 这条是设计稿 §11.1 的实现要求：「端口开着、包进不来」这种半死状态比直接报错难查得多，
    /// 而这在本机环境（有历史 node 放行规则）测不出用户侧结论，只能靠应用自己 bind 时才成立。
    pub firewall_hint: bool,
    /// 共享根之外、因「桌面上正开着」而暴露给手机的**文件**数（阶段 3 的白名单）。
    /// 与 `root_display` 同一条理由：多交出去一分，就得让用户看得见一分。
    pub open_shared: usize,
}

/// `protocol` 必须是本地常量而不是 0：前端拿它自证"我这一端说的是哪版协议"。
impl Default for LinkStatus {
    fn default() -> Self {
        LinkStatus {
            role: Role::Off,
            listening: false,
            port: 0,
            connected: false,
            peer_device: String::new(),
            peer_addr: String::new(),
            ticket: String::new(),
            last_error: String::new(),
            protocol: PROTOCOL_VERSION,
            root_display: String::new(),
            peer_key_id: String::new(),
            firewall_hint: false,
            open_shared: 0,
        }
    }
}

/// 推给前端的设备行（`link_pairings_list` 的载荷）。不含 LS，只给显示与撤销要的东西。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub key_id: String,
    pub name: String,
    pub paired_at: i64,
}

#[derive(Default)]
pub struct LinkState {
    inner: Mutex<LinkStatus>,
    stop: Mutex<Option<Arc<AtomicBool>>>,
    /// 落盘位置（app 数据目录下的 link.json）；setup 里注入，未注入时配对不落盘（仅测试/降级）
    store_path: Mutex<Option<PathBuf>>,
    /// 桌面长期身份；启动时从 store 载入或新建
    identity: Mutex<Option<identity::Identity>>,
    /// 当前有效的一次性配对票（含过期/已用状态）；开开关时新建
    pairing: Mutex<Option<pair::PairingTicket>>,
    /// 已配对设备（含各自 LS）。桌面=多台手机，手机=一台桌面，同一结构。
    store: Mutex<pair::Store>,
    /// 有一条配对请求正等用户决定（serve_conn 挂上、轮询 decision）
    pending: Mutex<Option<()>>,
    decision: Mutex<Option<bool>>,
    /// 桌面共享根（canonicalize 之后）按窗口各存一份。None = 那个窗口没开文件树。
    /// 与标签列表同属 [`board`]：谁是聚焦窗口，暴露面就是那一份。
    board: Mutex<board::Board>,
    /// 手机侧的活连接；前端 `link_request` 走它把请求塞进发出队列
    conn: Mutex<Option<Arc<Conn>>>,
    /// 桌面侧这条连接的推送队列（阶段 3 的 `event {type:'tabs'}`）。连接建立时挂上、结束时摘掉
    push: Mutex<Option<Arc<Push>>>,
    /// 桌面侧那份递归监听（阶段 4）。存在的唯一条件是「有设备在线且它要看的那棵树已定」，
    /// 断开或换根即释放/重建 —— 见 [`sync_fs_watch`]
    #[cfg(desktop)]
    fs_watch: Mutex<Option<watch::Handle>>,
}

/// 推给手机前端的对端事件载荷：`typ` 与帧里的 `event.type` 同名，`data` 是 JSON 文本。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEvent {
    #[serde(rename = "type")]
    pub typ: String,
    pub data: String,
}

impl LinkState {
    fn snapshot(&self) -> LinkStatus {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn identity_fp(&self) -> String {
        self.identity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|i| i.fingerprint())
            .unwrap_or_default()
    }
}

/* ------------------------------------------------------------------ 客户端请求通路 */

/// 一条已建立的客户端连接（手机侧）。前端命令与维持线程之间只经这三样东西交接：
/// 发出队列、等待中的请求表、以及「还活着」旗标。
///
/// 为什么不由命令线程直接往 socket 写：`Session` 里的发送帧计数器必须和写出顺序严格一致
/// （见 [`Session::nonce_of`]），两个线程各写各的会立刻把 nonce 与流顺序错开。
/// 所以socket 只有维持线程一个主人，命令线程把请求放进队列、由它在下一轮 poll 里发出。
pub struct Conn {
    outbox: Mutex<VecDeque<OutReq>>,
    pending: Mutex<HashMap<u64, Arc<Slot>>>,
    seq: AtomicU64,
    alive: AtomicBool,
}

struct OutReq {
    id: u64,
    method: String,
    params: String,
}

/// 一次请求的落点：`Condvar` 唤醒等待的命令线程，不靠轮询。
#[derive(Default)]
struct Slot {
    done: Mutex<Option<Result<String, String>>>,
    cv: Condvar,
}

/// 远程命令的等待上限。6MB 的读取在局域网里是亚秒级，但手机可能在信号边缘，
/// 宁可明确报「超时」也不要让前端的保存按钮一直转。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

impl Conn {
    fn new() -> Arc<Conn> {
        Arc::new(Conn {
            outbox: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
            alive: AtomicBool::new(true),
        })
    }

    /// 发一条远程命令并等结果。在 [`run_pump`] 转出这帧之前它只是队列里的一条记录。
    ///
    /// 加锁顺序要紧：`deliver` 是先 `pending` 后 `done`，所以这里凡是握着 `done`
    /// 的守卫就绝不再去碰 `pending`，取走结果后先放下守卫再摘表项。
    fn call(&self, method: &str, params: String) -> Result<String, String> {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let slot = Arc::new(Slot::default());
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id, Arc::clone(&slot));
        self.outbox.lock().unwrap_or_else(|p| p.into_inner()).push_back(OutReq {
            id,
            method: method.to_string(),
            params,
        });
        let mut g = slot.done.lock().unwrap_or_else(|p| p.into_inner());
        let until = Instant::now() + REQUEST_TIMEOUT;
        loop {
            if let Some(r) = g.take() {
                drop(g);
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                return r;
            }
            if !self.alive.load(Ordering::SeqCst) {
                drop(g);
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                return Err("链路已断开，这次没有送达桌面".to_string());
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                drop(g);
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
                return Err("桌面 30 秒内没有回话，请检查连接".to_string());
            }
            g = match slot.cv.wait_timeout_while(g, left, |v| v.is_none()) {
                Ok((g, _)) => g,
                Err(_) => return Err("等待被中断".to_string()),
            };
        }
    }

    /// 维持线程用：取走本回合要发的请求
    fn take_outbox(&self) -> Vec<OutReq> {
        let mut g = self.outbox.lock().unwrap_or_else(|p| p.into_inner());
        g.drain(..).collect()
    }

    /// 维持线程用：把应答交给等待者。未知 id（已超时被摘掉）直接丢弃。
    fn deliver(&self, id: u64, result: Result<String, String>) {
        if let Some(slot) = self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
            *slot.done.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
            slot.cv.notify_all();
        }
    }

    /// 连接结束时唤醒所有还在等的人，别让命令线程等到超时才反应过来
    fn shutdown(&self, why: &str) {
        self.alive.store(false, Ordering::SeqCst);
        let drained: Vec<Arc<Slot>> = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        for slot in drained {
            *slot.done.lock().unwrap_or_else(|p| p.into_inner()) =
                Some(Err(format!("链路已断开：{why}")));
            slot.cv.notify_all();
        }
    }
}

/// 桌面 → 手机的推送队列（阶段 3）。存在理由与 [`Conn`] 完全一样：
/// socket 只有维持线程一个主人，发送帧计数器才可能和写出顺序严格一致，
/// 所以别的线程（窗口上报标签、焦点事件、关窗）只往这里挂一帧，由 pump 在下一回合发出。
#[derive(Default)]
pub struct Push {
    items: Mutex<VecDeque<Msg>>,
    /// `fs` 那一类单独存：它带的是「哪些目录变了」这个**集合**，来一批并进来一批。
    /// 走 `items` 的话会被"同一类型只留一条"吃掉后一帧的目录（阶段 4 工单点名不能照抄的那条），
    /// 而集合天然可合并、长度由 `watch::MAX_PUSH_DIRS` 在出口处统一管。
    /// 只有桌面侧会有文件变更可推（手机是那棵树的远端读者），故整个字段 desktop-only。
    #[cfg(desktop)]
    dirs: Mutex<BTreeSet<String>>,
}

impl Push {
    /// 挂一条 `event {type:typ}`。同一类型只留一条：这类推送的语义是「变了，去重取」，
    /// 连着来十条只是让对端多拉十次同样的结果 —— dedupe 掉既省帧也让队首不饿死。
    /// 不复制 `Msg`，所以队列长度天然有界（一类型一条）。
    pub fn queue(&self, typ: &str) {
        let mut g = self.items.lock().unwrap_or_else(|p| p.into_inner());
        let dup = g.iter().any(|m| matches!(m, Msg::Event { typ: t, .. } if t == typ));
        if !dup {
            g.push_back(Msg::Event { typ: typ.to_string(), data: String::new() });
        }
    }

    /// 挂一批文件变更（阶段 4）。载荷在 [`Push::take`] 时才序列化，所以泵线程被一次
    /// 大文件读拖住的这几秒里攒下的若干窗口会合成一帧，而不是排成一串各自一帧。
    #[cfg(desktop)]
    pub fn queue_fs(&self, dirs: &[String]) {
        let mut g = self.dirs.lock().unwrap_or_else(|p| p.into_inner());
        // 已经退化成"整棵树都动了"就不必再攒名字了
        if g.len() > watch::MAX_PUSH_DIRS {
            return;
        }
        g.extend(dirs.iter().cloned());
    }

    /// 维持线程用：取走本回合要发的帧
    fn take(&self) -> Vec<Msg> {
        let mut out: Vec<Msg> = {
            let mut g = self.items.lock().unwrap_or_else(|p| p.into_inner());
            g.drain(..).collect()
        };
        #[cfg(desktop)]
        let dirs: Vec<String> = {
            let mut g = self.dirs.lock().unwrap_or_else(|p| p.into_inner());
            // 整份取走：留在队列里下一回合又发一遍，手机端就会为同一批目录重列两次
            std::mem::take(&mut *g).into_iter().collect()
        };
        #[cfg(desktop)]
        if !dirs.is_empty() {
            // 装得下就报目录清单，装不下就退化成不带载荷的一条 —— 后者手机端会整个重取，
            // 宁可多列几层也不能漏掉变化，所以退化方向只有一个
            let data = watch::payload_of(dirs.iter().map(|s| s.as_str())).unwrap_or_default();
            out.push(Msg::Event { typ: EVENT_FS.to_string(), data });
        }
        out
    }
}

/// 状态变更的唯一出口：改快照 + 推事件
fn publish(app: &AppHandle, f: impl FnOnce(&mut LinkStatus)) {
    let state = app.state::<LinkState>();
    let next = {
        let mut g = state.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g);
        g.clone()
    };
    let _ = app.emit(EVENT, &next);
}

fn snapshot(app: &AppHandle) -> LinkStatus {
    app.state::<LinkState>().snapshot()
}

fn mark_error(app: &AppHandle, msg: impl Into<String>) {
    let msg = msg.into();
    publish(app, |s| {
        s.connected = false;
        s.peer_device.clear();
        s.peer_addr.clear();
        s.last_error = msg;
    });
}

/// 换掉停止开关，返回旧的（调用方负责把它置为 true）
fn replace_stop(state: &LinkState, flag: Option<Arc<AtomicBool>>) -> Option<Arc<AtomicBool>> {
    let mut g = state.stop.lock().unwrap_or_else(|p| p.into_inner());
    std::mem::replace(&mut *g, flag)
}

/* -------------------------------------------------- 配对辅助（阶段 1） */

/// 用户多久没决定就把这次配对请求当作拒绝。别拿手机干等，也别久占桌面。
const PAIR_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

/// 推给前端的配对请求（TOFU 弹窗要显示的手机名 + 这次的 keyId）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairReq {
    pub device: String,
    pub key_id: String,
}

/// `link_pair_qr` 的返回：二维码 URI + 6 位短码 + 本机地址（供手填兜底时显示）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QrInfo {
    pub uri: String,
    pub code: String,
    pub host: String,
    pub port: u16,
    pub fp: String,
    pub name: String,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把存储落盘。没注入路径（测试/降级）就跳过；失败不致命，下一次配对再试。
fn persist(state: &LinkState) {
    let path = state.store_path.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(p) = path {
        let g = state.store.lock().unwrap_or_else(|p| p.into_inner());
        let _ = g.save(&p);
    }
}

fn clear_pending(state: &LinkState) {
    *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = None;
    *state.decision.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// 轮询等用户决定；超时、或等待期间桌面关了共享，都当作拒绝。
fn wait_decision(app: &AppHandle, state: &LinkState, timeout: Duration) -> bool {
    let until = Instant::now() + timeout;
    loop {
        if let Some(v) = *state.decision.lock().unwrap_or_else(|p| p.into_inner()) {
            return v;
        }
        if snapshot(app).role == Role::Off || stop_requested(app) {
            return false;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

/// 桌面当前的停止开关是否已被置位（关开关 / 重启服务时用它尽早收场）。
fn stop_requested(app: &AppHandle) -> bool {
    let state = app.state::<LinkState>();
    let g = state.stop.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref().map(|f| f.load(Ordering::SeqCst)).unwrap_or(false)
}

/// 本机对局域网可见的 IPv4：UDP「connect」不发包，只让内核按默认路由选出出口网卡地址。
/// 拿不到（无网络 / 特殊环境）返回空串，前端据此提示手填地址。
fn local_ipv4() -> String {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return String::new() };
    // 目的地址不需要可达，甚至不需要存在——connect 只是选定一条出向路由
    if sock.connect(("8.8.8.8", 80)).is_err() {
        return String::new();
    }
    sock.local_addr().map(|a| a.ip().to_string()).unwrap_or_default()
}

/// 桌面设备名：`COMPUTERNAME`（Windows）兜底 hostname。手机侧的名字经 HeidBridge 上报，不在这。
fn desktop_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "H.I.D.E".to_string())
}

/* ------------------------------------------------------------------ 连接维持 */

/// 一条请求 → 一帧应答。服务端 pump 与单测**共用**这一个函数：
/// 两边各写一遍 `match fsrv::handle(...)` 的话，命令面改了响应形状时测的是一套、跑的是一套。
fn answer_req(scope: &board::Scope, id: u64, method: &str, params: &str) -> Msg {
    match fsrv::handle(scope, method, params) {
        Ok(data) => Msg::Res { id, ok: true, code: String::new(), error: String::new(), data },
        Err((code, error)) => Msg::Res { id, ok: false, code, error, data: String::new() },
    }
}

/// 握手后的维持循环：心跳、断连判定、停止开关观察，以及**应用层消息的分派**。
/// 两端共用，只有 `role` 不同：服务端答 `Req`，客户端发 `Req` 并收 `Res` / `Event`。
///
/// 为什么分派也在这一个线程里做、不在命令线程里各开一路：见 [`Conn`] —— socket 只有一个主人，
/// 发送帧计数器才可能和写出顺序保持一致。
fn run_pump(
    mut stream: TcpStream,
    mut session: Session,
    app: &AppHandle,
    stop: &AtomicBool,
    role: Role,
) {
    let mut framer = Framer::default();
    let mut last_ping = Instant::now();
    let mut misses: u32 = 0;
    let mut awaiting_pong = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = session.send(&mut stream, &Msg::Bye {});
            return;
        }
        // 客户端：把前端排进来的远程命令发出去（一个回合全发，不一次只发一条）
        if role == Role::Client {
            let conn = client_conn(app);
            if let Some(conn) = conn.as_ref() {
                for req in conn.take_outbox() {
                    let OutReq { id, method, params } = req;
                    if let Err(e) = session.send(&mut stream, &Msg::Req { id, method, params }) {
                        mark_error(app, e);
                        return;
                    }
                }
            }
        }
        // 服务端：把别的线程挂上来的推送发出去（同上一条的理由，socket 只有一个主人）
        if role == Role::Server {
            if let Some(push) = server_push(app) {
                for msg in push.take() {
                    eprintln!("[heid-fsDBG] 泵要发 {msg:?}");
                    if let Err(e) = session.send(&mut stream, &msg) {
                        mark_error(app, e);
                        return;
                    }
                }
            }
        }
        match session.recv(&mut stream, &mut framer) {
            Ok(Some(Msg::Pong {})) => {
                misses = 0;
                awaiting_pong = false;
            }
            Ok(Some(Msg::Ping {})) => {
                if let Err(e) = session.send(&mut stream, &Msg::Pong {}) {
                    mark_error(app, e);
                    return;
                }
            }
            Ok(Some(Msg::Req { id, method, params })) => {
                if role != Role::Server {
                    mark_error(app, "手机端是客户端，不该收到请求帧".to_string());
                    return;
                }
                let scope = board_scope(app);
                let msg = answer_req(&scope, id, &method, &params);
                if let Err(e) = session.send(&mut stream, &msg) {
                    mark_error(app, e);
                    return;
                }
            }
            Ok(Some(Msg::Res { id, ok, code, error, data })) => {
                match client_conn(app) {
                    Some(conn) => conn.deliver(id, if ok { Ok(data) } else { Err(format!("{code}: {error}")) }),
                    None => mark_error(app, "没有活连接却收到应答帧".to_string()),
                }
            }
            Ok(Some(Msg::Event { typ, data })) => {
                // 只有手机侧该收到推送；桌面收到说明对端把我们当客户端在指挥，判死。
                if role != Role::Client {
                    mark_error(app, "桌面是服务端，不该收到事件帧".to_string());
                    return;
                }
                // 转成前端事件就完事：手机上「哪个类型该重取什么」由 `link.ts` 那侧决定，
                // 帧层与这里都不认识具体事件类型的语义（加一类事件不用动这个函数）。
                let _ = app.emit(EVENT_REMOTE, &RemoteEvent { typ, data });
            }
            Ok(Some(Msg::Bye {})) => return,
            Ok(Some(other)) => {
                mark_error(app, format!("收到本阶段不支持的消息：{other:?}"));
                return;
            }
            Ok(None) => {}
            Err(e) => {
                mark_error(app, e);
                return;
            }
        }
        if last_ping.elapsed() >= HEARTBEAT {
            last_ping = Instant::now();
            if awaiting_pong {
                misses += 1;
                if misses >= MAX_MISSES {
                    mark_error(app, format!("心跳 {misses} 次无响应，判定断连"));
                    return;
                }
            }
            if let Err(e) = session.send(&mut stream, &Msg::Ping {}) {
                mark_error(app, e);
                return;
            }
            awaiting_pong = true;
        }
        std::thread::sleep(POLL);
    }
}

/// 手机侧当前的活连接（未连接时为 None）
fn client_conn(app: &AppHandle) -> Option<Arc<Conn>> {
    app.state::<LinkState>().conn.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 桌面侧这条连接的推送队列（没在服务任何设备时为 None —— 那时推送无处可去）
fn server_push(app: &AppHandle) -> Option<Arc<Push>> {
    app.state::<LinkState>().push.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 这一刻的暴露面：聚焦窗口的共享根 + 标签列表 + 所有活窗口的白名单。
/// 每次请求现算，不缓存 —— 白名单的判定必须跟着「桌面上还开着什么」走（§6.3）。
fn board_scope(app: &AppHandle) -> board::Scope {
    app.state::<LinkState>().board.lock().unwrap_or_else(|p| p.into_inner()).scope()
}

/// 桌面向对端推一帧「变了，去重取」。没连着的时候静默丢掉：
/// 手机端连上之后本来就会自己拉一次全量，不必为断线期间的变化留队列。
fn notify(app: &AppHandle, typ: &str) {
    if let Some(push) = server_push(app) {
        push.queue(typ);
    }
}

/// 让监听跟着「现在暴露的是哪一棵树」走：有设备在线、且聚焦窗口确实开着文件树，才建；
/// 断开、换根、换成一台没开树的窗口 → 立刻释放。
///
/// 换根走"先释放再重建"而不是原地改：重建的实测成本是 0.2~0.3 ms（递归 watch 建立），
/// 而原地维护一份会漂移的绑定要处理"旧根还剩几个事件在飞"这种划不来的边角。
/// 空档里丢的那点变化，手机端下一次列举本来就会收敛。
///
/// 建不起来时只记一条状态提示、不影响读写：实时更新是锦上添花，文件读写不是。
#[cfg(desktop)]
fn sync_fs_watch(app: &AppHandle) {
    let state = app.state::<LinkState>();
    let online = state.push.lock().unwrap_or_else(|p| p.into_inner()).is_some();
    let want = if online {
        state.board.lock().unwrap_or_else(|p| p.into_inner()).root()
    } else {
        None
    };
    let mut cur = state.fs_watch.lock().unwrap_or_else(|p| p.into_inner());
    eprintln!(
        "[heid-fsDBG] sync online={online} want={want:?} had={:?}",
        cur.as_ref().map(|h| h.root().to_path_buf())
    );
    if match (cur.as_ref(), &want) {
        (Some(h), Some(r)) => h.root() == r.as_path(),
        (None, None) => true,
        _ => false,
    } {
        return;
    }
    *cur = None; // 摘掉即停：线程退出时把 notify 句柄一起释放
    let Some(root) = want else { return };
    let sink_app = app.clone();
    match watch::spawn(root, move |dirs| {
        match server_push(&sink_app) {
            Some(push) => {
                eprintln!("[heid-fsDBG] 挂进推送队列 {dirs:?}");
                push.queue_fs(dirs);
            }
            None => eprintln!("[heid-fsDBG] 没有在线连接，{dirs:?} 无处可去"),
        }
    }) {
        Ok(handle) => {
            eprintln!("[heid-fsDBG] 监听已建立 on {:?}", handle.root());
            *cur = Some(handle);
        }
        Err(e) => {
            drop(cur);
            /* 只记一行到 stderr，**不碰状态快照里的 `connected`**。
               这里原来走 `mark_error`，于是一个只影响实时更新的附属失败（共享根被删了、
               没权限、路径太长）会把整条链路在界面上判成已断开 —— 而读写一条都没受影响。
               2026-09-24 全量验收里 A 段那两条"TOFU 之后没转已连接"就是这么被带倒的。 */
            eprintln!("[heid-fs] 文件变更监听没建起来，实时更新暂不可用（读写不受影响）：{e}");
        }
    }
}

/// 手机侧没有本地共享根可监听（它就是那棵树的远端读者），故这里是个空操作 ——
/// 留着同名函数是为了上面那几处调用点不用各自加分支。
#[cfg(not(desktop))]
fn sync_fs_watch(_app: &AppHandle) {}

fn prepare(stream: &mut TcpStream) {
    stream.set_read_timeout(Some(POLL)).ok();
    stream.set_nodelay(true).ok();
}

/* ------------------------------------------------------------------ 服务端 */

/// bind 监听套接字，带两次短重试。
///
/// 为什么要重试：`link_server_stop` 只是置停止位，accept 线程最快也要一个 POLL 周期才退出，
/// 那一刻监听套接字仍在，用户「关了马上再开」就会撞 10048。
///
/// 为什么重试完仍要**明确报错而不换端口**（设计稿 §12.1 第 3 条）：静默换端口会让手机上
/// 记着的地址失效，比直接报错难查得多。Windows 上还有一条本轮实测到的成因：上一台设备的
/// 连接留在 TIME_WAIT 时，std 的监听套接字按 SO_EXCLUSIVEADDRUSE 绑定会直接被拒 ——
/// 本机实测 45 秒还没散，短重试救不了，所以报错文案必须自己把下一步说清楚。
fn bind_listener(port: u16) -> Result<TcpListener, String> {
    let mut kind = io::ErrorKind::Other;
    for attempt in 0..3 {
        match TcpListener::bind(("0.0.0.0", port)) {
            Ok(l) => return Ok(l),
            Err(e) => {
                kind = e.kind();
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(120));
                }
            }
        }
    }
    Err(match kind {
        io::ErrorKind::AddrInUse | io::ErrorKind::AddrNotAvailable => format!(
            "端口 {port} 现在占着：可能是上一台设备的连接还没被系统放掉（Windows 会留一会儿），等一分钟再试；还不行就换一个端口。"
        ),
        other => format!("端口 {port} 绑定失败：{other}"),
    })
}

/// 起服务端。阻塞 I/O 一律离开主线程；这条 accept 线程会活到用户关掉开关，
/// 所以用独立 `std::thread` 而不是 blocking 池的槽位（池槽位该留给短任务）。
fn spawn_server(app: AppHandle, port: u16) -> Result<(), String> {
    let listener = bind_listener(port)?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("监听套接字设置失败：{e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let ticket = new_ticket();
    {
        let state = app.state::<LinkState>();
        if let Some(old) = replace_stop(&state, Some(Arc::clone(&stop))) {
            old.store(true, Ordering::SeqCst);
        }
        // 开一次共享就发一张全新的一次性配对票（2 分钟 / 用后即废），旧的当场作废
        *state.pairing.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(pair::PairingTicket::new(ticket.clone()));
        *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    publish(&app, move |s| {
        s.role = Role::Server;
        s.listening = true;
        s.port = port;
        s.connected = false;
        s.peer_device.clear();
        s.peer_addr.clear();
        s.last_error.clear();
        s.ticket = ticket;
    });

    let app_thread = app.clone();
    std::thread::Builder::new()
        .name("heid-link-accept".into())
        .spawn(move || {
            // 从 bind 成功起算，到点还没有任何连接尝试就提一次防火墙（同一次监听只提一次，
            // 真来了一条连接即清除；反复弹同一条提示只会让人以为程序在瞎说）
            let bound = Instant::now();
            let mut hinted = false;
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, addr)) => {
                        hinted = false;
                        publish(&app_thread, |s| s.firewall_hint = false);
                        let app = app_thread.clone();
                        let stop = Arc::clone(&stop);
                        if std::thread::Builder::new()
                            .name("heid-link-conn".into())
                            .spawn(move || serve_conn(stream, addr, app, stop))
                            .is_err()
                        {
                            mark_error(&app_thread, "无法为来到的连接起线程");
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        if !hinted && bound.elapsed() >= BIND_QUIET_HINT {
                            hinted = true;
                            publish(&app_thread, |s| s.firewall_hint = true);
                        }
                        std::thread::sleep(POLL)
                    }
                    Err(e) => {
                        publish(&app_thread, |s| s.last_error = format!("accept 失败：{e}"));
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        })
        .map_err(|e| format!("监听线程启动失败：{e}"))?;
    Ok(())
}

/// 一条已建立的连接（服务端侧）。同时只服务一台：第二台收 busy 后关闭，不排队、不静默等待。
/// 之后分两条路：**配对**要走 TOFU（持票设备出现→问用户→允许才登记 LS），**重连**凭已存的 LS 直接放行。
fn serve_conn(mut stream: TcpStream, addr: std::net::SocketAddr, app: AppHandle, stop: Arc<AtomicBool>) {
    if snapshot(&app).connected {
        let _ = write_plain(
            &mut stream,
            &Msg::Refused {
                code: "busy".into(),
                reason: "已有设备连接中，请先在桌面断开它".into(),
            },
        );
        return;
    }
    prepare(&mut stream);
    let mut framer = Framer::default();
    let state = app.state::<LinkState>();

    // salt 选择：配对看一次性票还在不在有效期/没用过、按 slot 取票或短码；重连按 keyId 查存的 LS。
    // 这里**不消费票** —— 此刻还没证明对面真握着票（要等它解得开 Auth、回了 Pong）。
    // 拒绝一律以带「配对/票」字样的原因串返回，交给 refuse_code 归成稳定码后由下面统一发出。
    let resolve = |mode: Mode, key_id: &str, slot: &str| -> Result<String, String> {
        match mode {
            Mode::Pair => {
                let g = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
                match g.as_ref() {
                    None => Err("未开启配对，请在桌面点「让手机连接」".into()),
                    Some(t) if !t.usable() => Err("配对码已过期或已用过，请重新打开".into()),
                    Some(t) => Ok(if slot == "code" { t.code() } else { t.value().to_string() }),
                }
            }
            Mode::Reconnect => {
                let g = state.store.lock().unwrap_or_else(|p| p.into_inner());
                g.find_ls(key_id)
                    .map(|ls| pair::ls_to_hex(&ls))
                    .ok_or_else(|| "这台设备未配对或已被移除，请重新扫码".into())
            }
        }
    };

    // 身份在 setup 里必定建好；这条连接线程独占它到握手结束（别的线程只在 init 时碰一次）
    let id_guard = state.identity.lock().unwrap_or_else(|p| p.into_inner());
    let id = match id_guard.as_ref() {
        Some(i) => i,
        None => {
            drop(id_guard);
            publish(&app, |s| s.last_error = "桌面身份未初始化".into());
            return;
        }
    };

    let hs = match server_handshake(&mut stream, &mut framer, &resolve, id) {
        Ok(hs) => hs,
        Err(e) => {
            // 握手没走通：把原因归成稳定码回一帧 Refused（票不匹配 / 版本 / 未配对），再记状态
            let _ = write_plain(
                &mut stream,
                &Msg::Refused { code: refuse_code(&e).into(), reason: e.clone() },
            );
            publish(&app, |s| s.last_error = e);
            return;
        }
    };
    // 握手已完成签名，身份锁就此放开——TOFU 可能等上一分钟，别占着它
    drop(id_guard);
    let mut session = hs.session;

    // 对端的第一帧（我们发了 Auth，它应回 Pong）——解得开、回了 Pong 才算真握着 salt。
    // 同样带截止时间循环收，别把路上晚到的 Pong 误判成断连。
    match recv_msg_deadline(&mut stream, &mut session, &mut framer, Instant::now() + HANDSHAKE_DEADLINE) {
        Ok(Msg::Pong {}) => {}
        Ok(other) => {
            publish(&app, |s| s.last_error = format!("握手后期望 pong，收到 {other:?}"));
            return;
        }
        Err(e) => {
            // 多半是 salt 不对（票不匹配 / 未登记的 keyId）导致它解不开 Auth 直接断了
            publish(&app, |s| s.last_error = e);
            return;
        }
    }

    let key_id = pair::key_id(&hs.ls);
    if hs.mode == Mode::Pair {
        // 持票且已证明 → 挂一条待确认、弹 TOFU，等用户决定（超时/关共享视为拒绝）
        let req = PairReq { device: hs.peer_device.clone(), key_id: key_id.clone() };
        {
            *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(());
            *state.decision.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
        let _ = app.emit(EVENT_PAIR, &req);
        if !wait_decision(&app, &state, PAIR_CONFIRM_TIMEOUT) {
            let _ = session.send(&mut stream, &Msg::Refused {
                code: "denied".into(),
                reason: "桌面端拒绝了这次配对".into(),
            });
            clear_pending(&state);
            publish(&app, |s| s.last_error = "配对请求被拒绝或超时".into());
            return;
        }
        clear_pending(&state);
        // 允许才登记：消费票（用后即废）+ 存 LS + 落盘
        {
            let mut g = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(t) = g.as_mut() {
                t.consume();
            }
        }
        {
            let mut g = state.store.lock().unwrap_or_else(|p| p.into_inner());
            g.upsert(pair::PairedDevice {
                key_id: key_id.clone(),
                ls: pair::ls_to_hex(&hs.ls),
                name: hs.peer_device.clone(),
                paired_at: now_millis(),
                peer_fp: String::new(),
            });
        }
        persist(&state); // 出了 store 锁再落盘：persist 内部会重新锁 store，不可重入
    }

    publish(&app, |s| {
        s.connected = true;
        s.peer_device = hs.peer_device.clone();
        s.peer_addr = addr.to_string();
        s.peer_key_id = key_id.clone();
        s.last_error.clear();
    });
    // 挂上推送队列：从这一刻起，窗口上报标签 / 换焦点 / 关窗才有人能通知到对端。
    // 摘掉时留在队列里的帧一起作废 —— 下一次连接建立后对端本来就要重取全量（§6.1）。
    *state.push.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::<Push>::default());
    // 从这一刻起才有"谁在看这棵树"这回事：监听随连接而建，随断开而释放
    sync_fs_watch(&app);
    run_pump(stream, session, &app, &stop, Role::Server);
    *state.push.lock().unwrap_or_else(|p| p.into_inner()) = None;
    sync_fs_watch(&app);
    publish(&app, |s| {
        s.connected = false;
        s.peer_device.clear();
        s.peer_addr.clear();
        s.peer_key_id.clear();
    });
}

/* ------------------------------------------------------------------ 客户端 */

/// 手机这一趟连接要做什么。配对带一次性票或 6 位短码 + 期望指纹；重连带已存的 LS 与钉住的指纹。
pub enum ClientIntent {
    Pair { salt: String, slot: String, fp: String, name: String },
    Reconnect { key_id: String, ls_hex: String, fp: String, name: String },
}

fn connect_and_pump(
    host: String,
    port: u16,
    intent: ClientIntent,
    device: String,
    app: AppHandle,
    stop: Arc<AtomicBool>,
) {
    let mut stream = match dial(&host, port) {
        Ok(s) => s,
        Err(e) => {
            mark_error(&app, e);
            return;
        }
    };
    prepare(&mut stream);
    let mut framer = Framer::default();
    let (salt, mode, key_id, slot, fp, name) = match &intent {
        ClientIntent::Pair { salt, slot, fp, name } => {
            (salt.clone(), Mode::Pair, String::new(), slot.clone(), fp.clone(), name.clone())
        }
        ClientIntent::Reconnect { key_id, ls_hex, fp, name } => {
            (ls_hex.clone(), Mode::Reconnect, key_id.clone(), String::new(), fp.clone(), name.clone())
        }
    };
    let (session, ls, _id_pub) = match client_handshake(
        &mut stream,
        &mut framer,
        &salt,
        mode,
        &key_id,
        &slot,
        "heid-android",
        &device,
        &fp,
    ) {
        Ok(v) => v,
        Err(e) => {
            mark_error(&app, e);
            return;
        }
    };
    // 配对成功才把这把 LS + 钉住的桌面指纹落盘，之后重启就走重连、不再要票
    if let ClientIntent::Pair { .. } = &intent {
        let state = app.state::<LinkState>();
        {
            let mut g = state.store.lock().unwrap_or_else(|p| p.into_inner());
            g.upsert(pair::PairedDevice {
                key_id: pair::key_id(&ls),
                ls: pair::ls_to_hex(&ls),
                name,
                paired_at: now_millis(),
                peer_fp: fp,
            });
        }
        persist(&state); // 出锁再落盘（persist 会重新锁 store）
    }
    // 对端设备 id：配对时用刚算出、刚存盘的那把 LS 的 keyId；重连时用当初存下的那个 keyId。
    // 两者必须同源，否则重连一次之后 `hide-remote://<deviceId>/…` 就换了一个键，
    // 手机上已经打开的标签会指向一台「不存在」的设备。
    // （每次重连都重新生成临时 X25519，所以 `ls` 本身每趟都在变，只有存下来的 keyId 稳定。）
    let peer_key_id = match &intent {
        ClientIntent::Pair { .. } => pair::key_id(&ls),
        ClientIntent::Reconnect { key_id, .. } => key_id.clone(),
    };
    // 这条连接的远程命令通路：挂上 state，前端 `link_request` 才找得到它
    let conn = Conn::new();
    {
        let state = app.state::<LinkState>();
        *state.conn.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::clone(&conn));
    }
    publish(&app, |s| {
        s.connected = true;
        s.peer_addr = format!("{host}:{port}");
        s.peer_key_id = peer_key_id;
        s.last_error.clear();
    });
    run_pump(stream, session, &app, &stop, Role::Client);
    conn.shutdown("连接已结束");
    {
        let state = app.state::<LinkState>();
        let mut g = state.conn.lock().unwrap_or_else(|p| p.into_inner());
        // 只摘自己这一条：可能上一趟连接的尾巴还没走完，新趟已经挂上来了
        if g.as_ref().map(|c| Arc::ptr_eq(c, &conn)).unwrap_or(false) {
            *g = None;
        }
    }
    publish(&app, |s| {
        s.connected = false;
        s.peer_addr.clear();
        s.peer_key_id.clear();
    });
}

fn dial(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("地址解析失败：{e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("找不到 {host} 的地址"));
    }
    let mut last = String::new();
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = format!("{addr}：{e}"),
        }
    }
    Err(format!("连不上 {host}:{port}（{last}）"))
}

/* ------------------------------------------------------------------ 命令 */

#[tauri::command]
pub fn link_status(state: State<LinkState>) -> LinkStatus {
    state.snapshot()
}

/// 取当前配对票（桌面面板要显示它；阶段 1 的二维码也带它）。
/// 没在共享时也会生成一张，好让 UI 不至于空白。
#[tauri::command]
pub fn link_ticket(state: State<LinkState>) -> String {
    {
        let mut g = state.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.ticket.is_empty() {
            g.ticket = new_ticket();
        }
    }
    state.snapshot().ticket
}

/// 桌面：打开总开关 = bind 端口
#[tauri::command]
pub fn link_server_start(app: AppHandle, port: u16) -> Result<LinkStatus, String> {
    if !(1024..=65535).contains(&port) {
        return Err("端口要在 1024–65535 之间".to_string());
    }
    /* 幂等：同一个端口已经在听着，就直接回当前状态。
       每个文档窗口挂载时都会跑一次"上次开着就自动开"（App.tsx），没有这一道的话，
       用户新开一个窗口就会把手机上正连着的那条链路踢掉。 */
    let current = snapshot(&app);
    if current.listening && current.port == port {
        return Ok(current);
    }
    spawn_server(app.clone(), port)?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub fn link_server_stop(app: AppHandle) -> LinkStatus {
    let state = app.state::<LinkState>();
    if let Some(old) = replace_stop(&state, None) {
        old.store(true, Ordering::SeqCst);
    }
    publish(&app, |s| {
        s.role = Role::Off;
        s.listening = false;
        s.connected = false;
        s.peer_device.clear();
        s.peer_addr.clear();
        s.firewall_hint = false;
    });
    state.snapshot()
}

/// 手机侧发起一趟连接的公共流程：置客户端角色、换掉上一趟的停止开关、起连接线程。
/// 配对与重连都走这里，差别只在 `intent`。
fn start_client(
    app: &AppHandle,
    host: String,
    port: u16,
    intent: ClientIntent,
    device: String,
) -> Result<LinkStatus, String> {
    if host.trim().is_empty() {
        return Err("地址不能为空".to_string());
    }
    if !(1024..=65535).contains(&port) {
        return Err("端口要在 1024–65535 之间".to_string());
    }
    let host = host.trim().to_string();
    let state = app.state::<LinkState>();
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = replace_stop(&state, Some(Arc::clone(&stop))) {
        old.store(true, Ordering::SeqCst);
    }
    publish(app, move |s| {
        s.role = Role::Client;
        s.listening = false;
        s.port = port;
        s.connected = false;
        s.peer_device.clear();
        s.last_error.clear();
        /* 不写 s.ticket：那张票是"桌面共享给手机"的凭证，归服务端。
           客户端填的票只活在连接线程里，别把它塞回会广播给桌面的状态快照。 */
    });
    let app_thread = app.clone();
    std::thread::Builder::new()
        .name("heid-link-client".into())
        .spawn(move || connect_and_pump(host, port, intent, device, app_thread, stop))
        .map_err(|e| format!("连接线程启动失败：{e}"))?;
    Ok(snapshot(app))
}

/// 手机：手填地址 + 32 位配对码直连（设计稿 §7.4 的调试通道，也是扫码不可用时的兜底）。
/// 走的是配对路径，只是没有指纹可校验（fp 传空）。
#[tauri::command]
pub fn link_client_connect(
    app: AppHandle,
    host: String,
    port: u16,
    ticket: String,
    device: String,
) -> Result<LinkStatus, String> {
    let ticket = ticket.trim().to_lowercase();
    if !is_valid_ticket(&ticket) {
        return Err("配对码应是 32 位十六进制，请整段复制".to_string());
    }
    start_client(
        &app,
        host,
        port,
        ClientIntent::Pair { salt: ticket, slot: "ticket".into(), fp: String::new(), name: String::new() },
        device,
    )
}

/// 手机：吃一段扫来/粘来的 `hide-link://pair?...` 载荷走配对（带指纹，防抢答）。
#[tauri::command]
pub fn link_client_pair(
    app: AppHandle,
    uri: String,
    device: String,
) -> Result<LinkStatus, String> {
    let p = pair::PairingPayload::parse(&uri)?;
    let intent = if is_valid_ticket(&p.ticket) {
        ClientIntent::Pair { salt: p.ticket, slot: "ticket".into(), fp: p.fp, name: p.name }
    } else {
        return Err("这个配对码里没有有效的配对票".to_string());
    };
    start_client(&app, p.host, p.port, intent, device)
}

/// 手机：相机不可用时手输 6 位短码配对（设计稿 §7.3 的兜底，零依赖）。
#[tauri::command]
pub fn link_client_pair_code(
    app: AppHandle,
    host: String,
    port: u16,
    code: String,
    device: String,
) -> Result<LinkStatus, String> {
    let code = code.trim().to_string();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("配对短码是 6 位数字".to_string());
    }
    start_client(
        &app,
        host,
        port,
        ClientIntent::Pair { salt: code, slot: "code".into(), fp: String::new(), name: String::new() },
        device,
    )
}

/// 手机：用本地存过的某台桌面重连（免扫）。keyId 由前端从偏好里带上，LS 与指纹从存储取。
#[tauri::command]
pub fn link_client_reconnect(
    app: AppHandle,
    host: String,
    port: u16,
    key_id: String,
    device: String,
) -> Result<LinkStatus, String> {
    let state = app.state::<LinkState>();
    let (ls_hex, fp, name) = {
        let g = state.store.lock().unwrap_or_else(|p| p.into_inner());
        let dev = g
            .devices
            .iter()
            .find(|d| d.key_id == key_id)
            .ok_or("本机没有这台设备的配对记录，请重新扫码")?;
        (dev.ls.clone(), dev.peer_fp.clone(), dev.name.clone())
    };
    start_client(
        &app,
        host,
        port,
        ClientIntent::Reconnect { key_id, ls_hex, fp, name },
        device,
    )
}

/* ------------------------------------------------------------ 桌面配对命令 */

/// 桌面：生成/刷新一次配对的二维码信息（含一次性票 + 6 位短码 + 本机地址）。
/// 每次调用都换新票并重置有效期——「点让手机连接」就是开一扇新的 2 分钟配对窗。
#[tauri::command]
pub fn link_pair_qr(app: AppHandle) -> Result<QrInfo, String> {
    let state = app.state::<LinkState>();
    let s = state.snapshot();
    if !s.listening {
        return Err("请先打开「共享这台电脑」".to_string());
    }
    let ticket = new_ticket();
    *state.pairing.lock().unwrap_or_else(|p| p.into_inner()) =
        Some(pair::PairingTicket::new(ticket.clone()));
    *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = None;
    publish(&app, |st| {
        st.ticket = ticket.clone();
        st.last_error.clear();
    });
    let host = local_ipv4();
    let name = desktop_name();
    let fp = state.identity_fp();
    let payload = pair::PairingPayload { host: host.clone(), port: s.port, ticket, name: name.clone(), fp: fp.clone() };
    Ok(QrInfo {
        code: pair::short_code(&payload.ticket),
        uri: payload.to_uri(),
        host,
        port: s.port,
        fp,
        name,
    })
}

/// 前端对当前配对请求表态。只有确实挂着一条待确认时才生效，避免误点把上一次的决定带进下一次。
fn set_decision(app: &AppHandle, ok: bool) {
    let state = app.state::<LinkState>();
    let has_pending = state.pending.lock().unwrap_or_else(|p| p.into_inner()).is_some();
    if has_pending {
        *state.decision.lock().unwrap_or_else(|p| p.into_inner()) = Some(ok);
    }
}

#[tauri::command]
pub fn link_pair_approve(app: AppHandle) {
    set_decision(&app, true);
}

#[tauri::command]
pub fn link_pair_deny(app: AppHandle) {
    set_decision(&app, false);
}

/// 已配对设备列表（桌面多台 / 手机一台，同一结构）。
#[tauri::command]
pub fn link_pairings_list(app: AppHandle) -> Vec<PairInfo> {
    let state = app.state::<LinkState>();
    let g = state.store.lock().unwrap_or_else(|p| p.into_inner());
    let mut v: Vec<PairInfo> = g
        .devices
        .iter()
        .map(|d| PairInfo { key_id: d.key_id.clone(), name: d.name.clone(), paired_at: d.paired_at })
        .collect();
    v.sort_by(|a, b| b.paired_at.cmp(&a.paired_at));
    v
}

/// 解除一台设备的配对（撤销后它要重新扫码）。
#[tauri::command]
pub fn link_pairing_revoke(app: AppHandle, key_id: String) -> bool {
    let state = app.state::<LinkState>();
    let removed = {
        let mut g = state.store.lock().unwrap_or_else(|p| p.into_inner());
        g.revoke(&key_id)
    };
    if removed {
        persist(&state);
    }
    removed
}

#[tauri::command]
pub fn link_client_disconnect(app: AppHandle) -> LinkStatus {
    let state = app.state::<LinkState>();
    if let Some(old) = replace_stop(&state, None) {
        old.store(true, Ordering::SeqCst);
    }
    publish(&app, |s| {
        s.role = Role::Off;
        s.connected = false;
        s.peer_addr.clear();
    });
    state.snapshot()
}

/* ------------------------------------------------- 阶段 2：共享根与远程命令 */

/// 桌面设置 / 清除**本窗口**的共享范围。前端把文件树当前的根（`heid-tree-root`）原样交进来，
/// 桌面侧 canonicalize 之后才存 —— **手机上永远只出现相对路径，绝对路径不出桌面**。
///
/// `label` 由前端报自己的窗口标签（`currentWindowLabel()`）：多窗口下每台各有一份文件树，
/// 到底哪一份暴露给手机由聚焦窗口决定（§6.1）。不走 `WebviewWindow` 取标签，是因为这条命令
/// 两端共用一个实现，而手机侧根本没有多窗口 —— 少一处平台差异，就少一次「桌面好、手机炸」。
#[tauri::command]
pub fn link_set_root(app: AppHandle, label: String, path: Option<String>) -> Result<LinkStatus, String> {
    if !window_alive(&app, &label) {
        return Ok(snapshot(&app));
    }
    let root = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => Some(roots::canonical_root(Path::new(p))?),
    };
    board_edit(&app, move |b| b.set_root(&label, root));
    Ok(snapshot(&app))
}

/* ------------------------------------------------- 阶段 3：标签上报与推送 */

/// 这个窗口标签现在真的存在吗。
///
/// 关窗时前端可能赶在 `Destroyed` **之后再报一次**（关窗流程会先收干净标签与会话），
/// 收下它等于把已经不存在的窗口重新登记成"最近动过的窗口" ——
/// 手机上随后看到的就是凭空多出来的一份空列表。窗口存在与否只有 Tauri 自己知道，
/// 所以这里问它，而不是在看板里记"死标签"：文档窗口的 label 是**复用**的
/// （`windows.rs` 取最小空闲的 win-N），记死标签会把重开的同一个窗口永久拒收。
fn window_alive(app: &AppHandle, label: &str) -> bool {
    #[cfg(desktop)]
    { app.get_webview_window(label).is_some() }
    #[cfg(not(desktop))]
    { let _ = (app, label); true }
}

/// 手机侧事件类型：桌面的标签列表变了（§6.1）。载荷故意是空的 ——
/// 语义是「变了，去重取」，内容跟着手机端自己那次 `tabs` 请求走，
/// 这样推送永远不会带着半新半旧的列表覆盖掉请求的结果。
pub const EVENT_TABS: &str = "tabs";

/// 桌面的文件变了（阶段 4）。载荷是 `{"dirs":["src","docs"]}` —— **只列目录不列文件**，
/// 理由与实测代价都记在 `link/watch.rs` 的模块头与 ROADMAP 阶段 4 量测一节。
/// 载荷为空 = 这一帧装不下了（超 `MAX_PUSH_DIRS`），手机端按「你看到的每一层都重取」处理。
/// 只有桌面侧会发出这一类（手机是那棵树的远端读者），故非桌面构建下它没被引用。
#[cfg_attr(not(desktop), allow(dead_code))]
pub const EVENT_FS: &str = "fs";
/// 共享根换了（阶段 4 补阶段 3 留的缺口）。语义是 `tabs` 的超集：
/// 手机端要丢掉整棵树的缓存、重列展开着的层、并重取一次标签列表 —— 换根之后
/// 那些 `rel` 与 `@w/…` 引用十有八九指向别处，只刷列表是不够的。
/// 一次只推这一个或 [`EVENT_TABS`] 其中一个，不叠加。
pub const EVENT_ROOT: &str = "rootChanged";

/// 某个窗口把它当前的标签列表报给链路层（设计稿 §6.1）。桌面侧调用，手机端用不到。
///
/// 这条命令是白名单的唯一来源：**桌面上开着哪些文件**决定局域网能读到哪些根外文件，
/// 关掉标签即收回（下一次上报里没有它）。所以它必须与标签变化严格同步 ——
/// 前端在标签、脏标记、聚焦、共享根的每一次变更后都会重报一次（节流在 `link.ts`）。
#[tauri::command]
pub fn link_report_tabs(app: AppHandle, label: String, tabs: Vec<board::TabReport>) -> LinkStatus {
    if !window_alive(&app, &label) {
        return snapshot(&app);
    }
    board_edit(&app, move |b| b.set_tabs(&label, tabs));
    snapshot(&app)
}

/// 在看板的同一把锁里做一次变更，并带回两件判定：这次变更要不要通知对端、
/// 以及**手机上看到的那棵根换了没有**。
///
/// 两件判定必须同一次算：换根的推送与"不换了才推 tabs"是一对互斥的分支，
/// 分开问两次看板就可能一次一个样。根换了只推 [`EVENT_ROOT`]（它的语义包含重取列表），
/// 没换才推 [`EVENT_TABS`]。
fn board_edit(app: &AppHandle, change: impl FnOnce(&mut board::Board) -> bool) {
    let state = app.state::<LinkState>();
    let (changed, moved) = {
        let mut g = state.board.lock().unwrap_or_else(|p| p.into_inner());
        let before = g.root();
        let changed = change(&mut g);
        (changed, before != g.root())
    };
    if moved {
        publish_exposure(app);
        notify(app, EVENT_ROOT);
    } else if changed {
        publish_exposure(app);
        notify(app, EVENT_TABS);
    }
    sync_fs_watch(app);
}

/// 把「桌面现在暴露了什么」刷进状态快照。设置面板那两行（共享范围 + 根外文件数）
/// 就是从这里来的 —— 开启态必须让用户看得见自己交出去的是什么，这是 §5.2 的硬要求。
fn publish_exposure(app: &AppHandle) {
    let scope = board_scope(app);
    let display = scope.root.as_deref().map(display_path).unwrap_or_default();
    let opens = scope.outside_open_count();
    publish(app, |s| {
        s.root_display = display;
        s.open_shared = opens;
    });
}

/// 全局窗口事件里要处理的两件事（其余返回 `false` = 无需推送）。
/// 由 `lib.rs` 的 `on_window_event` 调用；桌面才有意义（手机只有一个窗口）。
pub fn on_window_focus(app: &AppHandle, label: &str) {
    // 换窗口可能连着换根，所以判据交给 board_edit：换根推 rootChanged，只换列表推 tabs
    let label = label.to_string();
    board_edit(app, move |b| b.focus(&label));
}

/// 窗口关掉：它报的根与标签当场作废。白名单是活窗口的并集，所以别的窗口里开着的文件不受牵连。
pub fn on_window_closed(app: &AppHandle, label: &str) {
    let label = label.to_string();
    board_edit(app, move |b| b.close_window(&label));
    sync_fs_watch(app);
}

/// 手机侧发一条远程文件命令，返回结果的 JSON 文本（形状由 [`fsrv`] 里各命令的定义决定）。
///
/// async 命令 + `spawn_blocking`：等应答最长 30 秒，而同步命令跑在主线程上，
/// 那样会把整个窗口冻成「未响应」（同 `http.rs:86` 的理由）。
#[tauri::command]
pub async fn link_request(app: AppHandle, method: String, params: String) -> Result<String, String> {
    let conn = client_conn(&app).ok_or("手机上还没有连着桌面，请先完成配对")?;
    tauri::async_runtime::spawn_blocking(move || conn.call(&method, params))
        .await
        .map_err(|e| format!("远程命令任务失败：{e}"))?
}

/// 给人看的根路径：去掉 Windows `canonicalize` 加的 `\\?\` 前缀。
/// 那只是 Win32 命名空间的标记，出现在设置面板里只会让人以为路径坏了。
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| s.into_owned()),
    }
}

/// 启动时载入/新建本地状态：落盘路径 + 桌面长期身份 + 已配对设备。两端都用（手机也存它自己那一份）。
/// 由 setup 调用；`dir` = 各平台 app 数据目录。
pub fn init_store(app: &AppHandle, dir: PathBuf) {
    let state = app.state::<LinkState>();
    let path = dir.join("link.json");
    let mut store = pair::Store::load(&path);
    let id = match pair::identity_from_store(&store) {
        Ok(id) => id,
        Err(_) => {
            let (new_id, pkcs8) = identity::Identity::generate();
            store.identity_pkcs8 = pair::b64_encode(&pkcs8);
            let _ = store.save(&path);
            new_id
        }
    };
    *state.store.lock().unwrap_or_else(|p| p.into_inner()) = store;
    *state.identity.lock().unwrap_or_else(|p| p.into_inner()) = Some(id);
    *state.store_path.lock().unwrap_or_else(|p| p.into_inner()) = Some(path);
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod roots_tests;
#[cfg(test)]
mod board_tests;
#[cfg(test)]
mod fsrv_tests;
#[cfg(all(test, desktop))]
mod watch_probe;
