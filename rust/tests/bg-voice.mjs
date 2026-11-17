// Does the VOICE keep up while the app's window is not in front? A real room on the local dev server (PORT=5199 node server/index.mjs --dev):
// the app (fake microphone) and a headless Chrome (fake microphone) talk to each other; for each of in front / behind another program / minimised,
// on an idle PC and with every core busy, 8 s of:
//   hears   what the app hears from the other one: concealed (made-up) audio ms and events (WebRTC receive stats), jitter buffer ms
//   heard   what the other one hears from the app: the same, at the other end — the app's microphone → encoder → network
//   stall   the longest pause of the app's page thread (ms);  raf  its frames a second;  lost  audio clock behind the wall clock (ms)
//   node desktop-rs/tests/bg-voice.mjs rust <debug or devport kroom.exe> [seconds]
//   node desktop-rs/tests/bg-voice.mjs electron <K ROOM.exe> [seconds]
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
const WebSocket = require('../../node_modules/ws');

const [kind, exe, secArg] = process.argv.slice(2);
const SEC = Number(secArg) || 8;
const URL_ = process.env.KTV_URL || 'http://localhost:5199';
const ROOM = 'bg' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kroom-bgv-'));
const port = kind === 'electron' ? 9431 : 9432;

// a fake microphone: a voice-like tone with vibrato, no rests (48 kHz mono 16-bit, 20 s, looped by the browser)
const wav = path.join(os.tmpdir(), 'kroom-bg-voice.wav');
{ const sr = 48000, n = sr * 20, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / sr, f = 220 * (1 + 0.3 * Math.sin(2 * Math.PI * 0.4 * t)), ph = 2 * Math.PI * f * t - (0.004 * f / 5.5) * Math.cos(2 * Math.PI * 5.5 * t);
    buf.writeInt16LE(Math.round((Math.sin(ph) * 0.35 + Math.sin(2 * ph) * 0.1 + Math.sin(3 * ph) * 0.05) * 32767), 44 + i * 2); }
  fs.writeFileSync(wav, buf); }
const FAKE = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`];

const start = `${URL_}/?room=${ROOM}&venue=ktv`;
const app = kind === 'electron'
  ? { args: [...(process.env.APP_DIR ? [process.env.APP_DIR] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--url=${start}`, ...FAKE], env: { KROOM_NO_UPDATE: '1', KROOM_URL: start } }
  : { args: [`--url=${start}`], env: { KROOM_DEBUG_PORT: String(port), KROOM_NO_UPDATE: '1', KROOM_TEST_SECOND: '1', WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: FAKE.join(' ') } };

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const USER32 = `Add-Type -Name W -Namespace K -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();';`;
const hwnd = (pid) => ps(`(Get-Process -Id ${pid}).MainWindowHandle`);
const state = (h) => ps(`${USER32} "$([K.W]::IsIconic([IntPtr]${h})) $([K.W]::GetForegroundWindow() -eq [IntPtr]${h})"`);
const show = (h, c) => { ps(`${USER32} [K.W]::ShowWindow([IntPtr]${h}, ${c}) | Out-Null; if (${c} -ne 6) { [K.W]::SetForegroundWindow([IntPtr]${h}) | Out-Null }`); };

async function target(deadline) {
  while (Date.now() < deadline) {
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(URL_)); if (t) return t; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('the app did not open ' + URL_);
}
function session(url) {
  const ws = new WebSocket(url); let n = 0; const pend = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const ready = new Promise((r) => ws.on('open', r));
  const ev = async (expression) => { await ready; return new Promise((r) => { const id = ++n; pend.set(id, (j) => r(j.result?.exceptionDetails ? 'ERR ' + (j.result.exceptionDetails.exception?.description || j.result.exceptionDetails.text) : j.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } })); }); };
  return { ev, close: () => ws.close() };
}

