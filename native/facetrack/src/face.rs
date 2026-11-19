// 臉部追蹤（ONNX Runtime 版）：MediaPipe FaceLandmarker 的三個模型（轉成 ONNX，見 tools/ref.py 的比對）＋ MediaPipe 的頭部姿勢算法。
//   流程跟 MediaPipe 一樣：臉部偵測（BlazeFace 128）→ 旋轉的方形 ROI → 478 點地標（256）→ 146 點 → 52 個 blendshape；
//   下一幀直接用上一幀的地標算 ROI（追蹤），地標信心太低才重新偵測。
//   頭部轉向：透視相機（垂直 FOV 63°）把地標換成公制座標，兩輪估尺度，對標準臉做加權 Procrustes（geometry_pipeline.cc 的做法）。
use anyhow::{Context, Result, anyhow};
use nalgebra::{Matrix3, Vector3};
use ort::{session::Session, value::Tensor};
use std::path::Path;

pub const MP_NAMES: [&str; 52] = [
    "_neutral", "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
    "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
    "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft", "mouthLowerDownLeft",
    "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower",
    "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "noseSneerLeft", "noseSneerRight",
];
const SUB: [usize; 146] = [
    0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39, 40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80, 81, 82, 84, 87, 88, 91, 93, 95, 103, 105,
    107, 109, 127, 132, 133, 136, 144, 145, 146, 148, 149, 150, 152, 153, 154, 155, 157, 158, 159, 160, 161, 162, 163, 168, 172, 173, 176, 178, 181, 185,
    191, 195, 197, 234, 246, 249, 251, 263, 267, 269, 270, 276, 282, 283, 284, 285, 288, 291, 293, 295, 296, 297, 300, 308, 310, 311, 312, 314, 317, 318,
    321, 323, 324, 332, 334, 336, 338, 356, 361, 362, 365, 373, 374, 375, 377, 378, 379, 380, 381, 382, 384, 385, 386, 387, 388, 389, 390, 397, 398, 400,
    402, 405, 409, 415, 454, 466, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
];

/// 一張 RGB8 畫面（緊密排列）
pub struct Frame<'a> { pub w: usize, pub h: usize, pub rgb: &'a [u8] }
/// 追蹤結果：頭的旋轉（標準臉 → 相機：x 右、y 上、z 朝鏡頭）＋ ARKit 名稱的 blendshape
pub struct FaceOut { pub rot: Matrix3<f32>, pub blend: Vec<(&'static str, f32)> }

#[derive(Clone, Copy, Debug)]
struct Roi { cx: f32, cy: f32, w: f32, h: f32, rot: f32 }   // (正規化座標；w、h 是對畫面寬、高的比例)

pub struct OnnxFace { det: Session, lmk: Session, bsm: Session, anchors: Vec<(f32, f32)>, canon: Vec<Vector3<f64>>, basis: Vec<(usize, f64)>, roi: Option<Roi>, pub ep: String }

fn ses(env: &ort::environment::Environment, p: &Path, ep: &str) -> Result<Session> {
    use ort::ep;
    let b = Session::builder(env)?;
    let b = match ep {
        #[cfg(target_os = "macos")]
        "coreml" => b.with_execution_providers([ep::CoreML::default().with_model_format(ep::coreml::ModelFormat::MLProgram).with_compute_units(ep::coreml::ComputeUnits::All).build().error_on_failure()]),
        #[cfg(windows)]
        "directml" => b.with_execution_providers([ep::DirectML::default().build().error_on_failure()]),
        #[allow(unreachable_patterns)]
        "coreml" | "directml" => return Err(anyhow!("{ep} 這個平台沒有")),
        // ⚠ ort 預設的裝置選擇是「最省電」→ Mac 上會被自動丟到 Neural Engine（實測比 CPU 慢 3 倍）：CPU 要明講
        _ => b.with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU),
    }.map_err(|e| anyhow!("{ep}: {e}"))?;
    let th: usize = std::env::var("FACETRACK_THREADS").ok().and_then(|x| x.parse().ok()).unwrap_or(1);   // (三個模型各自 1 執行緒最快，也最不搶遊戲的 CPU：實測 1→8ms、4→16ms)
    let mut b = b.with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3).map_err(|e| anyhow!("{e}"))?.with_intra_threads(th).map_err(|e| anyhow!("{e}"))?;
    b.commit_from_file(p).with_context(|| format!("載入 {}", p.display()))
}

