// What the K ROOM page can ask of the app (window.kroomApp; read by src/account.ts). Only the K ROOM site gets an answer (checked in main.js).
const { contextBridge, ipcRenderer } = require('electron');

// the app's device id (main.js 'device-id': from this computer itself), put where the page looks for it (localStorage ktv.device) before its scripts run
try {
  const id = ipcRenderer.sendSync('device-id');
  if (id && localStorage.getItem('ktv.device') !== id) localStorage.setItem('ktv.device', id);
} catch { /* another page (offline.html), storage off */ }

// back from an update restart (main.js keepRoom): the room the player was in goes back where the page looks for it (src/main.ts readRejoin,
// sessionStorage — which a restart empties), before the page's own scripts run, so the page rejoins that room by itself. Once, within 10 min.
try {
  const kept = JSON.parse(localStorage.getItem('ktv.rejoin.update') || 'null') || ipcRenderer.sendSync('kept-room'); localStorage.removeItem('ktv.rejoin.update'); // (kept-room: from the Rust app, main.js engineHandoff)
  if (kept && kept.rec && Date.now() - kept.saved < 10 * 60_000) sessionStorage.setItem('ktv.rejoin', kept.rec);
} catch { /* another page (offline.html), storage off */ }
// the Steam build (docs/STEAM-BUILD.md) has no update beta and no site switch: those two calls are not offered, so the page's admin switches stay hidden
let flags = {}; try { flags = ipcRenderer.sendSync('build-flags') || {}; } catch { /* another page */ }
const bridge = {
  /** open the sign-in page in the normal browser; the browser hands the account back by a kroom:// link */
  loginWithBrowser: () => ipcRenderer.invoke('login-with-browser'),
  /** ⚙ 設定: the app's own display switch (解除螢幕更新率限制, read when the app starts) and a restart back into the same room */
  getDisplay: () => ipcRenderer.invoke('get-display'),
  setUnlockFps: (on) => ipcRenderer.invoke('set-unlock-fps', !!on),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  /** 🧪 this install also takes betas (the page shows the switch to admins only) */
  setBeta: (on) => ipcRenderer.invoke('set-beta', !!on),
  /** 🌐 站台: which K ROOM site the app is on (main / test), and moving it to the other one (a restart; the page shows it to admins only) */
  getSites: () => ipcRenderer.invoke('get-sites'),
  /** 🔊 the volume (0–1) for the Bilibili player inside the page (the page itself cannot reach it) */
  setEmbedVolume: (v) => ipcRenderer.invoke('embed-volume', Number(v)),
  /** 🎵 the Bilibili player kept in step with the room: op time / seek / rate / pause / play → { t, paused, ended, stall } or null (no player yet) */
  embedMedia: (op, arg) => ipcRenderer.invoke('embed-media', String(op), Number(arg)),
  /** 🎼 升降 Key (semitones, −12…12) for the YouTube / Bilibili player → { semis, wired, shifting, latency (s), pending, error } or null (no player) */
  setEmbedKey: (n) => ipcRenderer.invoke('embed-key', Number(n)),
  /** ▶ Twitch stuck on its play button: the app presses it inside Twitch's frame (only when its video is really not playing) */
  embedPlay: () => ipcRenderer.invoke('embed-play'),
  /** 🌙 a song is playing: the screen does not go to sleep (or the screensaver) meanwhile */
  setAwake: (on) => ipcRenderer.invoke('set-awake', !!on),
  /** 🎮 Discord 狀態 (src/ui/discord.ts): what to show, or null to clear; the app builds the activity and its links itself (main.js presenceActivity) */
  setPresence: (p) => ipcRenderer.invoke('set-presence', p && typeof p === 'object' ? p : null),
  setSite: (key) => ipcRenderer.invoke('set-site', String(key)),
  /** 🧪 which app this is — { current: 'electron' | 'rust', engines } — and switching to the other one (its installer runs; the page shows it to admins only) */
  getEngine: () => ipcRenderer.invoke('get-engine'),
  setEngine: (which) => ipcRenderer.invoke('set-engine', String(which)),
  /** 🪟 the window minimised / in front or not (main.js 'win-state'): the page draws less meanwhile, so its voice keeps the CPU it needs */
  onWindowState: (fn) => { if (typeof fn === 'function') ipcRenderer.on('win-state', (_e, st) => { try { fn({ min: !!st?.min, focus: !!st?.focus }); } catch { /* the page's problem */ } }); },
};
if (flags.steam) { delete bridge.setBeta; delete bridge.getSites; delete bridge.setSite; delete bridge.getEngine; delete bridge.setEngine; }
if (flags.steam && flags.steamUser) {
  /** 🎮 sign in with the Steam account: an auth ticket for POST /api/auth/steam (src/account.ts) */
  bridge.steamTicket = () => ipcRenderer.invoke('steam-ticket');
  /** 🏪 in-app purchases (src/store-billing.ts, docs/STORE-BILLING.md): the Steam ID the server opens the transaction for */
  contextBridge.exposeInMainWorld('kroomBilling', { steamId: () => ipcRenderer.invoke('steam-id') });
}
contextBridge.exposeInMainWorld('kroomApp', bridge);
