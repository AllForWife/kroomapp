// 🎤 kroom-facetrack：K ROOM 桌面版附的原生臉部追蹤（docs/VTUBER-PERFORMER-SPEC.md §5.1「原生 GPU」）。
//   攝影機 → 臉部追蹤（NVIDIA AR SDK 或 ONNX Runtime：Windows DirectML／Mac CoreML／CPU）→ VMC 送到 127.0.0.1（K ROOM 的 VMC 接收）。
//   不經過瀏覽器，所以 GPU 用得穩；結果跟其他動捕軟體一樣走 VMC，舞台那邊不用改。
//   stdout 每行一個 JSON 狀態：{"t":"ready","backend":"onnx-coreml"} {"t":"stat","fps":..,"ms":..,"face":true} {"t":"error","e":".."}
//   用法：kroom-facetrack [--port 39539] [--camera 0] [--backend auto|nvidia|onnx|coreml|directml|cpu] [--mirror] [--models <資料夾>] [--nvar-dir <資料夾>]
//         kroom-facetrack --image <照片> [--backend ..] [--bench N]   （測試：辨識一張照片，印出結果）
//         kroom-facetrack --fake-camera <照片> [--port ..]          （測試：照片當攝影機，跟真的一樣送 VMC）
//         kroom-facetrack --list-cameras
mod face;
mod nvar;
mod vmc;

use anyhow::{Result, anyhow};
use face::{FaceOut, Frame, OnnxFace};
use serde_json::json;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

enum Backend { Onnx(OnnxFace), Nv(nvar::NvFace) }
static BENCH: std::sync::Mutex<Vec<(String, f64)>> = std::sync::Mutex::new(Vec::new());
impl Backend {
    fn name(&self) -> String { match self { Backend::Onnx(o) => format!("onnx-{}", o.ep), Backend::Nv(_) => "nvidia".into() } }
    fn process(&mut self, f: &Frame) -> Result<Option<FaceOut>> { match self { Backend::Onnx(o) => o.process(f), Backend::Nv(n) => n.process(f) } }
}