impl OnnxFace {
    /// ep：auto（Mac→CoreML、Windows→DirectML，不行就 CPU）／coreml／directml／cpu
    pub fn new(models: &Path, ep: &str) -> Result<Self> { Self::new_with(models, ep).map(|(f, _)| f) }
    /// 回傳選到的後端＋每個試過的後端的時間（毫秒／幀；auto 時用假畫面各跑幾次，挑最快的）
    pub fn new_with(models: &Path, ep: &str) -> Result<(Self, Vec<(String, f64)>)> {
        let env = crate::ort_env()?;
        let mut tries: Vec<&str> = match ep {
            "auto" => if cfg!(target_os = "macos") { vec!["coreml", "cpu"] } else if cfg!(windows) { vec!["directml", "cpu"] } else { vec!["cpu"] },
            x => vec![x],
        };
        // auto 的比賽結果記在暫存資料夾（同一台電腦、同一版 ONNX Runtime 就不用每次都比：CoreML 第一次編譯要好幾秒）
        let cache = std::env::temp_dir().join("kroom-facetrack-auto.json");
        let key = format!("{}-{}-{}", std::env::consts::OS, std::env::consts::ARCH, crate::ort_key());
        let mut cached = None;
        if ep == "auto" && std::env::var("FACETRACK_REBENCH").is_err() {
            if let Ok(c) = std::fs::read_to_string(&cache).map(|t| serde_json::from_str::<serde_json::Value>(&t).unwrap_or_default()) {
                if c["key"] == key.as_str() { if let Some(e) = c["ep"].as_str() { if let Some(&t) = tries.iter().find(|t| **t == e) { tries = vec![t]; cached = Some(c["times"].clone()); } } }
            }
        }
        let cj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(models.join("canonical.json"))?)?;
        let canon: Vec<Vector3<f64>> = cj["v"].as_array().ok_or(anyhow!("canonical.json"))?.iter().map(|p| Vector3::new(p[0].as_f64().unwrap_or(0.), p[1].as_f64().unwrap_or(0.), p[2].as_f64().unwrap_or(0.))).collect();
        let basis: Vec<(usize, f64)> = cj["w"].as_array().ok_or(anyhow!("canonical.json"))?.iter().map(|p| (p[0].as_u64().unwrap_or(0) as usize, p[1].as_f64().unwrap_or(0.))).collect();
        let (mut best, mut times, mut last): (Option<(OnnxFace, f64)>, Vec<(String, f64)>, anyhow::Error) = (None, Vec::new(), anyhow!("no ep"));
        for e in &tries {
            match (|| -> Result<OnnxFace> { Ok(OnnxFace { det: ses(&env, &models.join("face_detector.onnx"), e)?, lmk: ses(&env, &models.join("face_landmarks_detector.onnx"), e)?, bsm: ses(&env, &models.join("face_blendshapes.onnx"), e)?, anchors: anchors(), canon: canon.clone(), basis: basis.clone(), roi: None, ep: e.to_string() }) })() {
                Ok(mut f) => {
                    let ms = if tries.len() > 1 { f.bench().unwrap_or(f64::INFINITY) } else { 0. };
                    times.push((e.to_string(), ms));
                    if best.as_ref().map(|b| ms < b.1).unwrap_or(true) { best = Some((f, ms)); }
                }
                Err(er) => { eprintln!("[facetrack] {e} 不能用：{er}"); times.push((e.to_string(), f64::INFINITY)); last = er; }
            }
        }
        if ep == "auto" && cached.is_none() { if let Some((f, _)) = &best { let _ = std::fs::write(&cache, serde_json::json!({ "key": key, "ep": f.ep, "times": times.iter().map(|(k, v)| serde_json::json!([k, if v.is_finite() { serde_json::json!(v) } else { serde_json::Value::Null }])).collect::<Vec<_>>() }).to_string()); } }
        if let Some(c) = cached { times = c.as_array().map(|a| a.iter().map(|x| (format!("{}（上次）", x[0].as_str().unwrap_or("")), x[1].as_f64().unwrap_or(f64::INFINITY))).collect()).unwrap_or_default(); }
        best.map(|(f, _)| (f, times)).ok_or(last)
    }
    /// 三個模型各跑一次（假輸入）的時間：先暖機 3 次，再取 8 次平均
    fn bench(&mut self) -> Result<f64> {
        let run = |s: &mut OnnxFace| -> Result<()> {
            s.det.run(ort::inputs![Tensor::from_array((vec![1i64, 128, 128, 3], vec![0f32; 128 * 128 * 3]))?])?;
            s.lmk.run(ort::inputs![Tensor::from_array((vec![1i64, 256, 256, 3], vec![0.5f32; 256 * 256 * 3]))?])?;
            s.bsm.run(ort::inputs![Tensor::from_array((vec![1i64, 146, 2], vec![100f32; 292]))?])?; Ok(())
        };
        for _ in 0..12 { run(self)?; }
        let t = std::time::Instant::now(); for _ in 0..8 { run(self)?; } Ok(t.elapsed().as_secs_f64() * 1000. / 8.)
    }

    pub fn process(&mut self, f: &Frame) -> Result<Option<FaceOut>> {
        let roi = match self.roi { Some(r) => r, None => match self.detect(f)? { Some(r) => r, None => return Ok(None) } };
        let prof = std::env::var("FACETRACK_PROF").is_ok(); let t = std::time::Instant::now();
        let (lm, pres) = self.landmarks(f, roi)?; let t1 = t.elapsed();
        if pres < 0.5 { self.roi = None; return Ok(None); }
        self.roi = Some(roi_from_landmarks(&lm, f));
        let blend = self.blend(&lm, f)?; let t2 = t.elapsed();
        let rot = head_rot(&lm, f.w as f64, f.h as f64, &self.canon, &self.basis);
        if prof { eprintln!("[prof] landmarks {:?} blend {:?} head {:?}", t1, t2 - t1, t.elapsed() - t2); }
        Ok(Some(FaceOut { rot, blend: MP_NAMES.iter().zip(blend).skip(1).map(|(n, v)| (*n, v)).collect() }))
    }

    fn detect(&mut self, f: &Frame) -> Result<Option<Roi>> {
        let s = f.w.max(f.h) as f32; let (sx, sy) = (s / f.w as f32, s / f.h as f32);
        let mut t = warp(f, Roi { cx: 0.5, cy: 0.5, w: sx, h: sy, rot: 0. }, 128);
        for v in t.iter_mut() { *v = *v / 127.5 - 1.; }
        let out = self.det.run(ort::inputs![Tensor::from_array((vec![1i64, 128, 128, 3], t))?])?;
        let (_, reg) = out[0].try_extract_tensor::<f32>()?; let (_, cls) = out[1].try_extract_tensor::<f32>()?;
        let (mut bi, mut bs) = (0usize, f32::MIN);
        for (i, c) in cls.iter().enumerate() { if *c > bs { bs = *c; bi = i; } }
        if 1. / (1. + (-bs.clamp(-100., 100.)).exp()) < 0.5 { return Ok(None); }
        let r = &reg[bi * 16..bi * 16 + 16]; let (ax, ay) = self.anchors[bi];
        let un = |x: f32, y: f32| ((x - 0.5) * sx + 0.5, (y - 0.5) * sy + 0.5);
        let (cx, cy) = un(r[0] / 128. + ax, r[1] / 128. + ay); let (w, h) = (r[2] / 128. * sx, r[3] / 128. * sy);
        let p0 = un(r[4] / 128. + ax, r[5] / 128. + ay); let p1 = un(r[6] / 128. + ax, r[7] / 128. + ay);
        Ok(Some(roi_of(cx, cy, w, h, p0, p1, f)))
    }

    fn landmarks(&mut self, f: &Frame, roi: Roi) -> Result<(Vec<[f32; 3]>, f32)> {
        let tw = std::time::Instant::now(); let mut t = warp(f, roi, 256); for v in t.iter_mut() { *v /= 255.; }
        if std::env::var("FACETRACK_PROF").is_ok() { eprintln!("[prof] warp {:?}", tw.elapsed()); }
        let out = self.lmk.run(ort::inputs![Tensor::from_array((vec![1i64, 256, 256, 3], t))?])?;
        let (_, pts) = out[0].try_extract_tensor::<f32>()?; let (_, pr) = out[1].try_extract_tensor::<f32>()?;
        let pres = 1. / (1. + (-pr[0]).exp());
        let (c, s) = (roi.rot.cos(), roi.rot.sin()); let (ww, hh) = (roi.w * f.w as f32, roi.h * f.h as f32);
        let lm = (0..478).map(|i| {
            let (u, v) = (pts[i * 3] / 256. - 0.5, pts[i * 3 + 1] / 256. - 0.5);
            [roi.cx + (u * ww * c - v * hh * s) / f.w as f32, roi.cy + (u * ww * s + v * hh * c) / f.h as f32, pts[i * 3 + 2] / 256. * roi.w]
        }).collect();
        Ok((lm, pres))
    }

    fn blend(&mut self, lm: &[[f32; 3]], f: &Frame) -> Result<Vec<f32>> {
        let mut t = Vec::with_capacity(292); for &i in SUB.iter() { t.push(lm[i][0] * f.w as f32); t.push(lm[i][1] * f.h as f32); }
        let out = self.bsm.run(ort::inputs![Tensor::from_array((vec![1i64, 146, 2], t))?])?;
        let (_, b) = out[0].try_extract_tensor::<f32>()?; Ok(b.to_vec())
    }
}

