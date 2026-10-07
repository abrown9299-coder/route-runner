/* RouteRunner service worker — offline app shell. 20261007-143022 is stamped by dev/deploy.py. */
/* global Request: readonly, Response: readonly */
const CACHE = 'routerunner-20261007-143022';
// 2026-10-06: app.js/stats.js were split into modules — must match deploy.py SHELL_FILES.
const SHELL = [
  './', './index.html', './styles.css',
  './core.js', './ocr.js', './install.js',
  './stats-config.js', './stats-data.js', './stats-sanitize.js', './stats-store.js',
  './stats-report.js',
  './app-state.js', './app-stops.js', './app-windows.js', './app-search.js',
  './app-sheets.js', './app-ocr.js', './app-geocode.js', './app-gps.js',
  './app-traffic.js', './app-optimize.js', './app-map.js', './app-route.js',
  './app-saved.js', './app-settings.js', './app-boot.js',
  './manifest.json', './icon-192.png', './icon-512.png',
];
// Caches the install/update system owns — activate must never delete these
// (INSTALL_SPEC.md IR3/IR14). Stable names (not build-suffixed) because
// assets are content-addressed by their manifest hash.
const INSTALL_CACHES = ['routerunner-assets-v1', 'routerunner-tiles-v1'];

self.addEventListener('install', (e) => {
  e.waitUntil(installDelta().then(() => self.skipWaiting()));
});

/* 2026-10-05: delta shell install — only files that actually changed are
 * downloaded. Unchanged shell files are copied from the previous build's
 * cache, keyed by the sha256 hashes in assets-manifest.json (written by
 * dev/deploy.py from the deployed bytes). This build's hashes are stored in
 * the cache under HASH_KEY for the next update. Any failure falls back to
 * a full download so an update can never get stuck half-installed. */
const HASH_KEY = '__shell-hashes__';
function shellPathFor(url) {
  return url === './' ? 'index.html' : url.replace(/^\.\//, '');
}
async function installDelta() {
  const cache = await caches.open(CACHE);
  let manifest = null;
  try {
    const res = await fetch('assets-manifest.json', { cache: 'no-store' });
    if (res.ok) manifest = await res.json();
  } catch { /* offline on install — full download below */ }
  const newHashes = {};
  ((manifest && manifest.shell) || []).forEach((s) => { newHashes[s.path] = s.sha256; });

  const keys = await caches.keys();
  const prevKey = keys.find((k) => k !== CACHE && k.indexOf('routerunner-') === 0 && !INSTALL_CACHES.includes(k));
  let prev = null, prevHashes = null;
  if (prevKey) {
    try {
      prev = await caches.open(prevKey);
      const hr = await prev.match(HASH_KEY);
      if (hr) prevHashes = await hr.json();
    } catch { prev = null; prevHashes = null; }
  }

  try {
    if (prev && prevHashes && Object.keys(newHashes).length) {
      await Promise.all(SHELL.map(async (url) => {
        const path = shellPathFor(url);
        if (prevHashes[path] && newHashes[path] && prevHashes[path] === newHashes[path]) {
          const hit = await prev.match(url);
          if (hit) { await cache.put(url, hit); return; }
        }
        const res = await fetch(new Request(url, { cache: 'no-store' }));
        if (!res.ok) throw new Error('shell fetch failed: ' + url + ' (' + res.status + ')');
        await cache.put(url, res);
      }));
    } else {
      await cache.addAll(SHELL); // first install or no hash history — full download
    }
  } catch {
    // Delta failed mid-way: fall back to a full download so the new cache
    // is complete. addAll is atomic-ish (rejects on any failure → install
    // retries on next SW update).
    await cache.addAll(SHELL);
  }
  await cache.put(HASH_KEY, new Response(JSON.stringify(newHashes),
    { headers: { 'Content-Type': 'application/json' } }));
}
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks
      .filter((k) => k !== CACHE && !INSTALL_CACHES.includes(k))
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls or geocoding — only the app shell.
  if (/photon|nominatim|osrm|arcgis|geocoding\.geo\.census|census\.gov/i.test(url.hostname)) return;
  // version.json and assets-manifest.json must always be fresh — they're how
  // the app learns about code updates and asset updates, respectively.
  if (url.pathname.endsWith('/version.json')) return;
  if (url.pathname.endsWith('/assets-manifest.json')) return;
  if (e.request.method !== 'GET') return;
  // NETWORK-FIRST for the app shell: stale code is worse than a slow load.
  // Try the network, fall back to cache only when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const sameOrigin = url.origin === self.location.origin;
      if (res.ok && sameOrigin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
