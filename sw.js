/* RouteRunner service worker — offline app shell. 20261005-174103 is stamped by dev/deploy.py. */
const CACHE = 'routerunner-20261005-174103';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './core.js', './ocr.js', './install.js',
  './manifest.json', './icon-192.png', './icon-512.png',
];
// Caches the install/update system owns — activate must never delete these
// (INSTALL_SPEC.md IR3/IR14). Stable names (not build-suffixed) because
// assets are content-addressed by their manifest hash.
const INSTALL_CACHES = ['routerunner-assets-v1', 'routerunner-tiles-v1'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
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
