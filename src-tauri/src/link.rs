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

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf::{Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

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
/// 前端订阅的状态事件名
pub const EVENT: &str = "heid-link";

/* ------------------------------------------------------------------ 消息 */

/// 帧内消息。阶段 0 只有握手与心跳；阶段 2 的 list/stat/read/write 在此扩展，
/// 版本不匹配会在握手期就被拒，所以不需要为旧版本留兼容分支。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    /// 握手第一帧（明文）：协议版本 + 本方 X25519 公钥 + 可读信息
    Hello {
        ver: u32,
        #[serde(rename = "pub")]
        pub_key: String,
        agent: String,
        device: String,
    },
    /// 握手第二帧（明文）：服务端同意，带回自己的公钥
    Welcome {
        ver: u32,
        #[serde(rename = "pub")]
        pub_key: String,
    },
    Ping {},
    Pong {},
    /// 拒绝并关闭。`code` 是稳定标识（前端按它出文案），`reason` 给人看
    Refused { code: String, reason: String },
    /// 正常收尾
    Bye {},
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

/// 完成握手并返回加密会话。返回的第二项是对端设备名（客户端侧为空，
/// 因为设备名是它自己发出去的）。
pub fn handshake<S: Read + Write>(
    s: &mut S,
    framer: &mut Framer,
    ticket: &str,
    we_initiate: bool,
    agent: &str,
    device: &str,
) -> Result<(Session, String), String> {
    let rng = SystemRandom::new();
    let priv_key =
        EphemeralPrivateKey::generate(&X25519, &rng).map_err(|_| "无法生成临时密钥".to_string())?;
    let my_pub = encode_pub(
        priv_key
            .compute_public_key()
            .map_err(|_| "无法取到本方公钥".to_string())?
            .as_ref(),
    );

    // 私钥只能消费一次（`agree_ephemeral` 收走它），所以顺序是固定的：
    // 先取本方公钥 → 交换明文帧 → 最后才协商。协商必须在读完对端公钥之后。
    let (peer_pub, peer_device) = if we_initiate {
        write_plain(
            s,
            &Msg::Hello {
                ver: PROTOCOL_VERSION,
                pub_key: my_pub,
                agent: agent.to_string(),
                device: device.to_string(),
            },
        )?;
        match read_plain(s, framer)? {
            Msg::Welcome { ver, pub_key } => {
                check_version(ver)?;
                (pub_key, String::new())
            }
            Msg::Refused { code, reason } => return Err(format!("对端拒绝（{code}）：{reason}")),
            other => return Err(format!("握手期望 welcome，收到 {other:?}")),
        }
    } else {
        match read_plain(s, framer)? {
            Msg::Hello {
                ver,
                pub_key,
                device,
                ..
            } => {
                check_version(ver)?;
                write_plain(
                    s,
                    &Msg::Welcome {
                        ver: PROTOCOL_VERSION,
                        pub_key: my_pub,
                    },
                )?;
                (pub_key, device)
            }
            other => return Err(format!("握手期望 hello，收到 {other:?}")),
        }
    };

    let peer = UnparsedPublicKey::new(&X25519, decode_pub(&peer_pub)?);
    let (c2s, s2c) = agree_ephemeral(priv_key, &peer, |shared| derive_keys(shared, ticket))
        .map_err(|_| "密钥协商失败".to_string())??;
    let session = Session::from_keys(c2s, s2c, we_initiate)?;
    Ok((session, peer_device))
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

/// 握手失败时回给对端的稳定错误码
fn refuse_code(err: &str) -> &'static str {
    if err.contains("协议版本") {
        "version"
    } else if err.contains("握手超时") {
        "timeout"
    } else if err.contains("hello") || err.contains("welcome") || err.contains("解析") {
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
        }
    }
}

