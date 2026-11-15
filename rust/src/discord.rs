//! 🎮 Discord 狀態 (Rich Presence) — desktop/discord.js in Rust. Discord's local IPC: a named pipe on Windows (\\?\pipe\discord-ipc-N), a socket in
//! the temp folder on a Mac. Each frame = op (i32 LE) + length (i32 LE) + JSON. op 0 handshake → READY; op 1 commands / events; op 2 close;
//! op 3 ping → op 4 pong. Not running: tried again later (5 s, doubling, at most once a minute), silently.
//! At most one SET_ACTIVITY every GAP (always the newest), an unchanged one is not sent, a clear goes out at once. ACTIVITY_JOIN (a friend accepted
//! an invite) → on_join(secret).
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;

const GAP: Duration = Duration::from_millis(4000);
const MAX_FRAME: usize = 1 << 20;

#[derive(Clone)]
pub struct Discord {
    tx: mpsc::UnboundedSender<Option<Value>>,
}

impl Discord {
    /// show this activity (None: clear)
    pub fn set(&self, activity: Option<Value>) {
        let _ = self.tx.send(activity);
    }
}

trait Conn: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Conn for T {}

async fn open(i: u32) -> Option<Box<dyn Conn>> {
    let test = std::env::var("KROOM_TEST_DISCORD_PIPE").ok();
    #[cfg(windows)]
    {
        let p = test.map(|t| format!("{t}{i}")).unwrap_or_else(|| format!(r"\\?\pipe\discord-ipc-{i}"));
        return tokio::net::windows::named_pipe::ClientOptions::new().open(p).ok().map(|c| Box::new(c) as Box<dyn Conn>);
    }
    #[cfg(unix)]
    {
        let p = test.map(|t| format!("{t}{i}")).unwrap_or_else(|| {
            let dir = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].iter().find_map(|k| std::env::var(k).ok()).unwrap_or_else(|| "/tmp".into());
            std::path::Path::new(&dir).join(format!("discord-ipc-{i}")).to_string_lossy().into_owned()
        });
        return tokio::net::UnixStream::connect(p).await.ok().map(|c| Box::new(c) as Box<dyn Conn>);
    }
}

fn frame(op: i32, body: &Value) -> Vec<u8> {
    let b = serde_json::to_vec(body).unwrap_or_default();
    let mut f = Vec::with_capacity(8 + b.len());
    f.extend_from_slice(&op.to_le_bytes());
    f.extend_from_slice(&(b.len() as i32).to_le_bytes());
    f.extend_from_slice(&b);
    f
}

fn nonce() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn create(client_id: &'static str, on_join: impl Fn(String) + Send + Sync + 'static) -> Discord {
    let (tx, mut rx) = mpsc::unbounded_channel::<Option<Value>>();
    tauri::async_runtime::spawn(async move {
        let mut want: Option<Value> = None;
        let mut retries = 0u32;
        loop {
            // find Discord on pipe 0…9: one that is not there, or never says READY, counts as absent and the next is tried
            for i in 0..10 {
                let Some(mut c) = open(i).await else { continue };
                if c.write_all(&frame(0, &json!({ "v": 1, "client_id": client_id }))).await.is_err() {
                    continue;
                }
                if session(c, client_id, &mut want, &mut rx, &on_join).await {
                    retries = 0; // (it was there and went away: try again from pipe 0 after the wait)
                    break;
                }
            }
            // wait before trying again, still taking what the page wants meanwhile
            let wait = Duration::from_millis((5000u64 << retries.min(4)).min(60_000));
            retries += 1;
            let until = Instant::now() + wait;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(until) => break,
                    m = rx.recv() => match m { Some(a) => want = a, None => return },
                }
            }
        }
    });
    Discord { tx }
}

/// one connection; true when Discord said READY
async fn session(
    mut c: Box<dyn Conn>,
    _client_id: &str,
    want: &mut Option<Value>,
    rx: &mut mpsc::UnboundedReceiver<Option<Value>>,
    on_join: &(impl Fn(String) + Send + Sync),
) -> bool {
    let pid = std::process::id();
    let mut ready = false;
    let mut sent = String::from("null");
    let mut last_at: Option<Instant> = None;
    let mut again: Option<Instant> = None; // a refused SET_ACTIVITY: sent again in a while
    let dead = Instant::now() + Duration::from_secs(10); // (no READY in time: as if it were not there)
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        // when the wanted activity should go out next (None: nothing to send)
        let j = serde_json::to_string(&*want).unwrap_or_default();
        let due = if !ready || j == sent {
            None
        } else if want.is_none() {
            Some(again.unwrap_or_else(Instant::now)) // (clearing goes out at once — unless Discord just refused one: then after the wait)
        } else {
            Some(last_at.map(|t| t + GAP).unwrap_or_else(Instant::now).max(again.unwrap_or_else(Instant::now)))
        };
        let far = Instant::now() + Duration::from_secs(3600);
        tokio::select! {
            n = c.read(&mut chunk) => {
                let n = match n { Ok(0) | Err(_) => return ready, Ok(n) => n };
                buf.extend_from_slice(&chunk[..n]);
                while buf.len() >= 8 {
                    let op = i32::from_le_bytes(buf[0..4].try_into().unwrap());
                    let len = i32::from_le_bytes(buf[4..8].try_into().unwrap());
                    if len < 0 || len as usize > MAX_FRAME { return ready; }
                    let len = len as usize;
                    if buf.len() < 8 + len { break; }
                    let body: Vec<u8> = buf[8..8 + len].to_vec();
                    buf.drain(..8 + len);
                    match op {
                        3 => { let mut f = 4i32.to_le_bytes().to_vec(); f.extend_from_slice(&(body.len() as i32).to_le_bytes()); f.extend_from_slice(&body); if c.write_all(&f).await.is_err() { return ready; } continue; }
                        2 => return ready,
                        1 => {}
                        _ => continue,
                    }
                    let Ok(m) = serde_json::from_slice::<Value>(&body) else { continue };
                    let (cmd, evt) = (m["cmd"].as_str().unwrap_or(""), m["evt"].as_str().unwrap_or(""));
                    if cmd == "DISPATCH" && evt == "READY" {
                        ready = true; sent = "null".into();
                        if c.write_all(&frame(1, &json!({ "cmd": "SUBSCRIBE", "evt": "ACTIVITY_JOIN", "args": {}, "nonce": nonce() }))).await.is_err() { return ready; }
                    } else if cmd == "DISPATCH" && evt == "ACTIVITY_JOIN" {
                        if let Some(s) = m["data"]["secret"].as_str() { on_join(s.to_string()); }
                    } else if evt == "ERROR" {
                        eprintln!("discord {cmd} {} {}", m["data"]["code"], m["data"]["message"]);
                        if cmd == "SET_ACTIVITY" { sent = "!".into(); again = Some(Instant::now() + Duration::from_secs(15)); }
                    }
                }
            }
            m = rx.recv() => match m { Some(a) => *want = a, None => return ready },
            _ = tokio::time::sleep_until(due.unwrap_or(far)), if due.is_some() => {
                last_at = Some(Instant::now()); again = None; sent = j;
                let args = match want { Some(a) => json!({ "pid": pid, "activity": a }), None => json!({ "pid": pid }) };
                if c.write_all(&frame(1, &json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce() }))).await.is_err() { return ready; }
            }
            _ = tokio::time::sleep_until(dead), if !ready => return false,
        }
    }
}
