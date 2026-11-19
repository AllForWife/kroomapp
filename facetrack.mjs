// 打包前：建原生臉部追蹤（kroom-facetrack，VTuber 演出用）並放進 facetrack-dist/<os>/<arch>/（package.json extraResources 從這裡拿）。
//   程式在 native/facetrack：主專案是 ../native/facetrack，kroomapp repo（這個資料夾就是根目錄）是 ./native/facetrack。
//   node facetrack.mjs          這台電腦的平台（Mac＝Apple 晶片＋Intel 兩種，給 universal App；Windows＝x64）
//   要 Rust（cargo、rustup）和 Python 3；ONNX Runtime 第一次會自動從 PyPI 下載微軟官方版。
import { execFileSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = [path.join(HERE, '..', 'native', 'facetrack'), path.join(HERE, 'native', 'facetrack')].find((p) => fs.existsSync(path.join(p, 'Cargo.toml')));
if (!src) { console.error('找不到 native/facetrack（原生臉部追蹤的程式）'); process.exit(1); }
execFileSync(process.execPath, [path.join(src, 'scripts', 'stage.mjs'), '--build', '--all', '--out', path.join(HERE, 'facetrack-dist')], { stdio: 'inherit' });
