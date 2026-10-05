/* RouteRunner install.js — first-install / asset-update system.
 * Spec: dev/INSTALL_SPEC.md. Loaded in index.html BEFORE app.js; app.js
 * awaits window.RRInstall.ready before booting.
 *
 * Dependency-free. The pure functions at the top (diffInstall,
 * enumerateTileUrls, latLngToTile, isCriticalAsset, …) are node-testable:
 * exported via the module.exports guard exactly like core.js.
 * All browser work is guarded by typeof window/document checks.
 */
/* global Response: readonly */
(function () {
  'use strict';

  /* ---------------- constants ---------------- */
  var ASSETS_CACHE = 'routerunner-assets-v1';
  var TILES_CACHE = 'routerunner-tiles-v1';
  var CACHE_PREFIX = 'routerunner-';
  var LS_VERSION = 'rr.assets.v1';
  var LS_INDEX = 'rr.assets.index.v1';
  var LS_GPSFIX = 'rr.gpsfix.v1';
  var LS_TILE_CFG = 'rr.tiles.cfg.v1';
  var MANIFEST_PATH = 'assets-manifest.json';
  var MANIFEST_TIMEOUT_MS = 5000;
  var GPS_TIMEOUT_MS = 10000;
  var GPSFIX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  var TILE_AVG_BYTES = 70 * 1024; // worst-case planning figure (INSTALL_SPEC.md IR13)
  var MAX_ATTEMPTS = 3;
  var BACKOFF_MS = [1000, 3000, 9000];
  var FOREGROUND_RECHECK_MS = 30000;
  // Background Fetch (IR21): Android-only progressive enhancement. The
  // foreground blocking flow is the baseline both platforms share; a
  // background fetch cannot drive the 0–100% blocking UI, so we detect
  // support for future use but never depend on it.
  var BG_FETCH_SUPPORTED = (typeof navigator !== 'undefined') &&
    !!(navigator.serviceWorker && navigator.serviceWorker.controller);

  /* ---------------- pure functions (node-testable) ---------------- */

  // Normalize the stored index (rr.assets.index.v1) — garbage in, null out.
  function parseIndex(raw) {
    if (!raw) return null;
    try {
      var idx = JSON.parse(raw);
      if (!idx || typeof idx !== 'object' || Array.isArray(idx)) return null;
      return idx;
    } catch { return null; }
  }

  // Manifest diff algorithm (INSTALL_SPEC.md §3, normative).
  // Returns {mode, changed, removed, version, index}.
  function diffInstall(storedVersion, storedIndex, manifest) {
    var assets = (manifest && manifest.assets) || [];
    var fullIndex = {};
    assets.forEach(function (a) { fullIndex[a.path] = a.sha256; });
    var version = manifest ? manifest.manifestVersion : null;
    if (!storedVersion || !storedIndex) {
      return { mode: 'full', changed: assets.slice(), removed: [], version: version, index: fullIndex };
    }
    if (storedVersion === version) {
      return { mode: 'none', changed: [], removed: [], version: version, index: storedIndex };
    }
    var changed = assets.filter(function (a) { return storedIndex[a.path] !== a.sha256; });
    var removed = Object.keys(storedIndex).filter(function (p) { return !(p in fullIndex); });
    return {
      mode: changed.length ? 'update' : 'none',
      changed: changed, removed: removed, version: version, index: fullIndex,
    };
  }

  // Critical assets block the install without exception; the rest degrade.
  // (INSTALL_SPEC.md IR12)
  function isCriticalAsset(path) {
    return /^(vendor\/eng\.traineddata|vendor\/tesseract|vendor\/worker\.min\.js|vendor\/leaflet\.min\.js)/.test(path);
  }

  function assetContentType(path) {
    if (/\.css$/.test(path)) return 'text/css';
    if (/\.wasm\.js$/.test(path)) return 'application/javascript';
    if (/\.gz$/.test(path)) return 'application/gzip';
    return 'application/javascript';
  }

  function latLngToTile(lat, lng, z) {
    var n = Math.pow(2, z);
    var x = Math.floor(((lng + 180) / 360) * n);
    var latRad = lat * Math.PI / 180;
    var y = Math.floor((((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n));
    return { x: x, y: y };
  }

  function tileCenterLatLng(x, y, z) {
    var n = Math.pow(2, z);
    var lng = ((x + 0.5) / n) * 360 - 180;
    var latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
    return { lat: latRad * 180 / Math.PI, lng: lng };
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Enumerate tile URLs for a GPS fix within the manifest tile budget.
  // (INSTALL_SPEC.md IR8/IR10)
  function enumerateTileUrls(lat, lng, cfg) {
    var urls = [];
    var z, dx, dy;
    for (z = cfg.zmin; z <= cfg.zmax; z++) {
      if (urls.length >= cfg.budgetTiles) break;
      var center = latLngToTile(lat, lng, z);
      var n = Math.pow(2, z);
      // Tiles per degree of longitude shrink with cos(lat); approximate the
      // search square in tile units so the radius check stays honest.
      var kmPerTileX = (40075 * Math.cos(lat * Math.PI / 180)) / n;
      var kmPerTileY = 40075 / n;
      var spanX = Math.ceil(cfg.radiusKm / Math.max(kmPerTileX, 0.001)) + 1;
      var spanY = Math.ceil(cfg.radiusKm / Math.max(kmPerTileY, 0.001)) + 1;
      for (dx = -spanX; dx <= spanX; dx++) {
        for (dy = -spanY; dy <= spanY; dy++) {
          if (urls.length >= cfg.budgetTiles) break;
          var x = center.x + dx, y = center.y + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          var c = tileCenterLatLng(x, y, z);
          if (haversineKm(lat, lng, c.lat, c.lng) > cfg.radiusKm) continue;
          urls.push(cfg.template.split('{z}').join(String(z))
            .split('{x}').join(String(x)).split('{y}').join(String(y)));
        }
      }
    }
    return urls;
  }

  var RRInstallLib = {
    diffInstall: diffInstall,
    parseIndex: parseIndex,
    isCriticalAsset: isCriticalAsset,
    assetContentType: assetContentType,
    latLngToTile: latLngToTile,
    tileCenterLatLng: tileCenterLatLng,
    haversineKm: haversineKm,
    enumerateTileUrls: enumerateTileUrls,
    ASSETS_CACHE: ASSETS_CACHE,
    TILES_CACHE: TILES_CACHE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RRInstallLib;
  }

  /* ---------------- browser-only below ---------------- */
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------------- small helpers ---------------- */
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function assetUrl(path) {
    return new URL(path, document.baseURI).href;
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked — session still works */ } }

  function appBuild() {
    try {
      var m = document.querySelector('meta[name="app-version"]');
      return m ? m.getAttribute('content') : null;
    } catch { return null; }
  }

  async function fetchWithTimeout(url, ms, opts) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    try {
      return await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    } finally { clearTimeout(timer); }
  }

  async function sha256hex(bytes) {
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    var view = new Uint8Array(digest);
    var out = '';
    for (var i = 0; i < view.length; i++) {
      out += ('0' + view[i].toString(16)).slice(-2);
    }
    return out;
  }

  function concatChunks(chunks, totalLen) {
    var out = new Uint8Array(totalLen);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return String(n) + ' B';
  }

  /* ---------------- overlay UI ---------------- */
  var overlay = null, ui = null;

  var OVERLAY_CSS =
    '#rrinst-overlay{position:fixed;inset:0;z-index:99999;background:#0b0e1a;color:#e8ecf4;' +
    'display:flex;align-items:center;justify-content:center;padding:24px;' +
    'font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}' +
    '#rrinst-card{width:100%;max-width:420px}' +
    '#rrinst-card h1{font-size:22px;margin:0 0 6px}' +
    '#rrinst-sub{color:#9aa3b2;font-size:14px;margin:0 0 18px;line-height:1.5}' +
    '#rrinst-bar{height:12px;border-radius:6px;background:#1c2333;overflow:hidden;margin-bottom:8px}' +
    '#rrinst-fill{height:100%;width:0%;border-radius:6px;background:#3b82f6;transition:width .2s}' +
    '#rrinst-pct{font-size:13px;color:#9aa3b2;margin-bottom:16px}' +
    '#rrinst-rows{list-style:none;margin:0 0 12px;padding:0;max-height:38vh;overflow:auto}' +
    '#rrinst-rows li{display:flex;align-items:center;gap:10px;padding:8px 0;' +
    'border-bottom:1px solid #1c2333;font-size:13px}' +
    '.rrinst-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.rrinst-status{color:#9aa3b2;white-space:nowrap}' +
    '.rrinst-status.done{color:#4ade80}.rrinst-status.failed{color:#f87171}.rrinst-status.retrying{color:#fbbf24}' +
    '#rrinst-note{font-size:13px;color:#9aa3b2;line-height:1.5;margin:8px 0;white-space:pre-line}' +
    '#rrinst-err{font-size:13px;color:#fca5a5;line-height:1.5;margin:8px 0;white-space:pre-line}' +
    '#rrinst-btns{display:flex;flex-direction:column;gap:10px;margin-top:14px}' +
    '#rrinst-btns button{padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700}' +
    '#rrinst-retry{background:#3b82f6;color:#fff}' +
    '#rrinst-skip{background:transparent;color:#9aa3b2;border:1px solid #3a4356}' +
    '.rrinst-spin{display:inline-block;width:14px;height:14px;border:2px solid #3a4356;' +
    'border-top-color:#3b82f6;border-radius:50%;animation:rrinst-rot 0.8s linear infinite}' +
    '@keyframes rrinst-rot{to{transform:rotate(360deg)}}';

  function el(tag, text, attrs) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    }
    return node;
  }

  function ensureOverlay(title, subtitle) {
    if (overlay) {
      ui.title.textContent = title;
      ui.sub.textContent = subtitle;
      return;
    }
    var style = el('style');
    style.textContent = OVERLAY_CSS;
    document.head.appendChild(style);
    overlay = el('div', null, { id: 'rrinst-overlay', role: 'alertdialog', 'aria-label': title });
    var card = el('div', null, { id: 'rrinst-card' });
    ui = {
      title: el('h1', title),
      sub: el('p', subtitle, { id: 'rrinst-sub' }),
      bar: el('div', null, { id: 'rrinst-bar' }),
      fill: el('div', null, { id: 'rrinst-fill' }),
      pct: el('div', '0%', { id: 'rrinst-pct' }),
      rows: el('ul', null, { id: 'rrinst-rows' }),
      note: el('div', null, { id: 'rrinst-note' }),
      err: el('div', null, { id: 'rrinst-err' }),
      btns: el('div', null, { id: 'rrinst-btns' }),
      retry: el('button', 'Retry', { id: 'rrinst-retry' }),
      skip: el('button', 'Continue without these (not recommended)', { id: 'rrinst-skip' }),
    };
    ui.bar.appendChild(ui.fill);
    ui.btns.appendChild(ui.retry);
    ui.btns.appendChild(ui.skip);
    ui.btns.style.display = 'none';
    card.appendChild(ui.title);
    card.appendChild(ui.sub);
    card.appendChild(ui.bar);
    card.appendChild(ui.pct);
    card.appendChild(ui.rows);
    card.appendChild(ui.note);
    card.appendChild(ui.err);
    card.appendChild(ui.btns);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }


  /* ---------------- state ---------------- */
  var state = {
    phase: 'idle', // idle|checking|installing|tiles|error|complete
    manifestVersion: null,
    storedVersion: null,
    changedCount: 0,
    doneBytes: 0,
    totalBytes: 0,
    notes: [],
    lastError: null,
    lastCheckAt: 0,
    bgFetch: BG_FETCH_SUPPORTED,
  };
  var checkInFlight = false;

  function note(text) {
    state.notes.push(text);
    if (ui) ui.note.textContent = state.notes.join('\n\n');
  }

  function setPhase(p) { state.phase = p; }

  function renderProgress() {
    if (!ui) return;
    var pct = state.totalBytes > 0 ? Math.min(100, Math.round((state.doneBytes / state.totalBytes) * 100)) : 0;
    ui.fill.style.width = pct + '%';
    ui.pct.textContent = pct + '% · ' + fmtBytes(state.doneBytes) + ' of ' + fmtBytes(state.totalBytes);
  }

  function addRow(label) {
    var li = el('li');
    var name = el('span', label, { 'class': 'rrinst-name' });
    var status = el('span', 'queued', { 'class': 'rrinst-status' });
    li.appendChild(name);
    li.appendChild(status);
    ui.rows.appendChild(li);
    return status;
  }

  function setRowStatus(statusEl, status, detail) {
    statusEl.className = 'rrinst-status' + (status === 'done' ? ' done' : status === 'failed' ? ' failed' : status === 'retrying' ? ' retrying' : '');
    statusEl.textContent = detail ? status + ' · ' + detail : status;
  }

  function rowSpinner(statusEl) {
    statusEl.className = 'rrinst-status';
    statusEl.textContent = '';
    var spin = el('span', null, { 'class': 'rrinst-spin', 'aria-hidden': 'true' });
    statusEl.appendChild(spin);
  }

  /* ---------------- manifest fetch ---------------- */
  async function fetchManifest() {
    var url = assetUrl(MANIFEST_PATH);
    var resp = await fetchWithTimeout(url, MANIFEST_TIMEOUT_MS, { cache: 'no-store' });
    if (!resp.ok) throw new Error('manifest HTTP ' + resp.status);
    var data = await resp.json();
    if (!data || !data.manifestVersion || !Array.isArray(data.assets) || !data.tiles) {
      throw new Error('manifest malformed');
    }
    return data;
  }

  /* ---------------- asset download (3x retry, SHA-256 verify) ---------------- */
  async function downloadBytes(url, expectedBytes, onChunk) {
    var resp = await fetchWithTimeout(url, 120000, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var total = Number(resp.headers.get('content-length')) || expectedBytes || 0;
    if (resp.body && resp.body.getReader) {
      var reader = resp.body.getReader();
      var chunks = [];
      var received = 0;
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        received += step.value.length;
        onChunk(received, total);
      }
      return { bytes: concatChunks(chunks, received), received: received };
    }
    var buf = new Uint8Array(await resp.arrayBuffer());
    onChunk(buf.length, total);
    return { bytes: buf, received: buf.length };
  }

  async function downloadAsset(asset, cache, rowStatus) {
    var url = assetUrl(asset.path);
    var lastErr = null;
    var base = state.doneBytes; // rewound on retry so failed bytes never double-count
    for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) setRowStatus(rowStatus, 'retrying', 'attempt ' + attempt + '/' + MAX_ATTEMPTS);
        else rowSpinner(rowStatus);
        var dl = await downloadBytes(url, asset.bytes, function (received) {
          state.doneBytes = base + received;
          renderProgress();
        });
        var hash = await sha256hex(dl.bytes);
        if (hash !== asset.sha256) throw new Error('SHA-256 mismatch (corrupt download)');
        await cache.put(url, new Response(dl.bytes, {
          headers: { 'content-type': assetContentType(asset.path) },
        }));
        state.doneBytes = base + dl.received;
        renderProgress();
        setRowStatus(rowStatus, 'done', '✓');
        return { ok: true, bytes: dl.received };
      } catch (e) {
        lastErr = e;
        state.doneBytes = base;
        if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
      }
    }
    setRowStatus(rowStatus, 'failed', String((lastErr && lastErr.message) || lastErr));
    return { ok: false, error: lastErr };
  }

  // Resume support: an asset already in the asset cache with a matching
  // hash is never re-downloaded (INSTALL_SPEC.md IR12).
  async function cachedAssetVerified(asset, cache) {
    try {
      var hit = await cache.match(assetUrl(asset.path));
      if (!hit) return false;
      var buf = new Uint8Array(await hit.arrayBuffer());
      return (await sha256hex(buf)) === asset.sha256;
    } catch { return false; }
  }

  /* ---------------- GPS ---------------- */
  function getGpsFix() {
    return new Promise(function (resolve) {
      if (!('geolocation' in navigator)) { resolve(null); return; }
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, GPS_TIMEOUT_MS);
      try {
        navigator.geolocation.getCurrentPosition(function (pos) {
          if (done) return; done = true; clearTimeout(timer);
          var fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
          lsSet(LS_GPSFIX, JSON.stringify(fix));
          resolve(fix);
        }, function () {
          if (done) return; done = true; clearTimeout(timer); resolve(null);
        }, { enableHighAccuracy: false, maximumAge: 600000, timeout: GPS_TIMEOUT_MS });
      } catch {
        if (!done) { done = true; clearTimeout(timer); resolve(null); }
      }
    });
  }

  function lastKnownFix() {
    try {
      var fix = JSON.parse(lsGet(LS_GPSFIX) || 'null');
      if (fix && typeof fix.lat === 'number' && typeof fix.lng === 'number' &&
          (Date.now() - fix.at) < GPSFIX_MAX_AGE_MS) return fix;
    } catch {}
    return null;
  }

  /* ---------------- quota (IR13) ---------------- */
  async function checkQuota(assetBytes, tileBytes) {
    try {
      if (navigator.storage && navigator.storage.persist) {
        try { await navigator.storage.persist(); } catch {}
      }
      var est = await navigator.storage.estimate();
      if (!est || !est.quota) return { ok: true, tiles: true, free: -1 }; // unknown — proceed, downloads fail honestly
      var free = est.quota - (est.usage || 0);
      if (free >= assetBytes + tileBytes) return { ok: true, tiles: true, free: free };
      if (free >= assetBytes) return { ok: true, tiles: false, free: free };
      return { ok: false, tiles: false, free: free, need: assetBytes };
    } catch {
      return { ok: true, tiles: true, free: -1 }; // estimate unavailable — proceed, downloads will fail honestly
    }
  }

  /* ---------------- tile prefetch (IR8/IR10) ---------------- */
  async function fetchTiles(urls, cfg, onTile) {
    var cache = await caches.open(TILES_CACHE);
    var done = 0, bytes = 0, overBudget = false;
    for (var i = 0; i < urls.length; i++) {
      if (bytes > cfg.budgetBytes) { overBudget = true; break; }
      var url = urls[i];
      try {
        var already = await cache.match(url);
        if (already) { done++; onTile(done, urls.length, 0); continue; }
        var resp = await fetchWithTimeout(url, 30000, { cache: 'no-store' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var blob = await resp.blob();
        bytes += blob.size || 0;
        await cache.put(url, new Response(blob, { headers: { 'content-type': 'image/png' } }));
        done++;
        onTile(done, urls.length, bytes);
      } catch {
        // One bad tile never fails the install — skip and continue.
        done++;
        onTile(done, urls.length, bytes);
      }
      if (i < urls.length - 1 && cfg.throttleMs > 0) await sleep(cfg.throttleMs);
    }
    return { done: done, planned: urls.length, bytes: bytes, overBudget: overBudget };
  }

  async function runTilePhase(cfg, rowStatus) {
    setPhase('tiles');
    var fix = await getGpsFix();
    var fixSource = 'gps';
    if (!fix) {
      fix = lastKnownFix();
      fixSource = fix ? 'last-known' : null;
    }
    if (!fix) {
      // IR9: GPS denied/unavailable — skip tiles, never block.
      note('Map tiles skipped — location unavailable. Maps will work online; ' +
        'tap Settings → Refresh offline map tiles later.');
      if (rowStatus) setRowStatus(rowStatus, 'done', 'skipped');
      return;
    }
    var urls = enumerateTileUrls(fix.lat, fix.lng, cfg);
    // Remember the manifest's tile budget for the map layer's opportunistic fill (IR11/IR19).
    lsSet(LS_TILE_CFG, JSON.stringify({ budgetBytes: cfg.budgetBytes, budgetTiles: cfg.budgetTiles }));
    // Fold an honest tile estimate into the headline 0–100% bar; actual
    // bytes accumulate as tiles land (see onTile below).
    state.totalBytes += urls.length * TILE_AVG_BYTES;
    var tileBase = state.doneBytes;
    if (rowStatus) setRowStatus(rowStatus, 'downloading', '0/' + urls.length);
    var res = await fetchTiles(urls, cfg, function (done, total, tileBytes) {
      if (rowStatus) setRowStatus(rowStatus, 'downloading', done + '/' + total);
      state.doneBytes = tileBase + tileBytes;
      renderProgress();
    });
    if (rowStatus) setRowStatus(rowStatus, 'done', '✓ ' + res.done + '/' + res.planned);
    var parts = ['Map tiles: ' + res.done + ' of ' + res.planned + ' cached' +
      (fixSource === 'last-known' ? ' (last known location)' : '') + '.'];
    if (res.overBudget) parts.push('Stopped at the ' + fmtBytes(cfg.budgetBytes) + ' tile budget.');
    note(parts.join(' '));
  }

  /* ---------------- error screens (IR12) ---------------- */
  function showBlockingError(opts) {
    // opts: {title, message, failed: [{path, error}], allowSkip, onRetry}
    setPhase('error');
    ensureOverlay(opts.title, '');
    ui.rows.textContent = '';
    ui.note.textContent = '';
    ui.err.textContent = opts.message || '';
    (opts.failed || []).forEach(function (f) {
      var li = el('li');
      li.appendChild(el('span', f.path, { 'class': 'rrinst-name' }));
      var st = el('span', String((f.error && f.error.message) || f.error || 'failed'), { 'class': 'rrinst-status failed' });
      li.appendChild(st);
      ui.rows.appendChild(li);
    });
    ui.btns.style.display = 'flex';
    ui.skip.style.display = opts.allowSkip ? '' : 'none';
    ui.retry.onclick = function () {
      ui.btns.style.display = 'none';
      ui.err.textContent = '';
      opts.onRetry();
    };
    ui.skip.onclick = function () {
      ui.btns.style.display = 'none';
      ui.err.textContent = '';
      opts.onSkip();
    };
  }

  function showOfflineScreen(onRetry) {
    showBlockingError({
      title: "You're offline",
      message: 'RouteRunner needs a network connection for this one-time setup. ' +
        'Connect and tap Retry — nothing is lost.',
      failed: [],
      allowSkip: false,
      onRetry: onRetry,
      onSkip: function () {},
    });
  }

  /* ---------------- completion (IR3) ---------------- */
  async function completeInstall(version, index) {
    setPhase('complete');
    lsSet(LS_VERSION, version);
    lsSet(LS_INDEX, JSON.stringify(index));
    // Scoped cache clear: stale prior-build shell caches die here. The
    // asset cache, tile cache, and the current build's shell cache survive.
    try {
      var build = appBuild();
      var keepShell = build && build.indexOf('__BUILD__') === -1 ? CACHE_PREFIX + build : null;
      var keys = await caches.keys();
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf(CACHE_PREFIX) !== 0) continue;
        if (k === ASSETS_CACHE || k === TILES_CACHE || k === keepShell) continue;
        try { await caches.delete(k); } catch {}
      }
    } catch {}
    state.doneBytes = state.totalBytes;
    renderProgress();
    if (ui) {
      ui.rows.textContent = '';
      ui.note.textContent = '';
      ui.title.textContent = 'Install complete';
      ui.sub.textContent = 'Refreshing…';
    }
    resolveReady();
    await sleep(600);
    location.reload();
  }

  /* ---------------- the install run ---------------- */
  async function runInstall(manifest, diff) {
    var isUpdate = diff.mode === 'update';
    ensureOverlay(
      isUpdate ? 'Updating RouteRunner' : 'Setting up RouteRunner',
      isUpdate
        ? 'New app files are available. Downloading only what changed…'
        : 'First-time setup: downloading the offline pieces (map library, ' +
          'text reader, map tiles) so the app works anywhere.'
    );
    ui.rows.textContent = '';
    ui.note.textContent = '';
    ui.err.textContent = '';
    ui.btns.style.display = 'none';
    state.notes = [];
    state.manifestVersion = manifest.manifestVersion;
    state.changedCount = diff.changed.length;

    var cache;
    try {
      cache = await caches.open(ASSETS_CACHE);
    } catch {
      showBlockingError({
        title: 'Storage unavailable',
        message: 'This browser blocked the offline storage RouteRunner needs. ' +
          'Check that private browsing is off and storage is allowed for this site, then retry.',
        failed: [], allowSkip: false,
        onRetry: function () { runInstall(manifest, diff); },
        onSkip: function () {},
      });
      return;
    }

    // Quota check before any download (IR13).
    var assetBytesTotal = diff.changed.reduce(function (s, a) { return s + (a.bytes || 0); }, 0);
    var quota = await checkQuota(assetBytesTotal, manifest.tiles.budgetTiles * TILE_AVG_BYTES);
    if (!quota.ok) {
      showBlockingError({
        title: 'Not enough storage',
        message: 'RouteRunner needs about ' + fmtBytes(assetBytesTotal) + ' for its offline files, ' +
          'but this device reports only ' + fmtBytes(Math.max(quota.free, 0)) + ' free for the browser. ' +
          'Free up device storage (photos, unused apps) and tap Retry. ' +
          'On iPhone: free device storage in Settings → General → iPhone Storage. ' +
          'On Android: Settings → Storage.',
        failed: [], allowSkip: false,
        onRetry: function () { runInstall(manifest, diff); },
        onSkip: function () {},
      });
      return;
    }
    var skipTiles = !quota.tiles;

    // Asset downloads (resume: skip already-verified).
    setPhase('installing');
    state.totalBytes = assetBytesTotal;
    state.doneBytes = 0;
    renderProgress();
    var failed = [];
    var skippedNonCritical = [];
    for (var i = 0; i < diff.changed.length; i++) {
      var asset = diff.changed[i];
      var shortName = asset.path.split('/').pop();
      var rowStatus = addRow(shortName + ' · ' + fmtBytes(asset.bytes || 0));
      var verified = await cachedAssetVerified(asset, cache);
      if (verified) {
        setRowStatus(rowStatus, 'done', '✓ cached');
        state.doneBytes += asset.bytes || 0;
        renderProgress();
        continue;
      }
      var res = await downloadAsset(asset, cache, rowStatus);
      if (!res.ok) failed.push({ path: asset.path, error: res.error, critical: isCriticalAsset(asset.path) });
    }

    // Prune assets the manifest dropped.
    for (var r = 0; r < diff.removed.length; r++) {
      try { await cache.delete(assetUrl(diff.removed[r])); } catch {}
    }

    if (failed.length) {
      var failedCritical = failed.filter(function (f) { return f.critical; });
      state.lastError = failed;
      if (failedCritical.length) {
        // Critical failure: block without exception (IR12).
        showBlockingError({
          title: 'Setup needs attention',
          message: 'These core files failed after 3 tries. RouteRunner can\u2019t run without them — ' +
            'check your connection and tap Retry. Already-downloaded files won\u2019t download again.',
          failed: failed,
          allowSkip: false,
          onRetry: function () { runInstall(manifest, diff); },
          onSkip: function () {},
        });
        return;
      }
      // Only non-critical assets failed: offer the escape hatch.
      showBlockingError({
        title: 'Some optional files failed',
        message: 'These files failed after 3 tries. The app works without them ' +
          '(drag-reorder and map styling degrade). You can retry, or continue and we\u2019ll ' +
          'try again next launch.',
        failed: failed,
        allowSkip: true,
        onRetry: function () { runInstall(manifest, diff); },
        onSkip: function () {
          skippedNonCritical = failed.slice();
          failed = [];
          finishTilesAndComplete();
        },
      });
      return;
    }

    async function finishTilesAndComplete() {
      // Tile phase (IR8–IR10, IR19 on updates).
      var tileRow = addRow('Map tiles');
      setRowStatus(tileRow, 'queued');
      if (skipTiles) {
        note('Map tiles skipped — not enough free storage for the tile budget. ' +
          'Maps will work online; free up space and tap Settings → Refresh offline map tiles later.');
        setRowStatus(tileRow, 'done', 'skipped');
      } else {
        await runTilePhase(manifest.tiles, tileRow);
      }
      if (skippedNonCritical.length) {
        note('Skipped (will retry next launch): ' +
          skippedNonCritical.map(function (f) { return f.path.split('/').pop(); }).join(', '));
      }
      await completeInstall(manifest.manifestVersion, diff.index);
    }

    await finishTilesAndComplete();
  }

  /* ---------------- the check (IR6) ---------------- */
  async function runCheck(opts) {
    opts = opts || {};
    if (checkInFlight) return;
    checkInFlight = true;
    state.lastCheckAt = Date.now();
    try {
      setPhase('checking');
      state.storedVersion = lsGet(LS_VERSION);
      var manifest = await fetchManifest();
      var diff = diffInstall(state.storedVersion, parseIndex(lsGet(LS_INDEX)), manifest);
      if (diff.mode === 'none') {
        // Version differs but zero hash diffs → silent no-op, update stored
        // version (IR6). Same version → nothing at all (IR16).
        if (diff.version && diff.version !== state.storedVersion) {
          lsSet(LS_VERSION, diff.version);
          lsSet(LS_INDEX, JSON.stringify(diff.index));
        }
        setPhase('idle');
        resolveReady();
        return;
      }
      await runInstall(manifest, diff);
    } catch {
      // Manifest fetch failed.
      if (!state.storedVersion && !opts.background) {
        setPhase('error');
        showOfflineScreen(function () { runCheck(); });
        return; // ready stays pending until the user retries or quits
      }
      // Update check failed (offline etc.) → silent no-op; retry next boot.
      setPhase('idle');
      resolveReady();
    } finally {
      checkInFlight = false;
    }
  }

  /* ---------------- public surface ---------------- */
  var resolveReady;
  var ready = new Promise(function (res) { resolveReady = res; });

  function publicState() {
    return {
      phase: state.phase,
      manifestVersion: state.manifestVersion,
      storedVersion: state.storedVersion,
      changedCount: state.changedCount,
      doneBytes: state.doneBytes,
      totalBytes: state.totalBytes,
      notes: state.notes.slice(),
      bgFetch: state.bgFetch,
      lastError: state.lastError ? state.lastError.map(function (f) {
        return { path: f.path, message: String((f.error && f.error.message) || f.error) };
      }) : null,
    };
  }

  async function refreshTiles() {
    // Settings → "Refresh offline map tiles" (IR8/IR19): merge into the
    // existing tile cache for the current location, on demand.
    var prevPhase = state.phase;
    try {
      var manifest = await fetchManifest();
      await runTilePhase(manifest.tiles, null);
      return { ok: true, notes: state.notes.slice(-1) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (state.phase === 'tiles') setPhase(prevPhase === 'tiles' ? 'idle' : prevPhase);
    }
  }

  async function clearTiles() {
    try { await caches.delete(TILES_CACHE); } catch {}
    // Drop the map layer's meta index too — otherwise stale entries would
    // make the layer think cleared tiles are still cached (IR19).
    try { localStorage.removeItem('rr.tiles.meta.v1'); } catch {}
    return { ok: true };
  }

  window.RRInstall = {
    ready: ready,
    retry: function () { return runCheck(); },
    state: publicState,
  };
  // Playwright / test hook (IR17).
  window.__rrInstall = {
    state: publicState,
    retry: function () { return runCheck(); },
    refreshTiles: refreshTiles,
    clearTiles: clearTiles,
  };
  if (typeof module !== 'undefined' && module.exports) {
    window.__rrInstall.lib = RRInstallLib;
  }

  // Boot check runs immediately (script is synchronous at end of body).
  runCheck();

  // Foreground re-check, throttled to the version.json cadence (IR6).
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (Date.now() - state.lastCheckAt < FOREGROUND_RECHECK_MS) return;
    if (state.phase === 'installing' || state.phase === 'tiles' || state.phase === 'error') return;
    runCheck({ background: true });
  });
})();
