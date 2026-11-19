//! The window and everything around it: popups and navigation, kroom:// links (用瀏覽器登入, admin login, 用 App 開啟), Discord invites, the app's
//! keys, a crashed or unreachable page, restarts. desktop/main.js, piece by piece.
use crate::{config, App};
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

pub const SITES: [(&str, &str); 2] = [("main", "https://play.kroom.tw"), ("test", "https://ktv2.548754321.xyz")];
pub const DEFAULT_URL: &str = "https://play.kroom.tw";
pub const OLD_MAIN: &str = "https://ktv.548712345.xyz";
const LOGIN_MS: u64 = 10 * 60_000;

pub fn origin_of(u: &str) -> String {
    Url::parse(u).map(|u| u.origin().ascii_serialization()).unwrap_or_default()
}
pub fn site_of(origin: &str) -> Option<&'static str> {
    SITES.iter().find(|(_, o)| *o == origin).map(|(k, _)| *k)
}
pub fn is_google_auth(u: &str) -> bool {
    Url::parse(u).ok().and_then(|u| u.host_str().map(str::to_string)).is_some_and(|h| h == "accounts.google.com" || h == "accounts.youtube.com" || h.ends_with(".google.com"))
}
/// the app's own pages (the offline page)
pub fn is_local(u: &str) -> bool {
    u.starts_with("tauri://localhost") || u.starts_with("http://tauri.localhost") || u.starts_with("https://tauri.localhost") || u == "about:blank"
}
pub fn with_store(href: &str) -> String {
    match Url::parse(href) {
        Ok(mut u) => {
            let rest: Vec<(String, String)> = u.query_pairs().filter(|(k, _)| k != "store").map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
            u.query_pairs_mut().clear().extend_pairs(rest).append_pair("store", "1");
            u.to_string()
        }
        Err(_) => href.to_string(),
    }
}
fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

pub fn open_outside(app: &AppHandle, u: &str) {
    let l = u.to_ascii_lowercase();
    if l.starts_with("http://") || l.starts_with("https://") {
        let _ = app.opener().open_url(u, None::<&str>);
    }
}

/// the room names the entry screen allows (src/ui/hud.ts: ^[\w一-鿿-]{1,20}$)
pub fn room_ok(r: &str) -> bool {
    let n = r.chars().count();
    (1..=20).contains(&n) && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || ('\u{4e00}'..='\u{9fff}').contains(&c))
}

