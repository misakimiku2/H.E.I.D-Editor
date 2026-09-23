//! 阶段 0 基座的测试。重点是三条"错了不会立刻看得出来"的性质：
//! 帧边界在超时下不丢字节、密文里读不出任何明文、配对票不匹配必须失败。

use super::*;
use std::io::{self, Cursor};
use std::net::{TcpListener, TcpStream};

/// 喂完给定字节后就返回 `WouldBlock` 的读端 —— 模拟"设了读超时的 socket"。
/// 不能用 `Cursor`：它读完返回 `Ok(0)`，那是 EOF（对端关闭），语义完全不同，
/// 用它写出来的"半帧"用例会把 EOF 当成超时来通过，测不到真正要保的性质。
struct IdleReader {
    data: Vec<u8>,
    pos: usize,
}

impl Read for IdleReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.data.len() {
            return Err(io::Error::from(io::ErrorKind::WouldBlock));
        }
        let n = (self.data.len() - self.pos).min(buf.len());
        buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

fn ticket() -> String {
    "00112233445566778899aabbccddeeff".to_string()
}

/* ------------------------------------------------------------------ 帧 */

#[test]
fn 帧往返保留字节边界() {
    let mut out = Vec::new();
    write_frame(&mut out, b"abc").unwrap();
    write_frame(&mut out, b"").unwrap();
    write_frame(&mut out, b"\x00\x01\x02").unwrap();

    let mut cur = Cursor::new(out);
    let mut f = Framer::default();
    assert_eq!(f.next_frame(&mut cur, 16).unwrap().unwrap(), b"abc");
    assert_eq!(f.next_frame(&mut cur, 16).unwrap().unwrap(), b"");
    assert_eq!(f.next_frame(&mut cur, 16).unwrap().unwrap(), vec![0u8, 1, 2]);
    assert!(matches!(
        f.next_frame(&mut cur, 16),
        Err(FrameError::Eof)
    ));
}

/// 这条是 `Framer` 存在的全部理由：半帧必须留在缓冲区里，
/// 而不是被下一次读取当成新帧的开头。
#[test]
fn 半帧不丢字节() {
    let mut wire = Vec::new();
    write_frame(&mut wire, b"hello-frame").unwrap();

    // 只喂前 6 字节（长度前缀 + 2 字节载荷）然后就"超时"
    let mut head = IdleReader {
        data: wire[..6].to_vec(),
        pos: 0,
    };
    let mut f = Framer::default();
    assert!(f.next_frame(&mut head, 64).unwrap().is_none());
    assert_eq!(f.buffered(), 6);

    // 剩下的补上（同一个 Framer），仍然要能凑出完整帧
    let mut rest = IdleReader {
        data: wire[6..].to_vec(),
        pos: 0,
    };
    assert_eq!(
        f.next_frame(&mut rest, 64).unwrap().unwrap(),
        b"hello-frame"
    );
    assert_eq!(f.buffered(), 0);
}

#[test]
fn 超限帧直接拒绝且不消费载荷() {
    let mut wire = Vec::new();
    write_frame(&mut wire, &[7u8; 100]).unwrap();
    let mut cur = Cursor::new(wire);
    let mut f = Framer::default();
    match f.next_frame(&mut cur, 32) {
        Err(FrameError::TooLarge { len }) => assert_eq!(len, 100),
        other => panic!("应报超限，实际 {other:?}"),
    }
}

#[test]
fn 长度前缀按大端解析() {
    let mut f = Framer::default();
    f.buf.extend_from_slice(&[0u8, 0, 0, 2, b'h', b'i']);
    assert_eq!(f.take_frame(16).unwrap().unwrap(), b"hi");
}

/* ------------------------------------------------------------------ 会话 */

fn pair(we_initiate_ticket: &str) -> (Session, Session) {
    let (c2s, s2c) = derive_keys(&[0x5au8; 32], we_initiate_ticket).unwrap();
    (
        Session::from_keys(c2s, s2c, true).unwrap(),
        Session::from_keys(c2s, s2c, false).unwrap(),
    )
}

#[test]
fn 会话双向往返并保序() {
    let (mut client, mut server) = pair(&ticket());
    let mut a = Vec::new();
    let mut b = Vec::new();
    client.send(&mut a, &Msg::Ping {}).unwrap();
    server.send(&mut b, &Msg::Pong {}).unwrap();
    assert_eq!(server.open_frame(&a[4..]).unwrap(), Msg::Ping {});
    assert_eq!(client.open_frame(&b[4..]).unwrap(), Msg::Pong {});
    assert_eq!(client.tx_count(), 1);
}

#[test]
fn 篡改一字节就解不开() {
    let (mut client, mut server) = pair(&ticket());
    let mut a = Vec::new();
    client.send(&mut a, &Msg::Ping {}).unwrap();
    let mut frame = a[4..].to_vec();
    frame[0] ^= 0x01;
    assert!(server.open_frame(&frame).is_err());
}

