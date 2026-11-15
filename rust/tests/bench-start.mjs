// Start-up only, split in two: launch → the browser's page target exists (the app and its browser engine are up) → the page is loaded.
//   node desktop-rs/tests/bench-start.mjs <electron K ROOM.exe> <rust kroom.exe (devport build)> [runs]
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const WebSocket = require('../../node_modules/ws');
const [electronExe, rustExe, runsArg] = process.argv.slice(2);
const RUNS = Number(runsArg) || 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kroom-bench-electron-'));
const APPS = {
  electron: { exe: electronExe, args: ['--remote-debugging-port=9411', `--user-data-dir=${profile}`], env: { KROOM_NO_UPDATE: '1' }, port: 9411 },
  rust: { exe: rustExe, args: [], env: { KROOM_DEBUG_PORT: '9412', KROOM_NO_UPDATE: '1' }, port: 9412 },
};
async function once(name) {
  const a = APPS[name], t0 = Date.now();
  const p = spawn(a.exe, a.args, { env: { ...process.env, ...a.env }, stdio: 'ignore' });
  let engine = 0, target = null;
  try {
    while (!target) {
      try { const l = await (await fetch(`http://127.0.0.1:${a.port}/json/list`)).json(); if (!engine) engine = Date.now() - t0; target = l.find((x) => x.type === 'page' && /play\.kroom\.tw/.test(x.url)); } catch { /* not yet */ }
      if (!target) await sleep(10);
      if (Date.now() - t0 > 60000) throw new Error('timeout');
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
    let n = 0; const ev = (e) => new Promise((r) => { const id = ++n; ws.on('message', function h(m) { const j = JSON.parse(m); if (j.id === id) { ws.off('message', h); r(j.result?.result?.value); } }); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } })); });
    while ((await ev(`location.origin + ' ' + document.readyState`)) !== 'https://play.kroom.tw complete') await sleep(10);
    const loaded = Date.now() - t0;
    const nav = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; return Math.round(n.loadEventEnd - n.startTime); })()`);
    ws.close();
    return { engine, loaded, page: nav, before: loaded - nav };
  } finally {
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
    await sleep(2500);
  }
}
const res = { electron: [], rust: [] };
for (const n of ['electron', 'rust']) await once(n); // (warm-up)
for (let i = 0; i < RUNS; i++) for (const n of ['electron', 'rust']) res[n].push(await once(n));
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const n of ['electron', 'rust']) {
  const r = res[n];
  console.log(`${n.padEnd(9)} DevTools up ${med(r.map((x) => x.engine))} ms · launch → page loaded ${med(r.map((x) => x.loaded))} ms (page itself ${med(r.map((x) => x.page))} ms, before the page started ${med(r.map((x) => x.before))} ms)  runs: ${r.map((x) => x.loaded).join(' ')}`);
}
fs.rmSync(profile, { recursive: true, force: true });