fn anchors() -> Vec<(f32, f32)> {
    let mut a = Vec::with_capacity(896);
    for (stride, n) in [(8usize, 2usize), (16, 6)] { let g = 128 / stride; for y in 0..g { for x in 0..g { for _ in 0..n { a.push(((x as f32 + 0.5) / g as f32, (y as f32 + 0.5) / g as f32)); } } } }
    a
}
fn roi_of(cx: f32, cy: f32, w: f32, h: f32, p0: (f32, f32), p1: (f32, f32), f: &Frame) -> Roi {
    let rot = -(-(p1.1 - p0.1) * f.h as f32).atan2((p1.0 - p0.0) * f.w as f32);
    let rot = (rot + std::f32::consts::PI).rem_euclid(2. * std::f32::consts::PI) - std::f32::consts::PI;
    let side = (w * f.w as f32).max(h * f.h as f32) * 1.5;
    Roi { cx, cy, w: side / f.w as f32, h: side / f.h as f32, rot }
}
fn roi_from_landmarks(lm: &[[f32; 3]], f: &Frame) -> Roi {
    let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for p in lm { x0 = x0.min(p[0]); x1 = x1.max(p[0]); y0 = y0.min(p[1]); y1 = y1.max(p[1]); }
    roi_of((x0 + x1) / 2., (y0 + y1) / 2., x1 - x0, y1 - y0, (lm[33][0], lm[33][1]), (lm[263][0], lm[263][1]), f)
}
/// 旋轉的方形 ROI → size×size×3（雙線性，外面補 0），值 0–255
fn warp(f: &Frame, r: Roi, size: usize) -> Vec<f32> {
    let mut out = vec![0f32; size * size * 3];
    let (c, s) = (r.rot.cos(), r.rot.sin()); let (ww, hh) = (r.w * f.w as f32, r.h * f.h as f32);
    let (cxp, cyp) = (r.cx * f.w as f32, r.cy * f.h as f32);
    let px = |x: i64, y: i64, k: usize| -> f32 { if x < 0 || y < 0 || x >= f.w as i64 || y >= f.h as i64 { 0. } else { f.rgb[(y as usize * f.w + x as usize) * 3 + k] as f32 } };
    for j in 0..size {
        let v = (j as f32 + 0.5) / size as f32 - 0.5;
        for i in 0..size {
            let u = (i as f32 + 0.5) / size as f32 - 0.5;
            let x = cxp + u * ww * c - v * hh * s - 0.5; let y = cyp + u * ww * s + v * hh * c - 0.5;
            let (x0, y0) = (x.floor() as i64, y.floor() as i64); let (fx, fy) = (x - x0 as f32, y - y0 as f32);
            let o = (j * size + i) * 3;
            for k in 0..3 {
                out[o + k] = px(x0, y0, k) * (1. - fx) * (1. - fy) + px(x0 + 1, y0, k) * fx * (1. - fy) + px(x0, y0 + 1, k) * (1. - fx) * fy + px(x0 + 1, y0 + 1, k) * fx * fy;
            }
        }
    }
    out
}

