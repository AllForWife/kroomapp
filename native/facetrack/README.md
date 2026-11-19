# kroom-facetrack — 原生臉部追蹤（VTuber 演出，App 限定）

K ROOM 桌面版（Electron 與 Rust 兩版都有）附的子程式：攝影機 → 臉部辨識 → **VMC**（OSC/UDP，只送 127.0.0.1）→ App 本來就有的 VMC 接收 → 舞台。
不經過瀏覽器，所以 GPU 用得穩、也不佔遊戲畫面的執行緒。規格：`docs/VTUBER-PERFORMER-SPEC.md` §5.1。

## 後端（`--backend auto` 會自己挑）

| 後端 | 平台 | 說明 |
|---|---|---|
| `nvidia` | Windows＋RTX（Turing 以後） | NVIDIA AR SDK（Maxine）的 FaceExpressions。**我們不附 NVIDIA 的檔案**：使用者自己從 NVIDIA 的 End-user Redistributables 頁面裝 AR SDK 執行環境，這裡找 `NV_AR_SDK_PATH`／`%ProgramFiles%\NVIDIA Corporation\NVIDIA AR SDK` 動態載入。auto 時有裝就優先用。⚠ 開發端沒有 Windows＋RTX，這段只做過編譯檢查。 |
| `directml` | Windows（任何 DX12 顯卡） | ONNX Runtime 的 DirectML（微軟官方 onnxruntime-directml 1.24.4） |
| `coreml` | Mac | ONNX Runtime 的 CoreML（ML Program） |
| `cpu` | 全部 | ONNX Runtime CPU（一個模型一條執行緒） |

auto＝NVIDIA（有的話）→ 其他後端各跑幾次假畫面、挑最快的，結果記在暫存資料夾的 `kroom-facetrack-auto.json`（換 ONNX Runtime 版本才重比；`FACETRACK_REBENCH=1` 強制重比）。
實測（Apple M 系列）：CPU 每幀約 8–9 ms、CoreML 約 27 ms（這些小模型丟到 GPU／Neural Engine 反而慢），所以 Mac 上通常選 CPU。

## 模型

`models/`：MediaPipe FaceLandmarker（Apache 2.0，見 `MODELS-LICENSE.txt`）的三個模型轉成 ONNX＋標準臉（Procrustes 用）。
轉換與驗證工具在 `tools/`（Python 3.11 venv：tf2onnx、onnxruntime、mediapipe）：
- `ref.py`：ONNX 管線的 Python 參考實作，跟 MediaPipe 本身逐項比對（地標誤差 0.5–0.8 px；blendshape 模型輸入相同時誤差 0；頭部旋轉照 MediaPipe 的 geometry pipeline 算，誤差 0.000°）
- `geom.py`：從 `geometry_pipeline_metadata_landmarks.binarypb` 取出標準臉 → `canonical.json`
- `prep.py`（＋`pads.py`、`rename.py`）：批次固定 1、auto_pad 改明確 pads、名稱換成安全識別字（CoreML ML Program 需要）
- `opt.py`：PRelu → Max/Min（實驗用：CoreML 不吃 PRelu；最後沒採用，因為 CPU 版會慢一點）

## 建置與打包

```bash
python3 native/facetrack/scripts/fetch_ort.py          # 微軟官方 ONNX Runtime → ort/<平台>/（不進版控）
node native/facetrack/scripts/stage.mjs --build         # 建＋放到 dist/<os>/<arch>/（Mac 兩種架構：--target aarch64-apple-darwin／x86_64-apple-darwin）
```
`desktop/package.json` 的 `predist*`／`prerelease*` 與 `desktop-rs/package.json` 的 `prebuild` 會自動跑；Windows 版要在 Windows 上建。
打包後的位置：Electron `resources/facetrack/<arch>/`、Rust 版資源資料夾的 `facetrack/<arch>/`。

## 用法

```
kroom-facetrack [--port 39539] [--camera 0] [--backend auto|nvidia|onnx|coreml|directml|cpu] [--mirror]
kroom-facetrack --image <照片> [--bench N] [--send <埠>]     # 測試：辨識照片
kroom-facetrack --fake-camera <照片> [--port …]               # 測試：照片當攝影機
kroom-facetrack --list-cameras
```
stdout 每行一個 JSON：`{"t":"ready","backend":"onnx-cpu","tried":[…]}`、`{"t":"stat","fps":…,"ms":…,"face":true}`、`{"t":"error","e":…}`。stdin 送 `stop` 或關掉＝結束。

送出的 VMC：`Neck`、`Head` 骨（Unity 座標的區域旋轉，各一半）＋ 51 個 ARKit blendshape（MediaPipe 的 52 個去掉 `_neutral`）＋ `Apply`。

測試：`node tests/vtlive-facetrack-native.mjs`（照片 → 結果跟 MediaPipe 比、VMC → frameToPose）、`node tests/vtlive-facetrack-app-browser.mjs`（頁面 → App 橋 → 子程式 → VMC → 姿勢）。
