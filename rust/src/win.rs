//! Windows only: what the WebView2 control does natively that Tauri does not expose — the Electron app's permission policy, page crashes, the
//! offline page, element fullscreen → window fullscreen, the keyboard shortcuts (even while a player's frame has the focus), the priority boost.
use crate::{shell, App};
use std::sync::Arc;
use tauri::{Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::*;
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

/// "Chrome/142.0.0.0 … Edg/142.0.0.0" for the user agent: the installed WebView2's major version
pub fn runtime_major() -> Option<String> {
    let mut v = PWSTR::null();
    unsafe { GetAvailableCoreWebView2BrowserVersionString(None, &mut v).ok()? };
    let s = take_pwstr(v);
    let major = s.split('.').next()?.trim().to_string();
    (!major.is_empty() && major.chars().all(|c| c.is_ascii_digit())).then_some(major)
}

fn down(vk: u16) -> bool {
    unsafe { GetKeyState(vk as i32) < 0 }
}

pub fn attach(win: &WebviewWindow, app: Arc<App>) {
    let w = win.clone();
    let _ = win.with_webview(move |pw| unsafe {
        let controller = pw.controller();
        let Ok(core) = controller.CoreWebView2() else { return };
        let mut token = 0i64;

        // 🎤 the K ROOM page: the microphone (no camera); nothing else asks. Fullscreen, pointer lock, keyboard lock, speaker selection and
        // clipboard writes are not permission prompts in WebView2 (allowed as in Electron). Embedded players get nothing.
        let a = app.clone();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let ok = kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && a.is_app(&take_pwstr(uri));
                if let Ok(a3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    let _ = a3.SetSavesInProfile(false.into()); // (asked again next time: the rules here decide, not a remembered answer)
                }
                args.SetState(if ok { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
                Ok(())
            })),
            &mut token,
        );

        // ⛶ a page's element fullscreen fills the screen (Electron did this by itself)
        let ww = w.clone();
        let _ = core.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(s) = sender {
                    let mut on = false.into();
                    s.ContainsFullScreenElement(&mut on)?;
                    let _ = ww.set_fullscreen(on.as_bool());
                }
                Ok(())
            })),
            &mut token,
        );

        // the server cannot be reached: the small page that retries by itself (Electron did-fail-load)
        let a = app.clone();
        let ww = w.clone();
        let _ = core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                let mut ok = false.into();
                args.IsSuccess(&mut ok)?;
                if !ok.as_bool() {
                    let mut st = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.WebErrorStatus(&mut st)?;
                    let mut src = PWSTR::null();
                    sender.Source(&mut src)?;
                    let url = take_pwstr(src);
                    if st != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED && a.is_app(&url) {
                        shell::show_offline(&ww, &a, &format!("WebView2 error {}", st.0));
                    }
                } else {
                    boost(&sender);
                }
                Ok(())
            })),
            &mut token,
        );

        // the page crashed (out of memory, a GPU reset…): loaded again, back into the same room; a page that keeps crashing gets a choice.
        // "Not responding" is left alone (a venue load / shader compile on a slow PC freezes the page for a while and then recovers).
        let a = app.clone();
        let ww = w.clone();
        let _ = core.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    shell::page_crashed(&ww, &a, &format!("render process exited ({})", kind.0));
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                    shell::browser_gone(&ww, &a);
                }
                Ok(())
            })),
            &mut token,
        );

        // ⌨ the app's keys, wherever the focus is (the page or a player's frame) — Electron before-input-event
        let a = app.clone();
        let ww = w.clone();
        let _ = controller.add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                    return Ok(());
                }
                let mut vk = 0u32;
                args.VirtualKey(&mut vk)?;
                let (ctrl, shift, alt) = (down(VK_CONTROL.0), down(VK_SHIFT.0), down(VK_MENU.0));
                let key = match vk {
                    0x7A => Some(shell::Key::Fullscreen),                    // F11
                    0x74 => Some(shell::Key::Reload),                        // F5
                    0x52 if ctrl && shift => Some(shell::Key::Reload),       // Ctrl+Shift+R
                    0x7B => Some(shell::Key::DevTools),                      // F12
                    0x49 if ctrl && shift => Some(shell::Key::DevTools),     // Ctrl+Shift+I
                    0x41 if ctrl && shift => Some(shell::Key::Admin),        // Ctrl+Shift+A
                    0x24 if alt => Some(shell::Key::Home),                   // Alt+Home
                    0x25 if alt => Some(shell::Key::Back),                   // Alt+←
                    _ => None,
                };
                if let Some(k) = key {
                    args.SetHandled(true.into())?;
                    let (ww, a) = (ww.clone(), a.clone());
                    let _ = ww.clone().run_on_main_thread(move || shell::key(&ww, &a, k));
                }
                Ok(())
            })),
            &mut token,
        );

        player_csp_bypass(&core);

        // the page's processes one step above normal (WebRTC decoding, Web Audio): checked again every 30 s (a new page can get a new process)
        let core2 = core.clone();
        boost(&core2);
        let app_handle = w.app_handle().clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let Some(win) = app_handle.get_webview_window("main") else { return };
            let _ = win.with_webview(|pw| {
                if let Ok(c) = pw.controller().CoreWebView2() {
                    boost(&c);
                }
            });
        });
    });
}

