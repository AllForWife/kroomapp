// Does the app's audio keep up while its window is not in front? (Windows)
//   node desktop-rs/tests/bg-audio.mjs rust <kroom.exe built with --features devport, or a debug build> [seconds]
//   node desktop-rs/tests/bg-audio.mjs electron <K ROOM.exe> [seconds]
// For each of: in front / behind another program / minimised — each once on an idle PC and once with every CPU core busy — the page measures:
//   raf     animation frames a second (the page's voice upkeep runs on them)
//   timer   the longest wait of a 10 ms timer (ms)
//   sp      ScriptProcessor (audio on the page's thread): callbacks later than 2 buffers, and the longest gap (ms)
//   lost    audio time the sound card did not get: wall clock − the AudioContext's clock (ms). >0 = audible gaps
//   vis     document.visibilityState
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const WebSocket = require('../../node_modules/ws');

const [kind, exe, secArg] = process.argv.slice(2);
const SEC = Number(secArg) || 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kroom-bg-'));
const port = kind === 'electron' ? 9421 : 9422;
const app = kind === 'electron'
  ? { args: [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], env: { KROOM_NO_UPDATE: '1' } }
  : { args: [], env: { KROOM_DEBUG_PORT: String(port), KROOM_NO_UPDATE: '1', KROOM_TEST_SECOND: '1', WEBVIEW2_USER_DATA_FOLDER: profile } }; // (next to an open K ROOM)

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();
const USER32 = `Add-Type -Name W -Namespace K -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();';`;
/** the app's main window handle (the process with a window titled K ROOM under pid's tree is pid itself in both apps) */
const hwnd = (pid) => ps(`(Get-Process -Id ${pid}).MainWindowHandle`);
const show = (h, c) => ps(`${USER32} [K.W]::ShowWindow([IntPtr]${h}, ${c}) | Out-Null; if (${c} -ne 6) { [K.W]::SetForegroundWindow([IntPtr]${h}) | Out-Null }; Start-Sleep -Milliseconds 300; "$([K.W]::IsIconic([IntPtr]${h})) $([K.W]::GetForegroundWindow() -eq [IntPtr]${h})"`);

async function page(deadline) {
  while (Date.now() < deadline) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page' && /play\.kroom\.tw/.test(x.url));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page');
}
function session(url) {
  const ws = new WebSocket(url); let n = 0; const pend = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const ready = new Promise((r) => ws.on('open', r));
  const ev = async (expression) => { await ready; return new Promise((r) => { const id = ++n; pend.set(id, (j) => r(j.result?.result?.value ?? j.result?.exceptionDetails?.text)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); };
  return { ev, close: () => ws.close() };
}

const MEASURE = (ms) => `(async () => {
  const ctx = window.__bg || (window.__bg = new AudioContext({ latencyHint: 'interactive' }));
  await ctx.resume();
  if (!window.__bgNode) { // a quiet tone through a ScriptProcessor: sound really goes to the sound card
    const o = ctx.createOscillator(), g = ctx.createGain(), sp = ctx.createScriptProcessor(1024, 1, 1); g.gain.value = 0.0005;
    window.__bgSp = { last: 0, late: 0, max: 0, n: 0 };
    sp.onaudioprocess = (e) => { const s = window.__bgSp, t = performance.now(); if (s.last) { const d = t - s.last; s.n++; if (d > s.max) s.max = d; if (d > 2 * 1024 / ctx.sampleRate * 1000) s.late++; } s.last = t; e.outputBuffer.getChannelData(0).set(e.inputBuffer.getChannelData(0)); };
    o.connect(g).connect(sp).connect(ctx.destination); o.start(); window.__bgNode = sp;
    await new Promise((r) => setTimeout(r, 500));
  }
  Object.assign(window.__bgSp, { last: 0, late: 0, max: 0, n: 0 });
  let raf = 0, live = true, timer = 0, lt = performance.now();
  const tick = () => { raf++; if (live) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  const tm = () => { const t = performance.now(); if (t - lt > timer) timer = t - lt; lt = t; if (live) setTimeout(tm, 10); }; setTimeout(tm, 10);
  const w0 = performance.now(), a0 = ctx.currentTime;
  await new Promise((r) => setTimeout(r, ${ms}));
  const w = performance.now() - w0, a = (ctx.currentTime - a0) * 1000; live = false;
  const s = window.__bgSp;
  return { raf: Math.round(raf / (w / 1000)), timer: Math.round(timer), spLate: s.late, spMax: Math.round(s.max), spN: s.n, lost: Math.round(w - a), vis: document.visibilityState, focus: document.hasFocus() };
})()`;

const hogs = [];
const busy = (on) => {
  if (on) for (let i = 0; i < os.cpus().length; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
  else while (hogs.length) try { hogs.pop().kill(); } catch { /* gone */ }
};

const p = spawn(exe, app.args, { env: { ...process.env, ...app.env }, stdio: 'ignore' });
let cover;
try {
  const t = await page(Date.now() + 60000);
  const s = session(t.webSocketDebuggerUrl);
  while ((await s.ev(`location.origin + ' ' + document.readyState`)) !== 'https://play.kroom.tw complete') await sleep(100);
  await sleep(8000);
  const h = hwnd(p.pid);
  const rows = [];
  for (const load of [false, true]) {
    for (const state of ['front', 'behind', 'minimised']) {
      let st;
      if (state === 'front') st = show(h, 9);
      else if (state === 'behind') { show(h, 9); cover = spawn('notepad.exe', [], { stdio: 'ignore' }); await sleep(1500); ps(`${USER32} $n = (Get-Process -Id ${cover.pid} -ErrorAction SilentlyContinue).MainWindowHandle; if ($n) { [K.W]::ShowWindow($n, 3) | Out-Null; [K.W]::SetForegroundWindow($n) | Out-Null }`); st = ps(`${USER32} "$([K.W]::IsIconic([IntPtr]${h})) $([K.W]::GetForegroundWindow() -eq [IntPtr]${h})"`); }
      else st = show(h, 6);
      busy(load);
      await sleep(3000); // (Windows and the browser take a moment to treat the window as in the background)
      const r = await s.ev(MEASURE(SEC * 1000));
      busy(false);
      if (cover) { try { execFileSync('taskkill', ['/T', '/F', '/IM', 'notepad.exe'], { stdio: 'ignore' }); } catch { /* gone */ } cover = null; }
      rows.push({ state, load, ...r, win: st });
      console.log(`${kind.padEnd(8)} ${state.padEnd(10)} ${load ? 'busy' : 'idle'}  raf ${String(r.raf).padStart(4)}  timer ${String(r.timer).padStart(5)} ms  sp late ${String(r.spLate).padStart(4)}/${r.spN} max ${String(r.spMax).padStart(5)} ms  lost ${String(r.lost).padStart(5)} ms  ${r.vis} focus=${r.focus}  [minimised/foreground: ${st}]`);
      await sleep(1500);
    }
  }
  s.close();
} finally {
  busy(false);
  try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
