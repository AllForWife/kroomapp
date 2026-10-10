// K ROOM for Windows: the website in its own Chromium window. What it changes against a browser tab:
//  - sound plays at once (no 「點一下開啟聲音」: the autoplay gate is off)
//  - nothing is slowed down in the background (timers, rendering, a minimised / covered window) — the song's drift correction and the voices keep time
//  - the dedicated GPU is preferred, and the GPU is not blocklisted for the site after a GPU crash (fewer 「無法啟動 3D」)
//  - the microphone is allowed for the K ROOM site only; links to other sites open in the normal browser
// The server address: --url=https://… > env KROOM_URL > %APPDATA%/K ROOM/config.json {"url": "…"} > DEFAULT_URL
const { app, BrowserWindow, session, shell, Menu, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://ktv2.548754321.xyz';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.disableDomainBlockingFor3DAPIs();
app.setAppUserModelId('xyz.548754321.kroom');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJson = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch { /* read-only profile: not remembered */ } };
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function startUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  const raw = (arg && arg.slice(6)) || process.env.KROOM_URL || readJson(configFile()).url || DEFAULT_URL;
  try { const u = new URL(raw); if (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.href; } catch { /* not a URL */ }
  return DEFAULT_URL;
}
const START = startUrl();
const ORIGIN = new URL(START).origin;

const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const isApp = (u) => originOf(u) === ORIGIN;
/** Google sign-in (popup or redirect mode) has to happen inside the app: its answer goes back to this window / this cookie jar */
const isGoogleAuth = (u) => { try { const h = new URL(u).hostname; return h === 'accounts.google.com' || h === 'accounts.youtube.com' || h.endsWith('.google.com'); } catch { return false; } };
const openOutside = (u) => { if (/^https?:\/\//i.test(u)) void shell.openExternal(u); };

// Google refuses to sign in inside "embedded browsers" it recognises by the user agent: present the plain Chrome one (+ a marker the site can read)
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|kroom-desktop|K ?ROOM)\/\S+/gi, '') + ` KRoomDesktop/${app.getVersion()}`;

const firstInstance = app.requestSingleInstanceLock(); // a second start only brings the open window forward
if (!firstInstance) app.quit();
let win = null;

/* ---- 用瀏覽器登入: the page asks (preload.js) → the normal browser opens <site>/?applogin=<state> → signed in there, one click makes a one-time code
   (server/accounts.mjs) and opens kroom://login?code=…&state=… → Windows starts this app again with that link (second-instance) → the window opens
   <site>/api/auth/app/claim?code=…&state=… and gets its own session. Only the state this app just made is accepted, so a kroom:// link from
   anywhere else does nothing.
   The admin login (Ctrl+Shift+A) goes the same way: <site>/admin/applogin?state=… (server/admin.mjs) → kroom://admin?… → <site>/admin/appclaim. ---- */
