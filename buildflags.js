// Which build is this? One place for main.js (and the tests): the normal desktop app (GitHub releases, self-updating) or the Steam build (docs/STEAM-BUILD.md).
// Steam build = env STEAM_BUILD=1 (npm run start:steam / a test), or package.json "steamBuild": true (written by electron-builder's extraMetadata in
// steam/electron-builder.steam.json — `npm run dist:steam`). Nothing here changes the normal build: without either, STEAM is false.
const flag = (v) => v === '1' || v === 'true' || v === true;
function fromPackage() { try { return flag(require('./package.json').steamBuild); } catch { return false; } }
const STEAM = flag(process.env.STEAM_BUILD) || fromPackage();

/** the page address with ?store=1: src/store-mode.ts isStoreApp() then holds even before window.kroomApp exists (donation / app-download promos stay hidden) */
function withStore(href) {
  try { const u = new URL(href); u.searchParams.set('store', '1'); return u.href; } catch { return href; }
}

module.exports = { STEAM, withStore, flag };
