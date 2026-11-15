// Rust app vs Electron app on the same machine and the same page (play.kroom.tw's front page, signed out):
//   node desktop-rs/tests/bench.mjs <electron K ROOM.exe> <rust kroom.exe built with --features devport> [runs]
// Per run: launch → page fully loaded (wall clock), memory and idle CPU of the whole process tree (the app and every browser process under it),
// the page's frame rate, and a fixed JavaScript workload. Both apps are driven over the DevTools protocol (Electron: --remote-debugging-port;
// the Rust app: KROOM_DEBUG_PORT, only in a devport build). Windows only.
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const WebSocket = require('../../node_modules/ws');

const [electronExe, rustExe, runsArg] = process.argv.slice(2);
const RUNS = Number(runsArg) || 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kroom-bench-electron-'));

const APPS = {
  electron: { exe: electronExe, args: ['--remote-debugging-port=9411', `--user-data-dir=${profile}`], env: { KROOM_NO_UPDATE: '1' }, port: 9411 },
  rust: { exe: rustExe, args: [], env: { KROOM_DEBUG_PORT: '9412', KROOM_NO_UPDATE: '1' }, port: 9412 },
};

/** every process in the tree under pid: { ws (working set, MB), priv (private commit, MB), cpu (s), n } */
function tree(pid) {
  const ps = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`;
  const all = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true }));
  const ids = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const p of all) if (!ids.has(p.ProcessId) && ids.has(p.ParentProcessId)) { ids.add(p.ProcessId); grew = true; } }
  const mine = all.filter((p) => ids.has(p.ProcessId));
  const sum = (k) => mine.reduce((a, p) => a + Number(p[k] || 0), 0);
  return { ws: sum('WorkingSetSize') / 2 ** 20, priv: sum('PrivatePageCount') / 2 ** 20, cpu: (sum('KernelModeTime') + sum('UserModeTime')) / 1e7, n: mine.length };
}

async function cdpPage(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && /play\.kroom\.tw/.test(x.url));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(25);
  }
  throw new Error('no page');
}

function session(url) {
  const ws = new WebSocket(url); let n = 0; const pend = new Map();
  ws.on('message', (m) => { const j = JSON.parse(m); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const ready = new Promise((r) => ws.on('open', r));
  const ev = async (expression) => { await ready; return new Promise((r) => { const id = ++n; pend.set(id, (j) => r(j.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); };
  return { ev, close: () => ws.close() };
}

const JS_WORK = `(() => { // a fixed workload: numbers, strings, objects, arrays — the median of 5 runs, ms
  const once = () => { const t = performance.now(); let a = []; for (let i = 0; i < 300000; i++) a.push({ i, s: 'k' + (i % 977), v: Math.sqrt(i) * Math.sin(i) });
    a.sort((x, y) => x.v - y.v); const m = new Map(); for (const o of a) m.set(o.s, (m.get(o.s) || 0) + o.v); JSON.parse(JSON.stringify(a.slice(0, 50000)));
    let h = 0; for (let i = 0; i < 2e6; i++) h = (h * 31 + i) | 0; return performance.now() - t; };
  const r = []; for (let k = 0; k < 5; k++) r.push(once()); r.sort((x, y) => x - y); return r[2]; })()`;
const FPS = `new Promise((res) => { let f = 0; const t0 = performance.now(); const tick = () => { f++; if (performance.now() - t0 < 5000) requestAnimationFrame(tick); else res(f / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(tick); })`;

async function run(name) {
  const a = APPS[name];
  const t0 = Date.now();
  const p = spawn(a.exe, a.args, { env: { ...process.env, ...a.env }, stdio: 'ignore', windowsHide: false });
  try {
    const t = await cdpPage(a.port, t0 + 60000);
    const s = session(t.webSocketDebuggerUrl);
    // (the real page: Electron lists the address while its blank first document is still there — that one is 'complete' at once)
    while ((await s.ev(`location.origin + ' ' + document.readyState`)) !== 'https://play.kroom.tw complete') await sleep(25);
    const loaded = Date.now() - t0;
    const pageLoad = await s.ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? n.loadEventEnd - n.startTime : null; })()`);
    const signedOut = await s.ev(`fetch('/api/auth/me').then((r) => r.json()).then((j) => !j.account)`);
    await sleep(15000); // (settle: the menu's own start-up work is done)
    const m = tree(p.pid);
    const c0 = m.cpu; await sleep(20000); const c1 = tree(p.pid).cpu;
    const fps = await s.ev(FPS);
    const js = await s.ev(JS_WORK);
    s.close();
    return { loaded, pageLoad, ws: m.ws, priv: m.priv, procs: m.n, cpu: ((c1 - c0) / 20) * 100, fps, js, signedOut };
  } finally {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
    await sleep(3000);
  }
}

const results = { electron: [], rust: [] };
for (const name of ['electron', 'rust']) { console.log(`warm-up ${name}…`); await run(name); } // (first runs fill the caches: what is compared is a normal start)
for (let i = 0; i < RUNS; i++) for (const name of ['electron', 'rust']) { const r = await run(name); results[name].push(r); console.log(name, JSON.stringify(r)); }

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const row = (label, k, unit, dec = 0, lowerBetter = true) => {
  const e = med(results.electron.map((r) => r[k])), r = med(results.rust.map((x) => x[k]));
  const better = lowerBetter ? r < e : r > e;
  console.log(`${label.padEnd(30)} ${e.toFixed(dec).padStart(9)} ${r.toFixed(dec).padStart(9)} ${unit.padEnd(6)} ${better ? 'Rust' : 'Electron'} ${((Math.abs(r - e) / e) * 100).toFixed(0)}%`);
};
console.log(`\nmedian of ${RUNS} runs        Electron      Rust          better`);
row('launch → page loaded', 'loaded', 'ms');
row('page load (in the page)', 'pageLoad', 'ms');
row('memory, working set (all)', 'ws', 'MB');
row('memory, private (all)', 'priv', 'MB');
row('idle CPU on the menu', 'cpu', '% core', 1);
row('frame rate on the menu', 'fps', 'fps', 0, false);
row('JavaScript workload', 'js', 'ms', 0);
console.log(`processes: Electron ${results.electron[0].procs}, Rust ${results.rust[0].procs}; signed out in both: ${[...results.electron, ...results.rust].every((r) => r.signedOut)}`);
fs.rmSync(profile, { recursive: true, force: true });
