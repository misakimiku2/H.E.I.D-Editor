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

/* ------------------------------------------------------------------ 握手（阶段 1） */

/// 一把可复现的测试身份：同时给出对象、其 PKCS#8（塞给服务端线程重建）、其指纹（客户端拿去校验）。
fn test_identity() -> (identity::Identity, Vec<u8>, String) {
    let (id, pkcs8) = identity::Identity::generate();
    let fp = id.fingerprint();
    (id, pkcs8, fp)
}

/// 走一整对握手：`server_resolve` 是服务端为这次 Hello 选的 salt（或拒绝）；
/// `expect_fp` 是客户端要校验的桌面指纹。返回两侧各自的 `(会话, LS)`。
fn establish(
    server_resolve: Result<String, String>,
    server_pkcs8: &[u8],
    client_salt: &str,
    mode: Mode,
    key_id: &str,
    slot: &str,
    expect_fp: &str,
) -> (Result<(Session, [u8; 32]), String>, Result<(Session, [u8; 32]), String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let pkcs8 = server_pkcs8.to_vec();
    let srv = std::thread::spawn(move || -> Result<(Session, [u8; 32]), String> {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(800))).ok();
        let id = identity::Identity::from_pkcs8(&pkcs8)?;
        let mut f = Framer::default();
        let sr = server_resolve;
        let hs = server_handshake(
            &mut s,
            &mut f,
            &|_m: Mode, _k: &str, _sl: &str| -> Result<String, String> {
                match &sr {
                    Ok(salt) => Ok(salt.clone()),
                    Err(reason) => Err(reason.clone()),
                }
            },
            &id,
        )?;
        let mut sess = hs.session;
        // 客户端验证 Auth 后必须回 Pong，才证明它握有同一把 salt
        match sess.recv(&mut s, &mut f) {
            Ok(Some(Msg::Pong {})) => {}
            other => return Err(format!("服务端未收到 pong：{other:?}")),
        }
        Ok((sess, hs.ls))
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_millis(800))).ok();
    let mut cf = Framer::default();
    let cres =
        client_handshake(&mut c, &mut cf, client_salt, mode, key_id, slot, "heid-android", "SM-X808U", expect_fp)
            .map(|(s, ls, _)| (s, ls));
    let sres = srv.join().unwrap();
    (sres, cres)
}

#[test]
fn 配对握手两端派生出同一把LS() {
    let (_, pkcs8, fp) = test_identity();
    let ticket = ticket();
    let (srv, cli) =
        establish(Ok(ticket.clone()), &pkcs8, &ticket, Mode::Pair, "", "ticket", &fp);
    let (_server, s_ls) = srv.expect("服务端握手应成功");
    let (_client, c_ls) = cli.expect("客户端握手应成功");
    assert_eq!(s_ls, c_ls, "两端从同一份 ECDH 派生的 LS 必须逐字节相同");
    assert_eq!(pair::key_id(&s_ls).len(), 16, "keyId 是 16 个十六进制字符");
}

#[test]
fn 配对握手后两端可双向收发() {
    let (_, pkcs8, fp) = test_identity();
    let t = ticket();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let pk = pkcs8.clone();
    let t2 = t.clone();
    let srv = std::thread::spawn(move || -> (Msg, [u8; 32]) {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(800))).ok();
        let id = identity::Identity::from_pkcs8(&pk).unwrap();
        let mut f = Framer::default();
        let hs =
            server_handshake(&mut s, &mut f, &|_, _, _| Ok(t2.clone()), &id)
                .unwrap();
        let mut sess = hs.session;
        let _ = sess.recv(&mut s, &mut f); // 客户端认证 Auth 后回的 pong
        let got = match sess.recv(&mut s, &mut f) {
            Ok(Some(m)) => m,
            other => panic!("服务端没等到应用帧：{other:?}"),
        };
        sess.send(&mut s, &Msg::Pong {}).unwrap();
        (got, hs.ls)
    });
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_millis(800))).ok();
    let mut cf = Framer::default();
    let (mut csess, cl, _) =
        client_handshake(&mut c, &mut cf, &t, Mode::Pair, "", "ticket", "heid-android", "SM-X808U", &fp)
            .unwrap();
    csess.send(&mut c, &Msg::Ping {}).unwrap();
    let mut cf2 = Framer::default();
    assert_eq!(csess.recv(&mut c, &mut cf2).unwrap(), Some(Msg::Pong {}));
    let (got, sl) = srv.join().unwrap();
    assert_eq!(got, Msg::Ping {}, "服务端要原样收到应用帧");
    assert_eq!(cl, sl, "双向通信不改变两端 LS 一致这一事实");
}