/// 🎼 the key shifter's AudioWorklet module has to load inside the YouTube / Bilibili frame, whose content security rules refuse it (YouTube:
/// script-src with a nonce and 'strict-dynamic' — only the page's own nonce-carrying scripts may load modules). Electron served it from
/// kroomfx://, a scheme that bypasses them; without it the shifter falls back to a ScriptProcessor on the player's busy main thread (~80 ms later,
/// prone to stutter). Here: the players' embed PAGES only (not their scripts, not any other site) come back without their script-src policy —
/// their Trusted Types rule stays. Done over the DevTools protocol's Fetch domain, which every frame of the page (auto-attached) goes through.
const PLAYER_PAGES: &str = r#"{"patterns":[
  {"urlPattern":"https://www.youtube.com/embed/*","resourceType":"Document","requestStage":"Response"},
  {"urlPattern":"https://www.youtube-nocookie.com/embed/*","resourceType":"Document","requestStage":"Response"},
  {"urlPattern":"https://player.bilibili.com/*","resourceType":"Document","requestStage":"Response"}]}"#;

fn is_player(u: &str) -> bool {
    let Ok(u) = tauri::Url::parse(u) else { return false };
    let h = u.host_str().unwrap_or("");
    let site = |d: &str| h == d || h.ends_with(&format!(".{d}"));
    site("bilibili.com") || ((site("youtube.com") || site("youtube-nocookie.com")) && u.path().starts_with("/embed/"))
}

