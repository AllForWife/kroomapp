// 🎤 VMC 接收（docs/VTUBER-PERFORMER-SPEC.md §5.2）：VirtualMotionCapture／Warudo／VSeeFace／XR Animator 等動捕軟體用 VMC 協定（OSC over UDP，預設埠 39539）
//   送全身姿勢；瀏覽器收不到 UDP，所以由 App 收、整理成一幀一幀交給頁面（main.js → preload.js 的 window.kroomApp.vmc）。只聽本機 127.0.0.1。
//   一幀＝{ root:[px,py,pz,qx,qy,qz,qw]|null, bones:{ Unity HumanBodyBones 名: [px,py,pz,qx,qy,qz,qw] }, blend:{ 名: 值 }, at }（Unity 座標，頁面再轉）
//   Rust 版（desktop-rs/src/vmc.rs）是同一套規則；tests/vtlive-vmc-unit.mjs 兩邊都測。
'use strict';
const dgram = require('node:dgram');

/** OSC 字串（以 0 結尾、補到 4 的倍數） */
function readStr(b, o) { let e = o; while (e < b.length && b[e] !== 0) e++; const s = b.toString('utf8', o, e); return [s, (e + 4) & ~3]; }
/** 一則 OSC 訊息 → { addr, args } */
function parseMessage(b) {
  let [addr, o] = readStr(b, 0); if (!addr.startsWith('/')) return null;
  let tags; [tags, o] = readStr(b, o); if (!tags.startsWith(',')) return { addr, args: [] };
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'f') { args.push(b.readFloatBE(o)); o += 4; } else if (t === 'i') { args.push(b.readInt32BE(o)); o += 4; } else if (t === 's') { let s; [s, o] = readStr(b, o); args.push(s); }
    else if (t === 'd') { args.push(b.readDoubleBE(o)); o += 8; } else if (t === 'T') args.push(true); else if (t === 'F') args.push(false); else return { addr, args };
    if (o > b.length) return null;
  }
  return { addr, args };
}
/** 封包（可能是 #bundle）→ 訊息陣列 */
function parsePacket(b, out = [], depth = 0) {
  if (b.length >= 16 && b.toString('ascii', 0, 7) === '#bundle' && depth < 4) {
    let o = 16; while (o + 4 <= b.length) { const n = b.readInt32BE(o); o += 4; if (n <= 0 || o + n > b.length) break; parsePacket(b.subarray(o, o + n), out, depth + 1); o += n; }
    return out;
  }
  try { const m = parseMessage(b); if (m) out.push(m); } catch { /* 壞封包 */ }
  return out;
}
/** 把訊息累積成一幀：/VMC/Ext/Blend/Apply 或一個封包結束時交出去 */
function createAssembler(onFrame) {
  let cur = { root: null, bones: {}, blend: {} }, dirty = false;
  const flush = () => { if (!dirty) return; onFrame({ ...cur, at: Date.now() }); cur = { root: cur.root, bones: {}, blend: {} }; dirty = false; };
  return {
    feed(msgs) {
      for (const m of msgs) {
        const a = m.args;
        if (m.addr === '/VMC/Ext/Root/Pos' && a.length >= 8) { cur.root = a.slice(1, 8).map(Number); dirty = true; }
        else if (m.addr === '/VMC/Ext/Bone/Pos' && a.length >= 8 && typeof a[0] === 'string') { cur.bones[a[0]] = a.slice(1, 8).map(Number); dirty = true; }
        else if (m.addr === '/VMC/Ext/Blend/Val' && a.length >= 2 && typeof a[0] === 'string') { cur.blend[a[0]] = Number(a[1]); dirty = true; }
        else if (m.addr === '/VMC/Ext/Blend/Apply') flush();
      }
    },
    flush,
  };
}
/** 開始聽：回 { stop(), port }；onFrame 最多每 1000/maxHz ms 一次（最後一幀為準） */
function startVmc({ port = 39539, onFrame, onError = () => {}, maxHz = 60 }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let pending = null, timer = null, lastSent = 0;
  const emit = (f) => { pending = f; const wait = Math.max(0, 1000 / maxHz - (Date.now() - lastSent)); if (!timer) timer = setTimeout(() => { timer = null; lastSent = Date.now(); const x = pending; pending = null; if (x) onFrame(x); }, wait); };
  const asm = createAssembler(emit);
  sock.on('message', (b, rinfo) => { if (rinfo.address !== '127.0.0.1' && rinfo.address !== '::1' && rinfo.address !== '::ffff:127.0.0.1') return; asm.feed(parsePacket(b)); asm.flush(); });
  sock.on('error', (e) => onError(e));
  sock.bind(port, '127.0.0.1');
  return { port, stop() { clearTimeout(timer); try { sock.close(); } catch { /* 已關 */ } } };
}
module.exports = { parsePacket, parseMessage, createAssembler, startVmc };
