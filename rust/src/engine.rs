//! 🧪 App 測試版 → App 版本: back to the Electron app (desktop/), the mirror of desktop/main.js toRust(). The player does nothing and stays who they
//! were: this app's signed-in page makes a one-time sign-in code (/api/auth/app/code, 2 min, once) and hands it, with the room, to the Electron app
//! in ITS config.json (desktop/main.js engineHandoff reads them before its first page; its device id was never changed). Then the Electron app is
//! installed silently and started (Windows: KRoom-Setup.exe /S --force-run; a Mac: this K ROOM.app is replaced in place by Electron's), and this one
//! quits. Needs an Electron release that reads the handoff (1.0.16 and later): GitHub's "latest" release (the Rust ones are pre-releases).
use crate::{config, shell, App};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const ELECTRON_ASSET: &str = "KRoom-Setup.exe";
#[cfg(not(windows))]
const ELECTRON_ASSET: &str = "KRoom-mac.zip";

fn electron_url() -> String {
    format!("https://github.com/{}/releases/latest/download/{ELECTRON_ASSET}", crate::updates::REPO)
}

async fn download(url: &str) -> Option<Vec<u8>> {
    let r = reqwest::Client::builder().user_agent("kroom-desktop").timeout(Duration::from_secs(900)).build().ok()?.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let b = r.bytes().await.ok()?.to_vec();
    (b.len() > 1_000_000).then_some(b) // (a real file, not an error page)
}

/// the K ROOM page in the main window, if that is what it shows
fn page(app: &Arc<App>) -> Option<tauri::WebviewWindow> {
    shell::main_window(app).filter(|w| w.url().map(|u| app.is_app(u.as_str())).unwrap_or(false))
}

/// is the page signed in to an account
async fn signed_in(app: &Arc<App>) -> bool {
    let Some(w) = page(app) else { return false };
    matches!(app.page_value(&w, "fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json()).then((j) => !!(j && j.account)).catch(() => false)", Duration::from_secs(5)).await, Some(Value::Bool(true)))
}

/// a one-time sign-in code (2 min, once) made by the signed-in page → (code, state)
async fn mint(app: &Arc<App>) -> Option<(String, String)> {
    let w = page(app)?;
    let mut b = [0u8; 24];
    let _ = getrandom::fill(&mut b);
    use base64::Engine;
    let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let js = format!("fetch('/api/auth/app/code', {{ method: 'POST', headers: {{ 'content-type': 'application/json' }}, body: JSON.stringify({{ state: {} }}) }}).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.code) || '').catch(() => '')", serde_json::to_string(&state).unwrap());
    match app.page_value(&w, &js, Duration::from_secs(5)).await {
        Some(Value::String(code)) if !code.is_empty() => Some((code, state)),
        _ => None,
    }
}

/// the sign-in code (made now, right before the Electron app starts), the site, the room and the device id, into the Electron app's config.json
async fn handoff(app: &Arc<App>) {
    let Some(dir) = config::electron_dir() else { return };
    let file = dir.join("config.json");
    let mut c: serde_json::Map<String, Value> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    // the same site as here (the Electron app might have been on the other one: the code only works on this one)
    if shell::site_of(&app.origin).is_some() {
        c.insert("url".into(), json!(app.origin));
    }
    if let Some(w) = page(app) {
        {
            if let Some((code, state)) = mint(app).await {
                c.insert("handoff".into(), json!({ "code": code, "state": state, "origin": app.origin, "at": shell::now_ms() }));
            }
            if let Some(Value::String(rec)) = app.page_value(&w, "(() => { try { return sessionStorage.getItem('ktv.rejoin'); } catch { return null; } })()", Duration::from_secs(2)).await {
                c.insert("rejoin".into(), json!({ "rec": rec, "saved": shell::now_ms() }));
            }
        }
    }
    // the device id: the same in both, whatever the order of switching
    if !c.contains_key("hwId") {
        if let Some(h) = config::config().get("hwId") {
            c.insert("hwId".into(), h.clone());
        }
    }
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string_pretty(&Value::Object(c)) {
        let _ = std::fs::write(file, s);
    }
}

/// run a program with no window and wait for it; true when it ended well
#[cfg(windows)]
fn hidden(exe: &std::path::Path, args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new(exe).args(args).creation_flags(0x0800_0000).status().map(|s| s.success()).unwrap_or(false)
}

/// the installed Electron app: its folder is in its uninstall entry ("…\Uninstall K ROOM.exe"); else electron-builder's per-user default
#[cfg(windows)]
fn electron_exe() -> Option<std::path::PathBuf> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall", "/s", "/f", "Uninstall K ROOM.exe", "/d"])
        .creation_flags(0x0800_0000)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let from_reg = parse_uninstall(&out);
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    from_reg.into_iter()
        .chain(local.iter().flat_map(|l| [l.join("Programs").join("K ROOM").join("K ROOM.exe"), l.join("Programs").join("kroom-desktop").join("K ROOM.exe")]))
        .find(|p| p.is_file())
}