/// a content security policy without its script-src / script-src-elem directives (the ones that refuse the worklet module); every other
/// directive stays. (One header can hold several policies, one per line.)
fn without_script_src(policy: &str) -> String {
    policy
        .split('\n')
        .map(|one| {
            one.split(';')
                .map(str::trim)
                .filter(|d| {
                    let name = d.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                    !d.is_empty() && name != "script-src" && name != "script-src-elem"
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_other_directives() {
        let p = "base-uri 'self';object-src 'none';script-src 'nonce-x' 'strict-dynamic';report-uri https://r";
        assert_eq!(super::without_script_src(p), "base-uri 'self'; object-src 'none'; report-uri https://r");
        assert_eq!(super::without_script_src("require-trusted-types-for 'script'"), "require-trusted-types-for 'script'");
        assert_eq!(super::without_script_src("script-src 'none'"), "");
    }
}

fn session_of(args: &ICoreWebView2DevToolsProtocolEventReceivedEventArgs) -> String {
    let Ok(a2) = args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>() else { return String::new() };
    let mut s = PWSTR::null();
    if unsafe { a2.SessionId(&mut s) }.is_err() {
        return String::new();
    }
    take_pwstr(s)
}

fn player_csp_bypass(core: &ICoreWebView2) {
    unsafe {
        let Ok(c11) = core.cast::<ICoreWebView2_11>() else { return };
        let mut token = 0i64;
        // a player's embed page answered: on without its script-src policy (anything else that matched goes on untouched)
        if let Ok(rx) = core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Fetch.requestPaused")) {
            let c = c11.clone();
            let _ = rx.add_DevToolsProtocolEventReceived(
                &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let sid = session_of(&args);
                    let mut j = PWSTR::null();
                    args.ParameterObjectAsJson(&mut j)?;
                    let v: serde_json::Value = serde_json::from_str(&take_pwstr(j)).unwrap_or_default();
                    let Some(id) = v["requestId"].as_str() else { return Ok(()) };
                    let url = v["request"]["url"].as_str().unwrap_or("");
                    let send = {
                        let (c, sid) = (c.clone(), sid.clone());
                        move |m: &str, p: &str, done: Option<&ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>| {
                            let _ = if sid.is_empty() {
                                c.CallDevToolsProtocolMethod(&HSTRING::from(m), &HSTRING::from(p), done)
                            } else {
                                c.CallDevToolsProtocolMethodForSession(&HSTRING::from(sid.as_str()), &HSTRING::from(m), &HSTRING::from(p), done)
                            };
                        }
                    };
                    let go_on = serde_json::json!({ "requestId": id }).to_string();
                    let status = v["responseStatusCode"].as_u64().unwrap_or(0);
                    let headers = v["responseHeaders"].as_array().cloned();
                    let player = is_player(url) && status == 200 && headers.is_some();
                    if std::env::var_os("KROOM_TEST_LOG").is_some() {
                        println!("PAUSED [{sid}] player={player} {}", &url[..url.len().min(90)]);
                    }
                    if !player {
                        send("Fetch.continueRequest", &go_on, None);
                        return Ok(());
                    }
                    // the page as it came (body read back), answered again without the script-src policy; anything going wrong: as it came
                    let kept: Vec<serde_json::Value> = headers.unwrap_or_default().into_iter().filter_map(|mut x| {
                        if !x["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case("content-security-policy")) {
                            return Some(x);
                        }
                        let v = without_script_src(x["value"].as_str().unwrap_or(""));
                        if v.is_empty() {
                            return None;
                        }
                        x["value"] = serde_json::json!(v);
                        Some(x)
                    }).collect();
                    let (id, send2) = (id.to_string(), send.clone());
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |res, json: String| {
                        let b: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
                        match (res.is_ok(), b["body"].as_str()) {
                            (true, Some(body)) => {
                                use base64::Engine;
                                let body = if b["base64Encoded"].as_bool().unwrap_or(false) { body.to_string() } else { base64::engine::general_purpose::STANDARD.encode(body) };
                                let p = serde_json::json!({ "requestId": id, "responseCode": status, "responseHeaders": kept, "body": body });
                                send2("Fetch.fulfillRequest", &p.to_string(), None);
                            }
                            _ => send2("Fetch.continueRequest", &serde_json::json!({ "requestId": id }).to_string(), None),
                        }
                        Ok(())
                    }));
                    send("Fetch.getResponseBody", &go_on, Some(&done));
                    Ok(())
                })),
                &mut token,
            );
        }
        let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("Fetch.enable"), &HSTRING::from(PLAYER_PAGES), None);
    }
}

/// reload ignoring the cache (Electron reloadIgnoringCache)
pub fn hard_reload(win: &WebviewWindow) {
    let _ = win.with_webview(|pw| unsafe {
        if let Ok(c) = pw.controller().CoreWebView2() {
            let _ = c.CallDevToolsProtocolMethod(&HSTRING::from("Page.reload"), &HSTRING::from(r#"{"ignoreCache":true}"#), None);
        }
    });
}

/// the WebView2 browser process and every process under it (the page's renderer, the GPU and audio services): ABOVE_NORMAL
fn boost(core: &ICoreWebView2) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::Threading::*;
    let mut root = 0u32;
    if unsafe { core.BrowserProcessId(&mut root) }.is_err() || root == 0 {
        return;
    }
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return };
    let mut all = Vec::new();
    let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    if unsafe { Process32FirstW(snap, &mut e) }.is_ok() {
        loop {
            all.push((e.th32ProcessID, e.th32ParentProcessID));
            if unsafe { Process32NextW(snap, &mut e) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snap) };
    let mut ours = vec![root];
    let mut i = 0;
    while i < ours.len() {
        let p = ours[i];
        for (pid, parent) in &all {
            if *parent == p && !ours.contains(pid) {
                ours.push(*pid);
            }
        }
        i += 1;
    }
    for pid in ours.into_iter().skip(1) {
        if let Ok(h) = unsafe { OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            if unsafe { GetPriorityClass(h) } == NORMAL_PRIORITY_CLASS.0 {
                let _ = unsafe { SetPriorityClass(h, ABOVE_NORMAL_PRIORITY_CLASS) };
            }
            let _ = unsafe { CloseHandle(h) };
        }
    }
}

