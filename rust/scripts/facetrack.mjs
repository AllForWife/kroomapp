// tauri build 之前（tauri.macos.conf.json／tauri.windows.conf.json 的 beforeBuildCommand）：建原生臉部追蹤並放到 ../native/facetrack/dist/<os>/<arch>/，
//   bundle.resources 從那裡拿（主專案 desktop-rs/ 與 kroomapp 的 rust/ 都在 native/ 旁邊）。路徑都從這個檔案的位置算，跟在哪裡執行無關。
import { execFileSync } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(HERE, '..', '..', 'native', 'facetrack', 'scripts', 'stage.mjs'), '--build', '--all'], { stdio: 'inherit' });
