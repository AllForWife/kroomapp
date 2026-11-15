//! What the K ROOM page can ask of the app (js/bridge.js → window.kroomApp). Only the K ROOM site gets an answer: the capability lets only its
//! addresses call these at all (capabilities/default.json), and each one checks again that the asking page is on the site (Electron fromSite).
use crate::{config, engine, shell, updates, App};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State, Webview};

type S<'a> = State<'a, Arc<App>>;

fn from_site(w: &Webview, app: &App) -> bool {
    w.url().map(|u| app.is_app(u.as_str())).unwrap_or(false)
}
/// only the main window's own page (not a same-site popup)
fn from_main(w: &Webview, app: &App) -> bool {
    w.label() == "main" && from_site(w, app)
}

#[tauri::command]
pub fn login_with_browser(webview: Webview, app: S, h: AppHandle) -> bool {
    from_site(&webview, &app) && shell::handoff(&h, &app, "login")
}

#[tauri::command]
pub fn get_display(webview: Webview, app: S) -> Value {
    if !from_site(&webview, &app) {
        return Value::Null;
    }
    let c = config::config();
    let mut d = json!({ "unlockFps": cfg!(windows) && config::flag(&c, "unlockFps"), "version": app.version });
    if !app.steam {
        d["betaUpdates"] = json!(config::flag(&c, "betaUpdates"));
    }
    d
}

#[tauri::command]
pub fn set_beta(webview: Webview, app: S, h: AppHandle, on: bool) -> bool {
    if !from_site(&webview, &app) || app.steam {
        return false;
    }
    config::set(&[("betaUpdates", json!(on))]);
    if on {
        updates::check_soon(&h, &app);
    }
    true
}

#[tauri::command]
pub fn set_unlock_fps(webview: Webview, app: S, on: bool) -> bool {
    if !from_site(&webview, &app) || !cfg!(windows) {
        return false;
    }
    config::set(&[("unlockFps", json!(on))]);
    true
}

/// a restart back into the same room (the page handed its room record over first: keep_room)
#[tauri::command]
pub fn relaunch(webview: Webview, app: S, h: AppHandle) {
    if from_site(&webview, &app) {
        shell::relaunch(&h, &app, &[]);
    }
}

#[tauri::command]
pub fn get_sites(webview: Webview, app: S) -> Value {
    if !from_site(&webview, &app) || app.steam {
        return Value::Null;
    }
    let sites: serde_json::Map<String, Value> = shell::SITES.iter().map(|(k, o)| ((*k).to_string(), json!(o))).collect();
    json!({ "current": shell::site_of(&app.origin).unwrap_or("custom"), "sites": sites })
}

#[tauri::command]
pub fn set_site(webview: Webview, app: S, h: AppHandle, key: String) -> bool {
    if !from_site(&webview, &app) || app.steam {
        return false;
    }
    let Some((_, o)) = shell::SITES.iter().find(|(k, _)| *k == key) else { return false };
    if *o == app.origin {
        return false;
    }
    shell::switch_site(&h, &app, o, None);
    true
}

#[tauri::command]
pub fn set_awake(webview: Webview, app: S, on: bool) -> bool {
    if !from_site(&webview, &app) {
        return false;
    }
    app.stay_awake(on);
    true
}

#[tauri::command]
pub fn set_presence(webview: Webview, app: S, p: Value) -> bool {
    if !from_main(&webview, &app) || app.discord.lock().unwrap().is_none() {
        return false;
    }
    app.presence(shell::presence_activity(&app.origin, &p));
    true
}

#[tauri::command]
pub async fn steam_ticket(webview: Webview, app: S<'_>) -> Result<String, ()> {
    if !app.steam || !from_site(&webview, &app) {
        return Ok(String::new());
    }
    let a = app.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || a.steamworks.as_ref().map(|s| s.ticket()).unwrap_or_default()).await.unwrap_or_default())
}

#[tauri::command]
pub fn steam_id(webview: Webview, app: S) -> String {
    if !app.steam || !from_site(&webview, &app) {
        return String::new();
    }
    app.steamworks.as_ref().map(|s| s.steam_id()).unwrap_or_default()
}

/// the page's room record (sessionStorage ktv.rejoin), kept on disk for the next start — once, within 10 minutes (js/bridge.js KEPT)
#[tauri::command]
pub fn keep_room(webview: Webview, app: S, rec: Option<String>) -> bool {
    if !from_site(&webview, &app) {
        return false;
    }
    match rec.filter(|r| !r.is_empty() && r.len() <= 64 * 1024) {
        Some(r) => config::set(&[("rejoin", json!({ "rec": r, "saved": shell::now_ms() }))]),
        None => config::set(&[("rejoin", Value::Null)]),
    }
    true
}

/// an off-site link the page's bridge caught (a Mac: see shell::nav_guard)
#[tauri::command]
pub fn open_external(webview: Webview, app: S, h: AppHandle, url: String) -> bool {
    if !from_site(&webview, &app) {
        return false;
    }
    shell::open_outside(&h, &url);
    true
}

/// the answer to App::page_value
#[tauri::command]
pub fn js_result(webview: Webview, app: S, id: u64, v: Value) {
    if from_site(&webview, &app) {
        if let Some(tx) = app.js_wait.lock().unwrap().remove(&id) {
            let _ = tx.send(v);
        }
    }
}

/// 🧪 which app this is (rust / electron) and which ones can be switched to (the tablet's App 測試版 shows it to admins)
#[tauri::command]
pub fn get_engine(webview: Webview, app: S) -> Value {
    if !from_site(&webview, &app) || app.steam {
        return Value::Null;
    }
    json!({ "current": "rust", "engines": ["electron", "rust"] })
}

#[tauri::command]
pub async fn set_engine(webview: Webview, app: S<'_>, h: AppHandle, engine: String) -> Result<Value, ()> {
    if !from_site(&webview, &app) || app.steam || engine != "electron" {
        return Ok(json!({ "ok": false }));
    }
    Ok(engine::to_electron(&h, app.inner()).await)
}
