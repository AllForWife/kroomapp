// K ROOM for Windows: the website in its own Chromium window. What it changes against a browser tab:
//  - sound plays at once (no 「點一下開啟聲音」: the autoplay gate is off)
//  - nothing is slowed down in the background (timers, rendering, a minimised / covered window) — the song's drift correction and the voices keep time
//  - the dedicated GPU is preferred, and the GPU is not blocklisted for the site after a GPU crash (fewer 「無法啟動 3D」)
//  - the microphone is allowed for the K ROOM site only; links to other sites open in the normal browser
// The server address: --url=https://… > env KROOM_URL > %APPDATA%/K ROOM/config.json {"url": "…"} > DEFAULT_URL (the main site)
const { app, BrowserWindow, session, shell, Menu, ipcMain, dialog, powerSaveBlocker, screen } = require('electron'); // (dialog: updates, and 用 App 開啟's 「用「名字」登入？」)
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
// The hardware read takes 0.5–2 s and the first page waits for it: the id found last time (config.json hwId) is used at once, and the hardware is
// read again in the background — a different answer (another motherboard) is kept for the next start.
let device = '';
const hwCached = (() => { const h = readJson(configFile()).hwId; return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(h || '')) ? String(h) : ''; })();
if (hwCached) device = hwCached;
const deviceRead = new Promise((resolve) => {
  const PS = "$ErrorActionPreference='SilentlyContinue'; 'uuid=' + (Get-CimInstance Win32_ComputerSystemProduct).UUID; 'board=' + (Get-CimInstance Win32_BaseBoard).SerialNumber; 'bios=' + (Get-CimInstance Win32_BIOS).SerialNumber";
  require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 8000 }, (_err, out) => {
    const v = {}; for (const l of String(out || '').split(/\r?\n/)) { const m = /^(uuid|board|bios)=(.*)$/.exec(l.trim()); if (m) v[m[1]] = m[2].trim(); }
    const kind = ['uuid', 'board', 'bios'].find((k) => v[k] && !JUNK.test(v[k]) && !/^(.)\1+$/.test(v[k].replace(/-/g, '')));
    let id = '';
    if (kind) id = toId(`${kind}:${v[kind].toLowerCase()}`);
    else {
      try { const g = /MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i.exec(require('child_process').execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }))?.[1]; if (g) id = toId(g.toLowerCase()); } catch { /* no access */ }
    }
    if (id) { if (id !== hwCached) writeJson(configFile(), { ...readJson(configFile()), hwId: id }); }
    else { const c = readJson(configFile()); id = /^[\w-]{8,64}$/.test(String(c.deviceId || '')) ? String(c.deviceId) : crypto.randomUUID(); if (id !== c.deviceId) writeJson(configFile(), { ...c, deviceId: id }); }
    if (!device) device = id; // (a cached id stays for this run: the page already has it)
    resolve(device);
  });
});
const deviceReady = hwCached ? Promise.resolve(hwCached) : deviceRead;
ipcMain.on('device-id', (e) => { e.returnValue = fromSite(e) ? device || null : null; });
app.on('before-quit', () => { try { session.defaultSession.flushStorageData(); } catch { /* not ready */ } }); // (what the pages stored is on disk before the app goes)
/* ---- 🔊 the Bilibili player's volume: the page cannot reach into Bilibili's frame (another site), and that player has no volume command — the 伴奏音量
   slider did nothing for a Bilibili song and players were sent to set Bilibili's own slider by hand (src/ui/bilivol.ts). The app can: the page says
   the volume (src/music/stage.ts → 'embed-volume'), and every Bilibili frame gets its <video>/<audio> set to it — again every second (the player puts
   its own back) and whenever a frame (re)loads. ---- */
let embedVol = null;
const isBili = (u) => { try { return /(^|\.)bilibili\.com$/.test(new URL(u).hostname); } catch { return false; } };
const volJs = (v) => `(() => { window.__kroomVol = ${v};
  if (!window.__kroomVolT) {
    const media = (root, out) => { for (const m of root.querySelectorAll('video, audio')) out.push(m); for (const e of root.querySelectorAll('*')) if (e.shadowRoot) media(e.shadowRoot, out); return out; };
    let found = [];
    const set = () => { if (!found.length || found.some((m) => !m.isConnected)) found = media(document, []); for (const m of found) if (Math.abs(m.volume - window.__kroomVol) > 0.004) m.volume = window.__kroomVol; };
    window.__kroomVolSet = set; window.__kroomVolT = setInterval(set, 1000);
  }
  window.__kroomVolSet(); return true; })()`;
