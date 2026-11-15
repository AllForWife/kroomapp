// Put into EVERY frame (Tauri initialization_script_for_all_frames → WebView2 AddScriptToExecuteOnDocumentCreated / WKUserScript
// forMainFrameOnly:false). It does something only inside the players' own frames (Bilibili, YouTube /embed/, player.twitch.tv) — the frames the
// K ROOM page cannot reach (another site). Electron reached them with frame.executeJavaScript (desktop/main.js); here the K ROOM page's bridge
// (bridge.js) talks to this code with postMessage instead, so nothing native is needed and Windows and macOS work the same way.
//
// Who may drive it: only the TOP window, and only when it is the K ROOM site (event.origin === ORIGIN, checked by the browser — no other site that
// embeds YouTube can use it). Answers go to the top window with targetOrigin ORIGIN (dropped by the browser if the top is anything else).
// The bodies are desktop/main.js's volJs / mediaJs / twitchKickJs and desktop/keyshift.js's keyJs (js/keyshift.gen.js), unchanged in behaviour.
(() => {
  if (window === window.top) return;
  const ORIGIN = __KROOM_ORIGIN__;
  let kind = '';
  try {
    const h = location.hostname, p = location.pathname;
    if (/(^|\.)bilibili\.com$/.test(h)) kind = 'bili';
    else if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(h) && p.startsWith('/embed/')) kind = 'yt';
    else if (/(^|\.)twitch\.tv$/.test(h) && location.href.startsWith('https://player.twitch.tv/')) kind = 'twitch';
  } catch { return; }
  if (!kind) return;
  const top = window.top, post = (m) => { try { top.postMessage(m, ORIGIN); } catch { /* the top is not K ROOM: nothing to say */ } };

  /* @@KEYSHIFT@@ */

  const media = (root, out) => { for (const m of root.querySelectorAll('video, audio')) out.push(m); for (const e of root.querySelectorAll('*')) if (e.shadowRoot) media(e.shadowRoot, out); return out; };
  // 🔊 Bilibili volume (main.js volJs): set now and again every second (the player puts its own back)
  const vol = (v) => {
    window.__kroomVol = v;
    if (!window.__kroomVolT) {
      let found = [];
      const set = () => { if (!found.length || found.some((m) => !m.isConnected)) found = media(document, []); for (const m of found) if (Math.abs(m.volume - window.__kroomVol) > 0.004) m.volume = window.__kroomVol; };
      window.__kroomVolSet = set; window.__kroomVolT = setInterval(set, 1000);
    }
    window.__kroomVolSet(); return true;
  };
  // 🎵 Bilibili kept in step with the room (main.js mediaJs)
  const mediaOp = (op, arg) => {
    const own = (x) => /\/bfs\/static\//.test(x.currentSrc || x.src || ''); // (Bilibili's own clips — error.mp4 — are not the song)
    let m = window.__kroomMedia; if (!m || !m.isConnected || own(m)) { const l = media(document, []).filter((x) => !own(x)); m = window.__kroomMedia = l.find((x) => x.tagName === 'VIDEO') || l[0] || null; }
    if (!m) return null;
    if (op === 'rate') window.__kroomRate = arg; else if (op === 'seek') m.currentTime = arg; else if (op === 'pause') m.pause(); else if (op === 'play') m.play().catch(() => {});
    if (window.__kroomRate && Math.abs(m.playbackRate - window.__kroomRate) > 0.001) m.playbackRate = window.__kroomRate;
    return { t: m.currentTime, paused: m.paused, ended: m.ended, stall: m.readyState < 3 || m.seeking };
  };
  // ▶ Twitch stuck on its play button (main.js twitchKickJs): pressed only when its video is really not playing
  const twitchKick = () => {
    const v = document.querySelector('video'); if (v && !v.paused && v.readyState >= 2) return 'playing';
    const b = document.querySelector('button[data-a-target="player-play-pause-button"]') || [...document.querySelectorAll('button')].find((x) => /^play\b/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'no-button';
    if ((v && !v.paused) || b.getAttribute('data-a-player-state') === 'playing') return 'loading';
    b.click(); return 'pressed';
  };
  // 🎼 升降 Key: the worklet module from a blob: URL (Electron served it past the players' CSP from kroomfx://; where the player's CSP refuses a
  // blob: module, keyJs falls back to the same shifter in a ScriptProcessor by itself — what the iOS app uses — and reports the extra latency)
  let workletUrl = '';
  const key = (semis) => {
    if (!workletUrl) try { workletUrl = URL.createObjectURL(new Blob([__KROOM_WORKLET], { type: 'text/javascript' })); } catch { workletUrl = ''; }
    return __kroomKeyRun(semis, workletUrl);
  };

  const OPS = {
    vol: (a) => (kind === 'bili' && typeof a === 'number' && a >= 0 && a <= 1 ? vol(a) : undefined),
    media: (a, b) => (kind === 'bili' && ['time', 'seek', 'rate', 'pause', 'play'].includes(a) ? mediaOp(a, typeof b === 'number' ? b : null) : undefined),
    key: (a) => (kind !== 'twitch' && typeof a === 'number' ? key(a) : undefined),
    play: () => (kind === 'twitch' ? twitchKick() : undefined),
  };
  addEventListener('message', (e) => {
    if (e.source !== top || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__kroomFx !== 'req' || typeof d.id !== 'number' || !Object.prototype.hasOwnProperty.call(OPS, d.op)) return;
    let r; try { r = OPS[d.op](d.a, d.b); } catch { r = null; }
    if (r === undefined) return; // (not this player's job: no answer, the bridge does not wait for one)
    post({ __kroomFx: 'res', id: d.id, op: d.op, kind, r: r === null ? null : JSON.parse(JSON.stringify(r)) });
  });
  // a player that (re)loaded says so: the bridge gives it the room's volume and key at once (Electron: did-frame-finish-load)
  const hello = () => post({ __kroomFx: 'hello', kind });
  if (document.readyState === 'complete') hello(); else addEventListener('load', hello, { once: true });
})();
