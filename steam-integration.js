// Steamworks hook-up, a safe placeholder. NOTHING is installed or required to run: the optional package `steamworks.js` is NOT in package.json.
// To switch it on later (docs/STEAM-BUILD.md §Steamworks): `npm i steamworks.js` in desktop/, put your real App ID in steam_appid.txt next to the exe
// (dev only; Steam supplies it when launched from the client) and list "steam-integration.js" (already listed) + the native module in the build's files.
// init() returns null (never throws) when: this is not the Steam build, steamworks.js is not installed, or Steam is not running — the game then runs as usual.
const path = require('path');
const fs = require('fs');

/** the App ID from env STEAM_APP_ID or steam_appid.txt (next to the exe / in desktop/); 0 / missing = not set (the 0 in steam/*.vdf is a placeholder) */
function appId() {
  const e = parseInt(process.env.STEAM_APP_ID || '', 10); if (e > 0) return e;
  for (const dir of [path.dirname(process.execPath), __dirname]) {
    try { const n = parseInt(fs.readFileSync(path.join(dir, 'steam_appid.txt'), 'utf8').trim(), 10); if (n > 0) return n; } catch { /* no file there */ }
  }
  return 0;
}

function init() {
  if (!require('./buildflags').STEAM) return null;
  const id = appId(); if (!id) { console.warn('steam: no App ID (steam_appid.txt / STEAM_APP_ID): Steamworks stays off'); return null; }
  let sw;
  try { sw = require(['steamworks', 'js'].join('.')); } catch { console.warn('steam: steamworks.js is not installed: Steamworks stays off'); return null; } // (the name is built so no bundler tries to include it)
  try {
    const client = sw.init(id);
    return {
      client,
      /** the Steam persona name (a hint for the sign-in screen; never used as the K ROOM account) */
      name: () => { try { return client.localplayer.getName(); } catch { return ''; } },
      /** the player's 64-bit Steam ID as a 17-digit string, or '' (the server never trusts this: login and purchases are checked with Steam itself) */
      steamId: () => { try { const id = client.localplayer.getSteamId(); return String(id?.steamId64 ?? id ?? ''); } catch { return ''; } },
      /** an auth ticket for the server's Web API check (server/steamlogin.mjs, identity 'kroom') as a hex string, or ''. steamworks.js >= 0.4: auth.getAuthTicketForWebApi; older: auth.getSessionTicket. NOT tested against a real Steam client (docs/STEAM-LOGIN.md) */
      ticket: async () => { try { const a = client.auth, t = a.getAuthTicketForWebApi ? await a.getAuthTicketForWebApi('kroom') : await a.getSessionTicket(); const b = t?.getBytes ? t.getBytes() : t; return Buffer.from(b).toString('hex'); } catch { return ''; } },
      /** unlock an achievement by its API name (no achievements are defined yet) */
      achieve: (n) => { try { return client.achievement.activate(String(n)); } catch { return false; } },
    };
  } catch (e) { console.warn('steam: init failed (Steam not running?)', e?.message || e); return null; }
}

module.exports = { init, appId };
