//! 🥽 VTuber 的 VR（src/vtlive/vrshell.ts；跟 Electron 版 desktop/main.js 的 vr-*／vrui-* 一樣的事，Windows 的 WebView2 版）：
//!   - 允許 VR（config.json `vr`）：下次啟動 WebView2 帶 `--enable-features=WebXR,OpenXR`（shell.rs 讀 `at_launch()`）。沒允許的 App 完全不變。
//!   - 進 VR：瀏覽器要「使用者按過」才給開 VR → 用 DevTools protocol 的 Runtime.evaluate（userGesture）代按 `__kroomVrEnterNow`。
//!     換頁前在 VR 裡的話，新頁面載好代按 `__kroomVrResume`（頁面自己記得要不要回 VR）。
//!   - VR 裡的「畫面」：Page.startScreencast（JPEG，最多 20 fps，頁面有變才送）→ 頁面 `window.__kroomVrui({img, w, h})`；
//!     雷射點下去 → Input.dispatchMouseEvent（真的滑鼠動作）。
//!   ⚠ WebView2 的 WebXR 沒有官方文件說支援：開發端沒有 Windows＋頭盔，要實機確認（頁面會先問 navigator.xr，不行就叫你換 Electron 引擎）。
//!   Mac：沒有 SteamVR，全部回「沒有」。
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]   // (Windows 才用得到的部分)
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::WebviewWindow;

static AT_LAUNCH: OnceLock<bool> = OnceLock::new();
/// 這次啟動有沒有打開 WebXR（啟動時讀 config.json `vr`，之後改設定要重開才算）
pub fn at_launch() -> bool {
    *AT_LAUNCH.get_or_init(|| cfg!(windows) && crate::config::flag(&crate::config::config(), "vr"))
}
pub fn allowed() -> bool { cfg!(windows) && crate::config::flag(&crate::config::config(), "vr") }
/// 允許／不允許 VR；第一次允許要重開 App（WebView2 的功能開關只在啟動時）
pub fn set(on: bool) -> Value {
    if !cfg!(windows) { return json!({ "ok": false, "error": "VR 只有 Windows 版（SteamVR）" }); }
    crate::config::set(&[("vr", json!(on))]);
    json!({ "ok": true, "relaunch": on && !at_launch() })
}
/// 給 WebView2 的啟動參數（shell.rs）
pub fn browser_args() -> &'static str { if at_launch() { " --enable-features=WebXR,OpenXR" } else { "" } }

static UI_ON: AtomicBool = AtomicBool::new(false);
static UI_HOOKED: AtomicBool = AtomicBool::new(false);

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn eval_gesture(_w: &WebviewWindow, _js: &str) {}
    pub fn ui_start(_w: &WebviewWindow) -> bool { false }
    pub fn ui_stop(_w: &WebviewWindow) {}
    pub fn ui_input(_w: &WebviewWindow, _ev: &Value) {}
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::time::Instant;
    use std::sync::Mutex;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::*;
    use windows::core::{Interface, HSTRING, PWSTR};

    fn cdp(w: &WebviewWindow, method: &'static str, params: String) {
        let _ = w.with_webview(move |pw| unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                let _ = core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params.as_str()), None);
            }
        });
    }
    /// 頁面上執行一段 JS，算「使用者按的」（requestSession 才會過）
    pub fn eval_gesture(w: &WebviewWindow, js: &str) {
        cdp(w, "Runtime.evaluate", json!({ "expression": js, "userGesture": true, "awaitPromise": false }).to_string());
    }
    pub fn ui_start(w: &WebviewWindow) -> bool {
        if !UI_HOOKED.swap(true, Ordering::SeqCst) {
            // 畫面一幀：回 ack（不回就不送下一幀），最多每 50 ms 交給頁面一次
            let ww = w.clone();
            let last = std::sync::Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(1)));
            let _ = w.with_webview(move |pw| unsafe {
                let Ok(core) = pw.controller().CoreWebView2() else { return };
                let Ok(rx) = core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Page.screencastFrame")) else { return };
                let c = core.clone();
                let mut token = 0i64;
                let _ = rx.add_DevToolsProtocolEventReceived(
                    &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        if let Ok(a2) = args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>() {
                            let mut s = PWSTR::null();
                            if a2.SessionId(&mut s).is_ok() && !take_pwstr(s).is_empty() { return Ok(()); }   // (只要主頁面那一路，不要內嵌的播放器)
                        }
                        let mut j = PWSTR::null();
                        args.ParameterObjectAsJson(&mut j)?;
                        let v: Value = serde_json::from_str(&take_pwstr(j)).unwrap_or_default();
                        if let Some(sid) = v["sessionId"].as_i64() {
                            let _ = c.CallDevToolsProtocolMethod(&HSTRING::from("Page.screencastFrameAck"), &HSTRING::from(json!({ "sessionId": sid }).to_string().as_str()), None);
                        }
                        if !UI_ON.load(Ordering::SeqCst) { return Ok(()); }
                        let mut l = last.lock().unwrap();
                        if l.elapsed().as_millis() < 50 { return Ok(()); }
                        *l = Instant::now();
                        let (Some(data), w2, h2) = (v["data"].as_str(), v["metadata"]["deviceWidth"].as_f64().unwrap_or(0.), v["metadata"]["deviceHeight"].as_f64().unwrap_or(0.)) else { return Ok(()) };
                        if data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {   // (base64 才放進 JS)
                            let _ = ww.eval(format!("window.__kroomVrui&&window.__kroomVrui({{img:'{data}',w:{w2},h:{h2}}})"));
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            });
        }
        UI_ON.store(true, Ordering::SeqCst);
        cdp(w, "Page.startScreencast", json!({ "format": "jpeg", "quality": 75, "maxWidth": 1600, "maxHeight": 1600, "everyNthFrame": 1 }).to_string());
        true
    }
    pub fn ui_stop(w: &WebviewWindow) {
        UI_ON.store(false, Ordering::SeqCst);
        cdp(w, "Page.stopScreencast", "{}".into());
    }
    pub fn ui_input(w: &WebviewWindow, ev: &Value) {
        let x = ev["x"].as_f64().unwrap_or(0.).round(); let y = ev["y"].as_f64().unwrap_or(0.).round();
        let p = match ev["type"].as_str().unwrap_or("") {
            "move" => json!({ "type": "mouseMoved", "x": x, "y": y }),
            "down" => json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }),
            "up" => json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }),
            "wheel" => json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": ev["dy"].as_f64().unwrap_or(0.).clamp(-2000., 2000.) }),
            _ => return,
        };
        cdp(w, "Input.dispatchMouseEvent", p.to_string());
    }
}
pub use imp::{eval_gesture, ui_input, ui_start, ui_stop};

/// 新頁面載好：換頁前在 VR 裡的話接著回 VR（頁面自己判斷；有允許 VR 才代按）
pub fn on_page_finished(w: &WebviewWindow) {
    if !at_launch() { return; }
    let w = w.clone();
    std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(1200)); eval_gesture(&w, "window.__kroomVrResume && window.__kroomVrResume()"); });
}
