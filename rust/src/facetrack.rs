// 🎤 原生臉部追蹤（native/facetrack 的 kroom-facetrack 子程式；docs/VTUBER-PERFORMER-SPEC.md §5.1）：跟 Electron 版 main.js facetrack-start 一樣。
//   子程式：攝影機 → 臉部辨識（NVIDIA AR SDK／ONNX Runtime DirectML、CoreML、CPU）→ VMC 送到 127.0.0.1（vmc.rs 收）。
//   它的狀態（stdout 每行一個 JSON）轉給頁面：window.__kroomFacetrack({t:'ready'|'stat'|'error'|'exit',…})。
//   打包時在資源資料夾的 facetrack/<arch>/（tauri.macos.conf.json／tauri.windows.conf.json 的 resources）；開發時用 native/facetrack/dist/<os>/<arch>/。
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn exe(w: &WebviewWindow) -> Option<(PathBuf, PathBuf)> {
    let (os, name) = if cfg!(windows) { ("win", "kroom-facetrack.exe") } else { ("mac", "kroom-facetrack") };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let mut dirs = Vec::new();
    if let Ok(r) = w.app_handle().path().resource_dir() { dirs.push(r.join("facetrack").join(arch)); }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("native").join("facetrack").join("dist").join(os).join(arch));
    dirs.into_iter().find(|d| d.join(name).exists()).map(|d| (d.join(name), d))
}
pub fn available(w: &WebviewWindow) -> bool { exe(w).is_some() }

fn tell(w: &WebviewWindow, v: &Value) { let _ = w.eval(format!("window.__kroomFacetrack && window.__kroomFacetrack({v})")); }

/// opts：{ port, camera, backend, mirror }（頁面給的，這裡全部重新驗證）
pub fn start(w: WebviewWindow, opts: &Value) -> Result<u16, String> {
    stop();
    let (exe, dir) = exe(&w).ok_or("這個版本的 App 沒有附原生臉部追蹤")?;
    let port = opts["port"].as_u64().filter(|p| *p > 1023 && *p < 65536).unwrap_or(39539) as u16;
    let cam = opts["camera"].as_u64().filter(|c| *c < 16).unwrap_or(0);
    let be = opts["backend"].as_str().filter(|b| ["auto", "nvidia", "onnx", "coreml", "directml", "cpu"].contains(b)).unwrap_or("auto");
    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).args(["--port", &port.to_string(), "--camera", &cam.to_string(), "--backend", be]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if opts["mirror"].as_bool() == Some(true) { cmd.arg("--mirror"); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }   // (CREATE_NO_WINDOW)
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let out = child.stdout.take().ok_or("no stdout")?;
    let ww = w.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) { tell(&ww, &v); }   // (重新序列化：只轉合法 JSON)
        }
        tell(&ww, &json!({ "t": "exit" }));
    });
    *CHILD.lock().unwrap() = Some(child);
    Ok(port)
}
pub fn stop() {
    if let Some(mut c) = CHILD.lock().unwrap().take() {
        if let Some(mut i) = c.stdin.take() { let _ = i.write_all(b"stop\n"); }
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(1500)); let _ = c.kill(); let _ = c.wait(); });
    }
}