fn procrustes(c: &[Vector3<f64>], p: &[Vector3<f64>], w: &[f64]) -> (f64, Matrix3<f64>) {
    let ws: f64 = w.iter().sum();
    let (mut mp, mut mc) = (Vector3::zeros(), Vector3::zeros());
    for i in 0..c.len() { mp += p[i] * (w[i] / ws); mc += c[i] * (w[i] / ws); }
    let (mut m, mut var) = (Matrix3::<f64>::zeros(), 0.);
    for i in 0..c.len() { let (pc, cc) = (p[i] - mp, c[i] - mc); m += (pc * cc.transpose()) * (w[i] / ws); var += cc.norm_squared() * (w[i] / ws); }
    let svd = m.svd(true, true); let (u, vt) = (svd.u.unwrap(), svd.v_t.unwrap());
    let d = if (u * vt).determinant() < 0. { -1. } else { 1. };
    let dm = Matrix3::from_diagonal(&Vector3::new(1., 1., d));
    let r = u * dm * vt; let s = (svd.singular_values[0] + svd.singular_values[1] + svd.singular_values[2] * d) / var;
    (s, r)
}
/// MediaPipe geometry_pipeline：螢幕地標 → 公制 → 對標準臉 Procrustes 的旋轉
fn head_rot(lm: &[[f32; 3]], w: f64, h: f64, canon: &[Vector3<f64>], basis: &[(usize, f64)]) -> Matrix3<f32> {
    let near = 1.; let ht = 2. * near * (63f64.to_radians() / 2.).tan(); let wd = ht * w / h; let (left, bottom) = (-wd / 2., -ht / 2.);
    let scr: Vec<Vector3<f64>> = lm.iter().map(|p| Vector3::new(p[0] as f64 * wd + left, (1. - p[1] as f64) * ht + bottom, p[2] as f64 * wd)).collect();
    let dz = scr.iter().map(|p| p.z).sum::<f64>() / scr.len() as f64;
    let cc: Vec<Vector3<f64>> = basis.iter().map(|(i, _)| canon[*i]).collect(); let ww: Vec<f64> = basis.iter().map(|(_, x)| *x).collect();
    let est = |l: &[Vector3<f64>]| { let pp: Vec<Vector3<f64>> = basis.iter().map(|(i, _)| l[*i]).collect(); procrustes(&cc, &pp, &ww) };
    let metric = |sc: f64| -> Vec<Vector3<f64>> { scr.iter().map(|p| { let z = (p.z - dz + near) / sc; Vector3::new(p.x * z / near, p.y * z / near, -z) }).collect() };
    let inter: Vec<Vector3<f64>> = scr.iter().map(|p| Vector3::new(p.x, p.y, -p.z)).collect();
    let s1 = est(&inter).0; let s2 = est(&metric(s1)).0; let r = est(&metric(s1 * s2)).1;
    r.cast::<f32>()
}