#[test]
fn 配对salt不匹配_客户端解不开Auth() {
    let (_, pkcs8, fp) = test_identity();
    let (srv, cli) = establish(
        Ok(ticket()),               // 服务端用自己的票
        &pkcs8,
        "ffffffffffffffffffffffffffffffff", // 客户端拿错票
        Mode::Pair,
        "",
        "ticket",
        &fp,
    );
    assert!(cli.is_err(), "错票的客户端应开不了服务端发的 Auth");
    // 服务端收不到 pong，握手在维持前就结束
    assert!(srv.is_err(), "没收到 pong 时服务端不得当作握手完成");
}

#[test]
fn 指纹不符的桌面被客户端拒() {
    let (_, pkcs8, _) = test_identity(); // 真正的桌面身份（服务端用它的私钥）
    let (_, _, other_fp) = test_identity(); // 另一把身份：客户端被引导去期待这个指纹
    let (_, cli) = establish(
        Ok(ticket()),
        &pkcs8,
        &ticket(),
        Mode::Pair,
        "",
        "ticket",
        &other_fp,
    );
    let err = cli.err().expect("指纹不符必须失败");
    assert!(err.contains("指纹"), "错误要指到指纹上：{err}");
}

#[test]
fn 重连_未登记的设备被服务端拒() {
    let (_, pkcs8, fp) = test_identity();
    // 服务端 resolve 对未知 keyId 返回拒绝（等价注入；真实那帧 Refused 由 serve_conn 发，见 link-verify）
    let (srv, cli) = establish(
        Err("这台设备未配对或已被移除，请重新扫码".into()),
        &pkcs8,
        &pair::ls_to_hex(&[0x55u8; 32]),
        Mode::Reconnect,
        "deadbeefdeadbeef",
        "",
        &fp,
    );
    assert!(srv.is_err(), "被拒时服务端不进入维持循环");
    assert!(cli.is_err(), "握手没走通，客户端也拿不到会话");
}

#[test]
fn 重连_登记的链路密钥对得上则成功() {
    let (_, pkcs8, fp) = test_identity();
    let ls = pair::derive_link_secret(b"shared-material-for-this-test-32b!!");
    let kid = pair::key_id(&ls);
    let salt = pair::ls_to_hex(&ls);
    // 服务端按 keyId 查出的 LS 作为 salt —— 与客户端存的是同一把
    let (srv, cli) = establish(Ok(salt.clone()), &pkcs8, &salt, Mode::Reconnect, &kid, "", &fp);
    let (mut _server, s_ls) = srv.expect("重连握手应成功");
    let (mut _client, c_ls) = cli.expect("重连客户端应成功");
    // 重连会话里 LS 仍按 shared 派生（每次 eph 不同 → LS 每次不同）；这里只验握手成功、能双向
    let _ = (&mut _server, &mut _client, s_ls, c_ls);
}

#[test]
fn 协议版本不匹配被拒并给出稳定码() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let (_, pkcs8, _) = test_identity();
        let id = identity::Identity::from_pkcs8(&pkcs8).unwrap();
        let mut f = Framer::default();
        server_handshake(&mut s, &mut f, &|_, _, _| Ok(ticket()), &id)
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
            mode: Mode::Pair,
            key_id: String::new(),
            slot: "ticket".into(),
        })
        .unwrap(),
    )
    .unwrap();
    let err = server.join().unwrap();
    assert!(err.contains("协议版本"), "{err}");
    assert_eq!(refuse_code(&err), "version");
}

#[test]
fn 握手期不合规的第一帧被拒() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let (_, pkcs8, _) = test_identity();
        let id = identity::Identity::from_pkcs8(&pkcs8).unwrap();
        let mut f = Framer::default();
        server_handshake(&mut s, &mut f, &|_, _, _| Ok(ticket()), &id)
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

/* -------------------------------------------- 阶段 2：命令面走真实 TCP */

