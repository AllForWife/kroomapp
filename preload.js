// What the K ROOM page can ask of the app (window.kroomApp; read by src/account.ts). Only the K ROOM site gets an answer (checked in main.js).
const { contextBridge, ipcRenderer } = require('electron');

// back from an update restart (main.js keepRoom): the room the player was in goes back where the page looks for it (src/main.ts readRejoin,
// sessionStorage — which a restart empties), before the page's own scripts run, so the page rejoins that room by itself. Once, within 10 min.
try {
  const kept = JSON.parse(localStorage.getItem('ktv.rejoin.update') || 'null'); localStorage.removeItem('ktv.rejoin.update');
  if (kept && kept.rec && Date.now() - kept.saved < 10 * 60_000) sessionStorage.setItem('ktv.rejoin', kept.rec);
} catch { /* another page (offline.html), storage off */ }
contextBridge.exposeInMainWorld('kroomApp', {
  /** open the sign-in page in the normal browser; the browser hands the account back by a kroom:// link */
  loginWithBrowser: () => ipcRenderer.invoke('login-with-browser'),
  /** ⚙ 設定: the app's own display switch (解除螢幕更新率限制, read when the app starts) and a restart back into the same room */
  getDisplay: () => ipcRenderer.invoke('get-display'),
  setUnlockFps: (on) => ipcRenderer.invoke('set-unlock-fps', !!on),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  /** 🧪 this install also takes betas (the page shows the switch to admins only) */
  setBeta: (on) => ipcRenderer.invoke('set-beta', !!on),});
