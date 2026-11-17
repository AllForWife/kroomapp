// End-to-end check of the Rust app on the real site: start a debug build with KROOM_DEBUG_PORT=9333 KROOM_TEST_LOG=1, then
//   node desktop-rs/tests/app-e2e.mjs [port]
// It attaches to the app's WebView2 over the DevTools protocol (playwright-core from the repo root) and checks the bridge (window.kroomApp — the
// same API as desktop/preload.js), the device id, the players' frames (YouTube key shift, Bilibili volume / sync, Twitch), the permissions and the
// window-state callback. Windows only (a Mac's WKWebView has no DevTools protocol port).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../node_modules/playwright-core');

const port = process.argv[2] || '9333';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`); };

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i++) { page = ctx.pages().find((p) => /play\.kroom\.tw|ktv2\./.test(p.url())); if (!page) await new Promise((r) => setTimeout(r, 500)); }
if (!page) { console.log('no K ROOM page in the app'); process.exit(1); }
await page.waitForLoadState('domcontentloaded');
const origin = new URL(page.url()).origin;
console.log('page', page.url());

const ua = await page.evaluate(() => navigator.userAgent);
check('user agent carries KRoomDesktop/<version> and KRoomRust/<version>', /KRoomDesktop\/2\.\d+\.\d+/.test(ua) && /KRoomRust\/2\.\d+\.\d+/.test(ua) && !/Electron/.test(ua), ua);

const keys = await page.evaluate(() => Object.keys(window.kroomApp || {}).sort());
const want = ['embedMedia', 'embedPlay', 'getDisplay', 'getEngine', 'getSites', 'loginWithBrowser', 'onWindowState', 'relaunch', 'setAwake', 'setBeta', 'setEmbedKey', 'setEmbedQuality', 'setEmbedVolume', 'setEngine', 'setPresence', 'setSite', 'setUnlockFps'];
check('window.kroomApp has the preload.js API (+ engine switch)', JSON.stringify(keys) === JSON.stringify(want), keys.join(','));
check('window.kroomApp cannot be replaced by the page', await page.evaluate(() => { try { window.kroomApp = 1; } catch {} return typeof window.kroomApp === 'object' && Object.isFrozen(window.kroomApp); }));

const dev = await page.evaluate(() => localStorage.getItem('ktv.device'));
check('device id put in localStorage before the page ran', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(dev || ''), dev);

const disp = await page.evaluate(() => window.kroomApp.getDisplay());
check('getDisplay', disp && typeof disp.unlockFps === 'boolean' && /^2\./.test(disp.version) && typeof disp.betaUpdates === 'boolean', JSON.stringify(disp));
const sites = await page.evaluate(() => window.kroomApp.getSites());
check('getSites', sites && sites.sites && sites.sites.main === 'https://play.kroom.tw' && (sites.current === 'main' || sites.current === 'test'), JSON.stringify(sites));
const eng = await page.evaluate(() => window.kroomApp.getEngine());
check('getEngine', eng && eng.current === 'rust' && eng.engines.includes('electron'), JSON.stringify(eng));

check('setAwake(true)', (await page.evaluate(() => window.kroomApp.setAwake(true))) === true);
check('setAwake(false)', (await page.evaluate(() => window.kroomApp.setAwake(false))) === true);
check('setPresence answers (false without Discord running is fine)', typeof (await page.evaluate(() => window.kroomApp.setPresence({ details: 'test', state: 'e2e' }))) === 'boolean');
await page.evaluate(() => window.kroomApp.setPresence(null));

// 🪟 window state: the callback is called (at once with the last state)
const st = await page.evaluate(() => new Promise((r) => { window.kroomApp.onWindowState((s) => r(s)); setTimeout(() => r(null), 3000); }));
check('onWindowState gets { min, focus }', st && typeof st.min === 'boolean' && typeof st.focus === 'boolean', JSON.stringify(st));

// 🎤 permissions: microphone yes (or no device), camera never
const cam = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => e.name));
check('camera refused', cam === 'NotAllowedError' || cam === 'NotFoundError', cam);
const mic = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name));
check('microphone allowed for the K ROOM page', mic === 'granted' || mic === 'NotFoundError', mic);

// the players: frames added to the page like the 3D TV's, then driven through the bridge
await page.evaluate(() => {
  const add = (src) => { const f = document.createElement('iframe'); f.src = src; f.allow = 'autoplay; encrypted-media'; f.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;z-index:99999'; document.body.append(f); return f; };
  add('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=0&playsinline=1');
  add('https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&autoplay=1&high_quality=1');
  add(`https://player.twitch.tv/?channel=twitch&parent=${location.hostname}&autoplay=true&muted=true`);
});
await new Promise((r) => setTimeout(r, 12000));