fn main_win(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// the main window, from the app state (engine.rs)
pub fn main_window(app: &Arc<App>) -> Option<WebviewWindow> {
    app.handle.get().and_then(|h| h.get_webview_window("main"))
}

fn focus(w: &WebviewWindow) {
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    let _ = w.show();
    let _ = w.set_focus();
}

fn navigate(w: &WebviewWindow, u: &str) {
    if let Ok(u) = Url::parse(u) {
        let _ = w.navigate(u);
    }
}

/* ---------------------------------------------------------------- the window */

fn ua(app: &App) -> String {
    let v = &app.version;
    // KRoomDesktop/<v>: the desktop app (what the site and the server already look for); KRoomRust/<v>: this Rust version of it
    let marks = format!(" KRoomDesktop/{v} KRoomRust/{v}{}", if app.steam { format!(" KRoomSteam/{v}") } else { String::new() });
    #[cfg(windows)]
    {
        let m = crate::win::runtime_major().unwrap_or_else(|| "142".into());
        return format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{m}.0.0.0 Safari/537.36 Edg/{m}.0.0.0{marks}");
    }
    #[cfg(target_os = "macos")]
    {
        // Google refuses to sign in inside a webview it recognises by the user agent: WKWebView's own one has no "Version/… Safari/…"
        let safari = match crate::macos_major() { 0..=11 => 15, 12 => 15, 13 => 16, 14 => 17, 15 => 18, n => n };
        return format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{safari}.0 Safari/605.1.15{marks}");
    }
    #[allow(unreachable_code)]
    marks
}

fn scripts(app: &App, kept: &Value) -> (String, String) {
    let o = serde_json::to_string(&app.origin).unwrap();
    let flags = json!({ "steam": app.steam, "steamUser": app.steamworks.is_some(), "canUnlock": cfg!(windows) });
    let bridge = include_str!("../js/bridge.js")
        .replace("__KROOM_ORIGIN__", &o)
        .replace("__KROOM_DEVICE__", &serde_json::to_string(&app.device).unwrap())
        .replace("__KROOM_FLAGS__", &flags.to_string())
        .replace("__KROOM_KEPT__", &kept.to_string());
    let frames = include_str!("../js/frames.js")
        .replace("__KROOM_ORIGIN__", &o)
        .replace("/* @@KEYSHIFT@@ */", include_str!("../js/keyshift.gen.js"));
    (bridge, frames)
}

/// where the window was last time — only when that place is still on a screen (a monitor unplugged since: nobody would see the window)
fn saved_place(h: &AppHandle) -> (f64, f64, Option<(f64, f64)>, bool) {
    let st = config::read("window.json");
    let num = |k: &str| st.get(k).and_then(Value::as_f64);
    let (w, hh) = (num("width").unwrap_or(1280.0).max(640.0), num("height").unwrap_or(800.0).max(400.0));
    let mut pos = None;
    if let (Some(x), Some(y)) = (num("x"), num("y")) {
        let on_screen = h.available_monitors().unwrap_or_default().iter().any(|m| {
            let s = m.scale_factor();
            let a = m.work_area();
            let (ax, ay, aw, ah) = (a.position.x as f64 / s, a.position.y as f64 / s, a.size.width as f64 / s, a.size.height as f64 / s);
            x + 120.0 <= ax + aw && x + w - 120.0 >= ax && y >= ay - 8.0 && y + 40.0 <= ay + ah
        });
        if on_screen {
            pos = Some((x, y));
        }
    }
    (w, hh, pos, st.get("maximized").and_then(Value::as_bool).unwrap_or(false))
}

pub fn create_window(h: &AppHandle, app: &Arc<App>, kept: &Value) -> tauri::Result<WebviewWindow> {
    let (bridge, frames) = scripts(app, kept);
    let first = { std::mem::take(&mut *app.join_url.lock().unwrap()) };
    let url = Url::parse(if first.is_empty() { &app.start } else { &first }).unwrap_or_else(|_| Url::parse(DEFAULT_URL).unwrap());
    let (w, hh, pos, maximized) = saved_place(h);
    let mut b = WebviewWindowBuilder::new(h, "main", WebviewUrl::External(url))
        .title("K ROOM")
        .inner_size(w, hh)
        .min_inner_size(640.0, 400.0)
        .maximized(maximized)
        .background_color(tauri::window::Color(7, 6, 13, 255))
        .user_agent(&ua(app))
        .initialization_script(bridge.clone())
        .initialization_script_for_all_frames(frames.clone())
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .disable_drag_drop_handler() // (the page's own HTML5 drag and drop works, as in Electron)
        .on_navigation(nav_guard(h.clone(), app.clone()))
        .on_new_window(new_window(h.clone(), app.clone(), bridge, frames));
    if let Some((x, y)) = pos {
        b = b.position(x, y);
    }
    #[cfg(windows)]
    {
        // Electron's command-line switches, for WebView2: autoplay without a click, no throttling in the background, the fast GPU;
        // ⚙ 解除螢幕更新率限制 (read at start)
        let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --force_high_performance_gpu");
        if config::flag(&config::config(), "unlockFps") {
            args.push_str(" --disable-frame-rate-limit --disable-gpu-vsync");
        }
        // 🥽 VTuber 的 VR（vr.rs）：允許了才打開 WebXR／OpenXR
        args.push_str(crate::vr::browser_args());
        // tests (tests/app-e2e.mjs): the page can be driven over the DevTools protocol — an unpackaged (debug) build only
        if cfg!(debug_assertions) || cfg!(feature = "devport") {
            if let Some(p) = std::env::var("KROOM_DEBUG_PORT").ok().filter(|p| p.chars().all(|c| c.is_ascii_digit())) {
                args.push_str(&format!(" --remote-debugging-port={p}"));
            }
        }
        b = b.additional_browser_args(&args);
    }
    let a = app.clone();
    b = b.on_page_load(move |w, p| match p.event() {
        // 🎮 a new page (leaving the room, F5, an invite…): the old room comes off the Discord profile until the new page says what to show;
        // 🌙 the new page asks for "awake" again once its song plays
        PageLoadEvent::Started | PageLoadEvent::Finished if cfg!(target_os = "macos") && off_site(&a, p.url().as_str()) => {
            open_outside(w.app_handle(), p.url().as_str());
            let back = a.last_app_url.lock().unwrap().clone();
            navigate(&w, if back.is_empty() { &a.start } else { &back });
        }
        PageLoadEvent::Started => {
            crate::mark(&format!("page started {}", p.url()));
            a.loaded.send_replace(false);
            a.presence(None);
            a.stay_awake(false);
        }
        PageLoadEvent::Finished => {
            crate::mark("page finished");
            if a.is_app(p.url().as_str()) {
                *a.last_app_url.lock().unwrap() = p.url().to_string();
            }
            a.loaded.send_replace(true);
            win_state(&w);
            crate::vr::on_page_finished(&w);   // (🥽 換頁前在 VR 裡：接著回 VR)
        }
    });
    let win = b.build()?;
    #[cfg(windows)]
    crate::win::attach(&win, app.clone());
    #[cfg(target_os = "macos")]
    crate::mac::allow_pointer_lock(&win);
    Ok(win)
}

/// window.json: the window's last normal place (logical px) and whether it was maximised
pub fn save_window(w: &WebviewWindow) {
    let Some(app) = w.app_handle().try_state::<Arc<App>>() else { return };
    let mut st = config::read("window.json");
    if let Some((x, y, wd, ht)) = *app.bounds.lock().unwrap() {
        st.insert("x".into(), json!(x.round()));
        st.insert("y".into(), json!(y.round()));
        st.insert("width".into(), json!(wd.round()));
        st.insert("height".into(), json!(ht.round()));
    }
    st.insert("maximized".into(), json!(w.is_maximized().unwrap_or(false)));
    config::write("window.json", &st);
}

/// the page told whether the window is minimised / in front (it draws less meanwhile, so its voice keeps the CPU it needs)
pub fn win_state(w: &WebviewWindow) {
    let min = w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true);
    let focus = w.is_focused().unwrap_or(false);
    let _ = w.eval(format!("window.__kroomWinState && window.__kroomWinState({{ min: {min}, focus: {focus} }})"));
}

