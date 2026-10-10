// K ROOM for Windows: the website in its own Chromium window. What it changes against a browser tab:
//  - sound plays at once (no 「點一下開啟聲音」: the autoplay gate is off)
//  - nothing is slowed down in the background (timers, rendering, a minimised / covered window) — the song's drift correction and the voices keep time
//  - the dedicated GPU is preferred, and the GPU is not blocklisted for the site after a GPU crash (fewer 「無法啟動 3D」)
//  - the microphone is allowed for the K ROOM site only; links to other sites open in the normal browser
// The server address: --url=https://… > env KROOM_URL > %APPDATA%/K ROOM/config.json {"url": "…"} > DEFAULT_URL (the main site)
const { app, BrowserWindow, session, shell, Menu, ipcMain, dialog } = require('electron'); // (dialog: updates, and 用 App 開啟's 「用「名字」登入？」)
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** the two K ROOM sites: players use the main one; an admin can switch the app to the testing one on the main menu (🌐 站台; config.json url) */
const SITES = { main: 'https://ktv.548712345.xyz', test: 'https://ktv2.548754321.xyz' };
const DEFAULT_URL = SITES.main;
const siteOf = (origin) => Object.keys(SITES).find((k) => SITES[k] === origin) || '';

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
// ⚙ 設定 → 解除螢幕更新率限制: frames are no longer held to the screen's refresh (vsync); read at start, so a change needs a restart
if (readJson(configFile()).unlockFps) { app.commandLine.appendSwitch('disable-frame-rate-limit'); app.commandLine.appendSwitch('disable-gpu-vsync'); }
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
  if (u.hostname === 'open') return void openFromBrowser(u);
  const kind = u.hostname, p = pending[kind], state = u.searchParams.get('state'), code = u.searchParams.get('code');
  if (!HANDOFF[kind] || !p || !state || !code || state !== p.state || Date.now() - p.at > LOGIN_MS) return;
  delete pending[kind];
  if (win) void win.loadURL(`${ORIGIN}${HANDOFF[kind].claim}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}
/* ---- 🖥 用 App 開啟 on the website (src/ui/openapp.ts): kroom://open?code=…&state=…&rejoin=… — started in the browser, so there is no pending state
   here: a one-time code the signed-in browser made (2 min, once) signs the app in as that account, and the room record the browser was in (rejoin,
   base64url JSON) is handed to the page the same way as after an update restart (localStorage → preload.js → the page rejoins). ---- */
async function openFromBrowser(u) {
  if (!win) return;
  // the link came from the other K ROOM site (site=<its origin>): the app moves to that site first and handles the link there (its code only works there)
  const from = u.searchParams.get('site') || '';
  if (from && from !== ORIGIN && siteOf(from)) { switchSite(from, u.href); return; }
  if (win.isMinimized()) win.restore(); win.focus();
  const upTo = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]); // (never stuck: a page that is still busy just gets less help)
  if (win.webContents.isLoadingMainFrame()) await upTo(new Promise((r) => win.webContents.once('did-finish-load', r)), 15000); // (not isLoading(): the page's iframes — the Google button — keep that true)
  let rec = null, room = '';
  try { const j = JSON.parse(Buffer.from(u.searchParams.get('rejoin') || '', 'base64url').toString('utf8')); if (j && typeof j.room === 'string' && j.room.length <= 60) { rec = JSON.stringify({ ...j, at: Date.now() }); room = j.room; } } catch { /* no room */ }
  const code = u.searchParams.get('code'), state = u.searchParams.get('state');
  // a link like this can come from any page, so a code never signs the app in silently: whose code it is is asked first (without spending it), and
  // the player confirms — unless the app is already signed in as that very account (then it only moves rooms)
  if (code && state) {
    let name = null;
    try { const r = await fetch(`${ORIGIN}/api/auth/app/peek?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`); if (r.ok) name = String((await r.json()).name ?? ''); } catch { /* offline */ }
    if (name === null) return; // (a used, expired or made-up code: nothing happens)
    let mine = null;
    if (isApp(win.webContents.getURL())) try { mine = await upTo(win.webContents.executeJavaScript(`fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json()).then((j) => (j.account ? j.account.name || '' : null)).catch(() => null)`), 3000); } catch { /* the page went away */ }
    if (mine !== name) {
      const who = name || '（還沒取名字的帳號）';
      const ok = process.env.KROOM_TEST_CONFIRM ? (console.log(`CONFIRM_ASKED ${who}`), process.env.KROOM_TEST_CONFIRM === 'yes') // (tests: the answer is given)
        : (await dialog.showMessageBox(win, { type: 'question', title: 'K ROOM', message: `用「${who}」登入 K ROOM App？`, detail: `這是從瀏覽器的「用 App 開啟」傳來的。${mine !== null ? `App 現在登入的是「${mine || '（還沒取名字的帳號）'}」，會換成「${who}」。` : ''}${room ? `登入後會進入房間「${room}」。` : ''}\n如果不是你剛剛在瀏覽器按的，請按「取消」。`, buttons: ['登入並開啟', '取消'], defaultId: 0, cancelId: 1, noLink: true })).response === 0;
      if (!ok) return;
    }
  }
  if (rec && isApp(win.webContents.getURL())) {
    try { await upTo(win.webContents.executeJavaScript(`try { localStorage.setItem('ktv.rejoin.update', ${JSON.stringify(JSON.stringify({ rec, saved: Date.now() }))}); } catch {} true`), 3000); session.defaultSession.flushStorageData(); } catch { /* the page went away */ }
  }
  void win.loadURL(code && state ? `${ORIGIN}/api/auth/app/claim?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` : `${ORIGIN}/`);
}
/** open the normal browser for a hand-off (kind: 'login' | 'admin') */
function handoff(kind) {
  const state = crypto.randomBytes(24).toString('base64url'); pending[kind] = { state, at: Date.now() };
  const url = ORIGIN + HANDOFF[kind].start(state);  if (process.env.KROOM_TEST_PRINT_LOGIN) console.log(`HANDOFF_URL ${kind} ${url}`); // (tests: the browser is played by the test)
  else void shell.openExternal(url);
  return true;
}
app.on('second-instance', (_e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } deepLink(argv); });
ipcMain.handle('login-with-browser', (e) => originOf(e.senderFrame?.url || '') === ORIGIN && handoff('login'));
// the page's ⚙ 設定 (src/ui/appsettings.ts): the app-level display switch, and a restart that comes back into the same room
const fromSite = (e) => originOf(e.senderFrame?.url || '') === ORIGIN;
ipcMain.handle('get-display', (e) => { if (!fromSite(e)) return null; const c = readJson(configFile()); return { unlockFps: !!c.unlockFps, betaUpdates: !!c.betaUpdates, version: app.getVersion() }; });
// 🧪 App 測試版 (shown to admins only): this install also takes betas (GitHub pre-releases); turned on, it looks for one right away
ipcMain.handle('set-beta', (e, on) => {
  if (!fromSite(e)) return false;
  writeJson(configFile(), { ...readJson(configFile()), betaUpdates: !!on });
  if (app.isPackaged && !process.env.KROOM_NO_UPDATE) { autoUpdater.allowPrerelease = app.getVersion().includes('-') || !!on; if (on) void autoUpdater.checkForUpdates().catch(() => {}); }
  return true;
});
ipcMain.handle('set-unlock-fps', (e, on) => { if (!fromSite(e)) return false; writeJson(configFile(), { ...readJson(configFile()), unlockFps: !!on }); return true; });
ipcMain.handle('relaunch', async (e) => { if (!fromSite(e)) return; await keepRoom(); app.relaunch(); app.quit(); });
/** 🌐 站台: the app moves to the other K ROOM site — saved in config.json, then a restart (everything here is per site: the cookies, the allowed origin).
 *  link: a kroom:// link to handle once the app is up on that site */
function switchSite(origin, link = '') {
  writeJson(configFile(), { ...readJson(configFile()), url: origin });
  const args = process.argv.slice(1).filter((a) => !/^kroom:\/\//i.test(a) && !a.startsWith('--url=')); // (a --url= from a shortcut would win over the choice)
  app.relaunch({ args: link ? [...args, link] : args }); app.quit();
}
/* ---- the device id: the page's own (localStorage ktv.device, src/net/client.ts) was lost whenever its storage was — another site (each has its own),
   a run closed hard before it reached the disk, a reinstall — and the admin panel saw a "new device" each time. In the app it comes from the hardware:
   the motherboard's SMBIOS system UUID (kept in the firmware: it survives reinstalling Windows and changing disks), else the motherboard's serial
   number, else the BIOS serial; only without any of those Windows' MachineGuid, and last a random one kept in config.json. Placeholders makers leave
   ("To be filled by O.E.M.", all-F / all-0 UUIDs …) do not count. Never sent as it is: a one-way hash with K ROOM's own salt, shaped like the ids
   before. Read once per start (about a second, while the app starts); preload.js hands it to every page before its scripts run. ---- */
const JUNK = /^(|0+|f+|none|null|n\/a|na|default string|to be filled by o\.e\.m\.?|not applicable|not specified|system serial number|base board serial number|chassis serial number|serial number|123456789|0123456789|1234567890|[0-9a-f]{8}-?0{4}-?0{4}-?0{4}-?0{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|03000200-0400-0500-0006-000700080009)$/i;
const toId = (src) => { const h = crypto.createHash('sha256').update('kroom-device:' + src).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
let device = '';
const deviceReady = new Promise((resolve) => {
  const PS = "$ErrorActionPreference='SilentlyContinue'; 'uuid=' + (Get-CimInstance Win32_ComputerSystemProduct).UUID; 'board=' + (Get-CimInstance Win32_BaseBoard).SerialNumber; 'bios=' + (Get-CimInstance Win32_BIOS).SerialNumber";
  require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 8000 }, (_err, out) => {
    const v = {}; for (const l of String(out || '').split(/\r?\n/)) { const m = /^(uuid|board|bios)=(.*)$/.exec(l.trim()); if (m) v[m[1]] = m[2].trim(); }
    const kind = ['uuid', 'board', 'bios'].find((k) => v[k] && !JUNK.test(v[k]) && !/^(.)\1+$/.test(v[k].replace(/-/g, '')));
    if (kind) device = toId(`${kind}:${v[kind].toLowerCase()}`);
    else {
      try { const g = /MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i.exec(require('child_process').execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }))?.[1]; if (g) device = toId(g.toLowerCase()); } catch { /* no access */ }
      if (!device) { const c = readJson(configFile()); device = /^[\w-]{8,64}$/.test(String(c.deviceId || '')) ? String(c.deviceId) : crypto.randomUUID(); if (device !== c.deviceId) writeJson(configFile(), { ...c, deviceId: device }); }
    }
    resolve(device);
  });
});
ipcMain.on('device-id', (e) => { e.returnValue = fromSite(e) ? device || null : null; });
app.on('before-quit', () => { try { session.defaultSession.flushStorageData(); } catch { /* not ready */ } }); // (what the pages stored is on disk before the app goes)
// the main menu's 🌐 站台 (src/ui/hud.ts; the page shows it to admins only)
ipcMain.handle('get-sites', (e) => (fromSite(e) ? { current: siteOf(ORIGIN) || 'custom', sites: SITES } : null));
ipcMain.handle('set-site', (e, key) => { if (!fromSite(e) || !SITES[key] || SITES[key] === ORIGIN) return false; switchSite(SITES[key]); return true; });
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
  // started by a kroom:// link (the app was not running: 用 App 開啟 on the website): it is handled once the first page is up
  if (process.argv.some((a) => /^kroom:\/\//i.test(a))) { const argv = process.argv; win.webContents.once('did-finish-load', () => setTimeout(() => deepLink(argv), 300)); }
}

/* ---- updates: the installed app (KRoom-Setup.exe) checks the GitHub releases (package.json build.publish) at start and every 4 hours, downloads a
   newer version in the background and installs it when the app closes — or right away, if the player says so. The zip version does not update. ---- */
/** before an update restart: the page's rejoin record (sessionStorage, gone after a restart) is kept in localStorage; preload.js puts it back */
async function keepRoom() {
  if (!win || !isApp(win.webContents.getURL())) return;
  try { await win.webContents.executeJavaScript(`try { const r = sessionStorage.getItem('ktv.rejoin'); if (r) localStorage.setItem('ktv.rejoin.update', JSON.stringify({ rec: r, saved: Date.now() })); } catch {} true`); } catch { /* the page is gone */ }
  session.defaultSession.flushStorageData(); // (written to disk now: the installer closes the app right after)
  await new Promise((r) => setTimeout(r, 300));
}
function updates() {
  if (!app.isPackaged || process.env.KROOM_NO_UPDATE) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  // betas (1.0.4-beta.1) are GitHub pre-releases: a normal install only ever takes the newest normal release (GitHub's releases/latest); a beta
  // install also takes newer betas (it looks for beta.yml, finds none and uses the release's latest.yml). No channel is set: that would break it
  // 🧪 an admin can switch this install to betas too (the tablet's App 測試版: config.json betaUpdates)
  autoUpdater.allowPrerelease = app.getVersion().includes('-') || !!readJson(configFile()).betaUpdates;
  autoUpdater.on('error', (e) => console.warn('update', e?.message || e)); // (offline, GitHub busy, the zip version…: try again next time)
  autoUpdater.on('update-downloaded', async (info) => {
    const r = await dialog.showMessageBox(win || undefined, { type: 'info', title: 'K ROOM', message: `新版本 ${info.version} 已經下載好了`, detail: '現在重新啟動就會更新；選「稍後」的話，下次關閉 App 時自動更新。', buttons: ['現在重新啟動', '稍後'], defaultId: 0, cancelId: 1 });
    if (r.response === 0) { await keepRoom(); autoUpdater.quitAndInstall(true, true); } // (silent install, then the new version starts by itself)
  });
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 4 * 3600_000);
}

app.on('web-contents-created', (_e, wc) => guard(wc));
app.whenReady().then(async () => {
  if (!firstInstance) return;
  await Promise.race([deviceReady, new Promise((r) => setTimeout(r, 9000))]); // (the device id is read while Electron starts; the first page needs it)
  Menu.setApplicationMenu(null);
  permissions(session.defaultSession);
  createWindow();
  updates();
});
app.on('window-all-closed', () => app.quit());