/** the page's receive stats for every voice it hears (summed) */
const RECV = `(async () => { const o = { conc: 0, ev: 0, total: 0, jb: 0, jbn: 0, pk: 0, lost: 0 }; const v = window.__ktv.voice;
  for (const r of [...v.remotes.values(), ...v.serving.values()]) for (const s of (await r.pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.kind === 'audio') {
    o.conc += s.concealedSamples - (s.silentConcealedSamples || 0); o.ev += s.concealmentEvents || 0; o.total += s.totalSamplesReceived || 0; o.jb += s.jitterBufferDelay || 0; o.jbn += s.jitterBufferEmittedCount || 0; o.pk += s.packetsReceived || 0; o.lost += s.packetsLost || 0; }
  return o; })()`;
const diff = (a, b) => ({ concMs: Math.round((b.conc - a.conc) / 48), ev: b.ev - a.ev, jbMs: b.jbn > a.jbn ? Math.round(((b.jb - a.jb) / (b.jbn - a.jbn)) * 1000) : -1, pk: b.pk - a.pk, lost: b.lost - a.lost });
/** in the app's page: the page thread's longest pause, frames a second, the audio clock against the wall clock */
const PAGE = (ms) => `(async () => { const ctx = window.__ktv.voice.ctx; let raf = 0, live = true, stall = 0, lt = performance.now();
  const tick = () => { raf++; if (live) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  const tm = () => { const t = performance.now(); if (t - lt > stall) stall = t - lt; lt = t; if (live) setTimeout(tm, 5); }; setTimeout(tm, 5);
  const w0 = performance.now(), a0 = ctx.currentTime; await new Promise((r) => setTimeout(r, ${ms})); const w = performance.now() - w0, a = (ctx.currentTime - a0) * 1000; live = false;
  return { raf: Math.round(raf / (w / 1000)), stall: Math.round(stall), lost: Math.round(w - a), vis: document.visibilityState, fps: window.__ktv.appSettings?.fps }; })()`;

// the heavy program and the app share the first CORES cores; the other person's browser, the server and this script keep the rest to themselves
// (on one PC they would be starved with the app, and the test would measure them instead)
const PEERS = Number(process.env.PEERS) || 1, SONG = process.env.SONG || '';
const CORES = Math.max(2, os.cpus().length - (PEERS > 3 ? Math.floor(os.cpus().length / 2) : 2)), MASK = 2 ** CORES - 1;
// this script and everything it starts (the other people's browser, PowerShell helpers) and the dev server: the remaining cores only
{ const rest = 2 ** os.cpus().length - 1 - MASK, port = new URL(URL_).port;
  console.log('others on the last', os.cpus().length - CORES, 'cores:', ps(`(Get-Process -Id ${process.pid}).ProcessorAffinity = ${rest}; $s = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($s) { (Get-Process -Id $s).ProcessorAffinity = ${rest} }; "server $s"`)); }