const LOGIN_MS = 10 * 60_000;
const HANDOFF = { // kroom://<kind> → where the browser starts, where the app claims
  login: { start: (s) => `/?applogin=${s}`, claim: '/api/auth/app/claim' },
  admin: { start: (s) => `/admin/applogin?state=${s}`, claim: '/admin/appclaim' },
};
const pending = {}; // kind → { state, at }
if (app.isPackaged) app.setAsDefaultProtocolClient('kroom');
else app.setAsDefaultProtocolClient('kroom', process.execPath, [path.resolve(process.argv[1] || '.')]);
function deepLink(argv) {
  const raw = argv.find((a) => /^kroom:\/\//i.test(a)); if (!raw) return;
  let u; try { u = new URL(raw); } catch { return; }
  const kind = u.hostname, p = pending[kind], state = u.searchParams.get('state'), code = u.searchParams.get('code');
  if (!HANDOFF[kind] || !p || !state || !code || state !== p.state || Date.now() - p.at > LOGIN_MS) return;
  delete pending[kind];
  if (win) void win.loadURL(`${ORIGIN}${HANDOFF[kind].claim}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}
/** open the normal browser for a hand-off (kind: 'login' | 'admin') */
function handoff(kind) {
  const state = crypto.randomBytes(24).toString('base64url'); pending[kind] = { state, at: Date.now() };
  const url = ORIGIN + HANDOFF[kind].start(state);
  if (process.env.KROOM_TEST_PRINT_LOGIN) console.log(`HANDOFF_URL ${kind} ${url}`); // (tests: the browser is played by the test)
  else void shell.openExternal(url);
  return true;
}
app.on('second-instance', (_e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } deepLink(argv); });
ipcMain.handle('login-with-browser', (e) => originOf(e.senderFrame?.url || '') === ORIGIN && handoff('login'));
function guard(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isGoogleAuth(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, parent: win || undefined } };
    if (isApp(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (isApp(url) || isGoogleAuth(url) || url.startsWith('file:')) return;
    e.preventDefault(); openOutside(url);
  });
}

function permissions(ses) {
  // the K ROOM page: microphone (no camera), fullscreen, pointer lock (mouse look), clipboard writes; embedded players (YouTube, Bilibili…): fullscreen only
  const ok = (perm, url, media) => {
    if (perm === 'fullscreen') return true;
    if (!isApp(url)) return false;
    if (perm === 'media') return !(media || []).includes('video');
    return perm === 'pointerLock' || perm === 'clipboard-sanitized-write' || perm === 'keyboardLock' || perm === 'speaker-selection';
  };
  ses.setPermissionRequestHandler((wc, perm, cb, d) => cb(ok(perm, d.requestingUrl || wc.getURL(), d.mediaTypes)));
  // (the check also decides whether the page may see the microphones' names and ids — without it 使用的麥克風 listed nothing; the origin may come
  //  with a trailing slash, so it is compared as an origin)
  ses.setPermissionCheckHandler((wc, perm, origin, d) => {
    const from = (d && (d.securityOrigin || d.requestingUrl)) || origin;
    return perm === 'media' ? isApp(from) || isApp(origin) : ok(perm, from);
  });
}

const SCROLLBARS = `
::-webkit-scrollbar { width: 8px; height: 8px; background: transparent; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .16); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, .32); }
::-webkit-scrollbar-button { display: none; }`;

function createWindow() {
  const st = readJson(stateFile());
  win = new BrowserWindow({
    width: st.width || 1280, height: st.height || 800, x: st.x, y: st.y, minWidth: 640, minHeight: 400,
    backgroundColor: '#07060d', autoHideMenuBar: true, title: 'K ROOM', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => { const b = win.getNormalBounds(); writeJson(stateFile(), { ...b, maximized: win.isMaximized() }); });
  win.on('closed', () => { win = null; });

  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (i.key === 'F5' || (i.control && i.key.toLowerCase() === 'r' && i.shift)) { e.preventDefault(); win.webContents.reloadIgnoringCache(); }
    else if (i.key === 'F12' || (i.control && i.shift && i.key.toLowerCase() === 'i')) { e.preventDefault(); win.webContents.toggleDevTools(); }
    // Ctrl+Shift+A = admin login through the normal browser (logged in there as an admin → one click there); no address bar: Alt+Home = the game, Alt+← = back
    else if (i.control && i.shift && i.key.toLowerCase() === 'a') { e.preventDefault(); handoff('admin'); }
    else if (i.alt && i.key === 'Home') { e.preventDefault(); void win.loadURL(ORIGIN + '/'); }
    else if (i.alt && i.key === 'ArrowLeft' && win.webContents.navigationHistory.canGoBack()) { e.preventDefault(); win.webContents.navigationHistory.goBack(); }
  });
  // Electron draws Windows' old grey scrollbars (Chrome on Windows 11 has thin ones): thin dark ones on the K ROOM pages instead
  win.webContents.on('dom-ready', () => { if (isApp(win.webContents.getURL())) void win.webContents.insertCSS(SCROLLBARS); });
  // the server cannot be reached: a small page that retries by itself (instead of Chromium's error page)
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 /* aborted: a navigation replaced it */ || !isApp(url)) return;
    void win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: START, err: `${desc} (${code})` } });
  });
  void win.loadURL(START);
}

/* ---- updates: the installed app (KRoom-Setup.exe) checks the GitHub releases (package.json build.publish) at start and every 4 hours, downloads a
   newer version in the background and installs it when the app closes — or right away, if the player says so. The zip version does not update. ---- */
function updates() {
  if (!app.isPackaged || process.env.KROOM_NO_UPDATE) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.warn('update', e?.message || e)); // (offline, GitHub busy, the zip version…: try again next time)
  autoUpdater.on('update-downloaded', async (info) => {
    const r = await dialog.showMessageBox(win || undefined, { type: 'info', title: 'K ROOM', message: `新版本 ${info.version} 已經下載好了`, detail: '現在重新啟動就會更新；選「稍後」的話，下次關閉 App 時自動更新。', buttons: ['現在重新啟動', '稍後'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 4 * 3600_000);
}

app.on('web-contents-created', (_e, wc) => guard(wc));
app.whenReady().then(() => {
  if (!firstInstance) return;
  Menu.setApplicationMenu(null);
  permissions(session.defaultSession);
  createWindow();
  updates();
});
app.on('window-all-closed', () => app.quit());