/// a page the window itself may not show (the K ROOM site, Google sign-in and the app's own pages may)
fn off_site(app: &App, u: &str) -> bool {
    (u.starts_with("http://") || u.starts_with("https://")) && !app.is_app(u) && !is_google_auth(u) && !is_local(u)
}

/// Windows: an off-site page in the window opens in the normal browser instead (WebView2 asks only for the window's own page). A Mac's WebKit asks
/// for every frame too and does not say which one: the players' frames must load, so this is done by the page's bridge (js/bridge.js) there.
fn nav_guard(h: AppHandle, app: Arc<App>) -> impl Fn(&Url) -> bool + Send + 'static {
    move |u: &Url| {
        if cfg!(target_os = "macos") {
            return true;
        }
        let s = u.as_str();
        if app.is_app(s) || is_google_auth(s) || is_local(s) || s.starts_with("data:") {
            return true;
        }
        open_outside(&h, s);
        false
    }
}

/// window.open: Google sign-in (popup mode) in a small window of the app (its answer goes back to this window / cookie jar), the K ROOM site in
/// another window of the app, everything else in the normal browser
fn new_window(h: AppHandle, app: Arc<App>, bridge: String, frames: String) -> impl Fn(Url, tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static {
    move |u, features| {
        let s = u.as_str().to_string();
        let google = is_google_auth(&s);
        if !google && !app.is_app(&s) {
            open_outside(&h, &s);
            return NewWindowResponse::Deny;
        }
        let n = app.popups.fetch_add(1, Ordering::SeqCst);
        let mut b = WebviewWindowBuilder::new(&h, format!("popup-{n}"), WebviewUrl::External("about:blank".parse().unwrap()))
            .title("K ROOM")
            .window_features(features)
            .user_agent(&ua(&app))
            .initialization_script(bridge.clone())
            .initialization_script_for_all_frames(frames.clone())
            .on_navigation(nav_guard(h.clone(), app.clone()))
            .on_new_window(new_window(h.clone(), app.clone(), bridge.clone(), frames.clone()))
            .on_document_title_changed(|w, t| {
                let _ = w.set_title(&t);
            });
        // a Mac: the webview's navigation check cannot tell frames apart (nav_guard) — a popup that loads an off-site page sends it to the
        // normal browser and closes (Google sign-in may load in it)
        let a = app.clone();
        b = b.on_page_load(move |w, p| {
            if cfg!(target_os = "macos") && off_site(&a, p.url().as_str()) {
                open_outside(w.app_handle(), p.url().as_str());
                let _ = w.close();
            }
        });
        if google {
            b = b.inner_size(520.0, 680.0);
            if let Some(m) = main_win(&h) {
                if let Ok(bb) = b.parent(&m) {
                    b = bb;
                } else {
                    return NewWindowResponse::Deny;
                }
            }
        }
        match b.build() {
            Ok(window) => NewWindowResponse::Create { window },
            Err(_) => NewWindowResponse::Deny,
        }
    }
}

/* ---------------------------------------------------------------- the app's keys */

#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(windows), allow(dead_code))] // (a Mac: fullscreen is the menu's own item)
pub enum Key {
    Fullscreen,
    Reload,
    DevTools,
    Admin,
    Home,
    Back,
}

/// Windows: F11 / F5, Ctrl+Shift+R / F12, Ctrl+Shift+I / Ctrl+Shift+A / Alt+Home / Alt+← (src/win.rs); a Mac: the menu's ⌘ keys (src/main.rs)
pub fn key(w: &WebviewWindow, app: &Arc<App>, k: Key) {
    match k {
        Key::Fullscreen => {
            let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
        }
        Key::Reload => {
            #[cfg(windows)]
            crate::win::hard_reload(w);
            #[cfg(not(windows))]
            let _ = w.reload();
        }
        Key::DevTools => {
            if w.is_devtools_open() {
                w.close_devtools();
            } else {
                w.open_devtools();
            }
        }
        // admin login through the normal browser (logged in there as an admin → one click there)
        Key::Admin => {
            handoff(w.app_handle(), app, "admin");
        }
        Key::Home => navigate(w, &format!("{}/", app.origin)),
        Key::Back => {
            let _ = w.eval("history.back()");
        }
    }
}

/* ---------------------------------------------------------------- kroom:// links */

/* 用瀏覽器登入: the page asks → the normal browser opens <site>/?applogin=<state> → signed in there, one click makes a one-time code
   (server/accounts.mjs) and opens kroom://login?code=…&state=… → this app gets the link (a second start on Windows, open-url on a Mac) → the
   window opens <site>/api/auth/app/claim?code=…&state=… and gets its own session. Only the state this app just made is accepted.
   The admin login (Ctrl+Shift+A / ⌘⇧A) goes the same way: <site>/admin/applogin?state=… → kroom://admin?… → <site>/admin/appclaim. */
fn handoff_paths(kind: &str) -> Option<(fn(&str) -> String, &'static str)> {
    match kind {
        "login" => Some((|s| format!("/?applogin={s}"), "/api/auth/app/claim")),
        "admin" => Some((|s| format!("/admin/applogin?state={s}"), "/admin/appclaim")),
        _ => None,
    }
}

pub fn handoff(h: &AppHandle, app: &Arc<App>, kind: &'static str) -> bool {
    let Some((start, _)) = handoff_paths(kind) else { return false };
    let mut b = [0u8; 24];
    let _ = getrandom::fill(&mut b);
    let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    app.pending.lock().unwrap().insert(kind, (state.clone(), Instant::now()));
    let url = format!("{}{}", app.origin, start(&state));
    if std::env::var_os("KROOM_TEST_PRINT_LOGIN").is_some() {
        println!("HANDOFF_URL {kind} {url}"); // (tests: the browser is played by the test)
    } else {
        open_outside(h, &url);
    }
    true
}

/// a kroom:// (or discord-<id>://) link given to this app
pub fn deep_link(h: &AppHandle, app: &Arc<App>, raw: &str) {
    let Ok(u) = Url::parse(raw) else { return };
    if !u.scheme().eq_ignore_ascii_case("kroom") {
        return; // (discord-<id>:// only starts the app: the invite itself comes over Discord's IPC — ACTIVITY_JOIN)
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "open" {
        let (h, app) = (h.clone(), app.clone());
        tauri::async_runtime::spawn(async move { open_from_browser(&h, &app, u).await });
        return;
    }
    let q = |k: &str| u.query_pairs().find(|(kk, _)| kk == k).map(|(_, v)| v.into_owned());
    let (Some(state), Some(code)) = (q("state"), q("code")) else { return };
    let Some((_, claim)) = handoff_paths(&host) else { return };
    let kind: &'static str = if host == "login" { "login" } else { "admin" };
    {
        let mut p = app.pending.lock().unwrap();
        let Some((want, at)) = p.get(kind).cloned() else { return };
        if want != state || at.elapsed() > Duration::from_millis(LOGIN_MS) {
            return;
        }
        p.remove(kind);
    }
    if let Some(w) = main_win(h) {
        focus(&w);
        navigate(&w, &format!("{}{claim}?code={}&state={}", app.origin, enc(&code), enc(&state)));
    }
}

/* 🖥 用 App 開啟 on the website (src/ui/openapp.ts): kroom://open?code=…&state=…&rejoin=…&site=… — started in the browser, so there is no pending
   state here: a one-time code the signed-in browser made signs the app in as that account (after the player confirms, unless the app is already
   that account), and the room the browser was in (rejoin, base64url JSON) is handed to the page like after an update restart. */
async fn open_from_browser(h: &AppHandle, app: &Arc<App>, u: Url) {
    let q = |k: &str| u.query_pairs().find(|(kk, _)| kk == k).map(|(_, v)| v.into_owned());
    // the link came from the other K ROOM site: the app moves to that site first and handles the link there (its code only works there)
    if let Some(from) = q("site").filter(|s| !s.is_empty()) {
        if from != app.origin && site_of(&from).is_some() {
            switch_site(h, app, &from, Some(u.as_str()));
            return;
        }
    }
    let Some(w) = main_win(h) else { return };
    focus(&w);
    // the page still loading: waited for (never stuck — 15 s at most)
    let mut rx = app.loaded.subscribe();
    let _ = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|l| *l)).await;
    let mut rec = None;
    let mut room = String::new();
    if let Some(r) = q("rejoin") {
        if let Ok(b) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(r.trim_end_matches('=')) {
            if let Ok(Value::Object(mut j)) = serde_json::from_slice::<Value>(&b) {
                if let Some(rm) = j.get("room").and_then(Value::as_str).filter(|r| r.chars().count() <= 60).map(str::to_string) {
                    j.insert("at".into(), json!(now_ms()));
                    rec = Some(Value::Object(j).to_string());
                    room = rm;
                }
            }
        }
    }
    let (code, state) = (q("code"), q("state"));
    let on_app = || w.url().map(|u| app.is_app(u.as_str())).unwrap_or(false);
    if let (Some(code), Some(state)) = (&code, &state) {
        // whose code it is, asked first (without spending it)
        let peek = format!("{}/api/auth/app/peek?code={}&state={}", app.origin, enc(code), enc(state));
        let name = match reqwest::get(&peek).await {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().map(|j| match &j["name"] { Value::String(s) => s.clone(), Value::Null => String::new(), v => v.to_string() }),
            _ => None,
        };
        let Some(name) = name else { return }; // (a used, expired or made-up code: nothing happens)
        let mine = if on_app() {
            app.page_value(&w, "fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json()).then((j) => (j.account ? j.account.name || '' : null)).catch(() => null)", Duration::from_secs(3))
                .await
                .and_then(|v| v.as_str().map(str::to_string))
        } else {
            None
        };
        if mine.as_deref() != Some(name.as_str()) {
            let who = if name.is_empty() { "（還沒取名字的帳號）".to_string() } else { name.clone() };
            let ok = if let Ok(t) = std::env::var("KROOM_TEST_CONFIRM") {
                println!("CONFIRM_ASKED {who}");
                t == "yes"
            } else {
                let mut detail = String::from("這是從瀏覽器的「用 App 開啟」傳來的。");
                if let Some(m) = &mine {
                    detail.push_str(&format!("App 現在登入的是「{}」，會換成「{who}」。", if m.is_empty() { "（還沒取名字的帳號）" } else { m }));
                }
                if !room.is_empty() {
                    detail.push_str(&format!("登入後會進入房間「{room}」。"));
                }
                detail.push_str("\n如果不是你剛剛在瀏覽器按的，請按「取消」。");
                ask(h, Some(&w), &format!("用「{who}」登入 K ROOM App？"), &detail, "登入並開啟", "取消", MessageDialogKind::Info).await
            };
            if !ok {
                return;
            }
        }
    }
    if let Some(rec) = rec {
        if on_app() {
            let v = json!({ "rec": rec, "saved": now_ms() }).to_string();
            let _ = w.eval(format!("try {{ localStorage.setItem('ktv.rejoin.update', {}); }} catch {{}}", serde_json::to_string(&v).unwrap()));
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    match (code, state) {
        (Some(c), Some(s)) => navigate(&w, &format!("{}/api/auth/app/claim?code={}&state={}", app.origin, enc(&c), enc(&s))),
        _ => navigate(&w, &format!("{}/", app.origin)),
    }
}

/// a two-button question; true for the first button
pub async fn ask(h: &AppHandle, parent: Option<&WebviewWindow>, message: &str, detail: &str, yes: &str, no: &str, kind: MessageDialogKind) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = h.dialog().message(format!("{message}\n\n{detail}")).title("K ROOM").kind(kind).buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()));
    if let Some(p) = parent {
        d = d.parent(p);
    }
    d.show(move |ok| {
        let _ = tx.send(ok);
    });
    rx.await.unwrap_or(false)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/* ---------------------------------------------------------------- Discord invites */

