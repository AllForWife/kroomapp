//! K ROOM for Windows and macOS — the Rust (Tauri 2) version of desktop/ (Electron): the website in its own window, without the browser's autoplay
//! gate and background throttling, plus what only an app can do (desktop/main.js). See README.md for what maps to what.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cmds;
mod config;
mod device;
mod discord;
mod engine;
mod shell;
mod steam;
mod updates;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;
mod vmc;
mod vr;
mod facetrack;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewWindow, WindowEvent};

/// the app's own commands (build.rs lists the same ones; each is allowed to this run's site only, in setup)
const COMMANDS: &[&str] = &[
    "login_with_browser", "get_display", "set_beta", "set_unlock_fps", "relaunch", "get_sites", "set_site", "set_awake", "set_presence",
    "steam_ticket", "steam_id", "keep_room", "open_external", "js_result", "get_engine", "set_engine", "vmc_start", "vmc_stop", "facetrack_start", "facetrack_stop", "facetrack_available", "vr_get", "vr_set", "vr_enter", "vrui_start", "vrui_stop", "vrui_input",
];

/// the Discord application 「K ROOM」 (its name is the 「正在玩」 line)
const DISCORD_ID: &str = "1569425359034781747";

pub struct App {
    pub origin: String,
    pub start: String,
    pub version: String,
    pub steam: bool,
    pub device: String,
    pub pending: Mutex<HashMap<&'static str, (String, Instant)>>,
    pub awake: Mutex<Option<keepawake::KeepAwake>>,
    pub discord: Mutex<Option<discord::Discord>>,
    pub steamworks: Option<steam::Steam>,
    pub crashes: Mutex<Vec<Instant>>,
    pub crash_dialog: AtomicBool,
    pub join_url: Mutex<String>,
    pub loaded: tokio::sync::watch::Sender<bool>,
    pub js_wait: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
    pub js_seq: AtomicU64,
    pub popups: AtomicUsize,
    pub handle: std::sync::OnceLock<tauri::AppHandle>,
    /// 🧪 the Electron app is being installed (engine switch): no update of this one on the way out
    pub switching: AtomicBool,
    /// the last K ROOM page the window showed (a Mac: where an off-site page load is sent back to)
    pub last_app_url: Mutex<String>,
    pub update: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
    /// the window's last normal (not maximised / minimised / fullscreen) place, logical px: saved to window.json on close
    pub bounds: Mutex<Option<(f64, f64, f64, f64)>>,
}

impl App {
    pub fn is_app(&self, u: &str) -> bool {
        shell::origin_of(u) == self.origin
    }
    /// 🌙 while a song plays: the screen does not sleep and the screensaver does not start
    pub fn stay_awake(&self, on: bool) {
        let mut a = self.awake.lock().unwrap();
        if on == a.is_some() {
            return;
        }
        *a = if on { keepawake::Builder::default().display(true).idle(true).reason("K ROOM: a song is playing").app_name("K ROOM").app_reverse_domain("xyz.548754321.kroom").create().ok() } else { None };
        if std::env::var_os("KROOM_TEST_LOG").is_some() {
            println!("AWAKE {on}");
        }
    }
    pub fn presence(&self, a: Option<Value>) {
        if let Some(d) = &*self.discord.lock().unwrap() {
            d.set(a);
        }
    }
    /// a value from the page (a promise is waited for): sent back through the js_result command
    pub async fn page_value(&self, w: &WebviewWindow, expr: &str, timeout: Duration) -> Option<Value> {
        let id = self.js_seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.js_wait.lock().unwrap().insert(id, tx);
        let js = format!("(async () => {{ let v = null; try {{ v = await ({expr}); }} catch {{}} try {{ await window.__TAURI_INTERNALS__.invoke('js_result', {{ id: {id}, v: v === undefined ? null : v }}); }} catch {{}} }})()");
        if w.eval(js).is_err() {
            self.js_wait.lock().unwrap().remove(&id);
            return None;
        }
        let r = tokio::time::timeout(timeout, rx).await.ok().and_then(Result::ok);
        self.js_wait.lock().unwrap().remove(&id);
        r
    }
}

fn flag_env(k: &str) -> bool {
    std::env::var(k).map(|v| v == "1" || v == "true").unwrap_or(false)
}

