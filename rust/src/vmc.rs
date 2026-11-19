//! 🎤 VMC 接收（docs/VTUBER-PERFORMER-SPEC.md §5.2）：跟 Electron 版的 desktop/vmc.js 同一套規則。
//! 動捕軟體（VirtualMotionCapture／Warudo／VSeeFace／XR Animator…）用 OSC over UDP（預設 39539）送全身姿勢；這裡只聽 127.0.0.1，
//! 收成一幀（{ root, bones, blend, at }，Unity 座標）交給頁面：window.__kroomVmc(frame)（js/bridge.js 轉給 window.kroomApp.vmc.onFrame 的訂閱者）。
use serde_json::{json, Map, Value};
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

#[derive(Debug, Clone, PartialEq)]
pub enum Arg { F(f64), I(i64), S(String), B(bool) }
#[derive(Debug, Clone, PartialEq)]
pub struct Msg { pub addr: String, pub args: Vec<Arg> }

fn read_str(b: &[u8], o: usize) -> Option<(String, usize)> {
    let mut e = o; while e < b.len() && b[e] != 0 { e += 1; }
    if e >= b.len() { return None; }
    Some((String::from_utf8_lossy(&b[o..e]).into_owned(), (e + 4) & !3))
}
/// 一則 OSC 訊息
pub fn parse_message(b: &[u8]) -> Option<Msg> {
    let (addr, mut o) = read_str(b, 0)?; if !addr.starts_with('/') { return None; }
    let (tags, o2) = match read_str(b, o) { Some(x) => x, None => return Some(Msg { addr, args: vec![] }) }; o = o2;
    if !tags.starts_with(',') { return Some(Msg { addr, args: vec![] }); }
    let mut args = Vec::new();
    for t in tags[1..].chars() {
        match t {
            'f' => { let v = b.get(o..o + 4)?; args.push(Arg::F(f32::from_be_bytes([v[0], v[1], v[2], v[3]]) as f64)); o += 4; }
            'i' => { let v = b.get(o..o + 4)?; args.push(Arg::I(i32::from_be_bytes([v[0], v[1], v[2], v[3]]) as i64)); o += 4; }
            'd' => { let v = b.get(o..o + 8)?; let mut a = [0u8; 8]; a.copy_from_slice(v); args.push(Arg::F(f64::from_be_bytes(a))); o += 8; }
            's' => { let (s, o3) = read_str(b, o)?; args.push(Arg::S(s)); o = o3; }
            'T' => args.push(Arg::B(true)), 'F' => args.push(Arg::B(false)),
            _ => return Some(Msg { addr, args }),
        }
    }
    Some(Msg { addr, args })
}
/// 封包（可能是 #bundle，可以巢狀）→ 訊息
pub fn parse_packet(b: &[u8], out: &mut Vec<Msg>, depth: u32) {
    if b.len() >= 16 && &b[0..7] == b"#bundle" && depth < 4 {
        let mut o = 16;
        while o + 4 <= b.len() {
            let n = i32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]); o += 4;
            if n <= 0 || o + n as usize > b.len() { break; }
            parse_packet(&b[o..o + n as usize], out, depth + 1); o += n as usize;
        }
        return;
    }
    if let Some(m) = parse_message(b) { out.push(m); }
}
fn num(a: &Arg) -> Option<f64> { match a { Arg::F(f) => Some(*f), Arg::I(i) => Some(*i as f64), _ => None } }
/// 累積成一幀：Blend/Apply 或封包結束時交出
#[derive(Default)]
pub struct Assembler { root: Option<Vec<f64>>, bones: Map<String, Value>, blend: Map<String, Value>, dirty: bool }
impl Assembler {
    pub fn feed(&mut self, msgs: &[Msg]) -> Option<Value> {
        let mut out = None;
        for m in msgs {
            let a = &m.args;
            match m.addr.as_str() {
                "/VMC/Ext/Root/Pos" if a.len() >= 8 => { self.root = Some(a[1..8].iter().filter_map(num).collect()); self.dirty = true; }
                "/VMC/Ext/Bone/Pos" if a.len() >= 8 => { if let Arg::S(n) = &a[0] { self.bones.insert(n.clone(), json!(a[1..8].iter().filter_map(num).collect::<Vec<_>>())); self.dirty = true; } }
                "/VMC/Ext/Blend/Val" if a.len() >= 2 => { if let (Arg::S(n), Some(v)) = (&a[0], num(&a[1])) { self.blend.insert(n.clone(), json!(v)); self.dirty = true; } }
                "/VMC/Ext/Blend/Apply" => { out = self.flush().or(out); }
                _ => {}
            }
        }
        out
    }
    pub fn flush(&mut self) -> Option<Value> {
        if !self.dirty { return None; }
        self.dirty = false;
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Some(json!({ "root": self.root, "bones": std::mem::take(&mut self.bones), "blend": std::mem::take(&mut self.blend), "at": at }))
    }
}