/// a Discord invite accepted on this computer: into that room (the page's ?room= link opens 「進入房間」 with the code filled in)
pub fn discord_join(h: &AppHandle, app: &Arc<App>, secret: &str) {
    if !room_ok(secret) {
        return;
    }
    let url = format!("{}/?room={}", app.origin, enc(secret));
    let go = if app.steam { with_store(&url) } else { url };
    match main_win(h) {
        Some(w) => {
            focus(&w);
            navigate(&w, &go);
        }
        None => *app.join_url.lock().unwrap() = go, // (Discord started the app for it: the window opens there)
    }
}

fn txt(v: &Value, n: usize) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    };
    s.chars().filter(|c| !(('\u{0}'..='\u{1f}').contains(c) || *c == '\u{7f}')).collect::<String>().trim().chars().take(n).collect()
}

/// the activity Discord shows, built by the app (the page can never point a button anywhere but this site) — main.js presenceActivity
pub fn presence_activity(origin: &str, p: &Value) -> Option<Value> {
    let p = p.as_object()?;
    let null = Value::Null;
    let g = |k: &str| p.get(k).unwrap_or(&null);
    let mut a = json!({ "type": 0, "assets": { "large_image": format!("{origin}/icons/icon-512.png"), "large_text": "K ROOM" } });
    let (details, state) = (txt(g("details"), 128), txt(g("state"), 128));
    let room = g("room").as_str().filter(|r| room_ok(r)).unwrap_or("").to_string();
    if details.chars().count() >= 2 {
        a["details"] = json!(details);
    }
    if state.chars().count() >= 2 {
        a["state"] = json!(state);
    }
    if let Some(t) = g("start").as_f64() {
        if t.is_finite() && t > 1e12 && t < (now_ms() + 60_000) as f64 {
            a["timestamps"] = json!({ "start": t.floor() as u64 });
        }
    }
    let truthy = |k: &str| match g(k) { Value::Bool(b) => *b, Value::Null => false, Value::Number(n) => n.as_f64() != Some(0.0), Value::String(s) => !s.is_empty(), _ => true };
    let num = |k: &str| g(k).as_f64().or_else(|| g(k).as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0);
    match g("join").as_str() {
        Some("button") => {
            let label = txt(g("label"), 32);
            if !label.is_empty() {
                let url = if !room.is_empty() && !truthy("hidden") { format!("{origin}/?room={}", enc(&room)) } else { format!("{origin}/") };
                a["buttons"] = json!([{ "label": label, "url": url }]);
            }
        }
        Some("invite") if !room.is_empty() && !truthy("ghost") => {
            let n = num("people").floor().max(1.0);
            let max = num("max").floor().max(n);
            use sha2::Digest;
            let id: String = sha2::Sha256::digest(format!("{origin} {room}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>()[..32].to_string();
            let mut party = json!({ "id": id });
            if max > 1.0 && !truthy("hidden") {
                party["size"] = json!([n as u64, max as u64]);
            }
            a["party"] = party;
            a["secrets"] = json!({ "join": room });
        }
        _ => {}
    }
    Some(a)
}

/* ---------------------------------------------------------------- a page that crashed or cannot be reached */

pub fn show_offline(w: &WebviewWindow, app: &Arc<App>, err: &str) {
    #[cfg(windows)]
    let base = "http://tauri.localhost/offline.html";
    #[cfg(not(windows))]
    let base = "tauri://localhost/offline.html";
    navigate(w, &format!("{base}?url={}&err={}", enc(&app.start), enc(err)));
}

/// the page crashed: loaded again — back into the same room (sessionStorage outlives it); 3 times in 2 minutes → a choice
pub fn page_crashed(w: &WebviewWindow, app: &Arc<App>, reason: &str) {
    app.stay_awake(false);
    app.presence(None);
    eprintln!("page gone {reason}");
    let n = {
        let mut c = app.crashes.lock().unwrap();
        let now = Instant::now();
        c.push(now);
        c.retain(|t| now.duration_since(*t) < Duration::from_secs(120));
        c.len()
    };
    if n >= 3 {
        if app.crash_dialog.swap(true, Ordering::SeqCst) {
            return;
        }
        let (w, app, h) = (w.clone(), app.clone(), w.app_handle().clone());
        tauri::async_runtime::spawn(async move {
            let detail = format!("畫面在兩分鐘內當掉了 {n} 次（{reason}）。可以試試在點歌平板 → 🖥 畫面設定 把畫質調低。", reason = "crashed");
            let again = ask(&h, Some(&w), "K ROOM 一直當掉", &detail, "重新載入", "關閉 App", MessageDialogKind::Error).await;
            app.crash_dialog.store(false, Ordering::SeqCst);
            if !again {
                h.exit(0);
                return;
            }
            app.crashes.lock().unwrap().clear();
            let _ = w.reload();
        });
        return;
    }
    let _ = w.reload();
}

/// Windows: the whole WebView2 went away (its browser process): the app starts again
#[cfg(windows)]
pub fn browser_gone(w: &WebviewWindow, app: &Arc<App>) {
    let h = w.app_handle().clone();
    relaunch(&h, app, &[]);
}

/* ---------------------------------------------------------------- restarts */

/// start the app again (after this one is gone — the new one waits for it: one K ROOM at a time), with these extra arguments
pub fn relaunch(h: &AppHandle, _app: &Arc<App>, extra: &[String]) {
    let mut args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.to_ascii_lowercase().starts_with("kroom://") && !a.starts_with("--url=") && !a.starts_with("--kroom-wait="))
        .collect();
    args.extend(extra.iter().cloned());
    args.push(format!("--kroom-wait={}", std::process::id()));
    if let Some(w) = main_win(h) {
        save_window(&w);
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).args(args).spawn();
    }
    h.exit(0);
}

/// 🌐 站台: the app moves to the other K ROOM site (a restart; config.json url); link: a kroom:// link to handle once the app is up there
pub fn switch_site(h: &AppHandle, app: &Arc<App>, origin: &str, link: Option<&str>) {
    if app.steam {
        return; // (the Steam build stays on its site)
    }
    config::set(&[("url", json!(origin))]);
    let extra: Vec<String> = link.map(|l| vec![l.to_string()]).unwrap_or_default();
    relaunch(h, app, &extra);
}

/// before a restart: the page's room record (sessionStorage — gone after a restart) is handed to the app, which keeps it on disk (main.rs KEPT)
pub async fn keep_room(app: &Arc<App>, w: &WebviewWindow) {
    if !w.url().map(|u| app.is_app(u.as_str())).unwrap_or(false) {
        return;
    }
    let _ = app.page_value(w, "window.__kroomKeep ? window.__kroomKeep().then(() => true) : false", Duration::from_secs(2)).await;
}
