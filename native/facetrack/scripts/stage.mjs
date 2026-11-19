// 把 kroom-facetrack 打包要用的東西放到 native/facetrack/dist/<os>/<arch>/：執行檔＋facetrack-models/＋ONNX Runtime（scripts/fetch_ort.py 抓的）＋授權檔。
//   Electron（desktop/package.json extraResources）和 Rust 版（desktop-rs/tauri.*.conf.json resources）都從這裡拿。
//   node native/facetrack/scripts/stage.mjs [--target aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc | --all] [--build] [--out <資料夾>]
//   --build：先 cargo build --release --target …（Windows 版要在 Windows 上建；缺的 Rust target 會自動 rustup target add）
//   --all：這台電腦能建的全部（Mac＝Apple 晶片＋Intel，給 universal App；Windows＝x64）
//   --out：放到哪裡（預設 native/facetrack/dist；Electron 版放 desktop/facetrack-dist，見 desktop/facetrack.mjs）
import { execFileSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const host = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const targets = process.argv.includes('--all') ? (process.platform === 'win32' ? ['x86_64-pc-windows-msvc'] : ['aarch64-apple-darwin', 'x86_64-apple-darwin']) : [arg('--target') ?? host];
const OUT = path.resolve(arg('--out') ?? path.join(ROOT, 'dist'));
for (const target of targets) stage(target);
function stage(target) {
  const T = { 'aarch64-apple-darwin': ['mac', 'arm64', 'mac-arm64', 'kroom-facetrack'], 'x86_64-apple-darwin': ['mac', 'x64', 'mac-x64', 'kroom-facetrack'], 'x86_64-pc-windows-msvc': ['win', 'x64', 'win-x64', 'kroom-facetrack.exe'] }[target];
  if (!T) throw new Error('不支援的 target：' + target);
  const [os, arch, ortDir, exe] = T;
  if (process.argv.includes('--build')) {
    try { execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' }); } catch { /* 沒有 rustup（例如系統套件裝的 Rust）：照樣試著建 */ }
    execFileSync('cargo', ['build', '--release', '--target', target, '--manifest-path', path.join(ROOT, 'Cargo.toml')], { stdio: 'inherit' });
  }
  const built = [path.join(ROOT, 'target', target, 'release', exe), path.join(ROOT, 'target', 'release', exe)].find((p) => fs.existsSync(p) && (target === host || p.includes(target)));
  if (!built) throw new Error('找不到建好的 ' + exe + '（先加 --build）');
  const ort = path.join(ROOT, 'ort', ortDir);
  if (!fs.existsSync(ort)) execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', path.join(ROOT, 'scripts', 'fetch_ort.py'), ortDir], { stdio: 'inherit' });   // (第一次：抓官方 ONNX Runtime)
  const out = path.join(OUT, os, arch); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(out, 'facetrack-models'), { recursive: true });
  fs.copyFileSync(built, path.join(out, exe)); fs.chmodSync(path.join(out, exe), 0o755);
  for (const f of fs.readdirSync(path.join(ROOT, 'models'))) fs.copyFileSync(path.join(ROOT, 'models', f), path.join(out, 'facetrack-models', f));
  for (const f of fs.readdirSync(ort)) { const dst = /LICENSE|Notices/.test(f) ? 'onnxruntime-' + f : f; fs.copyFileSync(path.join(ort, f), path.join(out, dst)); }
  fs.copyFileSync(path.join(ROOT, 'MODELS-LICENSE.txt'), path.join(out, 'facetrack-models', 'LICENSE.txt'));
  if (os === 'mac') macSign(out, exe);
  console.log('→', out, fs.readdirSync(out));
}
/** Mac：Apple 公證要求 App 裡每個執行檔都用 Developer ID 簽（hardened runtime＋時間戳）。Tauri 不會簽 Resources 裡的執行檔，所以這裡先簽好：
 *  CI 有 APPLE_CERTIFICATE（.p12，base64）＋APPLE_SIGNING_IDENTITY 時匯進暫時的 keychain 簽；FACETRACK_SIGN_IDENTITY=- 可以本機用 ad-hoc 試。
 *  （Electron 打包會自己把整個 App 簽一遍，這裡簽過也沒關係。） */
function macSign(out, exe) {
  const id = process.env.FACETRACK_SIGN_IDENTITY || (process.env.APPLE_CERTIFICATE && process.env.APPLE_SIGNING_IDENTITY) || '';
  if (!id) return;
  let kc = '';
  try {
    if (process.env.APPLE_CERTIFICATE && !process.env.FACETRACK_SIGN_IDENTITY) {
      kc = path.join(ROOT, 'target', 'facetrack-sign.keychain-db'); const pw = 'facetrack-' + Date.now(), p12 = path.join(ROOT, 'target', 'facetrack-sign.p12');
      fs.mkdirSync(path.dirname(kc), { recursive: true }); fs.writeFileSync(p12, Buffer.from(process.env.APPLE_CERTIFICATE, 'base64'));
      try { execFileSync('security', ['delete-keychain', kc], { stdio: 'ignore' }); } catch { /* 沒有舊的 */ }
      execFileSync('security', ['create-keychain', '-p', pw, kc]); execFileSync('security', ['unlock-keychain', '-p', pw, kc]);
      execFileSync('security', ['import', p12, '-k', kc, '-P', process.env.APPLE_CERTIFICATE_PASSWORD ?? '', '-T', '/usr/bin/codesign']);
      execFileSync('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', pw, kc], { stdio: 'ignore' });
      fs.rmSync(p12, { force: true });
    }
    const base = ['--force', '--options', 'runtime', '--sign', id, ...(id === '-' ? [] : ['--timestamp']), ...(kc ? ['--keychain', kc] : [])];
    for (const f of fs.readdirSync(out)) if (f.endsWith('.dylib')) execFileSync('codesign', [...base, path.join(out, f)], { stdio: 'inherit' });
    execFileSync('codesign', [...base, '--entitlements', path.join(ROOT, 'macos', 'facetrack.entitlements'), path.join(out, exe)], { stdio: 'inherit' });
    console.log('  簽好了（' + (id === '-' ? 'ad-hoc' : id) + '）');
  } finally { if (kc) try { execFileSync('security', ['delete-keychain', kc], { stdio: 'ignore' }); } catch { /* 已刪 */ } }
}
