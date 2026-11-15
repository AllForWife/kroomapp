//! config.json / window.json in the app's data folder (the same keys the Electron app used), and the one-time move from the Electron app's folder.
use serde_json::{Map, Value};
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// the Electron app's userData folder (productName "K ROOM")
pub fn electron_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    return std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("K ROOM"));
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/K ROOM"));
    #[allow(unreachable_code)]
    None
}

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DIR.set(dir);
    // first start after the Electron app: its settings come along — the site, unlock fps, beta, the window's place, and above all the device id
    // (hwId / deviceId: the admin panel must see the same device). Merged once, key by key: what this app already has (the Electron app's
    // engine-switch handoff writes config.json before this app's first start) is kept
    if let Some(old) = electron_dir() {
        for f in ["config.json", "window.json"] {
            let mut mine = read(f);
            if mine.contains_key("fromElectron") {
                continue;
            }
            if let Some(Value::Object(theirs)) = std::fs::read_to_string(old.join(f)).ok().and_then(|s| serde_json::from_str(&s).ok()) {
                for (k, v) in theirs {
                    mine.entry(k).or_insert(v);
                }
            }
            mine.insert("fromElectron".into(), Value::Bool(true));
            write(f, &mine);
        }
    }
}

/// Windows: the Electron app's localStorage (the page's settings: ktv.*) is copied into the new WebView2 profile once, before WebView2 first starts —
/// both are Chromium's LevelDB. The Electron folder is left as it is. (Cookies are not moved: they are sealed with the Electron profile's own key,
/// so a player signs in once again.) A Mac's WKWebView keeps its storage elsewhere in its own format: nothing can be moved there.
#[cfg(windows)]
pub fn migrate_local_storage(webview_data: &Path) {
    let Some(old) = electron_dir() else { return };
    let from = old.join("Local Storage");
    if !from.is_dir() || webview_data.join("EBWebView").exists() {
        return;
    }
    let to = webview_data.join("EBWebView").join("Default").join("Local Storage");
    if copy_dir(&from, &to).is_err() {
        let _ = std::fs::remove_dir_all(&to);
    }
}

#[cfg(windows)]
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        if name == "LOCK" {
            continue;
        }
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to.join(&name))?;
        } else {
            std::fs::copy(e.path(), to.join(&name))?;
        }
    }
    Ok(())
}

fn path(name: &str) -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| PathBuf::from(".")).join(name)
}

pub fn read(name: &str) -> Map<String, Value> {
    std::fs::read_to_string(path(name))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn write(name: &str, m: &Map<String, Value>) {
    if let Ok(s) = serde_json::to_string_pretty(m) {
        let _ = std::fs::write(path(name), s); // (a read-only profile: not remembered)
    }
}

pub fn config() -> Map<String, Value> {
    read("config.json")
}

/// change some keys of config.json (the rest is kept)
pub fn set(kv: &[(&str, Value)]) {
    let mut c = config();
    for (k, v) in kv {
        if v.is_null() {
            c.remove(*k);
        } else {
            c.insert((*k).to_string(), v.clone());
        }
    }
    write("config.json", &c);
}

pub fn flag(c: &Map<String, Value>, k: &str) -> bool {
    c.get(k).and_then(Value::as_bool).unwrap_or(false)
}

