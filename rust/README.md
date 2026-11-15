# K ROOM desktop app — Rust (Tauri 2)

The Rust version of `desktop/` (Electron): the website `play.kroom.tw` in its own window, without the browser's autoplay gate and background
throttling, plus everything only an app can do. Same page API (`window.kroomApp`, `desktop/preload.js`), same device ids, same `config.json` keys.
Windows uses the system's WebView2 (Chromium), a Mac its WKWebView (WebKit) — no browser engine is shipped, so the installer is a few MB instead of
~100 MB.

## What maps to what

| Electron (`desktop/`) | Here |
|---|---|
| `preload.js` → `window.kroomApp` / `kroomBilling` | `js/bridge.js` (main frame, K ROOM site only) → Rust commands in `src/cmds.rs`; `capabilities/default.json` lets only the K ROOM sites call them |
| `frame.executeJavaScript` into the Bilibili / YouTube / Twitch frames (volume, sync, 升降 Key, Twitch ▶) | `js/frames.js`, put into every frame; acts only inside a player's frame, only on `postMessage` from a K ROOM top window. Same code bodies (`js/keyshift.gen.js` is generated from `desktop/keyshift.js`) |
| `kroomfx://` (the key shifter's AudioWorklet past the players' CSP) | Windows: the players' embed pages come without their `script-src` policy (DevTools `Fetch` on those documents only, `src/win.rs`) → worklet, ~42 ms. Mac: ScriptProcessor fallback (as the iOS app) |
| command-line switches (autoplay, no throttling, unlock fps) | WebView2 browser arguments (`src/shell.rs`); Mac: `background_throttling(Disabled)` (macOS 14+) |
| `before-input-event` keys | Windows: WebView2 `AcceleratorKeyPressed` (works while a player's frame has the focus); Mac: menu items with ⌘ keys |
| permission handlers | WebView2 `PermissionRequested` (microphone for the K ROOM page only, everything else refused); Mac: WebKit + the Info.plist microphone text |
| `render-process-gone` / `did-fail-load` | WebView2 `ProcessFailed` / `NavigationCompleted`; Mac: `on_web_content_process_terminate` + a reachability check at start |
| `discord.js` | `src/discord.rs` (same IPC protocol, tokio) |
| `steam-integration.js` | `src/steam.rs`, cargo feature `steam` (steamworks crate) |
| device id (SMBIOS / IOPlatformUUID → sha256) | `src/device.rs` — identical ids (unit test against Electron's output) |
| electron-updater | tauri-plugin-updater, `latest.json` on the newest `vX.Y.Z-rust.N` release (`src/updates.rs`) |
| — | 🧪 App 測試版 → App 版本: switch between this app and the Electron one (`src/engine.rs`; the Electron side is in `desktop/main.js`) |
| user agent `KRoomDesktop/<v>` | `KRoomDesktop/<v> KRoomRust/<v>`: everything that knows the desktop app still does; the server's admin panel labels it (Rust) |

### Electron → Rust without the player noticing

`desktop/main.js` `toRust()` (the App 版本 switch; also what a later "move everybody" release would call): downloads the newest `-rust` release,
writes into the Rust app's `config.json` a one-time sign-in code made by its signed-in page (`/api/auth/app/code`, 2 min, once), the room record
and its device id, installs the Rust app silently (Windows `KRoom-rust-Setup.exe /S`; a Mac: its `K ROOM.app` replaced in place) and starts it,
then quits. The Rust app claims the code on its first page (no question asked: it came from this computer's own file, not from a link), restores
the room, keeps the device id (`hwId`; and merges the rest of the Electron `config.json` / `window.json` once, key by key) and, on Windows, copies
the Electron app's localStorage on its first start.

Back to Electron (`src/engine.rs`, the same switch): the newest normal Electron release is installed silently (Windows `KRoom-Setup.exe /S`, then
its own exe started and the `K ROOM` shortcuts pointed back at it — not `--force-run`, which would start the shortcut the Rust installer took; a
Mac: the bundle replaced in place), with the same handoff into the Electron app's `config.json` (read by `desktop/main.js` `engineHandoff`, Electron
1.0.16+). Both directions: one switch at a time; a signed-in player whose sign-in code cannot be made stays on the app they are on; the code is made
after the install (it lasts 2 minutes) and the site goes along with it.

Known differences on a Mac (WKWebView): no 解除螢幕更新率限制 (the page hides the switch), background throttling stays on before macOS 14, the
key shifter uses the ScriptProcessor fallback (~127 ms, on the player's thread), and nothing from the Electron app's browser storage can be moved
over (a Mac switched with the App 版本 switch stays signed in through the handoff below). Windows moves `config.json`, `window.json` and the page's
localStorage over on the first start; cookies are not copied — the handoff below signs the player in instead.

## Speed (measured on Windows against Electron 1.0.13, same PC and page — `tests/bench*.mjs`, `tests/bench-window.ps1`)

- Window on screen: ~100 ms (Electron ~1.1 s: it waits for the page's first paint). Page ready: ~1.1 s in both.
- In the game: the same — frame rate, JavaScript, memory (both are Chromium on Windows).
- Idle CPU about half; page load once started ~10% faster; installer 2 MB instead of 115 MB, 6 MB on disk instead of 370 MB.
- The ~0.6 s before the page starts is WebView2 booting (our own start-up is ~30 ms; no browser argument changed it). The ~0.4 s after the
  HTML arrives is the site's own JavaScript running (everything comes from the cache) — only a lighter front page would shorten that, in both apps.

## Develop

```
npm install
node scripts/gen-scripts.mjs   # after desktop/keyshift.js changes
npx tauri dev                   # or: cargo build && target/debug/kroom.exe
```

Useful while developing (debug builds only): `--url=https://…` or `KROOM_START_URL` (another server), `KROOM_DEBUG_PORT=9333` (DevTools protocol
port), `KROOM_TEST_LOG=1`, `KROOM_TEST_PRINT_LOGIN=1`, `KROOM_TEST_CONFIRM=yes|no`.

End-to-end check against the real site (Windows): start `KROOM_DEBUG_PORT=9333 target/debug/kroom.exe`, then `node desktop-rs/tests/app-e2e.mjs`
from the repo root (22 checks: bridge API, device id, permissions, window state, YouTube key shift in a worklet, Bilibili volume / sync, Twitch).

### Building on Windows without Visual Studio

CI builds with MSVC. Locally the `x86_64-pc-windows-gnu` toolchain works with `.cargo/config.toml` (links with Rust's own `rust-lld`) plus, on
`PATH`, a `dlltool` that forwards to `llvm-dlltool` (rustup `llvm-tools`; GNU dlltool needs an assembler) and a `windres` that turns tauri-build's
resource script into a `.res` — small shims kept in `~/.kroom-toolchain/` on the machine this was written on.

## Release (in the kroomapp repo this folder is `rust/`)

1. Set the version in `Cargo.toml` and `package.json` (`2.0.0-rust.N` while it is a test version).
2. Push the tag `v2.0.0-rust.N` → `.github/workflows/release-rust.yml` builds Windows + Mac and publishes a **pre-release** with
   `KRoom-rust-Setup.exe`, `KRoom-rust-mac.dmg`, the signed update files and `latest.json`.

Secrets: `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) — the private half of the updater key in `tauri.conf.json` (`plugins.updater.pubkey`); the Mac
uses the Electron build's `CSC_LINK` / `APPLE_*` secrets.

GitHub lists releases by version, so a `2.x-rust` release always comes before every Electron 1.x, whatever was published last. An Electron app
before 1.0.16 with App 測試版 on takes that first release and looks for `latest.yml` / `latest-mac.yml` in it — so the workflow also copies the
newest Electron release's update files (`latest*.yml`, `KRoom-Setup.exe`, `KRoom-mac.zip` + blockmaps) into each Rust release. Such an app then
updates to that Electron version; from 1.0.16 on, Electron skips the Rust releases itself. The Rust app reads only `latest.json`.