/// `list` / `read` / `write` / 逃逸拒绝，全部经过一遍**真实 TCP + 真实 AEAD 会话**：
/// 命令面单测（`fsrv_tests`）不带网络，帧层单测不带命令，两边各自绿不代表接得上。
#[test]
fn 远程命令走完整加密链路往返() {
    use super::roots_tests::Temp;
    let t = Temp::new("tcp-fsrv");
    let root = t.root();
    let ticket_v = ticket();
    let (_, pkcs8, fp) = test_identity();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let pk = pkcs8.clone();
    let tv = ticket_v.clone();
    let srv_root = root.clone();

    // 服务端：握手 → 收请求 → 交给命令面 → 原样带 id 回响应，直到对端说再见
    let srv = std::thread::spawn(move || -> Vec<String> {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(800))).ok();
        let id = identity::Identity::from_pkcs8(&pk).unwrap();
        let mut f = Framer::default();
        let hs = server_handshake(&mut s, &mut f, &|_, _, _| Ok(tv.clone()), &id).unwrap();
        let mut sess = hs.session;
        let _ = recv_msg_deadline(&mut s, &mut sess, &mut f, Instant::now() + Duration::from_secs(2));
        let mut seen = Vec::new();
        loop {
            let msg = match recv_msg_deadline(&mut s, &mut sess, &mut f, Instant::now() + Duration::from_secs(3))
            {
                Ok(m) => m,
                Err(_) => break,
            };
            match msg {
                Msg::Bye {} => break,
                Msg::Req { id, method, params } => {
                    seen.push(format!("{method}:{id}"));
                    let msg = answer_req(&board::Scope::root_only(&srv_root), id, &method, &params);
                    sess.send(&mut s, &msg).unwrap();
                }
                other => {
                    seen.push(format!("unexpected:{other:?}"));
                    break;
                }
            }
        }
        seen
    });

    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_millis(800))).ok();
    let mut cf = Framer::default();
    let (mut csess, _ls, _) = client_handshake(
        &mut c, &mut cf, &ticket_v, Mode::Pair, "", "ticket", "heid-android", "SM-X808U", &fp,
    )
    .unwrap();

    let mut next = 0u64;
    let mut ask = |method: &str, params: &str| -> Result<serde_json::Value, String> {
        next += 1;
        let id = next;
        csess.send(&mut c, &Msg::Req { id, method: method.into(), params: params.into() }).unwrap();
        loop {
            match csess.recv(&mut c, &mut cf).unwrap() {
                Some(Msg::Res { id: rid, ok, code, error, data }) => {
                    assert_eq!(rid, id, "响应必须回到发起它的那条请求上（帧序不能错配）");
                    return if ok {
                        Ok(serde_json::from_str(&data).expect("响应载荷应是 JSON"))
                    } else {
                        Err(format!("{code}:{error}"))
                    };
                }
                Some(other) => panic!("客户端在等应答却收到 {other:?}"),
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    };

    let listed = ask("list", r#"{"relDir":""}"#).expect("列根目录应成功");
    let names: Vec<&str> = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"readme.md"), "实际：{names:?}");

    let read = ask("read", r#"{"relPath":"readme.md"}"#).expect("读文件应成功");
    assert_eq!(read["text"], "# hi");
    let base = read["hash"].as_str().unwrap().to_string();

    let written_params = serde_json::json!({
        "relPath": "readme.md", "text": "# 手机上改的", "encoding": "utf-8", "bom": false, "baseHash": base
    })
    .to_string();
    let written = ask("write", &written_params).expect("带正确基线的写入应成功");
    assert_eq!(written["conflict"], false);
    assert_eq!(std::fs::read(root.join("readme.md")).unwrap(), "# 手机上改的".as_bytes());

    // 基线错了：必须判成冲突且一个字都不落盘
    let again = ask(
        "write",
        r#"{"relPath":"readme.md","text":"不该被写入","encoding":"utf-8","bom":false,"baseHash":"0000000000000000000000000000000000000000000000000000000000000000"}"#,
    )
    .expect("冲突本身是一次成功应答");
    assert_eq!(again["conflict"], true);
    assert_eq!(again["serverText"], "# 手机上改的");
    assert_eq!(std::fs::read(root.join("readme.md")).unwrap(), "# 手机上改的".as_bytes());

    // 逃逸：链路上加密得好好的，命令面照样要拒
    let escaped = ask("read", r#"{"relPath":"../outside/secret.txt"}"#).unwrap_err();
    assert!(escaped.starts_with("badpath:"), "逃逸必须以 badpath 拒掉，实际：{escaped}");

    csess.send(&mut c, &Msg::Bye {}).unwrap();
    let seen = srv.join().unwrap();
    assert_eq!(seen, vec!["list:1", "read:2", "write:3", "write:4", "read:5"], "服务端要按序收到这五笔");
}

/* -------------------------------------------- 阶段 3：标签、白名单与推送 */

/// 标签列表、根外白名单读写、以及**服务端主动推送**，全走一遍真实 TCP + 真实 AEAD 会话。
///
/// 这条测试盯的是阶段 3 独有的三件事，各自的单测都覆盖不到：
/// - `event` 帧能在没有请求在飞的时候到达客户端（手机靠它刷新列表）；
/// - 服务端只按 `type` 各留一帧：连着报三次也只推一次，不会把链路刷爆；
/// - 关掉标签之后同一条 `@w` 引用在线上立刻失效 —— 收回授权不靠对端自觉。
/// 阶段 4：`fs` 推送的队列语义。三条都在别的推送上不存在，所以单独测：
/// - **合而不是丢重复**：泵被一次大文件读拖住的这几秒里，两个合并窗口各攒了一批目录，
///   出口必须是一帧两批都在（按 `queue` 那种"同类型只留一条"会把后一批吃掉）；
/// - 超限退化成不带载荷的一条，而不是把清单截断——截断会让手机端以为其余层没变；
/// - 空集合不发帧。
#[test]
#[cfg(desktop)]
fn fs_推送按窗口合并载荷且装不下就整体退化() {
    let push = Push::default();
    assert!(push.take().is_empty(), "没变化就不该有帧");

    push.queue_fs(&["src".into(), "docs".into()]);
    push.queue_fs(&["docs".into(), "src/lib".into()]);
    let frames = push.take();
    assert_eq!(frames.len(), 1, "两批合成一帧，而不是排两条");
    match &frames[0] {
        Msg::Event { typ, data } => {
            assert_eq!(typ, EVENT_FS);
            assert_eq!(data, r#"{"dirs":["docs","src","src/lib"]}"#, "去重 + 排序，同一批变化永远序列化成一个样子");
        }
        other => panic!("不该发出 {other:?}"),
    }
    assert!(push.take().is_empty(), "发过的不该重复发");

    // 一帧装不下的量（比 MAX_PUSH_DIRS 多一条），且**没有任何一部分被截断发出去**
    let many: Vec<String> = (0..=watch::MAX_PUSH_DIRS).map(|i| format!("d{i}")).collect();
    push.queue_fs(&many);
    let frames = push.take();
    assert_eq!(frames.len(), 1);
    match &frames[0] {
        Msg::Event { typ, data } => {
            assert_eq!(typ, EVENT_FS);
            assert_eq!(data, "", "退化 = 不带载荷的那条「变了，去重取」，手机端因此不会漏掉任何一层");
        }
        other => panic!("不该发出 {other:?}"),
    }
}

/// 阶段 4：监听随连接而生死。这条测的是"断开即释放"那半句 ——
/// 判据用 Windows 上最硬的那条：**句柄还开着就删不掉目录**。
/// 停掉之后能删干净，说明通知句柄真的随线程一起放下了，而不是留了一份没人管的监听。
#[test]
#[cfg(desktop)]
fn 监听停掉之后释放目录句柄() {
    use std::sync::mpsc;
    let dir = std::env::temp_dir().join(format!("heid-watch-close-{}-{}", std::process::id(), line!()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let (tx, rx) = mpsc::channel::<Vec<String>>();
    let handle = watch::spawn(dir.clone(), move |dirs| {
        let _ = tx.send(dirs.to_vec());
    })
    .expect("监听建不起来");

    std::fs::write(dir.join("a.md"), "一").unwrap();
    let got = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("建了监听却一帧都没收到");
    assert_eq!(got, vec![String::new()], "根目录下的变更报的是「重列根」这一层");

    drop(handle);
    // 线程最多再转一个 TICK 就退出；给它一秒足够，且不靠"猜 sleep"判定成败 —— 判据是删除能否成功
    let mut last_err = String::new();
    for _ in 0..50 {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => return,
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    panic!("停掉之后目录仍删不掉，说明监听句柄没释放：{last_err}");
}

/// 阶段 4：换根之后旧根当场读不到。判据落在服务端而不是手机端 ——
/// 手机上置灰只是好看，命令面拒了才是真的收回去。
#[test]
fn 换根后旧根的相对路径当场不可读() {
    use super::board::Board;
    use super::roots_tests::Temp;

    let t = Temp::new("root-switch");
    let a = t.root();
    std::fs::create_dir_all(t.base.join("second")).unwrap();
    // 服务端存的从来就是 canonicalize 过的那一份，测试不能拿裸路径冒充
    let b = super::roots::canonical_root(&t.base.join("second")).unwrap();

    let mut board = Board::default();
    board.set_root("main", Some(a.clone()));
    let scope_a = board.scope();
    assert!(super::fsrv::handle(&scope_a, "stat", r#"{"relPath":"readme.md"}"#).is_ok());

    board.set_root("main", Some(b.clone()));
    let scope_b = board.scope();
    // 同一份 rel，换了根就只能指向新根里面 —— 旧根那份不会还留在解析结果里
    let err = super::fsrv::handle(&scope_b, "stat", r#"{"relPath":"readme.md"}"#).unwrap_err();
    assert_eq!(err.0, "notfound", "旧根那份文件在新根里不存在，就该是读不到而不是读到旧内容");
    assert!(super::fsrv::handle(&scope_b, "list", r#"{"relDir":""}"#).is_ok(), "新根自己照样可列");
}

#[test]
fn 标签白名单与推送走完整加密链路() {
    use super::board::{open_id, Board, TabReport};
    use super::roots_tests::Temp;

    let t = Temp::new("tcp-tabs");
    let root = t.root();
    let outside = t.base.join("open/todo.md");
    std::fs::create_dir_all(t.base.join("open")).unwrap();
    std::fs::write(&outside, "# 根外那份").unwrap();

    // 看板两边都要碰（服务端线程读、主线程模拟窗口上报），所以与真实代码一样挂在锁上
    let mut initial = Board::default();
    initial.set_root("main", Some(root.clone()));
    initial.set_tabs(
        "main",
        vec![
            TabReport {
                path: Some(root.join("readme.md").to_string_lossy().to_string()),
                title: "readme.md".into(),
                ..Default::default()
            },
            TabReport {
                path: Some(outside.to_string_lossy().to_string()),
                title: "todo.md".into(),
                ..Default::default()
            },
        ],
    );
    let board = Arc::new(Mutex::new(initial));
    let srv_board = board.clone();

    let ticket_v = ticket();
    let (_, pkcs8, fp) = test_identity();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let pk = pkcs8.clone();
    let tv = ticket_v.clone();

    let push = Arc::new(Push::default());
    let srv_push = push.clone();
    let srv = std::thread::spawn(move || -> Vec<String> {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_millis(400))).ok();
        let id = identity::Identity::from_pkcs8(&pk).unwrap();
        let mut f = Framer::default();
        let hs = server_handshake(&mut s, &mut f, &|_, _, _| Ok(tv.clone()), &id).unwrap();
        let mut sess = hs.session;
        let _ = recv_msg_deadline(&mut s, &mut sess, &mut f, Instant::now() + Duration::from_secs(2));
        let mut seen = Vec::new();
        let mut pushed = false;
        loop {
            // 与 run_pump 同一顺序：先发挂上来的推送，再收请求
            for msg in srv_push.take() {
                sess.send(&mut s, &msg).unwrap();
            }
            let msg = match recv_msg_deadline(&mut s, &mut sess, &mut f, Instant::now() + Duration::from_secs(3))
            {
                Ok(m) => m,
                Err(_) => break,
            };
            match msg {
                Msg::Bye {} => break,
                Msg::Req { id, ref method, .. } => seen.push(format!("{method}:{id}")),
                other => {
                    seen.push(format!("unexpected:{other:?}"));
                    break;
                }
            }
            let Msg::Req { id, method, params } = msg else { break };
            let scope = srv_board.lock().unwrap().scope();
            let reply = answer_req(&scope, id, &method, &params);
            sess.send(&mut s, &reply).unwrap();
            // 应答之后模拟一次「桌面又报了三次标签」：队列里必须只留一帧，且紧接着就发出去
            if !pushed {
                pushed = true;
                srv_push.queue("tabs");
                srv_push.queue("tabs");
                srv_push.queue("tabs");
                for msg in srv_push.take() {
                    sess.send(&mut s, &msg).unwrap();
                }
            }
        }
        seen
    });

    /// 手机侧：把会话/流/增量读取器收在一起，`ask` 与 `recv` 才能交替调用 ——
    /// 两个 `&mut` 闭包各持有一份借用，写成闭包会在借用检查上撞车。
    struct Phone {
        sess: Session,
        sock: TcpStream,
        fr: Framer,
        next: u64,
    }
    impl Phone {
        /// 收一帧（应答与推送都接）
        fn recv(&mut self) -> Msg {
            loop {
                match self.sess.recv(&mut self.sock, &mut self.fr).unwrap() {
                    Some(m) => return m,
                    None => std::thread::sleep(Duration::from_millis(20)),
                }
            }
        }

        fn ask(&mut self, method: &str, params: &str) -> Result<serde_json::Value, String> {
            self.next += 1;
            let id = self.next;
            self.sess
                .send(&mut self.sock, &Msg::Req { id, method: method.into(), params: params.into() })
                .unwrap();
            loop {
                match self.recv() {
                    Msg::Res { id: rid, ok, code, error, data } => {
                        assert_eq!(rid, id, "响应必须回到发起它的那条请求上");
                        return if ok {
                            Ok(serde_json::from_str(&data).expect("响应载荷应是 JSON"))
                        } else {
                            Err(format!("{code}:{error}"))
                        };
                    }
                    other => panic!("在等 {method} 的应答却收到 {other:?}"),
                }
            }
        }
    }

    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_millis(400))).ok();
    let mut cf = Framer::default();
    let (csess, _ls, _) = client_handshake(
        &mut c, &mut cf, &ticket_v, Mode::Pair, "", "ticket", "heid-android", "SM-X808U", &fp,
    )
    .unwrap();
    let mut phone = Phone { sess: csess, sock: c, fr: cf, next: 0 };

    // ① 标签列表：根内的给相对路径，根外的给白名单引用
    let tabs = phone.ask("tabs", "{}").expect("tabs 应成功");
    let list = tabs.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["rel"], "readme.md");
    let open_rel = list[1]["rel"].as_str().unwrap().to_string();
    assert_eq!(open_rel, format!("@w/{}/todo.md", open_id(&outside.canonicalize().unwrap())));

    // ② 服务端在我们没有发任何请求的情况下推了一帧 event（且三次上报只成一帧）。
    // 顺序要紧跟着上一条 ask：这一帧到达时没有任何请求在飞。
    match phone.recv() {
        Msg::Event { typ, data } => {
            assert_eq!(typ, "tabs");
            assert!(data.is_empty(), "推送只报「变了」，内容跟着请求走");
        }
        other => panic!("期望收到一帧 event，实际 {other:?}"),
    }

    // ③ 根外那份照样能读——走的是与根内同一条命令、同一套解码
    let read = phone
        .ask("read", &format!(r#"{{"relPath":"{open_rel}"}}"#))
        .expect("白名单内的读取应成功");
    assert_eq!(read["text"], "# 根外那份");

    // ④ 关掉标签：同一条引用当场失效（先确认它曾经可用）
    board.lock().unwrap().set_tabs(
        "main",
        vec![TabReport { path: None, title: "未命名".into(), ..Default::default() }],
    );
    let tabs2 = phone.ask("tabs", "{}").expect("第二次 tabs 应成功");
    assert_eq!(tabs2[0]["reason"], "novirtual", "剩下的那个是无路径标签");
    let dead = phone
        .ask("read", &format!(r#"{{"relPath":"{open_rel}"}}"#))
        .unwrap_err();
    assert!(dead.starts_with("notopen:"), "关标签后必须断掉这条引用，实际：{dead}");

    phone.sess.send(&mut phone.sock, &Msg::Bye {}).unwrap();
    let seen = srv.join().unwrap();
    assert_eq!(seen, vec!["tabs:1", "read:2", "tabs:3", "read:4"], "服务端要按序收到这四笔");
}