struct Running { stop: Arc<AtomicBool> }
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// 開始聽（同一時間一個）；frames 以最多 60 Hz 交給頁面
pub fn start(w: WebviewWindow, port: u16) -> Result<u16, String> {
    stop();
    let sock = UdpSocket::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    sock.set_read_timeout(Some(Duration::from_millis(200))).ok();
    let stop_flag = Arc::new(AtomicBool::new(false)); let sf = stop_flag.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 65536]; let mut asm = Assembler::default(); let mut last = Instant::now() - Duration::from_secs(1); let mut pending: Option<Value> = None;
        while !sf.load(Ordering::Relaxed) {
            if let Ok((n, from)) = sock.recv_from(&mut buf) {
                if !from.ip().is_loopback() { continue; }
                let mut msgs = Vec::new(); parse_packet(&buf[..n], &mut msgs, 0);
                if let Some(f) = asm.feed(&msgs).or_else(|| asm.flush()) { pending = Some(f); }
            }
            if pending.is_some() && last.elapsed() >= Duration::from_millis(16) {
                let f = pending.take().unwrap(); last = Instant::now();
                let _ = w.eval(format!("window.__kroomVmc && window.__kroomVmc({})", f));
            }
        }
    });
    *RUNNING.lock().unwrap() = Some(Running { stop: stop_flag });
    Ok(port)
}
pub fn stop() { if let Some(r) = RUNNING.lock().unwrap().take() { r.stop.store(true, Ordering::Relaxed); } }

#[cfg(test)]
mod tests {
    use super::*;
    fn s(x: &str) -> Vec<u8> { let mut v = x.as_bytes().to_vec(); v.push(0); while v.len() % 4 != 0 { v.push(0); } v }
    fn msg(addr: &str, args: &[Arg]) -> Vec<u8> {
        let mut tags = String::from(","); let mut body = Vec::new();
        for a in args { match a { Arg::F(f) => { tags.push('f'); body.extend((*f as f32).to_be_bytes()); } Arg::I(i) => { tags.push('i'); body.extend((*i as i32).to_be_bytes()); } Arg::S(t) => { tags.push('s'); body.extend(s(t)); } Arg::B(b) => tags.push(if *b { 'T' } else { 'F' }) } }
        let mut v = s(addr); v.extend(s(&tags)); v.extend(body); v
    }
    #[test]
    fn bundle_to_frame() {
        let bone = msg("/VMC/Ext/Bone/Pos", &[Arg::S("Hips".into()), Arg::F(0.0), Arg::F(0.9), Arg::F(0.0), Arg::F(0.0), Arg::F(0.0), Arg::F(0.0), Arg::F(1.0)]);
        let blend = msg("/VMC/Ext/Blend/Val", &[Arg::S("A".into()), Arg::F(0.5)]);
        let apply = msg("/VMC/Ext/Blend/Apply", &[]);
        let mut b = s("#bundle"); b.extend([0u8; 8]);
        for m in [&bone, &blend, &apply] { b.extend((m.len() as i32).to_be_bytes()); b.extend(m.iter()); }
        let mut out = Vec::new(); parse_packet(&b, &mut out, 0); assert_eq!(out.len(), 3);
        let mut a = Assembler::default(); let f = a.feed(&out).expect("frame");
        assert!((f["bones"]["Hips"][1].as_f64().unwrap() - 0.9).abs() < 1e-6);
        assert!((f["blend"]["A"].as_f64().unwrap() - 0.5).abs() < 1e-6);
        assert!(a.flush().is_none());
    }
    #[test]
    fn junk_is_ignored() { let mut out = Vec::new(); parse_packet(b"garbage", &mut out, 0); assert!(out.is_empty()); parse_packet(&[0u8; 3], &mut out, 0); assert!(out.is_empty()); }
}