/// ONNX Runtime 執行時載入（微軟官方版：Mac 的 libonnxruntime.dylib 有 CoreML、Windows 的 onnxruntime-directml 有 DirectML）。
///   找的地方：環境變數 ORT_DYLIB_PATH → 執行檔旁邊（打包時放在一起）→ 開發用的 native/facetrack/ort/
static ORT_KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
/// 用到的 ONNX Runtime 的識別（檔案大小：換版本就重新比賽）
pub fn ort_key() -> String { ORT_KEY.get().cloned().unwrap_or_default() }
pub fn ort_env() -> Result<ort::environment::Environment> {
    static ENV: std::sync::OnceLock<std::result::Result<ort::environment::Environment, String>> = std::sync::OnceLock::new();
    ENV.get_or_init(|| {
        let name = if cfg!(windows) { "onnxruntime.dll" } else if cfg!(target_os = "macos") { "libonnxruntime.dylib" } else { "libonnxruntime.so" };
        let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
        let c: Vec<PathBuf> = std::env::var("ORT_DYLIB_PATH").ok().map(PathBuf::from).into_iter()
            .chain([exe.join(name), exe.join("../Frameworks").join(name), exe.join("../Resources").join(name), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ort").join(if cfg!(windows) { "win-x64" } else if cfg!(target_arch = "aarch64") { "mac-arm64" } else { "mac-x64" }).join(name)]).collect();
        let p = c.into_iter().find(|p| p.exists()).ok_or_else(|| format!("找不到 ONNX Runtime（{name}）"))?;
        let _ = ORT_KEY.set(std::fs::metadata(&p).map(|m| m.len().to_string()).unwrap_or_default());
        ort::init_from(&p).map_err(|e| e.to_string())?.with_name("kroom-facetrack").build().map_err(|e| e.to_string())
    }).clone().map_err(|e| anyhow!(e))
}

fn arg(a: &[String], k: &str) -> Option<String> { a.iter().position(|x| x == k).and_then(|i| a.get(i + 1).cloned()) }
fn say(v: serde_json::Value) { let mut o = std::io::stdout().lock(); let _ = writeln!(o, "{v}"); let _ = o.flush(); }

fn models_dir(a: &[String]) -> PathBuf {
    if let Some(m) = arg(a, "--models") { return m.into(); }
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    // 打包後：執行檔旁邊的 facetrack-models／（Mac：Contents/Resources/facetrack-models）；開發時：本專案的 models／
    [exe.join("facetrack-models"), exe.join("../Resources/facetrack-models"), exe.join("resources/facetrack-models"), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models")]
        .into_iter().find(|p| p.join("face_detector.onnx").exists()).unwrap_or_else(|| PathBuf::from("models"))
}

fn open_backend(a: &[String]) -> Result<Backend> {
    let b = arg(a, "--backend").unwrap_or_else(|| "auto".into());
    let nv = |a: &[String]| nvar::NvFace::new(arg(a, "--nvar-dir").as_deref());
    match b.as_str() {
        "nvidia" => Ok(Backend::Nv(nv(a)?)),
        "onnx" => onnx_auto(a),
        "coreml" | "directml" | "cpu" => Ok(Backend::Onnx(OnnxFace::new(&models_dir(a), &b)?)),
        _ => {
            // auto：有 NVIDIA AR SDK（RTX＋裝了執行環境）就用它，不然 ONNX（GPU → CPU）
            if cfg!(windows) { match nv(a) { Ok(n) => return Ok(Backend::Nv(n)), Err(e) => eprintln!("[facetrack] NVIDIA AR SDK 不能用：{e}") } }
            onnx_auto(a)
        }
    }
}
fn onnx_auto(a: &[String]) -> Result<Backend> { let (f, t) = OnnxFace::new_with(&models_dir(a), "auto")?; *BENCH.lock().unwrap() = t; Ok(Backend::Onnx(f)) }
fn bench_json() -> serde_json::Value { json!(BENCH.lock().unwrap().iter().map(|(k, v)| json!([k, if v.is_finite() { json!((v * 100.).round() / 100.) } else { json!(null) }])).collect::<Vec<_>>()) }

fn blend_out(o: &FaceOut, mirror: bool) -> Vec<(String, f32)> { o.blend.iter().map(|(n, v)| (vmc::mirror_name(n, mirror), *v)).collect() }

fn run_image(a: &[String], path: &str) -> Result<()> {
    let img = image::open(path)?.to_rgb8(); let (w, h) = (img.width() as usize, img.height() as usize);
    let mut be = open_backend(a)?; let f = Frame { w, h, rgb: img.as_raw() };
    let t0 = Instant::now(); let first = be.process(&f)?; let t1 = t0.elapsed().as_secs_f64() * 1000.;
    let o = be.process(&f)?.or(first).ok_or_else(|| anyhow!("照片裡找不到臉"))?;   // (第二次＝用地標追蹤的 ROI，跟即時追蹤一樣)
    let n = arg(a, "--bench").and_then(|x| x.parse().ok()).unwrap_or(0usize); let tb = Instant::now();
    // --send <埠>：每次結果也用 VMC 送出（測試 App 的 VMC 接收）
    let tx = match arg(a, "--send").and_then(|x| x.parse::<u16>().ok()) { Some(p) => Some(vmc::Vmc::new(p)?), None => None };
    let mirror = a.iter().any(|x| x == "--mirror");
    for i in 0..n { if let Some(o) = be.process(&f)? { if let Some(t) = &tx { t.send(i as f32 / 30., &vmc::head_bones(&o.rot, mirror), &blend_out(&o, mirror))?; std::thread::sleep(std::time::Duration::from_millis(5)); } } }
    let per = if n > 0 { tb.elapsed().as_secs_f64() * 1000. / n as f64 } else { 0. };
    let r = o.rot;
    say(json!({ "t": "image", "backend": be.name(), "tried": bench_json(), "first_ms": t1, "ms": per,
        "rot": [[r[(0,0)], r[(0,1)], r[(0,2)]], [r[(1,0)], r[(1,1)], r[(1,2)]], [r[(2,0)], r[(2,1)], r[(2,2)]]],
        "blend": o.blend.iter().map(|(n, v)| (n.to_string(), json!(v))).collect::<serde_json::Map<_, _>>(),
        "head": vmc::head_bones(&o.rot, false).iter().map(|(n, q)| json!([n, q])).collect::<Vec<_>>() }));
    Ok(())
}

fn run_camera(a: &[String]) -> Result<()> {
    use nokhwa::{Camera, pixel_format::RgbFormat, utils::{CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType}};
    let port: u16 = arg(a, "--port").and_then(|x| x.parse().ok()).unwrap_or(39539); let mirror = a.iter().any(|x| x == "--mirror");
    let cam_i: u32 = arg(a, "--camera").and_then(|x| x.parse().ok()).unwrap_or(0);
    let mut be = open_backend(a)?; let out = vmc::Vmc::new(port)?;
    // --fake-camera <照片>：不開攝影機，用一張照片當每一幀（30 fps；給自動測試和沒有攝影機時檢查 App 的接法）
    let fake = match arg(a, "--fake-camera") { Some(p) => Some(image::open(p)?.to_rgb8()), None => None };
    let mut cam = if fake.is_none() {
        let fmt = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(CameraFormat::new_from(640, 480, FrameFormat::MJPEG, 30)));
        let mut c = Camera::new(CameraIndex::Index(cam_i), fmt).map_err(|e| anyhow!("打不開攝影機：{e}"))?;
        c.open_stream().map_err(|e| anyhow!("攝影機串流：{e}"))?; Some(c)
    } else { None };
    let (w, h) = match (&cam, &fake) { (Some(c), _) => (c.resolution().width(), c.resolution().height()), (_, Some(i)) => (i.width(), i.height()), _ => (0, 0) };
    say(json!({ "t": "ready", "backend": be.name(), "tried": bench_json(), "port": port, "camera": cam_i, "w": w, "h": h, "fake": fake.is_some() }));
    // 父程式（K ROOM App）關掉 stdin 或送 "stop"＝要我們結束
    let stop = Arc::new(AtomicBool::new(false));
    { let s = stop.clone(); std::thread::spawn(move || { let mut l = String::new(); let mut i = std::io::stdin().lock(); while i.read_line(&mut l).map(|n| n > 0).unwrap_or(false) { if l.trim() == "stop" { break; } l.clear(); } s.store(true, Ordering::SeqCst); }); }
    let (t0, mut last, mut frames, mut ms_sum, mut faces) = (Instant::now(), Instant::now(), 0u32, 0f64, 0u32);
    while !stop.load(Ordering::SeqCst) {
        let owned; let img = if let Some(c) = cam.as_mut() {
            let fr = c.frame().map_err(|e| anyhow!("讀不到畫面：{e}"))?;
            owned = if fr.source_frame_format() == FrameFormat::MJPEG { image::load_from_memory_with_format(fr.buffer(), image::ImageFormat::Jpeg)?.to_rgb8() }
                else { fr.decode_image::<RgbFormat>().map_err(|e| anyhow!("畫面解碼：{e}"))? };
            &owned
        } else { std::thread::sleep(std::time::Duration::from_millis(33)); fake.as_ref().unwrap() };
        let f = Frame { w: img.width() as usize, h: img.height() as usize, rgb: img.as_raw() };
        let ts = Instant::now(); let r = be.process(&f)?; ms_sum += ts.elapsed().as_secs_f64() * 1000.; frames += 1;
        if let Some(o) = r { faces += 1; out.send(t0.elapsed().as_secs_f32(), &vmc::head_bones(&o.rot, mirror), &blend_out(&o, mirror))?; }
        if last.elapsed().as_secs_f32() >= 2. { say(json!({ "t": "stat", "fps": frames as f32 / last.elapsed().as_secs_f32(), "ms": ms_sum / frames.max(1) as f64, "face": faces > 0 })); last = Instant::now(); frames = 0; ms_sum = 0.; faces = 0; }
    }
    if let Some(mut c) = cam { let _ = c.stop_stream(); } Ok(())
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let r = if a.iter().any(|x| x == "--list-cameras") {
        nokhwa::query(nokhwa::utils::ApiBackend::Auto).map(|l| say(json!({ "t": "cameras", "list": l.iter().map(|c| json!({ "i": c.index().to_string(), "name": c.human_name() })).collect::<Vec<_>>() }))).map_err(|e| anyhow!("{e}"))
    } else if let Some(p) = arg(&a, "--image") { run_image(&a, &p) } else {
        #[cfg(target_os = "macos")]
        if arg(&a, "--fake-camera").is_none() { let (tx, rx) = std::sync::mpsc::channel(); nokhwa::nokhwa_initialize(move |ok| { let _ = tx.send(ok); }); if !rx.recv().unwrap_or(false) { say(json!({ "t": "error", "e": "沒有攝影機權限" })); std::process::exit(2); } }
        run_camera(&a)
    };
    if let Err(e) = r { say(json!({ "t": "error", "e": e.to_string() })); std::process::exit(1); }
}