#[test]
fn 用错配对票的端解不开第一帧() {
    let (c2s, s2c) = derive_keys(&[0x5au8; 32], &ticket()).unwrap();
    let (wrong_c2s, wrong_s2c) = derive_keys(&[0x5au8; 32], &new_ticket()).unwrap();
    let mut client = Session::from_keys(c2s, s2c, true).unwrap();
    let mut server = Session::from_keys(wrong_c2s, wrong_s2c, false).unwrap();
    let mut a = Vec::new();
    client.send(&mut a, &Msg::Ping {}).unwrap();
    let err = server.open_frame(&a[4..]).unwrap_err();
    assert!(err.contains("配对票"), "错误要能指到票上：{err}");
}

#[test]
fn 短于标签的帧被拒() {
    let (_, mut server) = pair(&ticket());
    assert!(server.open_frame(&[1, 2, 3]).is_err());
}

/// 「抓包看不到明文」在帧层的等价断言：密文里不得出现任何可识别的明文字节。
#[test]
fn 密文帧不含明文痕迹() {
    let (mut client, _) = pair(&ticket());
    let mut a = Vec::new();
    for msg in [
        Msg::Ping {},
        Msg::Pong {},
        Msg::Bye {},
        Msg::Refused {
            code: "ticket".into(),
            reason: "配对票不匹配".into(),
        },
    ] {
        client.send(&mut a, &msg).unwrap();
    }
    let t = ticket();
    for needle in [b"ping".as_slice(), b"pong".as_slice(), b"seq".as_slice()] {
        assert!(!a.windows(needle.len()).any(|w| w == needle), "找到明文 {needle:?}");
    }
    assert!(!String::from_utf8_lossy(&a).contains(&t[..8]));
    assert!(!String::from_utf8_lossy(&a).contains("heid-link"));
}

/* ------------------------------------------------------------------ 密钥 */

#[test]
fn 派生密钥双向对称且随票变化() {
    let (c1, s1) = derive_keys(b"shared-secret-material-32bytes", &ticket()).unwrap();
    let (c2, s2) = derive_keys(b"shared-secret-material-32bytes", &ticket()).unwrap();
    assert_eq!((c1, s1), (c2, s2));
    let (c3, _) = derive_keys(b"shared-secret-material-32bytes", &new_ticket()).unwrap();
    assert_ne!(c1, c3, "不同配对票必须派生不同密钥");
    let (c4, _) = derive_keys(b"other-secret-material-32-bytes!!", &ticket()).unwrap();
    assert_ne!(c1, c4, "不同共享密钥必须派生不同密钥");
}

#[test]
fn 两个方向的密钥不相同() {
    let (c2s, s2c) = derive_keys(b"shared-secret-material-32bytes", &ticket()).unwrap();
    assert_ne!(c2s, s2c);
}

#[test]
fn 配对票形状与校验() {
    let t = new_ticket();
    assert_eq!(t.len(), 32);
    assert!(is_valid_ticket(&t));
    assert!(!is_valid_ticket(""));
    assert!(!is_valid_ticket(&"z".repeat(32)));
    assert!(!is_valid_ticket(&"a".repeat(31)));
    assert!(!is_valid_ticket(&"a".repeat(33)));
}

#[test]
fn 公钥编解码往返与错误() {
    let raw = [0x11u8; 32];
    let s = encode_pub(&raw);
    assert_eq!(decode_pub(&s).unwrap(), raw);
    assert!(decode_pub("not base64!!").is_err());
    assert!(decode_pub(&encode_pub(&[0u8; 31])).is_err());
}

/* ------------------------------------------------------------------ 握手 */

/// 环回握手的一整对端。`peer_device` 是**对端**报来的设备名。
struct Side {
    stream: TcpStream,
    session: Session,
    peer_device: String,
}

fn loopback(t_client: &str, t_server: &str) -> Result<(Side, Side), String> {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let t_s = t_server.to_string();
    let srv = std::thread::spawn(move || -> Result<Side, String> {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(300))).ok();
        let mut f = Framer::default();
        let (session, peer_device) =
            handshake(&mut s, &mut f, &t_s, false, "heid-desktop", "MISAKI-PC")?;
        Ok(Side {
            stream: s,
            session,
            peer_device,
        })
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_millis(300))).ok();
    let mut cf = Framer::default();
    let client = handshake(&mut c, &mut cf, t_client, true, "heid-android", "SM-X808U").map(
        |(session, peer_device)| Side {
            stream: c,
            session,
            peer_device,
        },
    )?;
    Ok((client, srv.join().unwrap()?))
}

