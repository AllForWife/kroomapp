// Does the stage voice's receive transform (src/audio/sfu.ts STAMP_WORKER: an RTCRtpScriptTransform in a worker) keep running while the app's
// window is not in front? A loopback inside the app's page: a tone → connection A → connection B with the worker's receive transform → Web Audio.
// Every 5 s for MIN minutes per state (in front / behind another window / minimised): packets received, the transform's heartbeats that reached
// the page (25 frames each → 2 a second), concealed audio, and the sound level that came out.
//   node desktop-rs/tests/bg-transform.mjs rust <debug kroom.exe> [minutes per state]     (dev server on :5199)
//   node desktop-rs/tests/bg-transform.mjs electron <K ROOM.exe> [minutes per state]
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const WebSocket = require('../../node_modules/ws');

const [kind, exe, minArg] = process.argv.slice(2);
const MIN = Number(minArg) || 2;
const URL_ = process.env.KTV_URL || 'http://localhost:5199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kroom-bgt-'));
const port = kind === 'electron' ? 9441 : 9442;
const app = kind === 'electron'
  ? { args: [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--url=${URL_}`], env: { KROOM_NO_UPDATE: '1', KROOM_URL: URL_ } }
  : { args: [`--url=${URL_}`], env: { KROOM_DEBUG_PORT: String(port), KROOM_NO_UPDATE: '1', KROOM_TEST_SECOND: '1', WEBVIEW2_USER_DATA_FOLDER: profile } };
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const USER32 = `Add-Type -Name W -Namespace K -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);';`;
const show = (h, c) => ps(`${USER32} [K.W]::ShowWindow([IntPtr]${h}, ${c}) | Out-Null; if (${c} -ne 6) { [K.W]::SetForegroundWindow([IntPtr]${h}) | Out-Null }`);

const worker = fs.readFileSync(new URL('../../src/audio/sfu.ts', import.meta.url), 'utf8').match(/const STAMP_WORKER = `([\s\S]*?)`;/)[1];
const SETUP = `(async () => {
  const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' })));
  const T = window.__t = { hb: 0, hbAt: 0, stamps: 0 }; w.onmessage = (e) => { if (e.data.hb) { T.hb++; T.hbAt = performance.now(); } else T.stamps++; };
  const ctx = T.ctx = new AudioContext(); await ctx.resume();
  const o = ctx.createOscillator(), g = ctx.createGain(), d = ctx.createMediaStreamDestination(); g.gain.value = 0.3; o.connect(g).connect(d); o.start();
  const a = T.a = new RTCPeerConnection(), b = T.b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const tr = a.addTransceiver(d.stream.getAudioTracks()[0], { direction: 'sendonly' });
  tr.sender.transform = new RTCRtpScriptTransform(w, { side: 'send' });
  w.postMessage({ pos: true, on: true, p: 12, at: performance.timeOrigin + performance.now(), rate: 1, token: 7 }); // (stamped, as a singer with a song playing)
  b.ontrack = (e) => { e.receiver.transform = new RTCRtpScriptTransform(w, { side: 'recv', mid: e.transceiver.mid });
    const st = new MediaStream([e.track]), el = new Audio(); el.srcObject = st; el.muted = true; void el.play(); T.el = el;
    const src = ctx.createMediaStreamSource(st), an = T.an = ctx.createAnalyser(), mute = ctx.createGain(); mute.gain.value = 0; src.connect(an); an.connect(mute).connect(ctx.destination); };
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
  await new Promise((r) => { const t = setInterval(() => { if (b.connectionState === 'connected') { clearInterval(t); r(); } }, 100); });
  return 'connected'; })()`;
const READ = `(async () => { const T = window.__t, o = { hb: T.hb, stamps: T.stamps, pk: 0, conc: 0, total: 0, level: 0, ctx: T.ctx.state, vis: document.visibilityState, paused: T.el.paused };
  for (const s of (await T.b.getStats()).values()) if (s.type === 'inbound-rtp') { o.pk = s.packetsReceived; o.conc = s.concealedSamples; o.total = s.totalSamplesReceived; }
  const buf = new Float32Array(1024); T.an.getFloatTimeDomainData(buf); let m = 0; for (const x of buf) m = Math.max(m, Math.abs(x)); o.level = +m.toFixed(3); return o; })()`;

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
  return { ev: async (expression) => { await ready; return new Promise((r) => { const id = ++n; pend.set(id, (j) => r(j.result?.exceptionDetails ? 'ERR ' + (j.result.exceptionDetails.exception?.description || j.result.exceptionDetails.text) : j.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); }, close: () => ws.close() };
}

const p = spawn(exe, app.args, { env: { ...process.env, ...app.env }, stdio: 'ignore' });
try {
  const s = session((await target(Date.now() + 60000)).webSocketDebuggerUrl);
  while ((await s.ev(`document.readyState`)) !== 'complete') await sleep(100);
  await sleep(3000);
  console.log('loopback:', await s.ev(SETUP));
  const h = ps(`(Get-Process -Id ${p.pid}).MainWindowHandle`);
  for (const st of ['front', 'behind', 'minimised']) {
    if (st === 'front') show(h, 9);
    else if (st === 'behind') { show(h, 9); spawn('notepad.exe', [], { stdio: 'ignore' }); await sleep(1500); ps(`${USER32} $n = (Get-Process notepad -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -Last 1).MainWindowHandle; if ($n) { [K.W]::ShowWindow($n, 3) | Out-Null; [K.W]::SetForegroundWindow($n) | Out-Null }`); }
    else show(h, 6);
    let prev = await s.ev(READ), bad = 0, worst = '';
    const steps = st === 'front' ? 3 : MIN * 12;
    for (let i = 0; i < steps; i++) {
      await sleep(5000); const r = await s.ev(READ);
      const d = { pk: r.pk - prev.pk, hb: r.hb - prev.hb, stamps: r.stamps - prev.stamps, concMs: Math.round((r.conc - prev.conc) / 48) };
      const ok = d.pk > 200 && d.hb >= 8 && d.concMs < 100 && r.level > 0.05 && r.ctx === 'running';
      if (!ok) { bad++; worst = `${(i + 1) * 5}s: ${JSON.stringify(d)} level ${r.level} ctx ${r.ctx} el.paused ${r.paused}`; console.log(`  ${kind} ${st} BAD at ${worst}`); }
      prev = r;
    }
    console.log(`${kind.padEnd(8)} ${st.padEnd(10)} ${steps * 5} s: ${bad ? bad + ' bad 5 s windows' : 'all good'} — last ${JSON.stringify(prev)}`);
    if (st === 'behind') try { execFileSync('taskkill', ['/F', '/IM', 'notepad.exe'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  s.close();
} finally {
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* still held */ }
}
