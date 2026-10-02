/* RouteRunner service worker — offline app shell. 20261002-040831 is stamped by dev/deploy.py. */
const CACHE = 'routerunner-20261002-040831';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './core.js', './ocr.js',
  './manifest.json', './icon-192.png', './icon-512.png',
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls or geocoding — only shell + CDN libs.
  if (/photon|nominatim|osrm|arcgis|geocoding\.geo\.census|census\.gov/i.test(url.hostname)) return;
  // version.json must always be fresh — it's how the app learns about updates.
  if (url.pathname.endsWith('/version.json')) return;
  if (e.request.method !== 'GET') return;
  // NETWORK-FIRST for the app shell: stale code is worse than a slow load.
  // Try the network, fall back to cache only when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const sameOrigin = url.origin === self.location.origin;
      const cdnOk = CDN.some((c) => e.request.url.startsWith(c));
      if (res.ok && (sameOrigin || cdnOk)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