function applyEmbedVolume() {
  if (!win || embedVol === null) return;
  for (const f of win.webContents.mainFrame.framesInSubtree) if (f !== win.webContents.mainFrame && isBili(f.url)) f.executeJavaScript(volJs(embedVol)).catch(() => {});
}
ipcMain.handle('embed-volume', (e, v) => { if (!fromSite(e)) return false; const n = Number(v); if (!(n >= 0 && n <= 1)) return false; embedVol = n; applyEmbedVolume(); return true; });
/* ---- 🎵 the Bilibili player kept in step with the room: that embed has no command API either, so a Bilibili song ran on its own clock — it was never
   corrected and drifted away from the singers' voices (and from pause / seek / speed). The page drives the <video> in Bilibili's frame like its own
   direct video (src/music/stage.ts): time 4×/s, seek, pause / play, playback rate (kept: the player puts its own back). ---- */
const mediaJs = (op, arg) => `(() => {
  const all = (root, out) => { for (const m of root.querySelectorAll('video, audio')) out.push(m); for (const e of root.querySelectorAll('*')) if (e.shadowRoot) all(e.shadowRoot, out); return out; };
  const own = (x) => /\\/bfs\\/static\\//.test(x.currentSrc || x.src || ''); // (Bilibili's own clips — error.mp4 when a video cannot play here — are not the song)
  let m = window.__kroomMedia; if (!m || !m.isConnected || own(m)) { const l = all(document, []).filter((x) => !own(x)); m = window.__kroomMedia = l.find((x) => x.tagName === 'VIDEO') || l[0] || null; }
  if (!m) return null;
  const op = ${JSON.stringify(op)}, arg = ${JSON.stringify(arg)};
  if (op === 'rate') window.__kroomRate = arg; else if (op === 'seek') m.currentTime = arg; else if (op === 'pause') m.pause(); else if (op === 'play') m.play().catch(() => {});
  if (window.__kroomRate && Math.abs(m.playbackRate - window.__kroomRate) > 0.001) m.playbackRate = window.__kroomRate;
  return { t: m.currentTime, paused: m.paused, ended: m.ended, stall: m.readyState < 3 || m.seeking };
})()`;
ipcMain.handle('embed-media', async (e, op, arg) => {
  if (!fromSite(e) || !win || !['time', 'seek', 'rate', 'pause', 'play'].includes(op)) return null;
  const n = Number(arg); if ((op === 'seek' && !(n >= 0)) || (op === 'rate' && !(n >= 0.25 && n <= 4))) return null;
  const frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame && isBili(f.url));
  for (const f of frames) {
    const r = await Promise.race([f.executeJavaScript(mediaJs(op, op === 'seek' || op === 'rate' ? n : null)).catch(() => null), new Promise((res) => setTimeout(() => res(null), 1000))]);
    if (r) return r;
  }
  return null;
});
/* ---- 🎼 升降 Key: the room's key (src/music/stage.ts → 'embed-key', in semitones) is put into the YouTube / Bilibili player's frame, which takes the
   video's sound into Web Audio and shifts its pitch (keyshift.js) — the page cannot reach into those frames, only the app can. Answers how late the
   shifted sound is (the page plays ahead by that). The page asks again every few seconds while a key is set (a player that builds its <video>
   late, a new video in the same frame); a frame that (re)loads gets it at once. ---- */
const { keyJs } = require('./keyshift');
let embedKey = 0;
const isYt = (u) => { try { const x = new URL(u); return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(x.hostname) && x.pathname.startsWith('/embed/'); } catch { return false; } };
async function applyEmbedKey() {
  if (!win) return null; let out = null;
  for (const f of win.webContents.mainFrame.framesInSubtree) {
    if (f === win.webContents.mainFrame || !(isBili(f.url) || isYt(f.url))) continue;
    const r = await Promise.race([f.executeJavaScript(keyJs(embedKey)).catch(() => null), new Promise((res) => setTimeout(() => res(null), 1000))]);
    if (r && (!out || (r.wired && !out.wired))) out = r;
  }
  return out;
}
ipcMain.handle('embed-key', async (e, n) => { if (!fromSite(e)) return null; const k = Math.round(Number(n)); if (!(k >= -12 && k <= 12)) return null; embedKey = k; return applyEmbedKey(); });
/* ---- ▶ Twitch stuck on its play button: Twitch does not autoplay a player drawn on our 3D TV (「style visibility」), and the page's play() through
   Twitch's API does not load the stream either (the API even says it is playing). Its own ▶ pressed inside its frame does — so while the room plays,
   the page asks (src/music/stage.ts, every 2 s) and the app presses it only when Twitch's <video> is really not playing. ---- */
