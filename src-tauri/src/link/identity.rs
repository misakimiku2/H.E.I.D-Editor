//! 桌面长期身份（v1.5 阶段 1）：一把跨重启不变的 Ed25519 密钥对，外加它的**指纹**。
//!
//! 为什么要有身份密钥，而阶段 0 只有临时票：配对票一次性、用后即废，撑不起「记住设备、
//! 重启免扫自动重连」——重连时两端必须有一个**长期**的东西来证明「还是那台机器 / 还是那次配对」。
//! 手机扫的码里带这把身份公钥的指纹（设计稿 §12.1 第 5 条），握手后桌面出示对它签的名，
//! 手机一比对就知道同网段有没有人抢答、或者记着的地址什么时候被换了机器。
//!
//! 私钥只在配对完成后落一次盘（`pair::Store`），从不上网；环上流的只有 32 字节公钥与签名。

use ring::digest;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};

/// 指纹长度：SHA-256(公钥) 前 8 字节，base32 后 13 个字符 —— 与设计稿 §12.1 第 5 条「截 8 字节」一致。
pub const FINGERPRINT_BYTES: usize = 8;

const B32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32、无填充。只用来把 8 字节指纹渲染成人能读、码能带的短串。
pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32_ALPHABET[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32_ALPHABET[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// 公钥指纹。对端公钥先 SHA-256 再截 8 字节 —— 直接对公钥取前缀会让指纹撞上公钥本身的结构，
/// 哈希一次把这层去掉，也顺带让「比对指纹」不泄露公钥前缀。
pub fn fingerprint(pubkey: &[u8]) -> String {
    let d = digest::digest(&digest::SHA256, pubkey);
    base32(&d.as_ref()[..FINGERPRINT_BYTES])
}

/// 已加载的桌面身份。ring 的 `Ed25519KeyPair` 不可 Clone，故整体放在 `Mutex<Option<..>>` 里，
/// 只在握手时短暂取出。
pub struct Identity {
    keypair: Ed25519KeyPair,
}

impl Identity {
    /// 新生成一把身份，同时返回它的 PKCS#8（48 字节）供落盘。
    /// 随机源不可用就起不了身份：跟配对票同理，宁可不启也别用一把弱的。
    pub fn generate() -> (Identity, Vec<u8>) {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .expect("ring: Ed25519 密钥生成失败（系统随机源不可用）");
        let bytes = pkcs8.as_ref().to_vec();
        let keypair = Ed25519KeyPair::from_pkcs8(&bytes)
            .expect("刚由 ring 生成的 PKCS#8 必定可解析");
        (Identity { keypair }, bytes)
    }

    /// 从盘上的 PKCS#8 恢复。损坏/长度不对一律报错，让上层决定「重建一把新的」还是「拒绝启动共享」。
    pub fn from_pkcs8(bytes: &[u8]) -> Result<Identity, String> {
        Ed25519KeyPair::from_pkcs8(bytes)
            .map(|keypair| Identity { keypair })
            .map_err(|_| "桌面身份私钥损坏或不是合法 PKCS#8".to_string())
    }

    pub fn public_key(&self) -> Vec<u8> {
        self.keypair.public_key().as_ref().to_vec()
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(self.keypair.public_key().as_ref())
    }

    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.keypair.sign(msg).as_ref().to_vec()
    }
}

/// 验签。公钥不合法或签名不对都返回 false，不区分（对调用方都是「不认这台」）。
pub fn verify(pubkey: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    UnparsedPublicKey::new(&ED25519, pubkey)
        .verify(msg, sig)
        .is_ok()
}

/// 握手身份证明要签的那段字节。把「本方是谁的临时公钥」和「这把长期身份」焊死在一起：
/// 中间人若只是转发握手的临时公钥，签不出对得上这条消息、且公钥指纹又匹配码里那张的身份。
///
/// 方向前缀分开写死，是为了让「手机签的东西」永远不会被当成「桌面签的东西」（反之亦然），
/// 哪怕两端的临时公钥偶然相同也不会串。
pub fn auth_message(who: &[u8; 4], client_pub: &[u8], server_pub: &[u8], identity_pub: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(4 + 32 * 3 + b"heid-link-auth-v1".len());
    m.extend_from_slice(b"heid-link-auth-v1");
    m.extend_from_slice(who);
    m.extend_from_slice(client_pub);
    m.extend_from_slice(server_pub);
    m.extend_from_slice(identity_pub);
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_已知向量() {
        // RFC 4648："" -> ""，"f" -> "MY"======(去填充 MY)，"fo" -> "MZXQ"，"foo" -> "MZXW6"
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"fo"), "MZXQ");
        assert_eq!(base32(b"foo"), "MZXW6");
        assert_eq!(base32(b"foob"), "MZXW6YQ");
        assert_eq!(base32(b"fooba"), "MZXW6YTB");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
    }

    #[test]
    fn 指纹稳定且与公钥绑定() {
        let (id, pkcs8) = Identity::generate();
        let again = Identity::from_pkcs8(&pkcs8).unwrap();
        assert_eq!(id.fingerprint(), again.fingerprint(), "同一把私钥的指纹必须逐字不变");
        assert_eq!(id.public_key(), again.public_key());
        let (other, _) = Identity::generate();
        assert_ne!(id.fingerprint(), other.fingerprint(), "两把身份不该撞指纹");
    }

    #[test]
    fn 指纹是八字节的_base32() {
        let (id, _) = Identity::generate();
        let fp = id.fingerprint();
        // 8 字节 → ceil(64/5)=13 个 base32 字符
        assert_eq!(fp.len(), 13, "指纹显示宽度：{fp}");
        assert!(fp.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        assert!(!fp.contains('='), "不输出 base32 填充");
    }

    #[test]
    fn 签名可验且改一字节即废() {
        let (id, _) = Identity::generate();
        let msg = auth_message(b"srv\0", &[1u8; 32], &[2u8; 32], &id.public_key());
        let sig = id.sign(&msg);
        assert!(verify(&id.public_key(), &msg, &sig));
        let mut bad = msg.clone();
        bad[20] ^= 0x01;
        assert!(!verify(&id.public_key(), &bad, &sig));
        let (id2, _) = Identity::generate();
        assert!(!verify(&id2.public_key(), &msg, &sig), "别把身份签给别人的公钥");
    }

    #[test]
    fn 损坏的私钥字节被拒() {
        assert!(Identity::from_pkcs8(&[0u8; 8]).is_err());
        assert!(Identity::from_pkcs8(b"not a pkcs8 at all").is_err());
    }
}