/// the page address: --url= / KROOM_URL / config.json url (🌐 站台), only https (or localhost); the PACKAGED Steam build always opens the main site
fn start_url(steam: bool) -> String {
    let packaged = !cfg!(debug_assertions);
    let dev_url_ok = !steam || !packaged || flag_env("STEAM_BUILD_DEV");
    if !dev_url_ok {
        return shell::DEFAULT_URL.to_string();
    }
    let dev = if !packaged || flag_env("STEAM_BUILD_DEV") { std::env::var("KROOM_START_URL").unwrap_or_default() } else { String::new() };
    let arg = std::env::args().find_map(|a| a.strip_prefix("--url=").map(str::to_string)).unwrap_or_default();
    let cfg = config::config().get("url").and_then(Value::as_str).unwrap_or("").to_string();
    let raw = [dev, arg, std::env::var("KROOM_URL").unwrap_or_default(), cfg].into_iter().find(|s| !s.is_empty()).unwrap_or_else(|| shell::DEFAULT_URL.into());
    match tauri::Url::parse(&raw) {
        Ok(u) if u.origin().ascii_serialization() == shell::OLD_MAIN => shell::DEFAULT_URL.into(),
        Ok(u) if u.scheme() == "https" || matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")) => u.to_string(),
        _ => shell::DEFAULT_URL.into(),
    }
}

/// a restart (shell::relaunch): wait until the old app is gone, so this one is not taken for a second start
fn wait_for_parent() {
    let Some(pid) = std::env::args().find_map(|a| a.strip_prefix("--kroom-wait=").and_then(|p| p.parse::<u32>().ok())) else { return };
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(h, 10_000);
            let _ = CloseHandle(h);
        }
    }
    #[cfg(unix)]
    for _ in 0..100 {
        if unsafe { libc::kill(pid as i32, 0) } != 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(target_os = "macos")]
pub fn macos_major() -> u32 {
    let mut buf = [0u8; 32];
    let mut len = buf.len();
    let name = std::ffi::CString::new("kern.osproductversion").unwrap();
    let r = unsafe { libc::sysctlbyname(name.as_ptr(), buf.as_mut_ptr() as *mut _, &mut len, std::ptr::null_mut(), 0) };
    if r != 0 {
        return 14;
    }
    String::from_utf8_lossy(&buf[..len.saturating_sub(1)]).split('.').next().and_then(|m| m.parse().ok()).unwrap_or(14)
}

/// kroom:// links in the command line (Windows hands them to a new start; the restart after a site switch carries one too)
fn links_in(args: &[String]) -> Vec<String> {
    args.iter().filter(|a| a.to_ascii_lowercase().starts_with("kroom://")).cloned().collect()
}

#[cfg(target_os = "macos")]
fn mac_menu(h: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    // a Mac always has a menu bar, and without its Edit menu ⌘C ⌘V do nothing. The app's keys live here too (they work wherever the focus is,
    // a player's frame included): ⌘R / ⌘⇧R reload, ⌥⌘I developer tools, ⌘⇧A admin login, ⌘⇧H the game's front page, ⌘[ back
    let app_m = Submenu::with_items(h, "K ROOM", true, &[
        &PredefinedMenuItem::about(h, None, None)?,
        &PredefinedMenuItem::separator(h)?,
        &PredefinedMenuItem::hide(h, None)?,
        &PredefinedMenuItem::hide_others(h, None)?,
        &PredefinedMenuItem::show_all(h, None)?,
        &PredefinedMenuItem::separator(h)?,
        &PredefinedMenuItem::quit(h, None)?,
    ])?;
    let edit = Submenu::with_items(h, "編輯", true, &[
        &PredefinedMenuItem::undo(h, None)?,
        &PredefinedMenuItem::redo(h, None)?,
        &PredefinedMenuItem::separator(h)?,
        &PredefinedMenuItem::cut(h, None)?,
        &PredefinedMenuItem::copy(h, None)?,
        &PredefinedMenuItem::paste(h, None)?,
        &PredefinedMenuItem::select_all(h, None)?,
    ])?;
    let view = Submenu::with_items(h, "顯示", true, &[
        &MenuItem::with_id(h, "k:reload", "重新載入", true, Some("CmdOrCtrl+R"))?,
        &MenuItem::with_id(h, "k:reload2", "強制重新載入", true, Some("CmdOrCtrl+Shift+R"))?,
        &MenuItem::with_id(h, "k:home", "回到首頁", true, Some("CmdOrCtrl+Shift+H"))?,
        &MenuItem::with_id(h, "k:back", "上一頁", true, Some("CmdOrCtrl+["))?,
        &PredefinedMenuItem::separator(h)?,
        &PredefinedMenuItem::fullscreen(h, Some("全螢幕"))?,
        &MenuItem::with_id(h, "k:devtools", "開發者工具", true, Some("Alt+CmdOrCtrl+I"))?,
        &MenuItem::with_id(h, "k:admin", "管理員登入", true, Some("CmdOrCtrl+Shift+A"))?,
    ])?;
    let window = Submenu::with_items(h, "視窗", true, &[
        &PredefinedMenuItem::minimize(h, None)?,
        &PredefinedMenuItem::maximize(h, None)?,
        &PredefinedMenuItem::close_window(h, None)?,
    ])?;
    Menu::with_items(h, &[&app_m, &edit, &view, &window])
}