/// `reg query` output → the Electron app's exe next to its uninstaller
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_uninstall(out: &str) -> Option<std::path::PathBuf> {
    out.lines().filter(|l| l.trim_start().starts_with("UninstallString")).find_map(|l| {
        let v = l.split("REG_SZ").nth(1)?.trim().trim_start_matches('"');
        let i = v.find("Uninstall K ROOM.exe")?;
        Some(std::path::PathBuf::from(&v[..i]).join("K ROOM.exe"))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_electron_exe() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1d7a\r\n    UninstallString    REG_SZ    \"C:\\Users\\A B\\AppData\\Local\\Programs\\K ROOM\\Uninstall K ROOM.exe\" /currentuser\r\n";
        assert_eq!(super::parse_uninstall(out).unwrap(), std::path::PathBuf::from(r"C:\Users\A B\AppData\Local\Programs\K ROOM\K ROOM.exe"));
    }
}

/// the "K ROOM" shortcuts (desktop, Start menu) open the Electron app again (the Rust installer had pointed them here)
#[cfg(windows)]
fn point_shortcuts(exe: &std::path::Path) {
    let ps = format!(
        "$ErrorActionPreference='SilentlyContinue'; $w = New-Object -ComObject WScript.Shell; $e = '{e}'; foreach ($p in @([Environment]::GetFolderPath('Desktop') + '\\K ROOM.lnk', [Environment]::GetFolderPath('Programs') + '\\K ROOM.lnk')) {{ if (Test-Path -LiteralPath $p) {{ $l = $w.CreateShortcut($p); $l.TargetPath = $e; $l.WorkingDirectory = (Split-Path $e); $l.IconLocation = $e + ',0'; $l.Save() }} }}",
        e = exe.display().to_string().replace('\'', "''")
    );
    let _ = hidden(std::path::Path::new("powershell"), &["-NoProfile", "-NonInteractive", "-Command", &ps]);
}

fn fail(h: &AppHandle, app: &Arc<App>, error: &str) -> Value {
    app.switching.store(false, Ordering::SeqCst);
    if let Some(w) = h.get_webview_window("main") {
        let _ = w.show();
    }
    json!({ "ok": false, "error": error })
}

pub async fn to_electron(h: &AppHandle, app: &Arc<App>) -> Value {
    if app.switching.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return json!({ "ok": false, "error": "busy" }); // (one switch at a time)
    }
    // signed in, but no sign-in code can be made (offline, the server busy): this app stays, nobody is signed out by a switch
    if signed_in(app).await && mint(app).await.is_none() {
        return fail(h, app, "signin");
    }
    let Some(bytes) = download(&electron_url()).await else { return fail(h, app, "download") };
    let tmp = std::env::temp_dir().join(format!("kroom-electron-{}", shell::now_ms()));
    let _ = std::fs::create_dir_all(&tmp);
    let file = tmp.join(ELECTRON_ASSET);
    if std::fs::write(&file, &bytes).is_err() {
        return fail(h, app, "write");
    }
    if let Some(w) = h.get_webview_window("main") {
        shell::save_window(&w);
    }

    #[cfg(windows)]
    {
        if !bytes.starts_with(b"MZ") {
            return fail(h, app, "download");
        }
        if let Some(w) = h.get_webview_window("main") {
            let _ = w.hide(); // (the player sees the Electron app appear, nothing in between)
        }
        // electron-builder's one-click installer, silent (/S). Not --force-run: that starts the Start-menu shortcut, which the Rust installer had
        // pointed at this app (and electron-builder keeps an existing shortcut as it is)
        let f = file.clone();
        let ok = tauri::async_runtime::spawn_blocking(move || hidden(&f, &["/S"])).await.unwrap_or(false);
        let Some(exe) = (if ok { electron_exe() } else { None }) else { return fail(h, app, "install") };
        point_shortcuts(&exe);
        handoff(app).await; // (now: the sign-in code lasts 2 minutes)
        if std::process::Command::new(&exe).spawn().is_err() {
            return fail(h, app, "start");
        }
    }

    #[cfg(target_os = "macos")]
    {
        // the bundle this app runs from (…/K ROOM.app) is replaced by Electron's (both are "K ROOM.app"), as an update would
        let Some(bundle) = std::env::current_exe().ok().and_then(|e| e.ancestors().nth(3).map(|p| p.to_path_buf())).filter(|b| b.extension().is_some_and(|x| x == "app")) else {
            return fail(h, app, "bundle");
        };
        let fresh = tmp.join("K ROOM.app");
        let unpacked = std::process::Command::new("ditto").args(["-x", "-k"]).arg(&file).arg(&tmp).status().map(|s| s.success()).unwrap_or(false);
        if !unpacked || !fresh.join("Contents/Info.plist").exists() {
            return fail(h, app, "unpack");
        }
        let old = bundle.with_extension("app.rust-old");
        let _ = std::fs::remove_dir_all(&old);
        if std::fs::rename(&bundle, &old).is_err() {
            return fail(h, app, "replace");
        }
        if !std::process::Command::new("ditto").arg(&fresh).arg(&bundle).status().map(|s| s.success()).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(&bundle);
            let _ = std::fs::rename(&old, &bundle);
            return fail(h, app, "replace");
        }
        handoff(app).await; // (now: the sign-in code lasts 2 minutes)
        let script = format!("sleep 1; open -n \"{}\"; sleep 20; rm -rf \"{}\" \"{}\"", bundle.display(), old.display(), tmp.display());
        let _ = std::process::Command::new("/bin/sh").args(["-c", &script]).spawn();
    }

    let h = h.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        h.exit(0);
    });
    json!({ "ok": true })
}