const isTwitch = (u) => { try { return /(^|\.)twitch\.tv$/.test(new URL(u).hostname); } catch { return false; } };
const twitchKickJs = `(() => {
  const v = document.querySelector('video'); if (v && !v.paused && v.readyState >= 2) return 'playing';
  const b = document.querySelector('button[data-a-target="player-play-pause-button"]') || [...document.querySelectorAll('button')].find((x) => /^play\\b/i.test(x.getAttribute('aria-label') || ''));
  if (!b) return 'no-button';
  if ((v && !v.paused) || b.getAttribute('data-a-player-state') === 'playing') return 'loading'; // (buffering: a press now would pause it)
  b.click(); return 'pressed';
})()`;
ipcMain.handle('embed-play', async (e) => {
  if (!fromSite(e) || !win) return null;
  const out = [];
  for (const f of win.webContents.mainFrame.framesInSubtree) if (f !== win.webContents.mainFrame && isTwitch(f.url) && /^https:\/\/player\.twitch\.tv\//.test(f.url)) out.push(await Promise.race([f.executeJavaScript(twitchKickJs).catch(() => null), new Promise((res) => setTimeout(() => res(null), 1000))]));
  return out.length ? out.join(',') : null;
});
// 🌙 while a song plays (src/main.ts): the screen does not sleep and the screensaver does not start — a listener may not touch the mouse for minutes
let awakeId = -1;
const stayAwake = (on) => { if (on && awakeId < 0) awakeId = powerSaveBlocker.start('prevent-display-sleep'); else if (!on && awakeId >= 0) { powerSaveBlocker.stop(awakeId); awakeId = -1; } else return; if (process.env.KROOM_TEST_LOG) console.log(`AWAKE ${on}`); }; // (tests: logged)
ipcMain.handle('set-awake', (e, on) => { if (!fromSite(e)) return false; stayAwake(!!on); return true; });
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
  // the place saved last time is only used when it is still on a screen (a monitor unplugged since: the window would open where nobody sees it)
  if (st.x != null && st.y != null && !screen.getAllDisplays().some(({ workArea: a }) => st.x + 120 <= a.x + a.width && st.x + (st.width || 1280) - 120 >= a.x && st.y >= a.y - 8 && st.y + 40 <= a.y + a.height)) { delete st.x; delete st.y; }
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
  win.webContents.on('did-navigate', () => stayAwake(false)); // (a new page asks again once its song plays)
  win.webContents.on('did-frame-finish-load', (_e, isMain) => { if (!isMain) { applyEmbedVolume(); if (embedKey) void applyEmbedKey(); } }); // (a player that just (re)loaded gets the volume and the key) // (a Bilibili player that just (re)loaded gets the volume)
  // Electron draws Windows' old grey scrollbars (Chrome on Windows 11 has thin ones): thin dark ones on the K ROOM pages instead
  win.webContents.on('dom-ready', () => { if (isApp(win.webContents.getURL())) void win.webContents.insertCSS(SCROLLBARS); });
  // the server cannot be reached: a small page that retries by itself (instead of Chromium's error page)
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 /* aborted: a navigation replaced it */ || !isApp(url)) return;
    void win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: START, err: `${desc} (${code})` } });
  });
  // the page crashed (the 3D page ran out of memory, a GPU driver reset…): the window stayed blank until the app was restarted. It is loaded again —
  // back into the same room (the page's rejoin record, sessionStorage, outlives the crash); a page that keeps crashing gets a choice instead
  const crashes = [];
  win.webContents.on('render-process-gone', async (_e, d) => {
    stayAwake(false); // (the page that asked for it is gone)
    if (d.reason === 'clean-exit' || !win) return;
    console.warn('page gone', d.reason, d.exitCode);
    const now = Date.now(); crashes.push(now); while (crashes.length && now - crashes[0] > 120_000) crashes.shift();
    if (crashes.length >= 3) {
      const r = await dialog.showMessageBox(win, { type: 'error', title: 'K ROOM', message: 'K ROOM 一直當掉', detail: `畫面在兩分鐘內當掉了 ${crashes.length} 次（${d.reason}）。可以試試在點歌平板 → 🖥 畫面設定 把畫質調低。`, buttons: ['重新載入', '關閉 App'], defaultId: 0, cancelId: 1, noLink: true });
      if (r.response === 1) { app.quit(); return; }
      crashes.length = 0;
    }
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  // the page stopped answering (a long freeze): ask, instead of a window that does nothing
  let asking = false;
  win.on('unresponsive', async () => {
    if (asking || !win) return; asking = true;
    const r = await dialog.showMessageBox(win, { type: 'warning', title: 'K ROOM', message: 'K ROOM 沒有回應', detail: '可以再等一下，或重新載入（會回到同一個房間）。', buttons: ['等待', '重新載入'], defaultId: 0, cancelId: 0, noLink: true });
    asking = false;
    if (r.response === 1 && win && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); // (render-process-gone loads it again)
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
