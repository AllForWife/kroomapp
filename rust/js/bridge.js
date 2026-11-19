// The K ROOM page's window.kroomApp (and the Steam build's window.kroomBilling) — the same API desktop/preload.js gave the Electron app, read by
// src/account.ts, src/ui/appsettings.ts, src/ui/discord.ts, src/music/stage.ts, src/store-billing.ts. Main frame only, K ROOM site only.
// Values baked in by the app (src/main.rs) before the window opens: the origin, the device id, the build flags, a room kept across a restart.
(() => {
  if (window !== window.top) return;
  const ORIGIN = __KROOM_ORIGIN__, DEVICE = __KROOM_DEVICE__, FLAGS = __KROOM_FLAGS__, KEPT = __KROOM_KEPT__;
  if (location.origin !== ORIGIN) return;

  // the app's device id (from this computer itself), where the page looks for it, before its scripts run (preload.js)
  try { if (DEVICE && localStorage.getItem('ktv.device') !== DEVICE) localStorage.setItem('ktv.device', DEVICE); } catch { /* storage off */ }
  // back from an update / site / display restart: the room the player was in goes back where the page looks for it (sessionStorage ktv.rejoin),
  // once, within 10 min. Two sources: the app's own copy (KEPT: written to disk by the app — a restart can come before the page's storage is) and
  // localStorage ktv.rejoin.update (用 App 開啟 puts it there just before loading the page).
  try {
    const fromLs = JSON.parse(localStorage.getItem('ktv.rejoin.update') || 'null'); localStorage.removeItem('ktv.rejoin.update');
    for (const kept of [fromLs, KEPT]) if (kept && typeof kept.rec === 'string' && Date.now() - kept.saved < 10 * 60_000) { sessionStorage.setItem('ktv.rejoin', kept.rec); break; }
  } catch { /* storage off */ }

  const vmcSubs = new Set();
  Object.defineProperty(window, '__kroomVmc', { value: (f) => { for (const cb of vmcSubs) try { cb(f); } catch { /* 訂閱者壞了 */ } } });
  const ftSubs = new Set(), vruiSubs = new Set();
  // 🥽 VR 裡的畫面（src/vr.rs 的 screencast）：base64 JPEG → 位元組，交給 vrui.ts
  Object.defineProperty(window, '__kroomVrui', { value: (f) => { if (!vruiSubs.size || !f || typeof f.img !== 'string') return; const b = atob(f.img), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); for (const cb of vruiSubs) try { cb({ img: u, type: 'image/jpeg', w: f.w, h: f.h }); } catch { /* 訂閱者壞了 */ } } });
  Object.defineProperty(window, '__kroomFacetrack', { value: (m) => { for (const cb of ftSubs) try { cb(m); } catch { /* 訂閱者壞了 */ } } });
  const invoke = (cmd, args) => {
    const t = window.__TAURI_INTERNALS__;
    return t ? t.invoke(cmd, args || {}).catch(() => null) : Promise.resolve(null);
  };
  /** the room record the page keeps in sessionStorage, handed to the app before a restart (Electron keepRoom) */
  const keep = () => { let rec = null; try { rec = sessionStorage.getItem('ktv.rejoin'); } catch { /* storage off */ } return invoke('keep_room', { rec }); };
  Object.defineProperty(window, '__kroomKeep', { value: keep });

  /* ---- the players' frames (frames.js): the requests go to every frame in the page (window.frames, any depth — Electron's framesInSubtree),
     the answers come back by postMessage. An answer counts only from a player frame (its origin and kind), for a request this page sent. ---- */
  /** which player an origin is (an answer's kind must match the site it really came from) */
  const kindOf = (origin) => {
    const m = /^https:\/\/(?:[\w-]+\.)*(bilibili\.com|youtube\.com|youtube-nocookie\.com|twitch\.tv)$/.exec(origin || '');
    return !m ? '' : m[1] === 'bilibili.com' ? 'bili' : m[1] === 'twitch.tv' ? 'twitch' : 'yt';
  };
  const known = new Map(); // player frame window → kind (from its hello)
  let seq = 0; const waiting = new Map(); // request id → { op, kinds, targets (the frames it went to), answered, take }
  const everyFrame = (w, out) => { let n = 0; try { n = w.frames.length; } catch { return out; } for (let i = 0; i < n; i++) { const f = w.frames[i]; out.push(f); everyFrame(f, out); } return out; };
  // (targetOrigin '*': a cross-site frame's address cannot be read from here; a request carries only a volume / a key / an op — nothing private)
  const send = (targets, op, a, b) => { const id = ++seq; for (const f of targets) try { f.postMessage({ __kroomFx: 'req', id, op, a, b }, '*'); } catch { /* gone */ } return id; };
  /** ask the players of these kinds; resolves with the answers so far as soon as one is good(), else once every known player of those kinds
   *  answered, else after 1 s (a player can hold more frames of its own site — Bilibili does — and those answer null) */
  const ask = (kinds, op, a, b, good = () => false) => new Promise((resolve) => {
    for (const [w] of known) if (w.closed) known.delete(w);
    const expect = [...known].filter(([, k]) => kinds.includes(k)).length;
    const targets = everyFrame(window, []), id = send(targets, op, a, b), got = [];
    const done = () => { clearTimeout(t); waiting.delete(id); resolve(got); };
    const t = setTimeout(done, 1000);
    waiting.set(id, { op, kinds, targets: new Set(targets), answered: new Set(), take: (r) => { got.push(r); if (good(r.r) || (expect && got.length >= expect)) done(); } });
  });
  let vol = null, key = 0;
  addEventListener('message', (e) => {
    const d = e.data;
    // an answer counts only from the site it claims to be (its origin, checked by the browser), from a window this page knows
    if (!d || typeof d !== 'object' || !e.source || !d.kind || d.kind !== kindOf(e.origin)) return;
    if (d.__kroomFx === 'hello') {
      known.set(e.source, d.kind);
      // a player that just (re)loaded gets the volume and the key at once
      if (d.kind === 'bili' && vol !== null) send([e.source], 'vol', vol);
      if (d.kind !== 'twitch' && key) send([e.source], 'key', key);
    } else if (d.__kroomFx === 'res' && typeof d.id === 'number' && waiting.has(d.id)) {
      // …for a request that went to that very frame, for that operation and player kind, once per frame
      const w = waiting.get(d.id);
      if (!w.targets.has(e.source) || w.answered.has(e.source) || d.op !== w.op || !w.kinds.includes(d.kind)) return;
      w.answered.add(e.source); known.set(e.source, d.kind);
      w.take({ kind: d.kind, r: d.r });
    }
  });

  const bridge = {
    loginWithBrowser: () => invoke('login_with_browser'),
    getDisplay: () => invoke('get_display'),
    setUnlockFps: (on) => invoke('set_unlock_fps', { on: !!on }),
    relaunch: async () => { await keep(); return invoke('relaunch'); },
    setBeta: (on) => invoke('set_beta', { on: !!on }),
    getSites: () => invoke('get_sites'),
    setSite: async (k) => { await keep(); return invoke('set_site', { key: String(k) }); },
    /** 🔊 the Bilibili player's volume (0–1) */
    /** 🎤 VTuber 演出：收 VMC（src/vmc.rs；跟 Electron 版 preload.js 一樣的介面） */
    vmc: { start: (port) => invoke('vmc_start', { port: Number.isInteger(port) ? port : null }), stop: () => invoke('vmc_stop'), onFrame: (cb) => { vmcSubs.add(cb); return () => vmcSubs.delete(cb); }, onError: () => () => {} },
    /** 🎤 原生臉部追蹤（src/facetrack.rs；跟 Electron 版 preload.js 一樣的介面） */
    /** 🥽 VTuber 的 VR（src/vr.rs；跟 Electron 版 preload.js 一樣的介面；只有 Windows） */
    vr: { get: () => invoke('vr_get'), set: (on) => invoke('vr_set', { on: !!on }), enter: () => invoke('vr_enter') },
    vrui: { start: () => invoke('vrui_start'), stop: () => invoke('vrui_stop'), onFrame: (cb) => { vruiSubs.add(cb); return () => vruiSubs.delete(cb); }, input: (ev) => invoke('vrui_input', { ev }) },
    facetrack: { available: () => invoke('facetrack_available'), start: (o) => invoke('facetrack_start', { opts: o || {} }), stop: () => invoke('facetrack_stop'), onStatus: (cb) => { ftSubs.add(cb); return () => ftSubs.delete(cb); } },
    setEmbedVolume: async (v) => { const n = Number(v); if (!(n >= 0 && n <= 1)) return false; vol = n; send(everyFrame(window, []), 'vol', n); return true; },
    /** 🎵 the Bilibili player kept in step: op time / seek / rate / pause / play → { t, paused, ended, stall } or null */
    embedMedia: async (op, arg) => {
      op = String(op); const n = Number(arg);
      if (!['time', 'seek', 'rate', 'pause', 'play'].includes(op) || (op === 'seek' && !(n >= 0)) || (op === 'rate' && !(n >= 0.25 && n <= 4))) return null;
      const got = await ask(['bili'], 'media', op, op === 'seek' || op === 'rate' ? n : null, (r) => !!r && typeof r.t === 'number');
      const r = got.find((x) => x.r && typeof x.r.t === 'number');
      return r ? { t: +r.r.t, paused: !!r.r.paused, ended: !!r.r.ended, stall: !!r.r.stall } : null;
    },
    /** 🎼 升降 Key (−12…12) for the YouTube / Bilibili player → { semis, wired, shifting, kind, latency, pending, error } or null */
    setEmbedKey: async (n) => {
      const k = Math.round(Number(n)); if (!(k >= -12 && k <= 12)) return null; key = k;
      let out = null;
      for (const { r } of await ask(['bili', 'yt'], 'key', k)) if (r && typeof r === 'object' && (!out || (r.wired && !out.wired))) out = r;
      return out;
    },
    /** 🌙 the YouTube player's quality ('tiny' in the background, 'auto' back) → the level set, or null (no player) */
    setEmbedQuality: async (q) => {
      q = String(q); if (!['tiny', 'small', 'medium', 'auto'].includes(q)) return null;
      const got = await ask(['yt'], 'quality', q, null, (r) => r === q);
      return got.some((x) => x.r === q) ? q : null;
    },
    /** ▶ Twitch stuck on its play button */
    embedPlay: async () => { const got = await ask(['twitch'], 'play'); return got.length ? got.map((x) => String(x.r)).join(',') : null; },
    /** 🧪 which app this is — { current: 'rust' | 'electron', engines } — and switching to the other one (it is installed, then started) */
    getEngine: () => invoke('get_engine'),
    setEngine: async (e) => { await keep(); return invoke('set_engine', { engine: String(e) }); },
    setAwake: (on) => invoke('set_awake', { on: !!on }),
    setPresence: (p) => invoke('set_presence', { p: p && typeof p === 'object' ? JSON.parse(JSON.stringify(p)) : null }),
    /** 🪟 the window minimised / in front or not: the page draws less meanwhile */
    onWindowState: (fn) => { if (typeof fn === 'function') { states.push(fn); if (last) try { fn(last); } catch { /* the page's problem */ } } },
  };
  const states = []; let last = null;
  Object.defineProperty(window, '__kroomWinState', { value: (st) => { last = { min: !!(st && st.min), focus: !!(st && st.focus) }; for (const fn of states) try { fn(last); } catch { /* the page's problem */ } } });
  if (!FLAGS.canUnlock) delete bridge.setUnlockFps; // (a Mac's WebKit always draws at the screen's rate: the page then hides the switch)
  if (FLAGS.steam) { delete bridge.setBeta; delete bridge.getSites; delete bridge.setSite; delete bridge.getEngine; delete bridge.setEngine; }
  if (FLAGS.steam && FLAGS.steamUser) {
    bridge.steamTicket = () => invoke('steam_ticket');
    Object.defineProperty(window, 'kroomBilling', { value: Object.freeze({ steamId: () => invoke('steam_id') }) });
  }
  Object.defineProperty(window, 'kroomApp', { value: Object.freeze(bridge) });

  // thin dark scrollbars on the K ROOM pages (WebView2 draws Windows' old grey ones)
  const css = '::-webkit-scrollbar{width:8px;height:8px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.32)}::-webkit-scrollbar-button{display:none}';
  const addCss = () => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', addCss, { once: true }); else addCss();

  // a link to another site in the same window opens in the normal browser (Electron will-navigate). Windows also checks this natively; on a Mac the
  // webview's navigation check cannot tell the page from its iframes, so it is done here.
  const google = (h) => h === 'accounts.google.com' || h === 'accounts.youtube.com' || h.endsWith('.google.com');
  addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.composedPath().find((x) => x && x.tagName === 'A' && x.href);
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || u.origin === ORIGIN || google(u.hostname)) return;
    e.preventDefault(); invoke('open_external', { url: u.href });
  }, true);
})();
