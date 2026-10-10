// What the K ROOM page can ask of the app (window.kroomApp; read by src/account.ts). Only the K ROOM site gets an answer (checked in main.js).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kroomApp', {
  /** open the sign-in page in the normal browser; the browser hands the account back by a kroom:// link */
  loginWithBrowser: () => ipcRenderer.invoke('login-with-browser'),
});
