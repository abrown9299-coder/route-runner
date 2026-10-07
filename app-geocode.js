/* app-geocode.js — geocoding providers, caches, background geocode (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, devMode:writable, doOptimize:writable, markDirty:writable, refreshMap:writable, render:writable, setDevicePosFromGps:writable, showMap:writable, state:writable, stopLabel:writable */ // eslint-disable-line no-unused-vars
/* exported matrixCache, geocodeCacheLookup, geocodeCacheStore, endResolved, getEndCoords, getGps, devicePos, deviceDot, deviceWatchId, ensureDevicePos, fetchJson, geocodeArcGIS, locatedPoints, ensureGeocoded, geocodeInflight, geocodeInBackground, optInFlight, cacheStore, _cacheStore */
'use strict';

  function cacheStore() {
    try {
      const t = '__rr_cache_probe';
      localStorage.setItem(t, '1');
      localStorage.removeItem(t);
      return localStorage;
    } catch { return null; }
  }
  const _cacheStore = cacheStore();
  // CODING_RULES §6: geocode results 24h, matrices 1h. LRU-capped so the
  // blobs stay far under iOS Safari's ~5 MB localStorage budget.
  const geocodeCache = RouteCore.makeTtlCache('rr.geocode.v1', 24 * 3600 * 1000, 500, _cacheStore);
  const matrixCache = RouteCore.makeTtlCache('rr.matrix.v1', 3600 * 1000, 8, _cacheStore, {
    // JSON turns Infinity into null; revive unreachable legs on read.
    revive: (v) => (v && Array.isArray(v.matrix))
      ? { matrix: v.matrix.map((row) => (row || []).map((x) => (x == null ? Infinity : x))), source: v.source }
      : v,
  });
  function geocodeCacheLookup(key) {
    if (!key) return null;
    try {
      const v = geocodeCache.get(key);
      if (v && isFinite(v.lat) && isFinite(v.lng)) return { lat: v.lat, lng: v.lng };
    } catch {}
    return null;
  }
  function geocodeCacheStore(key, lat, lng) {
    if (!key || !isFinite(lat) || !isFinite(lng)) return;
    try { geocodeCache.set(key, { lat: lat, lng: lng }); } catch {}
  }

  /* ---------- geocoding ---------- */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function geocodeCensusBatch(stops) {
    // US Census batch geocoder: one free POST for all addresses, no key.
    // Format is 5 columns, NO header row: id,street,city,state,zip
    const q = (v) => String(v == null ? '' : v).replace(/"/g, '');
    const rows = stops.map((s, i) =>
      [i, q(s.street), q(s.city), q(s.state), q(s.zip)].join(','));
    const csv = rows.join('\n');
    const fd = new FormData();
    fd.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addrs.csv');
    fd.append('benchmark', 'Public_AR_Current');
    const r = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', {
      method: 'POST', body: fd,
    });
    if (!r.ok) throw new Error('census ' + r.status);
    const text = await r.text();
    const lines = text.trim().split('\n');
    if (!lines.length || !/Match/.test(text)) throw new Error('census no matches');
    lines.forEach((ln) => {
      const cols = ln.split('","').map((c) => c.replace(/^"|"$/g, ''));
      if (cols[2] === 'Match' && cols[5]) {
        const m = cols[5].match(/(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        const s = stops[parseInt(cols[0], 10)];
        if (m && s) { s.lng = parseFloat(m[1]); s.lat = parseFloat(m[2]); s.geocodeSource = 'census'; }
      }
    });
  }

  async function geocodeNominatim(s) {
    const q = encodeURIComponent(stopLabel(s));
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + q, {
      headers: { 'Accept': 'application/json' },
    });
    const j = await r.json();
    if (j && j[0]) {
      s.lat = parseFloat(j[0].lat); s.lng = parseFloat(j[0].lon); s.geocodeSource = 'nominatim';
      return true;
    }
    return false;
  }

  async function geocodeCensusOne(s) {
    // Nominatim one-shot geocoder: free, no key, CORS-friendly.
    // (US Census API doesn't send CORS headers, so browsers block it.)
    const q = encodeURIComponent(stopLabel(s));
    const r = await fetch(
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + q,
      { headers: { 'Accept': 'application/json' } });
    const j = await r.json();
    const m = j && j[0];
    if (m && m.lat && m.lon) {
      s.lng = parseFloat(m.lon); s.lat = parseFloat(m.lat); s.geocodeSource = 'nominatim-one';
      return true;
    }
    return false;
  }

  // End coordinates for optimization (spec §1): tripEnd wins. Returns null
  // when unset (skipped silently). endResolved is the map-facing mirror of
  // the optimizer's end point (item 4) — refreshMap() must never derive map
  // state from the geocode cache.
  let endCoordsCache = null, endCoordsFor = null;
  let endResolved = null; // {lat, lng, label} | null — resolved end of the current optimization
  async function getEndCoords() {
    const tripEnd = RouteCore.normalizeEndpoint(state.tripEnd);
    if (tripEnd && tripEnd.lat != null) {
      return { lat: tripEnd.lat, lng: tripEnd.lng };
    }
    if (tripEnd && tripEnd.label) {
      const key = 'trip:' + tripEnd.label;
      if (endCoordsCache && endCoordsFor === key) return endCoordsCache;
      const tmp = { street: tripEnd.label, city: '', state: '', zip: '' };
      const ok = await geocodeCensusOne(tmp).catch(() => false) ||
                 await geocodeNominatim(tmp).catch(() => false);
      if (ok && tmp.lat != null) {
        endCoordsCache = { lat: tmp.lat, lng: tmp.lng };
        endCoordsFor = key;
        state.tripEnd = { label: tripEnd.label, lat: tmp.lat, lng: tmp.lng };
        return endCoordsCache;
      }
      return null; // unlocatable: skipped silently
    }
    return null; // no end set
  }

  function getGps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({
          lat: p.coords.latitude, lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
        }),
        () => resolve(null), { timeout: 9000, maximumAge: 60000 });
    });
  }

  /* Last known device position (in-memory; refreshed on boot and map open).
   * Powers the "you are here" dot before optimize ever runs. */
  let devicePos = null;
  let deviceDot = null; // live blue-dot marker on the map
  let deviceWatchId = null;
  async function ensureDevicePos() {
    if (devicePos) return devicePos;
    try {
      const g = await getGps();
      if (g) setDevicePosFromGps({ lat: g.lat, lng: g.lng }, g.accuracy);
    } catch { if (!devMode.pos) devicePos = null; }
    return devicePos;
  }
  /* Keep the blue dot tracking the device in real time. */
  async function fetchJson(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /* Esri World Geocoder: free, keyless, CORS-enabled, commercial-grade data.
   * Verified score 100 on "1004 Summerview Ct, Nashville, TN 37221" —
   * the address Census/Nominatim/Photon all miss. */
  async function geocodeArcGIS(s, query) {
    const j = await fetchJson(RouteCore.arcgisGeocodeUrl(query || stopLabel(s)));
    const p = RouteCore.parseArcGisCandidates(j);
    if (p && p.score >= 80) {
      s.lat = p.lat; s.lng = p.lng; s.geocodeSource = 'arcgis'; s.approx = false;
      return true;
    }
    return false;
  }

  /* Last resort: pin the ZIP area so the optimizer puts the stop in the
   * right part of town instead of dead-last. */
  async function geocodeZipApprox(s) {
    const m = String(s.zip || '').match(/\d{5}/);
    if (!m || s.lat != null) return false;
    try {
      const j = await fetchJson(RouteCore.arcgisGeocodeUrl(m[0]));
      const p = RouteCore.parseArcGisCandidates(j);
      if (p) {
        s.lat = p.lat; s.lng = p.lng; s.geocodeSource = 'zip-approx'; s.approx = true;
        return true;
      }
    } catch { /* fall through — stays unlocated */ }
    return false;
  }

  /* Located points in current display order (origin first when known). */
  function locatedPoints() {
    const pts = [];
    if (state.origin.lat != null && state.origin.lng != null) {
      pts.push({ lat: state.origin.lat, lng: state.origin.lng });
    }
    state.stops.forEach((s) => {
      if (s.lat != null && s.lng != null) pts.push({ lat: s.lat, lng: s.lng });
    });
    return pts;
  }

  async function ensureGeocoded(statusFn, opts) {
    const o = opts || {};
    // Start (spec §1): tripStart wins; else fall back to legacy origin/GPS.
    // If neither is available, skip silently — route starts at first stop.
    const startEp = RouteCore.normalizeEndpoint(state.tripStart);
    if (startEp && startEp.lat != null) {
      state.origin = { type: 'address', label: startEp.label, lat: startEp.lat, lng: startEp.lng };
    } else if (startEp && startEp.lat == null && startEp.label) {
      statusFn('Locating start address…');
      const tmp = { street: startEp.label };
      if (await geocodeCensusOne(tmp).catch(() => false)) {
        state.origin = { type: 'address', label: startEp.label, lat: tmp.lat, lng: tmp.lng };
        state.tripStart = { label: startEp.label, lat: tmp.lat, lng: tmp.lng };
      } else if (await geocodeNominatim(tmp).catch(() => false)) {
        state.origin = { type: 'address', label: startEp.label, lat: tmp.lat, lng: tmp.lng };
        state.tripStart = { label: startEp.label, lat: tmp.lat, lng: tmp.lng };
      } else {
        // Unlocatable start: clear it so optimize skips silently.
        state.tripStart = null;
        state.origin = { type: 'gps', label: 'Current location', lat: null, lng: null };
      }
    } else if (!startEp) {
      // No explicit start: try GPS (existing behavior), else skip silently.
      if (state.origin.type === 'gps' && state.origin.lat == null && !o.skipGps) {
        statusFn('Getting your location…');
        const g = await getGps();
        if (g) { state.origin.lat = g.lat; state.origin.lng = g.lng; }
        // else: leave null — optimize skips the origin silently.
      }
    }
    // origin (legacy path when tripStart wasn't set and origin has an address)
    if (!startEp && state.origin.type === 'address' && state.origin.lat == null) {
      statusFn('Locating start address…');
      const tmp = { street: state.origin.label };
      if (await geocodeCensusOne(tmp).catch(() => false)) {
        state.origin.lat = tmp.lat; state.origin.lng = tmp.lng;
      } else if (await geocodeNominatim(tmp).catch(() => false)) {
        state.origin.lat = tmp.lat; state.origin.lng = tmp.lng;
      } else {
        try {
          if (await geocodeArcGIS(tmp)) {
            state.origin.lat = tmp.lat; state.origin.lng = tmp.lng;
          }
        } catch {}
      }
    }
    // stops: cache -> Census batch -> ArcGIS (parallel, cap 4) ->
    //        Nominatim (serial, 1 req/s) -> suffix retry (parallel) -> ZIP area (parallel)
    const missing = state.stops.filter((s) => s.lat == null);
    if (missing.length) {
      // Cache keys must come from the address form: stopLabel() switches to
      // "lat,lng" once coords exist, so capture keys before any geocoding.
      const cacheKeys = new Map();
      let still = [];
      for (const s of missing) {
        const key = RouteCore.normalizeGeocodeKey(stopLabel(s));
        cacheKeys.set(s, key);
        const hit = geocodeCacheLookup(key);
        if (hit) {
          s.lat = hit.lat; s.lng = hit.lng; s.geocodeSource = 'cache'; s.approx = false;
        } else {
          still.push(s);
        }
      }
      // Write cache entries for stops this run located (precise results only —
      // ZIP-approx coords are deliberately never cached: a cached approximation
      // would block a later, better ArcGIS hit for the same address).
      const cacheNewlyLocated = (list) => {
        for (const s of list) {
          if (s.lat != null && s.lng != null && !s.approx && s.geocodeSource !== 'cache') {
            geocodeCacheStore(cacheKeys.get(s), s.lat, s.lng);
          }
        }
      };
      if (still.length) {
        statusFn('Locating ' + still.length + ' address' +
          (still.length === 1 ? '' : 'es') + '…');
        try { await geocodeCensusBatch(still); } catch { /* fall through */ }
        cacheNewlyLocated(still);
        still = still.filter((s) => s.lat == null);
        // ArcGIS stages share one concurrency cap of 4; each worker keeps the
        // 400/300 ms gap the serial code had (politeness per worker slot).
        await RouteCore.parallelLimit(still, 4, async (s) => {
          try { await geocodeArcGIS(s); } catch {}
          await sleep(400);
        });
        cacheNewlyLocated(still);
        still = still.filter((s) => s.lat == null);
        // Nominatim usage policy is ≤1 req/s — stays strictly serial.
        for (const s of still) {
          try { await geocodeNominatim(s); } catch {}
          await sleep(1100); // nominatim politeness
        }
        cacheNewlyLocated(still);
        still = still.filter((s) => s.lat == null);
        const suffixJobs = [];
        for (const s of still) {
          const expanded = RouteCore.expandStreetSuffix(s.street || '');
          if (expanded && expanded !== s.street) {
            suffixJobs.push({ s: s, q: [expanded, s.city, s.state, s.zip].filter(Boolean).join(', ') });
          }
        }
        await RouteCore.parallelLimit(suffixJobs, 4, async (job) => {
          try { await geocodeArcGIS(job.s, job.q); } catch {}
          await sleep(400);
        });
        cacheNewlyLocated(still);
        still = still.filter((s) => s.lat == null);
        await RouteCore.parallelLimit(still, 4, async (s) => {
          await geocodeZipApprox(s); // never throws; approx results stay uncached
          await sleep(300);
        });
      }
    }
  }

  /* Geocode right after import so the map preview + rough estimate work
   * before optimization. One shared in-flight promise: Optimize awaits it
   * instead of racing it. */
  let geocodeInflight = null;
  function geocodeInBackground() {
    if (geocodeInflight || state.geocoding) return;
    if (!state.stops.some((s) => s.lat == null)) return;
    state.geocoding = true;
    render();
    geocodeInflight = (async () => {
      try {
        await ensureGeocoded((t) => {
          state.geocodeStatus = t;
          if (!state.optimized) render();
        }, { skipGps: true });
      } finally {
        state.geocoding = false;
        state.geocodeStatus = '';
        geocodeInflight = null;
      }
      markDirty(); // recompute rough estimate + re-render
      // auto-show the map preview once, so pins are visible pre-optimization
      if ($('mapWrap').hidden && state.stops.some((s) => s.lat != null)) {
        try { await showMap(); } catch { /* map needs a connection */ }
      } else {
        render();
      }
    })();
  }

  /* ---------- optimize ---------- */
  let optInFlight = false;
  $('optimizeBtn').onclick = () => doOptimize(false);

  /* Optimize the route. auto=true when the automatic engine fires it
   * (stop done / idle reopen / window confirmed): same math, quieter toasts. */
