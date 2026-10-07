/* app-map.js — Leaflet map, tile cache (split from app.js 2026-10-06) */
/* global Response: readonly */
/* global $:writable, LS_TILE_CFG:writable, LS_TILE_META:writable, TILES_CACHE:writable, TILE_BUDGET_BYTES:writable, TILE_BUDGET_TILES:writable, TILE_TEMPLATE:writable, adoptDevicePos:writable, deviceDot:writable, devicePos:writable, endResolved:writable, ensureDevicePos:writable, esc:writable, load:writable, markDirty:writable, state:writable, stopLabel:writable, tileMeta:writable, tileMetaDirty:writable, toast:writable */ // eslint-disable-line no-unused-vars
/* exported saveTileMeta, mapObj, showMap, openMapForPin, refreshMap */
'use strict';

  function loadTileMeta() {
    if (tileMeta) return tileMeta;
    tileMeta = [];
    try {
      const arr = JSON.parse(localStorage.getItem(LS_TILE_META) || 'null');
      if (Array.isArray(arr)) tileMeta = arr.filter((e) => e && typeof e.u === 'string');
    } catch {}
    return tileMeta;
  }
  function saveTileMeta() {
    if (!tileMetaDirty || !tileMeta) return;
    tileMetaDirty = false;
    try { localStorage.setItem(LS_TILE_META, JSON.stringify(tileMeta.slice(-TILE_BUDGET_TILES))); } catch {}
  }
  function tileBudgetBytes() {
    try {
      const cfg = JSON.parse(localStorage.getItem(LS_TILE_CFG) || 'null');
      if (cfg && Number(cfg.budgetBytes) > 0) return Number(cfg.budgetBytes);
    } catch {}
    return TILE_BUDGET_BYTES;
  }
  async function tileCachePut(url, blob) {
    const meta = loadTileMeta();
    const now = Date.now();
    const existing = meta.find((e) => e.u === url);
    if (existing) { existing.t = now; tileMetaDirty = true; saveTileMeta(); return; }
    try {
      const cache = await caches.open(TILES_CACHE);
      await cache.put(url, new Response(blob, { headers: { 'content-type': 'image/png' } }));
    } catch { return; }
    meta.push({ u: url, b: blob.size || 0, t: now });
    tileMetaDirty = true;
    // Oldest-first eviction when over budget (IR11/IR19).
    const budget = tileBudgetBytes();
    let total = meta.reduce((s, e) => s + (e.b || 0), 0);
    try {
      const cache = await caches.open(TILES_CACHE);
      while ((total > budget || meta.length > TILE_BUDGET_TILES) && meta.length) {
        const evict = meta.shift();
        total -= evict.b || 0;
        try { await cache.delete(evict.u); } catch {}
      }
    } catch {}
    saveTileMeta();
  }
  // Cache-first tile bytes for the map layer; null = fall back to the
  // plain URL (network via the <img> element itself).
  async function tileBytesForLayer(url) {
    try {
      const cache = await caches.open(TILES_CACHE);
      const hit = await cache.match(url);
      if (hit) return URL.createObjectURL(await hit.blob());
    } catch {}
    let resp = null;
    try { resp = await fetch(url, { cache: 'no-store' }); } catch { /* offline */ }
    if (!resp || !resp.ok) return null;
    const blob = await resp.blob();
    tileCachePut(url, blob).catch(() => {});
    return URL.createObjectURL(blob);
  }
  function createCachedTileLayer() {
    const CachedLayer = L.TileLayer.extend({
      createTile: function (coords, done) {
        const tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
        L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
        const url = this.getTileUrl(coords);
        tileBytesForLayer(url).then((blobUrl) => {
          if (blobUrl) { tile.dataset.blobUrl = blobUrl; tile.src = blobUrl; }
          else tile.src = url;
        }).catch(() => { tile.src = url; });
        return tile;
      },
      _removeTile: function (key) {
        const entry = this._tiles[key];
        if (entry && entry.el && entry.el.dataset && entry.el.dataset.blobUrl) {
          try { URL.revokeObjectURL(entry.el.dataset.blobUrl); } catch {}
        }
        L.TileLayer.prototype._removeTile.call(this, key);
      },
    });
    return new CachedLayer(TILE_TEMPLATE, {
      attribution: '&copy; OpenStreetMap', maxZoom: 19,
    });
  }

  /* ---------- map ---------- */
  let mapObj = null, leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/leaflet.min.js'; // vendored (IR18) — was a jsdelivr CDN URL
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return leafletLoading;
  }
  async function showMap() {
    const w = $('mapWrap');
    if (!w.hidden) return;
    await loadLeaflet(); // throws when offline -> caller toasts
    w.hidden = false;
    $('mapToggle').textContent = '🗺 Hide';
    if (!mapObj) {
      mapObj = L.map('map');
      createCachedTileLayer().addTo(mapObj); // cache-first, network fallback (IR11)
      mapObj.on('click', (e) => {
        if (!state.pinModeStopId) return;
        const s = state.stops.find((x) => x.id === state.pinModeStopId);
        if (s) {
          s.lat = e.latlng.lat; s.lng = e.latlng.lng; s.geocodeSource = 'manual-pin';
          s.approx = false;
          state.pinModeStopId = null;
          markDirty('📍 Pin dropped');
          toast('Pin dropped — re-optimize to re-route');
        }
      });
    }
    setTimeout(async () => {
      try {
        mapObj.invalidateSize();
        // Make sure the GPS origin (and "you are here") is known before drawing.
        if (state.origin.type === 'gps' && state.origin.lat == null) await ensureDevicePos();
        adoptDevicePos();
        refreshMap();
        // No GPS and no stops: neutral continental-US view, never a
        // hardcoded city. GPS is the source of truth — we don't guess.
        if (!devicePos && !state.stops.some((s) => s.lat != null)) {
          mapObj.setView([39.8, -98.5], 4);
        }
        updateLocationHint();
      } catch { /* map draw failures must never break the app */ }
    }, 50);
  }
  $('mapToggle').onclick = async () => {
    const w = $('mapWrap');
    if (!w.hidden) { w.hidden = true; $('mapToggle').textContent = '🗺 Map'; return; }
    try { await showMap(); } catch { toast('Map needs a connection'); }
  };
  /* Subtle "enable location" hint on the map when GPS is unavailable.
   * Non-blocking — the map still works, searches run unbiased. */
  function updateLocationHint() {
    const hint = $('locationHint');
    if (!hint) return;
    hint.hidden = !!devicePos;
  }
  $('locationHintRetry').onclick = async () => {
    toast('Getting your location…');
    devicePos = null; // force a fresh fix attempt
    await ensureDevicePos();
    adoptDevicePos();
    updateLocationHint();
    refreshMap();
    if (devicePos) toast('✓ Location found');
  };
  function openMapForPin(stopId) {
    state.pinModeStopId = stopId;
    if ($('mapWrap').hidden) $('mapToggle').click();
    toast('Tap the map to drop a pin for that stop');
  }
  let mapLayers = [];
  function refreshMap() {
    if (!mapObj || $('mapWrap').hidden) return;
    mapLayers.forEach((l) => mapObj.removeLayer(l));
    mapLayers = [];
    deviceDot = null; // redrawn below; live tracking re-attaches
    const pts = state.stops.filter((s) => s.lat != null);
    // GPS origin: the blue "you are here" dot represents it — no separate pin.
    const originIsGps = state.origin.type === 'gps';
    if (state.origin.lat != null && !originIsGps) pts.unshift({ lat: state.origin.lat, lng: state.origin.lng, _origin: true });
    // return-to-start: show the origin again as the final destination
    if (state.returnActive && state.optimized && state.origin.lat != null) {
      pts.push({ lat: state.origin.lat, lng: state.origin.lng, _return: true });
    }
    // trip-end block: show the resolved end point as the final destination
    if (state.endActive && state.optimized && endResolved) {
      pts.push({ lat: endResolved.lat, lng: endResolved.lng, _end: true });
    }
    pts.forEach((s, i) => {
      const cls = 'pin-num' + (s.isLast ? ' last' : '') + (s.isFirst ? ' first' : '') + (s.done ? ' done' : '') + (s._return || s._end ? ' ret' : '');
      // 1-based numbering: the blue dot is your position, stops start at 1.
      const stopNum = pts.slice(0, i + 1).filter((p) => !p._origin && !p._return && !p._end).length;
      const label = s._origin ? '📍' : s._return ? '↩' : s._end ? '🏠' : (s.isFirst ? '🚩' : (s.isLast ? '🏁' : String(stopNum)));
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: '<div class="' + cls + '">' + esc(label) + '</div>', iconSize: [28, 28] }),
      }).addTo(mapObj);
      if (!s._origin && !s._return && !s._end) m.bindPopup(esc(stopLabel(s)));
      if (s._return) m.bindPopup('↩ Return to start');
      if (s._end) m.bindPopup('🏠 ' + esc(endResolved && endResolved.label ? endResolved.label : 'Home'));
      mapLayers.push(m);
    });
    // Active route line: from your blue dot through remaining (not-done) stops only.
    // Done stops stay visible as markers but are out of the route line.
    const remaining = pts.filter((p) => !p.done && !p._origin);
    const linePts = [];
    if (devicePos) linePts.push([devicePos.lat, devicePos.lng]);
    remaining.forEach((p) => linePts.push([p.lat, p.lng]));
    if (linePts.length > 1) {
      const pl = L.polyline(linePts, { color: '#7c5cff', weight: 4 }).addTo(mapObj);
      mapLayers.push(pl);
    }
    // "You are here" blue dot — always drawn when the device position is known.
    // The dot IS the GPS origin; no separate pin is drawn for it.
    if (devicePos) {
      // Blue dot as a marker (not circleMarker) so it lives in the marker pane
      // and renders above the stop pins via zIndexOffset.
      const dot = L.marker([devicePos.lat, devicePos.lng], {
        icon: L.divIcon({ className: '', html: '<div class="you-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        zIndexOffset: 1000,
      }).addTo(mapObj);
      dot.bindPopup('You are here');
      mapLayers.push(dot);
      deviceDot = dot;
    }
    const boundPts = pts.map((p) => [p.lat, p.lng]);
    if (devicePos) boundPts.push([devicePos.lat, devicePos.lng]);
    if (boundPts.length) mapObj.fitBounds(L.latLngBounds(boundPts).pad(0.15));
    updateLocationHint();
  }

  /* ---------- clear all / fresh start ---------- */