let appPid = 0;
const pin = () => ps(`$all = Get-CimInstance Win32_Process; $ids = @(${appPid}); do { $n = $ids.Count; foreach ($p in $all) { if ($ids -notcontains $p.ProcessId -and $ids -contains $p.ParentProcessId) { $ids += $p.ProcessId } } } while ($ids.Count -ne $n); foreach ($i in $ids) { try { (Get-Process -Id $i).ProcessorAffinity = ${MASK} } catch {} }; $ids.Count`);
const hogs = [];
const busy = (on, n = os.cpus().length) => {
  if (on) for (let i = 0; i < n; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
  else while (hogs.length) try { hogs.pop().kill(); } catch { /* gone */ }
};

/** "a game in front": a maximised Chrome window drawing a very heavy shader as fast as it can (the graphics card is busy), in the foreground */
let hog;
const HOG = `<title>KROOM-GPU-HOG</title><body style="margin:0;background:#000"><canvas id=c style="width:100vw;height:100vh"></canvas><script>
const c = document.getElementById('c'); c.width = innerWidth * 2; c.height = innerHeight * 2; const g = c.getContext('webgl2');
const sh = (t, s) => { const o = g.createShader(t); g.shaderSource(o, s); g.compileShader(o); return o; }, p = g.createProgram();
g.attachShader(p, sh(g.VERTEX_SHADER, '#version 300 es\\nin vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
g.attachShader(p, sh(g.FRAGMENT_SHADER, '#version 300 es\\nprecision highp float; uniform float t; out vec4 o; void main(){ vec2 z = gl_FragCoord.xy / 900. - 1.; float s = 0.; for (int i = 0; i < 600; i++) { z = vec2(z.x * z.x - z.y * z.y, 2. * z.x * z.y) + vec2(sin(t + float(i) * .01), cos(t)) * .6; s += exp(-dot(z, z)); } o = vec4(fract(s), fract(s * .37), fract(s * .11), 1.); }'));
g.linkProgram(p); g.useProgram(p); g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer()); g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0); const u = g.getUniformLocation(p, 't'); window.frames_ = 0;
const f = (t) => { g.uniform1f(u, t / 1000); for (let k = 0; k < 3; k++) g.drawArrays(g.TRIANGLES, 0, 3); window.frames_++; requestAnimationFrame(f); }; requestAnimationFrame(f);
</script>`;
async function game(on) {
  if (!on) { if (hog) { await hog.close().catch(() => {}); hog = null; } return; }
  hog = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--start-maximized', '--force_high_performance_gpu', '--no-first-run'] });
  const pg = await (await hog.newContext({ viewport: null })).newPage(); await pg.setContent(HOG); await sleep(1500);
  ps(`${USER32} $n = (Get-Process chrome | Where-Object { $_.MainWindowTitle -like '*KROOM-GPU-HOG*' } | Select-Object -First 1).MainWindowHandle; if ($n) { [K.W]::ShowWindow($n, 3) | Out-Null; [K.W]::SetForegroundWindow($n) | Out-Null }`);
  hog.fps = async () => { const a = await pg.evaluate('window.frames_'); await sleep(1000); return (await pg.evaluate('window.frames_')) - a; };
}

/** sign in on the dev server (POST /api/auth/dev: tests only), open the room, press 進入 */
const SIGNIN = (sub) => `(async () => { const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const r = await post('/api/auth/dev', { sub: ${JSON.stringify(sub)} }); const me = await (await fetch('/api/auth/me')).json();
  if (!me.account.terms || me.account.age === false) await post('/api/account/terms', { v: me.auth.terms, ...(me.account.rating ? { age: me.account.rating } : {}) });
  if (!me.account.name) await post('/api/account/name', { name: ${JSON.stringify(sub)}.slice(0, 3) + Math.floor(Math.random() * 9000 + 1000) });
  return r.status; })()`;
const GO = `(async () => { const w = (f, ms) => new Promise((r, no) => { const t0 = Date.now(), t = setInterval(() => { if (f()) { clearInterval(t); r(); } else if (Date.now() - t0 > ms) { clearInterval(t); no(new Error('timeout: ' + document.body.innerText.slice(0, 200))); } }, 100); });
  await w(() => document.querySelector('#e-go'), 90000); document.querySelector('#e-go').click();
  await w(() => window.__ktv && window.__ktv.net.connected, 240000); return window.__ktv.net.id; })()`;

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: [...FAKE, '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = spawn(exe, app.args, { env: { ...process.env, ...app.env }, stdio: 'ignore' }); appPid = p.pid;
let cover, fg;
try {
  const peers = [];
  for (let k = 0; k < PEERS; k++) {
    // the other people are only there to talk and listen: with many of them on one PC they draw 2 frames a second and load no video player
    const C = await browser.newContext({ viewport: { width: 480, height: 300 } });
    if (PEERS > 1) { await C.addInitScript(() => { window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 500); window.cancelAnimationFrame = (i) => clearTimeout(i); }); await C.route(/youtube\.com|ytimg\.com|googlevideo\.com|youtube-nocookie\.com/, (r) => r.abort()); }
    const P = await C.newPage();
    if (!k) { P.on('pageerror', (e) => console.log('[B] pageerror', e.message.slice(0, 300))); }
    await P.goto(URL_, { timeout: 120000 }); await P.evaluate(SIGNIN('bg' + k + ROOM)); await P.goto(start, { timeout: 120000 }); const id = await P.evaluate(GO); peers.push(P);
    await P.evaluate(`(() => { const k = window.__ktv; try { k.qualityCtl?.set?.('low'); } catch {} })()`);
  }
  const B = peers[0]; console.log(peers.length, 'other people joined');
  const s = session((await target(Date.now() + 60000)).webSocketDebuggerUrl);
  while ((await s.ev(`document.readyState`)) !== 'complete') await sleep(100);
  console.log('app sign-in', await s.ev(SIGNIN('bgA' + ROOM))); await s.ev(`void (location.href = ${JSON.stringify(start)})`); await sleep(1500);
  while ((await s.ev(`document.readyState`)) !== 'complete') await sleep(100);
  console.log('app joined as', await s.ev(GO), 'ua', await s.ev('navigator.userAgent.match(/KRoom\S+/g)?.join(" ")'));
  await sleep(4000);
  console.log('mic app:', await s.ev(`window.__ktv.voice.toggleMic(true).then(() => window.__ktv.voice.micOn + ' ' + (window.__ktv.voice.micError || 'ok'))`));
  for (const P of peers) await P.evaluate(`window.__ktv.voice.toggleMic(true).then(() => window.__ktv.voice.micOn + ' ' + (window.__ktv.voice.micError || 'ok'))`);
  console.log('mics on:', (await Promise.all(peers.map((P) => P.evaluate('window.__ktv.voice.micOn')))).filter(Boolean).length, 'of', peers.length);
  if (SONG) { // a real YouTube song in the room's player, as a real room has
    await s.ev(`window.__ktv.net.send({ t: 'q:add', item: { title: 'test song', artist: '', lang: 'en', thumb: '', duration: 212, catalogKey: '', src: { platform: 'youtube', id: ${JSON.stringify(SONG)}, url: 'https://www.youtube.com/watch?v=' + ${JSON.stringify(SONG)}, embedUrl: '' } } })`);
    for (let i = 0; i < 60 && !(await s.ev('!!(window.__ktv.net.now && !window.__ktv.net.now.prep && window.__ktv.stage.isPlaying)')); i++) await sleep(1000);
    console.log('song playing in the app:', await s.ev('!!window.__ktv.stage.isPlaying'), 'at', await s.ev('Math.round(window.__ktv.stage.playPos?.() ?? -1)'), 's');
  }
  await sleep(4000); console.log('voice connections in the app:', await s.ev(`[...window.__ktv.voice.remotes.values(), ...window.__ktv.voice.serving.values()].filter((r) => r.pc.connectionState === 'connected').length`));
  await sleep(6000);
  // BOOST_ALL=1: every process under the app one step above normal, from outside (what desktop/main.js does itself from 1.0.17 on — for an older Electron)
  if (process.env.BOOST_ALL) console.log('raised:', ps(`$all = Get-CimInstance Win32_Process; $ids = @(${p.pid}); do { $n = $ids.Count; foreach ($q in $all) { if ($ids -notcontains $q.ProcessId -and $ids -contains $q.ParentProcessId) { $ids += $q.ProcessId } } } while ($ids.Count -ne $n); $c = 0; foreach ($i in $ids) { $cl = ($all | Where-Object ProcessId -eq $i).CommandLine; if (($i -ne ${p.pid} -or "${process.env.BOOST_ALL}" -eq "2") -and ("${process.env.BOOST_ALL}" -ne "util" -or $cl -match "--type=utility")) { try { (Get-Process -Id $i).PriorityClass = 'AboveNormal'; $c++ } catch {} } }; $c`), 'processes');
  const h = hwnd(p.pid); console.log('app processes on the first', CORES, 'cores:', pin());
  for (const load of (process.env.LOADS || 'idle,busy,game').split(',')) {
    for (const st of load === 'game' || load.startsWith('fg') ? ['behind', 'minimised'] : ['front', 'behind', 'minimised']) {
      if (st === 'front') show(h, 9);
      else if (st === 'behind' && (load === 'game' || load.startsWith('fg'))) show(h, 9);
      else if (st === 'behind') { show(h, 9); cover = spawn('notepad.exe', [], { stdio: 'ignore' }); await sleep(1500); ps(`${USER32} $n = (Get-Process notepad -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -Last 1).MainWindowHandle; if ($n) { [K.W]::ShowWindow($n, 3) | Out-Null; [K.W]::SetForegroundWindow($n) | Out-Null }`); }
      else show(h, 6);
      // fg / fghigh / fgabove: ONE program that owns the foreground window and keeps every core busy (tests/fg-hog.ps1), at normal / high / above-normal priority
      if (load.startsWith('fg')) { fg = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', new URL('./fg-hog.ps1', import.meta.url).pathname.slice(1), '-Threads', String(CORES), '-Affinity', String(MASK), '-Priority', load === 'fghigh' ? 'High' : load === 'fgabove' ? 'AboveNormal' : 'Normal', '-Seconds', String(SEC + 16)], { stdio: 'ignore' });
        pin(); await sleep(3500); ps(`${USER32} $n = (Get-Process powershell | Where-Object { $_.MainWindowTitle -eq 'KROOM-FG-HOG' } | Select-Object -First 1).MainWindowHandle; if ($n) { [K.W]::SetForegroundWindow($n) | Out-Null }`); }
      busy(load !== 'idle' && !load.startsWith('fg'), load === 'game' ? Math.ceil(os.cpus().length / 2) : os.cpus().length);
      if (load === 'game') await game(true);
      await sleep(load.startsWith('fg') ? 6000 : 4000);
      const win = state(h);
      const hogFps = hog ? await hog.fps() : null;
      const [a0, b0] = [await s.ev(RECV), await B.evaluate(RECV)];
      const pg = await s.ev(PAGE(SEC * 1000));
      const [a1, b1] = [await s.ev(RECV), await B.evaluate(RECV)];
      busy(false); await game(false); if (fg) { await new Promise((r) => { fg.on('exit', r); setTimeout(r, 20000); }); try { fg.kill(); } catch { /* gone */ } fg = null; }
      if (cover) { try { execFileSync('taskkill', ['/F', '/IM', 'notepad.exe'], { stdio: 'ignore' }); } catch { /* gone */ } cover = null; }
      const hears = diff(a0, a1), heard = diff(b0, b1);
      console.log(`${kind.padEnd(8)} ${st.padEnd(10)} ${load} | hears: concealed ${String(hears.concMs).padStart(5)} ms in ${String(hears.ev).padStart(3)}, buffer ${String(hears.jbMs).padStart(4)} ms, ${hears.pk} pk −${hears.lost} | heard: concealed ${String(heard.concMs).padStart(5)} ms in ${String(heard.ev).padStart(3)}, buffer ${String(heard.jbMs).padStart(4)} ms, ${heard.pk} pk −${heard.lost} | page: stall ${String(pg.stall).padStart(5)} ms raf ${pg.raf} drawn ${pg.fps} lost ${pg.lost} ms ${pg.vis} | min/fg ${win}${hogFps === null ? '' : ' | the game: ' + hogFps + ' fps'}`);
      await sleep(1500);
    }
  }
  s.close();
} finally {
  busy(false);
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
  await browser.close().catch(() => {});
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* still held */ }
}