#[test]
fn 环回握手成功后双向可通信() {
    let (mut client, mut server) = loopback(&ticket(), &ticket()).expect("握手应成功");
    // 设备名只在服务端侧有意义（它是客户端 Hello 里带过去的）
    assert_eq!(server.peer_device, "SM-X808U");
    assert_eq!(client.peer_device, "");

    let mut f = Framer::default();
    client.session.send(&mut client.stream, &Msg::Ping {}).unwrap();
    assert_eq!(
        server.session.recv(&mut server.stream, &mut f).unwrap(),
        Some(Msg::Ping {})
    );
    server.session.send(&mut server.stream, &Msg::Pong {}).unwrap();
    assert_eq!(
        client.session.recv(&mut client.stream, &mut f).unwrap(),
        Some(Msg::Pong {})
    );
}

/// 这条把设计的顺序钉住：**握手两帧是明文，所以票不匹配不会在握手期报错**，
/// 而是在第一帧密文上暴露。服务端因此要在握手后主动发一帧（见 `serve_conn`），
/// 否则手机会对着"连上了但什么都没说"干等心跳超时。
#[test]
fn 票不匹配在第一帧密文上暴露而不是握手期() {
    let (mut client, mut server) = loopback(&ticket(), &new_ticket()).expect("握手只交换公钥");
    client.session.send(&mut client.stream, &Msg::Ping {}).unwrap();
    let mut f = Framer::default();
    let err = server
        .session
        .recv(&mut server.stream, &mut f)
        .unwrap_err();
    assert!(err.contains("配对票"), "{err}");
}

#[test]
fn 配对票不匹配时服务端解不开客户端首帧() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let t = ticket();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let mut f = Framer::default();
        let (mut sess, _) =
            handshake(&mut s, &mut f, &new_ticket(), false, "heid-desktop", "").unwrap();
        // 服务端按协议先发一帧；客户端用另一张票，必然解不开
        sess.send(&mut s, &Msg::Pong {}).unwrap();
        let mut cf = Framer::default();
        sess.recv(&mut s, &mut cf)
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_millis(500))).ok();
    let mut cf = Framer::default();
    let (mut cs, _) = handshake(&mut c, &mut cf, &t, true, "heid-android", "SM-X808U").unwrap();
    let err = cs.recv(&mut c, &mut cf).unwrap_err();
    assert!(err.contains("配对票"), "客户端要能看出是票的问题：{err}");
    let _ = server.join();
}

#[test]
fn 协议版本不匹配被拒并给出稳定码() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let mut f = Framer::default();
        handshake(&mut s, &mut f, &ticket(), false, "heid-desktop", "")
            .err()
            .unwrap_or_default()
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write_frame(
        &mut c,
        &serde_json::to_vec(&Msg::Hello {
            ver: PROTOCOL_VERSION + 99,
            pub_key: encode_pub(&[1u8; 32]),
            agent: "heid-android".into(),
            device: "SM-X808U".into(),
        })
        .unwrap(),
    )
    .unwrap();
    let err = server.join().unwrap();
    assert!(err.contains("协议版本"), "{err}");
    assert_eq!(refuse_code(&err), "version");
}

#[test]
fn 握手期收到巨帧被拒() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let mut f = Framer::default();
        handshake(&mut s, &mut f, &ticket(), false, "heid-desktop", "")
            .err()
            .unwrap_or_default()
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write_frame(&mut c, &vec![b'x'; MAX_HANDSHAKE_BYTES + 10]).unwrap();
    let err = server.join().unwrap();
    assert!(err.contains("上限"), "要如实报超限：{err}");
}

#[test]
fn 握手期不合规的第一帧被拒() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let mut f = Framer::default();
        handshake(&mut s, &mut f, &ticket(), false, "heid-desktop", "")
            .err()
            .unwrap_or_default()
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write_frame(&mut c, &serde_json::to_vec(&Msg::Ping {}).unwrap()).unwrap();
    let err = server.join().unwrap();
    assert!(err.contains("期望 hello"), "{err}");
    assert_eq!(refuse_code(&err), "protocol");
}

/* ------------------------------------------------------------------ 状态 */

#[test]
fn 状态快照默认是关闭的() {
    let s = LinkStatus::default();
    assert_eq!(s.role, Role::Off);
    assert!(!s.listening);
    assert!(!s.connected);
    assert!(s.ticket.is_empty());
    // 本端版本要一出生就对：前端拿它自证，快照里留 0 等于永远显示"未知"
    assert_eq!(s.protocol, PROTOCOL_VERSION);
}

#[test]
fn 状态序列化成驼峰且角色是小写串() {
    let s = LinkStatus {
        role: Role::Server,
        listening: true,
        port: 47123,
        protocol: PROTOCOL_VERSION,
        ..Default::default()
    };
    let v: serde_json::Value = serde_json::to_value(&s).unwrap();
    assert_eq!(v["role"], "server");
    assert_eq!(v["listening"], true);
    assert_eq!(v["port"], 47123);
    assert_eq!(v["peerDevice"], "");
    assert_eq!(v["lastError"], "");
}
