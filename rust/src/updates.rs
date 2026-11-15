//! Updates (desktop/main.js updates()): the installed app checks GitHub releases at start and every 4 hours, downloads a newer version in the
//! background, and installs it when the app closes — or right away, if the player says so (back into the same room). The Steam build: none.
//! Rust releases are tagged vX.Y.Z-rust.N (a prerelease channel "rust", which the Electron app's updater skips) and carry latest.json
//! (tauri-plugin-updater, signed with the key in TAURI_SIGNING_PRIVATE_KEY). Which release: the newest one with a latest.json.
use crate::{config, shell, App};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::MessageDialogKind;
use tauri_plugin_updater::UpdaterExt;

pub const REPO: &str = "AllForWife/kroomapp";

pub fn enabled(app: &App) -> bool {
    !app.steam && !cfg!(debug_assertions) && std::env::var_os("KROOM_NO_UPDATE").is_none()
}

pub fn start(h: &AppHandle, app: &Arc<App>) {
    if !enabled(app) {
        return;
    }
    let (h, app) = (h.clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = check(&h, &app).await {
                eprintln!("update {e}"); // (offline, GitHub busy…: try again next time)
            }
            tokio::time::sleep(Duration::from_secs(4 * 3600)).await;
        }
    });
}

/// 🧪 App 測試版 just switched on: look now
pub fn check_soon(h: &AppHandle, app: &Arc<App>) {
    if !enabled(app) {
        return;
    }
    let (h, app) = (h.clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        let _ = check(&h, &app).await;
    });
}

/// the newest release (prereleases too) that has a latest.json — GitHub's API lists the newest first
pub async fn newest_release(asset: &str, want: impl Fn(&str) -> bool) -> Result<String, String> {
    let r = reqwest::Client::builder()
        .user_agent("kroom-desktop")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=30"))
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let list: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    for rel in list.as_array().into_iter().flatten() {
        if rel["draft"].as_bool().unwrap_or(false) || !want(rel["tag_name"].as_str().unwrap_or("")) {
            continue;
        }
        for a in rel["assets"].as_array().into_iter().flatten() {
            if a["name"].as_str() == Some(asset) {
                if let Some(u) = a["browser_download_url"].as_str() {
                    return Ok(u.to_string());
                }
            }
        }
    }
    Err(format!("no release with {asset}"))
}

async fn check(h: &AppHandle, app: &Arc<App>) -> Result<(), String> {
    if app.update.lock().unwrap().is_some() {
        return Ok(()); // (one is downloaded and waits for the app to close)
    }
    // a normal install takes only the newest normal release; a prerelease install (every Rust build for now) or 🧪 App 測試版 also takes prereleases
    let beta = app.version.contains('-') || config::flag(&config::config(), "betaUpdates");
    let endpoint = if beta {
        newest_release("latest.json", |_| true).await?
    } else {
        format!("https://github.com/{REPO}/releases/latest/download/latest.json")
    };
    let updater = h
        .updater_builder()
        .endpoints(vec![tauri::Url::parse(&endpoint).map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
    let version = update.version.clone();
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    *app.update.lock().unwrap() = Some((update, bytes));
    let w = h.get_webview_window("main");
    let now = shell::ask(
        h,
        w.as_ref(),
        &format!("新版本 {version} 已經下載好了"),
        "現在重新啟動就會更新；選「稍後」的話，下次關閉 App 時自動更新。",
        "現在重新啟動",
        "稍後",
        MessageDialogKind::Info,
    )
    .await;
    if now {
        if let Some(w) = &w {
            shell::keep_room(app, w).await;
        }
        install_now(h, app, true);
    }
    Ok(())
}

/// install the downloaded update (Windows: the installer takes over and this process ends; a Mac: the app is replaced in place). restart: start it
pub fn install_now(h: &AppHandle, app: &Arc<App>, restart: bool) {
    if app.switching.load(std::sync::atomic::Ordering::SeqCst) {
        return; // (the Electron app is being installed: no second installer)
    }
    let Some((update, bytes)) = app.update.lock().unwrap().take() else { return };
    if let Some(w) = h.get_webview_window("main") {
        shell::save_window(&w); // (Windows: the installer ends this process — no close event comes)
    }
    let update = update.restart_after_install(restart);
    match update.install(&bytes) {
        Ok(()) => {
            if restart {
                h.restart();
            }
        }
        Err(e) => eprintln!("update install {e}"),
    }
}
