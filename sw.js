// Stopflow redirect service worker (rebrand cutover, 2026-10-07).
// Replaces the old RouteRunner SW, then removes itself so the redirect page
// below always loads from the network.
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    await self.registration.unregister();
    var clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(function (c) { c.navigate(c.url); });
  })());
});
self.addEventListener('fetch', function (e) { /* network fallback */ });