static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
/// (tests: start-up stages, KROOM_TEST_LOG)
pub fn mark(what: &str) {
    if std::env::var_os("KROOM_TEST_LOG").is_some() {
        println!("T {:>5} ms {what}", T0.get_or_init(Instant::now).elapsed().as_millis());
    }
}

fn main() {
    mark("main");
    wait_for_parent();
    let steam = cfg!(feature = "steam") || flag_env("STEAM_BUILD");
    let launch_args: Vec<String> = std::env::args().collect();

    let mut builder = tauri::Builder::default();
    // (tests, debug / devport builds only: KROOM_TEST_SECOND=1 runs next to an installed K ROOM that is open — with WEBVIEW2_USER_DATA_FOLDER
    // set to a folder of its own)
    let second = (cfg!(debug_assertions) || cfg!(feature = "devport")) && std::env::var_os("KROOM_TEST_SECOND").is_some();
    if !second {
        // a second start only brings the open window forward (and hands over its kroom:// link)
        builder = builder.plugin(tauri_plugin_single_instance::init(|h, argv, _cwd| {
            if let Some(w) = h.get_webview_window("main") {
                if w.is_minimized().unwrap_or(false) {
                    let _ = w.unminimize();
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            let app = h.state::<Arc<App>>().inner().clone();
            for l in links_in(&argv) {
                shell::deep_link(h, &app, &l);
            }
        }));
    }
    let mut builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            cmds::login_with_browser,
            cmds::get_display,
            cmds::set_beta,
            cmds::set_unlock_fps,
            cmds::relaunch,
            cmds::get_sites,
            cmds::set_site,
            cmds::set_awake,
            cmds::set_presence,
            cmds::steam_ticket,
            cmds::steam_id,
            cmds::keep_room,
            cmds::open_external,
            cmds::js_result,
            cmds::get_engine,
            cmds::set_engine,
            cmds::vmc_start,
            cmds::vmc_stop,
            cmds::facetrack_start,
            cmds::facetrack_stop,
            cmds::facetrack_available,
            cmds::vr_get,
            cmds::vr_set,
            cmds::vr_enter,
            cmds::vrui_start,
            cmds::vrui_stop,
            cmds::vrui_input,
        ]);
    #[cfg(target_os = "macos")]
    {
        // the page's process ended (out of memory, a GPU reset…): loaded again, back into the same room
        builder = builder.on_web_content_process_terminate(|wv| {
            let h = wv.app_handle();
            if let (Some(w), Some(app)) = (h.get_webview_window(wv.label()), h.try_state::<Arc<App>>()) {
                if wv.label() == "main" {
                    shell::page_crashed(&w, app.inner(), "web content process terminated");
                } else {
                    let _ = w.reload();
                }
            }
        });
    }

    builder = builder.setup(move |tapp| {
        let h = tapp.handle().clone();
        mark("setup");
        config::init(h.path().app_config_dir()?);
        #[cfg(windows)]
        if let Ok(d) = h.path().app_local_data_dir() {
            config::migrate_local_storage(&d);
        }
        let start = start_url(steam);
        let start = if steam { shell::with_store(&start) } else { start };
        let origin = shell::origin_of(&start);
        // 🧪 switched from the Electron app (desktop/main.js set-engine): it left a one-time sign-in code for this site (made by its signed-in page a
        // moment ago — 2 min, once): the first page claims it, so the player stays signed in without being asked. Only a code in this computer's
        // own config file counts (a kroom://open link from a page still asks first: shell::open_from_browser)
        let handoff = config::config().get("handoff").cloned();
        if handoff.is_some() {
            config::set(&[("handoff", Value::Null)]);
        }
        let claim = handoff.and_then(|h| {
            let s = |k: &str| {
                h.get(k).and_then(Value::as_str).filter(|v| (20..=200).contains(&v.len()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).map(str::to_string)
            };
            let fresh = h.get("at").and_then(Value::as_u64).is_some_and(|at| shell::now_ms().saturating_sub(at) < 3 * 60_000);
            let same_site = h.get("origin").and_then(Value::as_str) == Some(origin.as_str());
            match (s("code"), s("state")) {
                (Some(c), Some(st)) if fresh && same_site => Some(format!("{origin}/api/auth/app/claim?code={c}&state={st}")),
                _ => None,
            }
        });
        let device = device::get();
        mark("device id");
        // a room kept across the last restart: given to the first page once (js/bridge.js KEPT), then forgotten
        let kept = config::config().get("rejoin").cloned().unwrap_or(Value::Null);
        if !kept.is_null() {
            config::set(&[("rejoin", Value::Null)]);
        }
        let (loaded, _) = tokio::sync::watch::channel(false);
        let app = Arc::new(App {
            origin,
            start,
            version: h.package_info().version.to_string(),
            steam,
            device,
            pending: Mutex::default(),
            awake: Mutex::default(),
            discord: Mutex::default(),
            steamworks: if steam { steam::init() } else { None },
            crashes: Mutex::default(),
            crash_dialog: AtomicBool::new(false),
            join_url: Mutex::default(),
            loaded,
            js_wait: Mutex::default(),
            js_seq: AtomicU64::new(1),
            popups: AtomicUsize::new(0),
            handle: std::sync::OnceLock::new(),
            switching: AtomicBool::new(false),
            last_app_url: Mutex::default(),
            update: Mutex::default(),
            bounds: Mutex::default(),
        });
        if let Some(c) = claim {
            *app.join_url.lock().unwrap() = c;
        }
        let _ = app.handle.set(h.clone());
        tapp.manage(app.clone());
        // only THIS run's site may call the app's commands (Tauri checks the calling frame's own address: a frame of another site — the other
        // K ROOM site included — gets nothing); the main window and its same-site popups
        {
            let mut cap = tauri::ipc::CapabilityBuilder::new("kroom-site").remote(format!("{}/*", app.origin)).windows(["main", "popup-*"]);
            for c in COMMANDS {
                cap = cap.permission(format!("allow-{}", c.replace('_', "-")));
            }
            tapp.add_capability(cap)?;
        }

        #[cfg(target_os = "macos")]
        {
            let m = mac_menu(&h)?;
            h.set_menu(m)?;
            let a = app.clone();
            h.on_menu_event(move |h, e| {
                let Some(w) = h.get_webview_window("main") else { return };
                let k = match e.id().as_ref() {
                    "k:reload" | "k:reload2" => shell::Key::Reload,
                    "k:home" => shell::Key::Home,
                    "k:back" => shell::Key::Back,
                    "k:devtools" => shell::Key::DevTools,
                    "k:admin" => shell::Key::Admin,
                    _ => return,
                };
                shell::key(&w, &a, k);
            });
        }

        // kroom:// and the Discord invite scheme: registered for this user (the installer does it too; the zip version and `cargo run` need this)
        // (not by a development build: it would take the links away from the installed app)
        #[cfg(windows)]
        if !cfg!(debug_assertions) {
            use tauri_plugin_deep_link::DeepLinkExt;
            let _ = h.deep_link().register_all();
        }
        // 🎮 Discord: before the window, so an invite that made Discord start the app is not missed (discord_join keeps it for the window)
        {
            let (hh, a) = (h.clone(), app.clone());
            *app.discord.lock().unwrap() = Some(discord::create(DISCORD_ID, move |secret| {
                let (hh2, a2) = (hh.clone(), a.clone());
                let _ = hh.run_on_main_thread(move || shell::discord_join(&hh2, &a2, &secret));
            }));
        }
        // links that arrive while the app runs (a Mac: open-url; Windows: through the single-instance plugin above)
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            let (hh, a) = (h.clone(), app.clone());
            h.deep_link().on_open_url(move |e| {
                #[cfg(target_os = "macos")]
                for u in e.urls() {
                    shell::deep_link(&hh, &a, u.as_str());
                }
                #[cfg(not(target_os = "macos"))]
                let _ = (&e, &hh, &a);
            });
        }

        mark("before window");
        let win = shell::create_window(&h, &app, &kept)?;
        mark("window built");
        // a Mac: the first page cannot be reached → the page that retries by itself (Windows notices any failed load itself: src/win.rs)
        #[cfg(not(windows))]
        {
            let (w, a) = (win.clone(), app.clone());
            tauri::async_runtime::spawn(async move {
                let ok = match reqwest::Client::builder().timeout(Duration::from_secs(12)).build() {
                    Ok(c) => c.head(&a.start).send().await.is_ok(),
                    Err(_) => true,
                };
                if !ok {
                    shell::show_offline(&w, &a, "the server cannot be reached");
                }
            });
        }
        let _ = win;

        // started by a kroom:// link (用 App 開啟 on the website): handled once the first page is up
        let mut first: Vec<String> = links_in(&launch_args);
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            if let Ok(Some(urls)) = h.deep_link().get_current() {
                for u in urls {
                    if !first.contains(&u.to_string()) {
                        first.push(u.to_string());
                    }
                }
            }
        }
        if !first.is_empty() {
            let (hh, a) = (h.clone(), app.clone());
            tauri::async_runtime::spawn(async move {
                let mut rx = a.loaded.subscribe();
                let _ = tokio::time::timeout(Duration::from_secs(20), rx.wait_for(|l| *l)).await;
                tokio::time::sleep(Duration::from_millis(300)).await;
                for l in first {
                    let (hh2, a2) = (hh.clone(), a.clone());
                    let _ = hh.run_on_main_thread(move || shell::deep_link(&hh2, &a2, &l));
                }
            });
        }
        updates::start(&h, &app);
        Ok(())
    });

    let app = builder.build(tauri::generate_context!()).expect("K ROOM could not start");
    app.run(|h, ev| match ev {
        RunEvent::WindowEvent { label, event, .. } if label == "main" => {
            let (Some(w), Some(app)) = (h.get_webview_window("main"), h.try_state::<Arc<App>>()) else { return };
            match event {
                WindowEvent::Focused(_) => shell::win_state(&w),
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                    shell::win_state(&w);
                    let normal = !w.is_maximized().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && !w.is_fullscreen().unwrap_or(false);
                    if normal {
                        if let (Ok(p), Ok(s), Ok(f)) = (w.outer_position(), w.inner_size(), w.scale_factor()) {
                            *app.bounds.lock().unwrap() = Some((p.x as f64 / f, p.y as f64 / f, s.width as f64 / f, s.height as f64 / f));
                        }
                    }
                }
                WindowEvent::CloseRequested { .. } => shell::save_window(&w),
                WindowEvent::Destroyed => {
                    app.presence(None);
                    app.stay_awake(false);
                    h.exit(0); // (the popups go with the main window, as in Electron's window-all-closed → quit)
                }
                _ => {}
            }
        }
        // any way out (a restart, a site switch, ⌘Q): the window's place is kept
        RunEvent::ExitRequested { .. } => {
            if let Some(w) = h.get_webview_window("main") {
                shell::save_window(&w);
            }
        }
        // an update downloaded earlier and put off: installed now, while the app closes (it does not start again by itself)
        RunEvent::Exit => {
            if let Some(app) = h.try_state::<Arc<App>>() {
                app.presence(None);
                updates::install_now(h, app.inner(), false);
            }
        }
        _ => {}
    });
}
