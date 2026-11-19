// NVIDIA AR SDK（Maxine）臉部表情：只限 Windows＋RTX（Turing 以後、有 Tensor Core）。
//   我們不附 NVIDIA 的檔案：使用者自己從 NVIDIA 的 End-user Redistributables 頁面裝「AR SDK」執行環境，這裡執行時找到它的 DLL 再動態載入。
//   找的地方：環境變數 NV_AR_SDK_PATH → %ProgramFiles%\NVIDIA Corporation\NVIDIA AR SDK；或 --nvar-dir 指定。
//   API 跟 NVIDIA 官方範例 ExpressionApp（github.com/NVIDIA-Maxine/AR-SDK-Samples）同一套：FaceExpressions 功能、輸入 GPU 上的 BGR 影像、
//   輸出 53 個表情係數（ARKit 名稱的 _L/_R 版本）＋頭的旋轉（四元數）。
//   ⚠ 開發端沒有 Windows＋RTX，這段只有編譯檢查，要實機確認。
use crate::face::{FaceOut, Frame};
use anyhow::Result;

#[allow(dead_code)]
/// NVIDIA 的 53 個表情 → ARKit 名稱（browInnerUp、cheekPuff 左右合併成一個）
pub const NV_NAMES: [&str; 53] = [
    "browDown_L", "browDown_R", "browInnerUp_L", "browInnerUp_R", "browOuterUp_L", "browOuterUp_R", "cheekPuff_L", "cheekPuff_R", "cheekSquint_L",
    "cheekSquint_R", "eyeBlink_L", "eyeBlink_R", "eyeLookDown_L", "eyeLookDown_R", "eyeLookIn_L", "eyeLookIn_R", "eyeLookOut_L", "eyeLookOut_R",
    "eyeLookUp_L", "eyeLookUp_R", "eyeSquint_L", "eyeSquint_R", "eyeWide_L", "eyeWide_R", "jawForward", "jawLeft", "jawOpen", "jawRight", "mouthClose",
    "mouthDimple_L", "mouthDimple_R", "mouthFrown_L", "mouthFrown_R", "mouthFunnel", "mouthLeft", "mouthLowerDown_L", "mouthLowerDown_R",
    "mouthPress_L", "mouthPress_R", "mouthPucker", "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
    "mouthSmile_L", "mouthSmile_R", "mouthStretch_L", "mouthStretch_R", "mouthUpperUp_L", "mouthUpperUp_R", "noseSneer_L", "noseSneer_R",
];
#[allow(dead_code)]
pub fn to_arkit(v: &[f32]) -> Vec<(&'static str, f32)> {
    let mut out: Vec<(&'static str, f32)> = Vec::with_capacity(52);
    let mut i = 0;
    while i < NV_NAMES.len().min(v.len()) {
        let n = NV_NAMES[i];
        if n == "browInnerUp_L" || n == "cheekPuff_L" { out.push((if n.starts_with("brow") { "browInnerUp" } else { "cheekPuff" }, (v[i] + v.get(i + 1).copied().unwrap_or(0.)) / 2.)); i += 2; continue; }
        out.push((arkit_name(n), v[i])); i += 1;
    }
    out
}
#[allow(dead_code)]
fn arkit_name(n: &'static str) -> &'static str {
    // browDown_L → browDownLeft（靜態字串表，免得每幀配置）
    crate::face::MP_NAMES.iter().copied().find(|m| { let b = n.trim_end_matches("_L").trim_end_matches("_R"); let side = if n.ends_with("_L") { "Left" } else if n.ends_with("_R") { "Right" } else { "" }; m.len() == b.len() + side.len() && m.starts_with(b) && m.ends_with(side) }).unwrap_or(n)
}

#[cfg(windows)]
pub use win::NvFace;

#[cfg(not(windows))]
pub struct NvFace;
#[cfg(not(windows))]
impl NvFace {
    pub fn new(_dir: Option<&str>) -> Result<Self> { Err(anyhow::anyhow!("NVIDIA AR SDK 只有 Windows 版")) }
    pub fn process(&mut self, _f: &Frame) -> Result<Option<FaceOut>> { Ok(None) }
}

#[cfg(windows)]
mod win {
    use super::*;
    use anyhow::{anyhow, bail};
    use libloading::{Library, Symbol};
    use nalgebra::{Matrix3, UnitQuaternion, Quaternion};
    use std::ffi::{CString, c_char, c_void};
    use std::path::PathBuf;

    #[repr(C)]
    pub struct NvCVImage { width: u32, height: u32, pitch: i32, pixel_format: i32, component_type: i32, pixel_bytes: u8, component_bytes: u8, num_components: u8, planar: u8, gpu_mem: u8, colorspace: u8, reserved: [u8; 2], pixels: *mut c_void, delete_ptr: *mut c_void, delete_proc: *mut c_void, buffer_bytes: u64 }
    const _: () = assert!(std::mem::size_of::<NvCVImage>() == 64);
    #[repr(C)] #[derive(Clone, Copy, Default)] struct Rect { x: f32, y: f32, w: f32, h: f32 }
    #[repr(C)] struct BBoxes { boxes: *mut Rect, num_boxes: u8, max_boxes: u8 }
    #[repr(C)] #[derive(Clone, Copy, Default)] struct P2 { x: f32, y: f32 }
    #[repr(C)] #[derive(Clone, Copy, Default)] struct P3 { x: f32, y: f32, z: f32 }
    #[repr(C)] #[derive(Clone, Copy, Default)] struct Quat { x: f32, y: f32, z: f32, w: f32 }
    const NVCV_BGR: i32 = 5; const NVCV_U8: i32 = 1; const NVCV_CHUNKY: u32 = 0; const NVCV_CPU: u32 = 0; const NVCV_GPU: u32 = 1;
    type H = *mut c_void;
    type FCreate = unsafe extern "C" fn(*const c_char, *mut H) -> i32;
    type FH = unsafe extern "C" fn(H) -> i32;
    type FSetStr = unsafe extern "C" fn(H, *const c_char, *const c_char) -> i32;
    type FSetU32 = unsafe extern "C" fn(H, *const c_char, u32) -> i32;
    type FGetU32 = unsafe extern "C" fn(H, *const c_char, *mut u32) -> i32;
    type FSetF32A = unsafe extern "C" fn(H, *const c_char, *mut f32, i32) -> i32;
    type FSetObj = unsafe extern "C" fn(H, *const c_char, *mut c_void, u32) -> i32;
    type FSetStream = unsafe extern "C" fn(H, *const c_char, *mut c_void) -> i32;
    type FStreamCreate = unsafe extern "C" fn(*mut *mut c_void) -> i32;
    type FImgAlloc = unsafe extern "C" fn(*mut NvCVImage, u32, u32, i32, i32, u32, u32, u32) -> i32;
    type FImgInit = unsafe extern "C" fn(*mut NvCVImage, u32, u32, i32, *mut c_void, i32, i32, u32, u32) -> i32;
    type FImgXfer = unsafe extern "C" fn(*const NvCVImage, *mut NvCVImage, f32, *mut c_void, *mut NvCVImage) -> i32;

    pub struct NvFace {
        _ar: Library, _img: Library, h: H, stream: *mut c_void, run: FH, xfer: FImgXfer, init: FImgInit, alloc: FImgAlloc,
        gpu: Box<NvCVImage>, cpu: Box<NvCVImage>, bgr: Vec<u8>, w: u32, ht: u32,
        expr: Vec<f32>, pose: Box<Quat>, _bb: Box<BBoxes>, _bbd: Vec<Rect>, _lm: Vec<P2>, _lm3: Vec<P3>, _conf: Vec<f32>, intr: [f32; 3], loaded: bool,
    }
    fn sdk_dir(d: Option<&str>) -> Option<PathBuf> {
        let mut c: Vec<PathBuf> = Vec::new();
        if let Some(d) = d { c.push(d.into()); }
        if let Ok(p) = std::env::var("NV_AR_SDK_PATH") { c.push(p.into()); }
        if let Ok(p) = std::env::var("ProgramFiles") { c.push(PathBuf::from(p).join("NVIDIA Corporation").join("NVIDIA AR SDK")); }
        c.into_iter().flat_map(|p| [p.clone(), p.join("bin")]).find(|p| p.join("nvARPose.dll").exists())
    }
    fn cs(s: &str) -> CString { CString::new(s).unwrap() }
    fn ok(e: i32, what: &str) -> Result<()> { if e == 0 { Ok(()) } else { Err(anyhow!("NVIDIA AR SDK {what} 失敗（錯誤碼 {e}）")) } }

    impl NvFace {
        pub fn new(dir: Option<&str>) -> Result<Self> {
            let d = sdk_dir(dir).ok_or_else(|| anyhow!("找不到 NVIDIA AR SDK（請先安裝 NVIDIA 的 AR SDK 執行環境）"))?;
            let models = [d.join("models"), d.join("..").join("models")].into_iter().find(|p| p.exists()).ok_or_else(|| anyhow!("NVIDIA AR SDK 沒有 models 資料夾"))?;
            unsafe {
                let img = Library::new(d.join("NVCVImage.dll"))?; let ar = Library::new(d.join("nvARPose.dll"))?;
                macro_rules! sym { ($l:expr, $t:ty, $n:expr) => {{ let s: Symbol<$t> = $l.get($n)?; *s }} }
                let create = sym!(ar, FCreate, b"NvAR_Create\0"); let load = sym!(ar, FH, b"NvAR_Load\0"); let run = sym!(ar, FH, b"NvAR_Run\0");
                let set_str = sym!(ar, FSetStr, b"NvAR_SetString\0"); let set_u32 = sym!(ar, FSetU32, b"NvAR_SetU32\0"); let get_u32 = sym!(ar, FGetU32, b"NvAR_GetU32\0");
                let set_f32a = sym!(ar, FSetF32A, b"NvAR_SetF32Array\0"); let set_obj = sym!(ar, FSetObj, b"NvAR_SetObject\0");
                let set_stream = sym!(ar, FSetStream, b"NvAR_SetCudaStream\0"); let stream_create = sym!(ar, FStreamCreate, b"NvAR_CudaStreamCreate\0");
                let alloc = sym!(img, FImgAlloc, b"NvCVImage_Alloc\0"); let init = sym!(img, FImgInit, b"NvCVImage_Init\0"); let xfer = sym!(img, FImgXfer, b"NvCVImage_Transfer\0");
                let mut h: H = std::ptr::null_mut(); ok(create(cs("FaceExpressions").as_ptr(), &mut h), "Create")?;
                let mut stream: *mut c_void = std::ptr::null_mut(); ok(stream_create(&mut stream), "CudaStreamCreate")?;
                ok(set_str(h, cs("NvAR_Parameter_Config_ModelDir").as_ptr(), cs(&models.to_string_lossy()).as_ptr()), "ModelDir")?;
                ok(set_stream(h, cs("NvAR_Parameter_Config_CUDAStream").as_ptr(), stream), "CUDAStream")?;
                let _ = set_u32(h, cs("NvAR_Parameter_Config_Temporal").as_ptr(), 0xFFFF_FFFF);   // (時間平滑全開；不認得就照預設)
                let _ = set_u32(h, cs("NvAR_Parameter_Config_PoseMode").as_ptr(), 0);
                ok(load(h), "Load")?;
                let mut n = 0u32; ok(get_u32(h, cs("NvAR_Parameter_Config_ExpressionCount").as_ptr(), &mut n), "ExpressionCount")?;
                let mut s = NvFace {
                    _ar: ar, _img: img, h, stream, run, xfer, init, alloc,
                    gpu: Box::new(std::mem::zeroed()), cpu: Box::new(std::mem::zeroed()), bgr: Vec::new(), w: 0, ht: 0,
                    expr: vec![0.; n.max(53) as usize], pose: Box::new(Quat::default()), _bb: Box::new(BBoxes { boxes: std::ptr::null_mut(), num_boxes: 0, max_boxes: 25 }), _bbd: vec![Rect::default(); 25],
                    _lm: vec![P2::default(); 126], _lm3: vec![P3::default(); 126], _conf: vec![0.; 126], intr: [0.; 3], loaded: false,
                };
                s._bb.boxes = s._bbd.as_mut_ptr();
                ok(set_obj(h, cs("NvAR_Parameter_Output_BoundingBoxes").as_ptr(), &mut *s._bb as *mut _ as *mut c_void, std::mem::size_of::<BBoxes>() as u32), "BoundingBoxes")?;
                ok(set_obj(h, cs("NvAR_Parameter_Output_Landmarks").as_ptr(), s._lm.as_mut_ptr() as *mut c_void, std::mem::size_of::<P2>() as u32), "Landmarks")?;
                let _ = set_obj(h, cs("NvAR_Parameter_Output_Landmarks3d").as_ptr(), s._lm3.as_mut_ptr() as *mut c_void, std::mem::size_of::<P3>() as u32);
                ok(set_f32a(h, cs("NvAR_Parameter_Output_LandmarksConfidence").as_ptr(), s._conf.as_mut_ptr(), 126), "LandmarksConfidence")?;
                ok(set_f32a(h, cs("NvAR_Parameter_Output_ExpressionCoefficients").as_ptr(), s.expr.as_mut_ptr(), n as i32), "ExpressionCoefficients")?;
                ok(set_obj(h, cs("NvAR_Parameter_Output_Pose").as_ptr(), &mut *s.pose as *mut _ as *mut c_void, std::mem::size_of::<Quat>() as u32), "Pose")?;
                // 輸入影像跟相機參數要等知道畫面大小才設（第一幀）
                let _ = (set_obj, set_f32a);
                Ok(s)
            }
        }
        unsafe fn setup(&mut self, w: u32, h: u32) -> Result<()> {
            unsafe {
                ok((self.alloc)(&mut *self.gpu, w, h, NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_GPU, 1), "影像配置")?;
                let ar = &self._ar;
                let set_obj: Symbol<FSetObj> = ar.get(b"NvAR_SetObject\0")?; let set_f32a: Symbol<FSetF32A> = ar.get(b"NvAR_SetF32Array\0")?;
                ok(set_obj(self.h, cs("NvAR_Parameter_Input_Image").as_ptr(), &mut *self.gpu as *mut _ as *mut c_void, std::mem::size_of::<NvCVImage>() as u32), "Input_Image")?;
                self.intr = [h as f32, w as f32 / 2., h as f32 / 2.];   // (焦距不知道時的估法，跟官方範例一樣)
                let _ = set_f32a(self.h, cs("NvAR_Parameter_Input_CameraIntrinsicParams").as_ptr(), self.intr.as_mut_ptr(), 3);
                // 參數改了要重新 Load
                let load: Symbol<FH> = ar.get(b"NvAR_Load\0")?; ok(load(self.h), "Load")?;
            }
            self.w = w; self.ht = h; self.bgr = vec![0; (w * h * 3) as usize]; self.loaded = true; Ok(())
        }
        pub fn process(&mut self, f: &Frame) -> Result<Option<FaceOut>> {
            if !self.loaded || self.w != f.w as u32 || self.ht != f.h as u32 { if self.loaded { bail!("畫面大小變了"); } unsafe { self.setup(f.w as u32, f.h as u32)?; } }
            for (d, s) in self.bgr.chunks_exact_mut(3).zip(f.rgb.chunks_exact(3)) { d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; }
            unsafe {
                ok((self.init)(&mut *self.cpu, self.w, self.ht, (self.w * 3) as i32, self.bgr.as_mut_ptr() as *mut c_void, NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_CPU), "影像包裝")?;
                ok((self.xfer)(&*self.cpu, &mut *self.gpu, 1.0, self.stream, std::ptr::null_mut()), "影像傳到 GPU")?;
                ok((self.run)(self.h), "Run")?;
            }
            if self._bb.num_boxes == 0 { return Ok(None); }
            let q = *self.pose; let r = UnitQuaternion::from_quaternion(Quaternion::new(q.w, q.x, q.y, q.z)).to_rotation_matrix();
            let rot: Matrix3<f32> = *r.matrix();   // ⚠ NVIDIA 的頭部姿勢座標系（x 右、y 上、z 朝鏡頭？）要實機確認
            Ok(Some(FaceOut { rot, blend: to_arkit(&self.expr) }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nv_names_map_to_arkit() {
        let v: Vec<f32> = (0..53).map(|i| i as f32).collect(); let a = to_arkit(&v);
        assert_eq!(a.len(), 51);
        assert!(a.iter().any(|(n, x)| *n == "browInnerUp" && (*x - 2.5).abs() < 1e-6));
        assert!(a.iter().any(|(n, x)| *n == "eyeBlinkLeft" && (*x - 10.).abs() < 1e-6));
        assert!(a.iter().any(|(n, x)| *n == "noseSneerRight" && (*x - 52.).abs() < 1e-6));
        assert!(a.iter().any(|(n, _)| *n == "jawOpen"));
    }
}
