// VMC 協定送出（OSC over UDP，只送本機）：一幀＝一個 #bundle：Neck、Head 骨（Unity 座標的區域旋轉）＋ ARKit blendshape ＋ Apply。
//   K ROOM 桌面版的 VMC 接收（desktop/vmc.js、desktop-rs/src/vmc.rs）收到 Apply 就交出一幀；VSeeFace 等軟體也收得到。
use nalgebra::Matrix3;
use std::net::UdpSocket;

fn pad(b: &mut Vec<u8>) { while b.len() % 4 != 0 { b.push(0); } }
fn s(b: &mut Vec<u8>, x: &str) { b.extend_from_slice(x.as_bytes()); b.push(0); pad(b); }
fn msg(addr: &str, tags: &str, args: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> { let mut b = Vec::new(); s(&mut b, addr); s(&mut b, &format!(",{tags}")); args(&mut b); b }
fn f(b: &mut Vec<u8>, v: f32) { b.extend_from_slice(&v.to_be_bytes()); }

pub struct Vmc { sock: UdpSocket, to: String }
impl Vmc {
    pub fn new(port: u16) -> std::io::Result<Self> { Ok(Vmc { sock: UdpSocket::bind("127.0.0.1:0")?, to: format!("127.0.0.1:{port}") }) }
    /// bones：(Unity 骨名, [qx,qy,qz,qw])；blend：(名稱, 值)
    pub fn send(&self, t: f32, bones: &[(&str, [f32; 4])], blend: &[(String, f32)]) -> std::io::Result<()> {
        let mut parts: Vec<Vec<u8>> = vec![msg("/VMC/Ext/OK", "i", |b| b.extend_from_slice(&1i32.to_be_bytes())), msg("/VMC/Ext/T", "f", |b| f(b, t))];
        for (n, q) in bones { parts.push(msg("/VMC/Ext/Bone/Pos", "sfffffff", |b| { s(b, n); for v in [0., 0., 0., q[0], q[1], q[2], q[3]] { f(b, v); } })); }
        for (n, v) in blend { parts.push(msg("/VMC/Ext/Blend/Val", "sf", |b| { s(b, n); f(b, *v); })); }
        parts.push(msg("/VMC/Ext/Blend/Apply", "", |_| {}));
        let mut b = Vec::with_capacity(4096); s(&mut b, "#bundle"); b.extend_from_slice(&1u64.to_be_bytes());
        for p in parts { b.extend_from_slice(&(p.len() as i32).to_be_bytes()); b.extend_from_slice(&p); }
        self.sock.send_to(&b, &self.to).map(|_| ())
    }
}

/// 頭的旋轉（標準臉 → 相機：x 右、y 上、z 朝鏡頭）→ 脖子、頭各分一半的 VRM 區域旋轉 → Unity 座標（x,-y,-z,w）。
///   跟網頁版 solve.ts 的 headFromMatrix 同一套：YXZ 歐拉角，yaw、roll 視鏡像翻號，pitch 反號。
pub fn head_bones(r: &Matrix3<f32>, mirror: bool) -> [(&'static str, [f32; 4]); 2] {
    let (m13, m23, m33, m21, m22, m31, m11) = (r[(0, 2)], r[(1, 2)], r[(2, 2)], r[(1, 0)], r[(1, 1)], r[(2, 0)], r[(0, 0)]);
    let ex = (-m23.clamp(-1., 1.)).asin();
    let (ey, ez) = if m23.abs() < 0.9999999 { (m13.atan2(m33), m21.atan2(m22)) } else { ((-m31).atan2(m11), 0.) };
    let sg = if mirror { -1. } else { 1. };
    let (yaw, pitch, roll) = (sg * ey, -ex, sg * -ez);
    let (x, y, z) = (pitch / 4., yaw / 4., roll / 4.);   // (一半給脖子、一半給頭；四元數再取半角)
    let (c1, c2, c3, s1, s2, s3) = (x.cos(), y.cos(), z.cos(), x.sin(), y.sin(), z.sin());
    let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
    let u = [q[0], -q[1], -q[2], q[3]];
    [("Neck", u), ("Head", u)]
}

/// 鏡像時左右對調名稱（eyeBlinkLeft ↔ eyeBlinkRight）
pub fn mirror_name(n: &str, mirror: bool) -> String {
    if !mirror { return n.to_string(); }
    if let Some(b) = n.strip_suffix("Left") { format!("{b}Right") } else if let Some(b) = n.strip_suffix("Right") { format!("{b}Left") } else { n.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundle_layout() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap(); let port = rx.local_addr().unwrap().port();
        let v = Vmc::new(port).unwrap(); v.send(1.0, &head_bones(&Matrix3::identity(), false), &[("jawOpen".into(), 0.5)]).unwrap();
        let mut buf = [0u8; 4096]; let n = rx.recv(&mut buf).unwrap();
        assert_eq!(&buf[..8], b"#bundle\0"); assert!(n > 100);
        let txt = String::from_utf8_lossy(&buf[..n]); assert!(txt.contains("/VMC/Ext/Bone/Pos") && txt.contains("Head") && txt.contains("jawOpen") && txt.contains("/VMC/Ext/Blend/Apply"));
    }
    #[test]
    fn identity_head_is_identity() { let b = head_bones(&Matrix3::identity(), false); assert!((b[1].1[3] - 1.).abs() < 1e-6); }
    #[test]
    fn mirror_names() { assert_eq!(mirror_name("eyeBlinkLeft", true), "eyeBlinkRight"); assert_eq!(mirror_name("jawOpen", true), "jawOpen"); }
}
