// 🎮 Discord 狀態 (Rich Presence): 「正在玩 K ROOM」 on the player's Discord profile, with a button others can press to come into the same room.
// Discord's local IPC, written here (no npm package: the Steam build ships no node_modules): a named pipe on Windows (\\?\pipe\discord-ipc-N),
// a socket in the temp folder on a Mac. Each frame = op (int32 LE) + length (int32 LE, UTF-8 bytes) + JSON. op 0 handshake → Discord answers
// READY; op 1 commands (SET_ACTIVITY, SUBSCRIBE) and events; op 2 close; op 3 ping → op 4 pong with the same body. Discord not running / not
// installed: tried again later (up to once a minute); nothing is ever shown on screen about it.
// 📨 Discord's own invites (畫面設定 ▸ Discord ▸ 加入方式「Discord 邀請」): the activity carries a party and a join secret (the room); a friend who
// accepts the invite gets ACTIVITY_JOIN with that secret in THEIR app — onJoin. Discord starts the app for
// it if it is not running (the discord-<id>:// link, registered in main.js), so the app keeps the connection open even with nothing to show.
// Discord asks apps not to change the activity too often: at most one SET_ACTIVITY every GAP ms (always the newest), an unchanged one is not sent,
// and clearing goes out at once (the room must not stay on the profile after the player left it).
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const GAP = 4000;
const MAX_FRAME = 1 << 20;
const pipePath = (i) => process.env.KROOM_TEST_DISCORD_PIPE ? `${process.env.KROOM_TEST_DISCORD_PIPE}${i}` // (tests/discord-ipc-unit.mjs: a pretend Discord)
  : process.platform === 'win32' ? `\\\\?\\pipe\\discord-ipc-${i}`
  : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp', `discord-ipc-${i}`);
const frame = (op, body) => { const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(body.length, 4); return Buffer.concat([h, body]); };

/** clientId: the Discord application's id (its name is the 「正在玩 …」 line). set(activity) shows it, set(null) clears it;
 *  onJoin(secret): a Discord invite to a friend's room was accepted on this computer */
function create(clientId, onJoin) {
  let sock = null, ready = false, want = null, sent = 'null', lastAt = 0, timer = null, retryT = null, retries = 0, again = null;
  const later = () => {
    if (retryT) return;
    retryT = setTimeout(() => { retryT = null; connect(0); }, Math.min(60_000, 5000 * 2 ** retries++));
  };
  const write = (op, obj) => { try { sock.write(frame(op, Buffer.from(JSON.stringify(obj), 'utf8'))); } catch { /* closing */ } };
  function flush() {
    if (!ready) return;
    const j = JSON.stringify(want);
    if (j === sent) return;
    const wait = lastAt + GAP - Date.now();
    if (want !== null && wait > 0) { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, wait); return; }
    if (timer) { clearTimeout(timer); timer = null; }
    lastAt = Date.now(); sent = j;
    write(1, { cmd: 'SET_ACTIVITY', args: want ? { pid: process.pid, activity: want } : { pid: process.pid }, nonce: crypto.randomUUID() });
  }
  function connect(i) {
    if (sock || i > 9) { if (!sock) later(); return; }
    const s = net.createConnection(pipePath(i));
    let greeted = false, buf = Buffer.alloc(0);
    const dead = setTimeout(() => s.destroy(), 10_000); // (no READY in time: as if it were not there)
    s.on('connect', () => { sock = s; s.write(frame(0, Buffer.from(JSON.stringify({ v: 1, client_id: clientId }), 'utf8'))); });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (len < 0 || len > MAX_FRAME) return void s.destroy();
        if (buf.length < 8 + len) break;
        const body = buf.subarray(8, 8 + len); buf = buf.subarray(8 + len);
        if (op === 3) { try { s.write(frame(4, body)); } catch { /* closing */ } continue; }
        if (op === 2) return void s.destroy();
        if (op !== 1) continue;
        let m; try { m = JSON.parse(body.toString('utf8')); } catch { continue; }
        if (m.cmd === 'DISPATCH' && m.evt === 'READY') { clearTimeout(dead); greeted = ready = true; retries = 0; sent = 'null'; write(1, { cmd: 'SUBSCRIBE', evt: 'ACTIVITY_JOIN', args: {}, nonce: crypto.randomUUID() }); flush(); }
        else if (m.cmd === 'DISPATCH' && m.evt === 'ACTIVITY_JOIN') { if (typeof m.data?.secret === 'string') onJoin?.(m.data.secret); }
        else if (m.evt === 'ERROR') {
          console.warn('discord', m.cmd, m.data?.code, m.data?.message);
          // a refused SET_ACTIVITY (a clear included) is not what Discord shows: sent again in a while, not taken as done
          if (m.cmd === 'SET_ACTIVITY') { sent = '!'; if (!again) again = setTimeout(() => { again = null; flush(); }, 15_000); }
        }
        if (process.env.KROOM_TEST_DISCORD_LOG && m.cmd !== 'DISPATCH') try { require('fs').appendFileSync(process.env.KROOM_TEST_DISCORD_LOG, JSON.stringify({ cmd: m.cmd, evt: m.evt || null, data: m.data }) + '\n'); } catch { /* the test's file */ } // (tests/app-discord-e2e.mjs: what Discord answered — a file, so nothing said before the test listens is lost)
      }
    });
    s.on('error', () => { /* the close below handles it */ });
    s.on('close', () => {
      clearTimeout(dead);
      if (sock === s) { sock = null; ready = false; }
      if (!greeted) return void connect(i + 1); // (no Discord on this pipe number, or one that never said READY: the next one)
      later();
    });
  }
  connect(0);
  return {
    set(activity) { want = activity || null; flush(); },
  };
}

module.exports = { create };