const frames = page.frames().map((f) => f.url());
check('the player frames loaded', frames.some((u) => /youtube/.test(u)) && frames.some((u) => /bilibili/.test(u)), frames.filter((u) => u !== page.url()).map((u) => u.slice(0, 60)).join(' | '));

// 🎼 key shift in the YouTube / Bilibili frames: asked a few times (the player builds its <video> late; the worklet loads first)
let key = null;
for (let i = 0; i < 8 && !(key && key.wired); i++) { key = await page.evaluate(() => window.kroomApp.setEmbedKey(2)); await new Promise((r) => setTimeout(r, 1500)); }
check('setEmbedKey(2) wires a player', key && key.wired && key.shifting && key.semis === 2 && key.latency > 0, JSON.stringify(key));
check('the shifter runs in an AudioWorklet (not the ScriptProcessor fallback)', key && key.kind === 'worklet', key && key.kind);
console.log('      key shifter kind:', key && key.kind, key && key.error ? `(${key.error})` : '');
const back = await page.evaluate(() => window.kroomApp.setEmbedKey(0));
check('setEmbedKey(0) back to 原調', back && back.semis === 0 && !back.shifting, JSON.stringify(back));

// 🔊 / 🎵 Bilibili
check('setEmbedVolume(0.3)', (await page.evaluate(() => window.kroomApp.setEmbedVolume(0.3))) === true);
await new Promise((r) => setTimeout(r, 1500));
const bf = page.frames().find((f) => /bilibili/.test(f.url()));
const bvol = bf ? await bf.evaluate(() => { const v = document.querySelector('video'); return v ? v.volume : null; }).catch((e) => String(e)) : 'no frame';
check('the Bilibili <video> took the volume', typeof bvol === 'number' && Math.abs(bvol - 0.3) < 0.01, String(bvol));
const t = await page.evaluate(() => window.kroomApp.embedMedia('time'));
const errClip = bf ? await bf.evaluate(() => /\/bfs\/static\//.test(document.querySelector('video')?.currentSrc || '')).catch(() => false) : false;
if (errClip) console.log('SKIP  embedMedia("time"): Bilibili shows its own error clip for this video here (not the song: correctly ignored)');
else check('embedMedia("time") from the Bilibili frame', t && typeof t.t === 'number', JSON.stringify(t));
check('embedMedia refuses a bad rate', (await page.evaluate(() => window.kroomApp.embedMedia('rate', 9))) === null);

// ▶ Twitch
const tw = await page.evaluate(() => window.kroomApp.embedPlay());
check('embedPlay reaches the Twitch frame', typeof tw === 'string' && /playing|pressed|loading|no-button/.test(tw), String(tw));

// a page of another site cannot drive a player: a message from a non-K ROOM top is ignored (the frame checks event.origin)
const yf = page.frames().find((f) => /youtube/.test(f.url()));
// (the frame posts a request to itself; an answer would go to the top window — listened for there)
await page.evaluate(() => { window.__spoof = 'ignored'; addEventListener('message', (e) => { if (e.data && e.data.__kroomFx === 'res' && e.data.id === 777) window.__spoof = 'answered'; }); });
if (yf) await yf.evaluate(() => window.postMessage({ __kroomFx: 'req', id: 777, op: 'key', a: 5 }, '*')).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const spoof = yf ? await page.evaluate(() => window.__spoof) : 'no frame';
check('a request not from the K ROOM top window is ignored', spoof === 'ignored', spoof);

// a forged answer: the YouTube frame answers a Bilibili request claiming to be Bilibili — refused (its origin says YouTube)
const forged = yf ? await (async () => {
  const p = page.evaluate(() => window.kroomApp.embedMedia('time'));
  await new Promise((r) => setTimeout(r, 50));
  await yf.evaluate(() => { for (let id = 1; id < 400; id++) window.top.postMessage({ __kroomFx: 'res', id, op: 'media', kind: 'bili', r: { t: 999, paused: false, ended: false, stall: false } }, '*'); }).catch(() => {});
  return p;
})() : null;
check('a forged player answer does not count', !(forged && forged.t === 999), JSON.stringify(forged));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close().catch(() => {});
process.exit(failed.length ? 1 : 0);
