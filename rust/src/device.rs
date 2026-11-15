//! The device id (desktop/main.js): from the hardware — the SMBIOS system UUID, else the motherboard serial, else the BIOS serial (a Mac: the
//! IOPlatformUUID, else the serial number); Windows' MachineGuid only without any of those; last a random one kept in config.json. Never sent as it
//! is: sha256("kroom-device:" + source), shaped like a UUID — the same ids the Electron app made, so the admin panel sees the same device.
//! The id found last time (config.json hwId) is used at once; the hardware is read again in the background and a different answer is kept for next time.
use crate::config;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::process::Command;
use std::time::Duration;

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 36
        && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(c) })
}

pub fn to_id(src: &str) -> String {
    let h: String = Sha256::digest(format!("kroom-device:{src}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// the placeholders makers leave (main.js JUNK) — and any value that is one character repeated
fn junk(v: &str) -> bool {
    let l = v.trim().to_lowercase();
    const WORDS: &[&str] = &[
        "", "none", "null", "n/a", "na", "default string", "to be filled by o.e.m.", "to be filled by o.e.m", "not applicable", "not specified",
        "system serial number", "base board serial number", "chassis serial number", "serial number", "123456789", "0123456789", "1234567890",
        "03000200-0400-0500-0006-000700080009",
    ];
    if WORDS.contains(&l.as_str()) {
        return true;
    }
    let hex: String = l.chars().filter(|c| *c != '-').collect();
    if hex.chars().all(|c| c == '0') || hex.chars().all(|c| c == 'f') {
        return true;
    }
    // [0-9a-f]{8}-?0000-?0000-?0000-?000000000000
    if hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) && hex[8..].chars().all(|c| c == '0') {
        return true;
    }
    let mut cs = hex.chars();
    match cs.next() {
        Some(first) => cs.all(|c| c == first),
        None => true,
    }
}

fn run(cmd: &mut Command) -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let (tx, rx) = std::sync::mpsc::channel();
    let child = cmd.stdout(std::process::Stdio::piped()).spawn();
    let Ok(child) = child else { return String::new() };
    let id = child.id();
    std::thread::spawn(move || {
        let out = child.wait_with_output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let _ = tx.send(out);
    });
    rx.recv_timeout(Duration::from_secs(8)).unwrap_or_else(|_| {
        kill(id);
        String::new()
    })
}

fn kill(pid: u32) {
    #[cfg(windows)]
    let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

fn read_hardware() -> Vec<(&'static str, String)> {
    #[cfg(target_os = "macos")]
    {
        let out = run(Command::new("ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]));
        let get = |k: &str| -> String {
            let pat = format!("\"{k}\"");
            out.lines()
                .find(|l| l.contains(&pat))
                .and_then(|l| l.split('=').nth(1))
                .map(|v| v.trim().trim_matches('"').to_string())
                .unwrap_or_default()
        };
        return vec![("uuid", get("IOPlatformUUID")), ("board", get("IOPlatformSerialNumber"))];
    }
    #[cfg(windows)]
    {
        const PS: &str = "$ErrorActionPreference='SilentlyContinue'; 'uuid=' + (Get-CimInstance Win32_ComputerSystemProduct).UUID; 'board=' + (Get-CimInstance Win32_BaseBoard).SerialNumber; 'bios=' + (Get-CimInstance Win32_BIOS).SerialNumber";
        let out = run(Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", PS]));
        let mut v = Vec::new();
        for k in ["uuid", "board", "bios"] {
            let val = out.lines().find_map(|l| l.trim().strip_prefix(&format!("{k}=")).map(|s| s.trim().to_string())).unwrap_or_default();
            v.push((k, val));
        }
        return v;
    }
    #[allow(unreachable_code)]
    Vec::new()
}

#[cfg(windows)]
fn machine_guid() -> Option<String> {
    let out = run(Command::new("reg").args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"]));
    let line = out.lines().find(|l| l.contains("MachineGuid"))?;
    let g = line.split_whitespace().last()?.to_lowercase();
    (g.len() >= 20 && g.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then_some(g)
}

/// read the hardware now (0.5–2 s); keeps the answer in config.json
pub fn read_now() -> String {
    let v = read_hardware();
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut id = v.iter().find(|(_, val)| !junk(val)).map(|(k, val)| to_id(&format!("{k}:{}", val.to_lowercase()))).unwrap_or_default();
    #[cfg(windows)]
    if id.is_empty() {
        if let Some(g) = machine_guid() {
            id = to_id(&g);
        }
    }
    let c = config::config();
    if !id.is_empty() {
        if c.get("hwId").and_then(Value::as_str) != Some(id.as_str()) {
            config::set(&[("hwId", Value::String(id.clone()))]);
        }
        return id;
    }
    let kept = c.get("deviceId").and_then(Value::as_str).unwrap_or("");
    if (8..=64).contains(&kept.len()) && kept.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        return kept.to_string();
    }
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let r = format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]);
    config::set(&[("deviceId", Value::String(r.clone()))]);
    r
}

/// the id for this run: the cached one at once (and the hardware read again in the background), else read now
pub fn get() -> String {
    let cached = config::config().get("hwId").and_then(Value::as_str).map(str::to_string).filter(|h| is_uuid(h));
    match cached {
        Some(h) => {
            std::thread::spawn(read_now); // (a different answer — another motherboard — is kept for the next start)
            h
        }
        None => read_now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_ids_as_electron() {
        // the Electron app's id for the same source (desktop/main.js toId, computed with node)
        assert_eq!(to_id("uuid:4c4c4544-0042-3510-8051-b4c04f4b4e32"), "d5daa2f1-170a-e441-45a2-b72fb0c0cc95");
        assert!(junk("To be filled by O.E.M."));
        assert!(junk("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"));
        assert!(junk("12345678-0000-0000-0000-000000000000"));
        assert!(junk("aaaa"));
        assert!(!junk("4C4C4544-0042-3510-8051-B4C04F4B4E32"));
    }
}