#[derive(Default)]
pub struct LinkState {
    inner: Mutex<LinkStatus>,
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl LinkState {
    fn snapshot(&self) -> LinkStatus {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
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

/* ------------------------------------------------------------------ 连接维持 */

/// 握手后的维持循环：心跳、断连判定、停止开关观察。
/// 两端共用，只有 `we_initiate` 不同（影响退出时是否主动发 bye）。
fn run_pump(
    mut stream: TcpStream,
    mut session: Session,
    app: &AppHandle,
    stop: &AtomicBool,
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
            Ok(Some(Msg::Bye {})) => return,
            Ok(Some(other)) => {
                // 阶段 0 不该收到别的消息；真收到了说明版本判断有漏
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

fn prepare(stream: &mut TcpStream) {
    stream.set_read_timeout(Some(POLL)).ok();
    stream.set_nodelay(true).ok();
}

/* ------------------------------------------------------------------ 服务端 */

/// 起服务端。阻塞 I/O 一律离开主线程；这条 accept 线程会活到用户关掉开关，
/// 所以用独立 `std::thread` 而不是 blocking 池的槽位（池槽位该留给短任务）。
fn spawn_server(app: AppHandle, port: u16) -> Result<(), String> {
    let listener =
        TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("端口 {port} 绑定失败：{e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("监听套接字设置失败：{e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<LinkState>();
        if let Some(old) = replace_stop(&state, Some(Arc::clone(&stop))) {
            old.store(true, Ordering::SeqCst);
        }
    }
    publish(&app, move |s| {
        s.role = Role::Server;
        s.listening = true;
        s.port = port;
        s.connected = false;
        s.peer_device.clear();
        s.peer_addr.clear();
        s.last_error.clear();
        /* 每次开始共享都换一张新票：关掉了再开，旧票不该还连得上。
           阶段 1 的「记住设备免重复扫码」走长期凭证，不依赖这张票存活。 */
        s.ticket = new_ticket();
    });

    let app_thread = app.clone();
    std::thread::Builder::new()
        .name("heid-link-accept".into())
        .spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, addr)) => {
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
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(POLL),
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

/// 一条已建立的连接（服务端侧）。同时只服务一台：第二台收 busy 后关闭，
/// 不排队、不静默等待（设计稿 §12.1 第 1 条）。
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
    let ticket = snapshot(&app).ticket;
    let mut framer = Framer::default();
    let (mut session, peer_device) = match handshake(
        &mut stream,
        &mut framer,
        &ticket,
        false,
        "heid-desktop",
        "",
    ) {
        Ok(v) => v,
        Err(e) => {
            // 票不匹配最常见，且此刻对端还在等 —— 给一个能看懂的码，
            // 别让手机对着超时干转
            let _ = write_plain(
                &mut stream,
                &Msg::Refused {
                    code: refuse_code(&e).into(),
                    reason: e.clone(),
                },
            );
            publish(&app, |s| s.last_error = e);
            return;
        }
    };
    // 握手两帧是明文，不计入会话计数器；第一帧密文用来验证票是否一致
    if let Err(e) = session.send(&mut stream, &Msg::Ping {}) {
        publish(&app, |s| s.last_error = e);
        return;
    }
    publish(&app, |s| {
        s.connected = true;
        s.peer_device = peer_device;
        s.peer_addr = addr.to_string();
        s.last_error.clear();
    });
    run_pump(stream, session, &app, &stop);
    publish(&app, |s| {
        s.connected = false;
        s.peer_device.clear();
        s.peer_addr.clear();
    });
}

/* ------------------------------------------------------------------ 客户端 */

fn connect_and_pump(
    host: String,
    port: u16,
    ticket: String,
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
    let (session, _) = match handshake(
        &mut stream,
        &mut framer,
        &ticket,
        true,
        "heid-android",
        &device,
    ) {
        Ok(v) => v,
        Err(e) => {
            mark_error(&app, e);
            return;
        }
    };
    publish(&app, |s| {
        s.connected = true;
        s.peer_addr = format!("{host}:{port}");
        s.last_error.clear();
    });
    run_pump(stream, session, &app, &stop);
    publish(&app, |s| {
        s.connected = false;
        s.peer_addr.clear();
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
    });
    state.snapshot()
}

/// 手机：连桌面。阶段 0 只有手填地址 + 手填配对票这一条通道
/// （设计稿 §7.4 的调试通道），扫码在阶段 1。
#[tauri::command]
pub fn link_client_connect(
    app: AppHandle,
    host: String,
    port: u16,
    ticket: String,
    device: String,
) -> Result<LinkStatus, String> {
    let host = host.trim().to_string();
    let ticket = ticket.trim().to_lowercase();
    if host.is_empty() {
        return Err("地址不能为空".to_string());
    }
    if !is_valid_ticket(&ticket) {
        return Err("配对票应是 32 位十六进制，请整段复制".to_string());
    }
    let state = app.state::<LinkState>();
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = replace_stop(&state, Some(Arc::clone(&stop))) {
        old.store(true, Ordering::SeqCst);
    }
    publish(&app, move |s| {
        s.role = Role::Client;
        s.listening = false;
        s.port = port;
        s.connected = false;
        s.last_error.clear();
        /* 注意：这里**不写** s.ticket。那张票是"桌面共享给手机"的凭证，
           归服务端所有；客户端填的票只活在前端偏好里。之前两边共用一个字段，
           手机连过一次就把桌面的配对码覆盖成错的，桌面上还照样显示。 */
    });
    let app_thread = app.clone();
    std::thread::Builder::new()
        .name("heid-link-client".into())
        .spawn(move || connect_and_pump(host, port, ticket, device, app_thread, stop))
        .map_err(|e| format!("连接线程启动失败：{e}"))?;
    Ok(snapshot(&app))
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

#[cfg(test)]
mod tests;
