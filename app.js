/* RouteRunner app.js — UI wiring. Pure-algorithm work lives in core.js (window.RouteCore). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LS_ROUTE = 'rr.route.v1', LS_SET = 'rr.settings.v1', LS_HIST = 'rr.history.v1';

  const state = {
    stops: [],           // display order = route order
    origin: { type: 'gps', label: 'Current location', lat: null, lng: null },
    optimized: false,
    matrixSource: null,  // 'osrm' | 'haversine'
    pinModeStopId: null,
  };
  const settings = {
    defaultStart: '', avoidTolls: false, avoidHwy: false,
    returnToStart: false, saveHistory: false,
  };

  /* ---------- persistence ---------- */
  function save() {
    try {
      localStorage.setItem(LS_ROUTE, JSON.stringify({
        stops: state.stops, origin: state.origin,
        optimized: state.optimized, matrixSource: state.matrixSource,
      }));
      localStorage.setItem(LS_SET, JSON.stringify(settings));
    } catch (e) { /* storage full/blocked — app still works for the session */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SET) || 'null');
      if (s) Object.assign(settings, s);
      const r = JSON.parse(localStorage.getItem(LS_ROUTE) || 'null');
      if (r) {
        state.stops = r.stops || [];
        state.origin = r.origin || state.origin;
        state.optimized = !!r.optimized;
        state.matrixSource = r.matrixSource || null;
      }
    } catch (e) {}
    if (settings.defaultStart && state.origin.type === 'gps' && !state.origin.lat) {
      state.origin = { type: 'address', label: settings.defaultStart, lat: null, lng: null };
    }
  }

  /* ---------- helpers ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function stopLabel(s) {
    const a = [s.street, s.city, s.state && s.zip ? s.state + ' ' + s.zip : (s.state || s.zip)]
      .filter(Boolean).join(', ').replace(/,(\s*,)+/g, ',').trim();
    if (a) return a;
    if (s.lat != null && s.lng != null) return s.lat.toFixed(5) + ',' + s.lng.toFixed(5);
    return 'Unknown address';
  }
  function markDirty(msg) {
    state.optimized = false; state.matrixSource = null;
    save(); render();
    if (msg) toast(msg);
  }
  let toastTimer = null;
  function toast(msg, action) {
    const t = $('toast');
    t.innerHTML = esc(msg);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = () => { action.fn(); t.hidden = true; };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2800);
  }

  /* ---------- render ---------- */
  function render() {
    $('routeDate').textContent = new Date().toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    $('originLabel').textContent = state.origin.label || 'Current location';

    const total = state.stops.length;
    const done = state.stops.filter((s) => s.done).length;
    $('progressText').textContent = done + '/' + total;
    $('progressRing').style.strokeDashoffset = total
      ? 113 - (113 * done / total) : 113;
    $('stopCount').textContent = total ? '(' + total + ')' : '';

    const ul = $('stopList');
    ul.innerHTML = '';
    $('emptyHint').style.display = total ? 'none' : 'block';
    state.stops.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'stop' + (s.done ? ' done' : '') + (s.isLast ? ' is-last' : '');
      li.dataset.id = s.id;
      const needsPin = s.lat == null || s.lng == null;
      li.innerHTML =
        '<span class="drag" title="Drag to reorder">⠿</span>' +
        '<span class="num">' + (s.isLast ? '🏁' : (i + 1)) + '</span>' +
        '<div class="info"><div class="addr">' + esc(stopLabel(s)) + '</div>' +
        '<div class="meta">' +
          (s.jobType ? '<span class="chip">' + esc(s.jobType) + '</span>' : '') +
          (s.isLast ? '<span class="chip last">🏁 last stop</span>' : '') +
          (needsPin ? '<span class="chip warn">📍 no location — tap to drop pin</span>' : '') +
          (s.note ? '<span class="chip">📝 ' + esc(s.note) + '</span>' : '') +
        '</div></div>' +
        '<div class="acts">' +
          '<button class="check-btn' + (s.done ? ' on' : '') + '" data-act="check" title="Mark done">✓</button>' +
          '<button data-act="last" title="Set as last stop">🏁</button>' +
          '<button data-act="note" title="Add note">📝</button>' +
          '<button data-act="del" title="Remove stop">✕</button>' +
        '</div>';
      if (needsPin) li.querySelector('.meta').style.cursor = 'pointer';
      ul.appendChild(li);
    });

    // status line
    const st = $('routeStatus');
    const unlocated = state.stops.filter((s) => s.lat == null).length;
    if (!total) { st.textContent = ''; st.className = 'status-line'; }
    else if (!state.optimized) {
      st.textContent = 'Not optimized yet — tap ⚡ Optimize when ready.';
      st.className = 'status-line warn';
    } else {
      st.textContent = (state.matrixSource === 'osrm' ? 'Optimized by drive time' : 'Optimized by straight-line distance') +
        ' · ' + total + ' stops' + (unlocated ? ' · ' + unlocated + ' need a pin' : '');
      st.className = 'status-line ok';
    }
    $('optimizeBtn').classList.toggle('needs-rerun', total > 0 && !state.optimized);
    $('optimizeBtn').querySelector('span').textContent = state.optimized ? 'Re-optimize' : 'Optimize';
    if (mapObj) refreshMap();
  }

  /* ---------- list actions ---------- */
  $('stopList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const li = e.target.closest('li.stop');
    if (!li) return;
    const s = state.stops.find((x) => x.id === li.dataset.id);
    if (!s) return;
    if (!btn) { // tapped body — if needs pin, enter pin mode
      if (s.lat == null) openMapForPin(s.id);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'check') { s.done = !s.done; save(); render(); }
    else if (act === 'last') {
      state.stops.forEach((x) => { if (x !== s) x.isLast = false; });
      s.isLast = !s.isLast;
      markDirty(s.isLast ? '🏁 will be routed last' : 'Last-stop pin removed');
    }
    else if (act === 'note') {
      const n = prompt('Note for this stop:', s.note || '');
      if (n !== null) { s.note = n.trim(); save(); render(); }
    }
    else if (act === 'del') {
      const idx = state.stops.indexOf(s);
      state.stops.splice(idx, 1);
      markDirty();
      toast('Stop removed', { label: 'Undo', fn: () => {
        state.stops.splice(Math.min(idx, state.stops.length), 0, s);
        markDirty();
      }});
    }
  });

  // drag reorder (touch-friendly via SortableJS)
  new Sortable($('stopList'), {
    handle: '.drag', animation: 150, delay: 120, delayOnTouchOnly: true,
    onEnd: () => {
      const order = [...$('stopList').children].map((li) => li.dataset.id);
      state.stops.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      markDirty('Order updated — re-optimize to re-route');
    },
  });

  /* ---------- add: search ---------- */
  let searchTimer = null;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 4) { $('suggestList').hidden = true; return; }
    searchTimer = setTimeout(() => searchPhoton(q), 350);
  });
  async function searchPhoton(q) {
    try {
      const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) +
        '&limit=6&lat=36.1627&lon=-86.7816';
      const r = await fetch(url);
      const j = await r.json();
      const list = $('suggestList');
      list.innerHTML = '';
      (j.features || []).forEach((f) => {
        const p = f.properties || {};
        const label = [p.name, p.street, p.city, p.state, p.postcode].filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i).join(', ');
        const li = document.createElement('li');
        li.innerHTML = esc(label || 'Unnamed place') +
          '<small>' + esc([p.city, p.state].filter(Boolean).join(', ')) + '</small>';
        li.onclick = () => {
          const [lng, lat] = f.geometry.coordinates;
          addStops([{
            id: uid(), street: [p.name, p.street].filter(Boolean).join(' ') || label,
            city: p.city || '', state: p.state || '', zip: p.postcode || '',
            jobType: '', note: '', lat, lng, geocodeSource: 'search',
            done: false, isLast: false, source: 'search',
          }]);
          $('searchInput').value = '';
          list.hidden = true;
        };
        list.appendChild(li);
      });
      list.hidden = !(j.features || []).length;
    } catch (e) { /* offline — suggestions unavailable */ }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchWrap')) $('suggestList').hidden = true;
  });

  /* ---------- add: manual form ---------- */
  $('manualBtn').onclick = () => {
    const f = $('manualForm');
    f.hidden = !f.hidden;
    if (!f.hidden) $('mStreet').focus();
  };
  $('mAdd').onclick = async () => {
    const street = $('mStreet').value.trim();
    if (!street) { toast('Enter at least a street address'); return; }
    const s = {
      id: uid(), street, city: $('mCity').value.trim(), state: $('mState').value.trim(),
      zip: $('mZip').value.trim(), jobType: $('mJob').value.trim(), note: '',
      lat: null, lng: null, geocodeSource: null, done: false, isLast: false, source: 'manual',
    };
    addStops([s]);
    $('mStreet').value = ''; $('mZip').value = ''; $('mJob').value = '';
    toast('Stop added — it will be located when you optimize');
  };

  /* ---------- add: screenshots / OCR ---------- */
  $('ocrBtn').onclick = () => $('fileInput').click();
  $('fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    if (state.stops.length + files.length * 8 > 40) { /* soft guard */ }
    $('ocrOverlay').hidden = false;
    const all = [];
    try {
      await RR_OCR.load((p) => { $('ocrStatus').textContent = p; });
      for (let i = 0; i < files.length; i++) {
        $('ocrBarFill').style.width = Math.round(100 * i / files.length) + '%';
        $('ocrStatus').textContent = 'Reading image ' + (i + 1) + ' of ' + files.length + '…';
        try {
          const text = await RR_OCR.recognize(files[i]);
          const parsed = RouteCore.parseOcrText(text);
          parsed.forEach((p) => all.push({
            id: uid(), street: p.street, city: p.city, state: p.state, zip: p.zip,
            jobType: p.jobType || '', note: '', lat: null, lng: null, geocodeSource: null,
            done: false, isLast: false, source: 'ocr',
          }));
        } catch (err) { console.warn('OCR failed for one image', err); }
      }
      await RR_OCR.done();
    } catch (err) {
      $('ocrOverlay').hidden = true;
      toast('Could not load the text reader — check connection and retry');
      return;
    }
    $('ocrBarFill').style.width = '100%';
    $('ocrOverlay').hidden = true;
    if (!all.length) { toast('No addresses found in those screenshots'); return; }
    const before = state.stops.length;
    const merged = RouteCore.dedupeStops(state.stops.concat(all));
    state.stops = merged.stops;
    const added = state.stops.length - before;
    markDirty('Added ' + added + ' stop' + (added === 1 ? '' : 's') +
      (merged.removed ? ' · ' + merged.removed + ' duplicate' + (merged.removed === 1 ? '' : 's') + ' skipped' : ''));
  });

  function addStops(arr) {
    if (!arr.length) return;
    if (state.stops.length + arr.length > 20) {
      toast('20-stop ceiling reached — remove a stop first');
      arr = arr.slice(0, 20 - state.stops.length);
      if (!arr.length) return;
    }
    const before = state.stops.length;
    const merged = RouteCore.dedupeStops(state.stops.concat(arr));
    state.stops = merged.stops;
    const added = state.stops.length - before;
    markDirty('Added ' + added + ' stop' + (added === 1 ? '' : 's') +
      (merged.removed ? ', ' + merged.removed + ' duplicate' + (merged.removed === 1 ? '' : 's') + ' skipped' : ''));
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

  function getGps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null), { timeout: 9000, maximumAge: 60000 });
    });
  }

  async function ensureGeocoded(statusFn) {
    // origin
    if (state.origin.type === 'gps' && state.origin.lat == null) {
      statusFn('Getting your location…');
      const g = await getGps();
      if (g) { state.origin.lat = g.lat; state.origin.lng = g.lng; }
      else { state.origin.label = 'Current location (GPS unavailable)'; }
    } else if (state.origin.type === 'address' && state.origin.lat == null) {
      statusFn('Locating start address…');
      const tmp = { street: state.origin.label };
      if (await geocodeNominatim(tmp).catch(() => false)) {
        state.origin.lat = tmp.lat; state.origin.lng = tmp.lng;
      }
    }
    // stops
    const missing = state.stops.filter((s) => s.lat == null);
    if (missing.length) {
      statusFn('Locating ' + missing.length + ' address' + (missing.length === 1 ? '' : 'es') + '…');
      try { await geocodeCensusBatch(missing); } catch (e) { /* fall through to nominatim */ }
      const still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        try { await geocodeNominatim(s); } catch (e) {}
        await sleep(1100); // nominatim politeness
      }
    }
  }

  /* ---------- optimize ---------- */
  $('optimizeBtn').onclick = async () => {
    if (!state.stops.length) { toast('Add some stops first'); return; }
    const btn = $('optimizeBtn');
    btn.disabled = true;
    const setStatus = (t) => { $('routeStatus').textContent = t; $('routeStatus').className = 'status-line warn'; };
    try {
      await ensureGeocoded(setStatus);
      const located = state.stops.filter((s) => s.lat != null);
      const unlocated = state.stops.filter((s) => s.lat == null);
      if (!located.length) { toast('Could not locate any addresses'); return; }

      const points = [{ lat: state.origin.lat, lng: state.origin.lng, _stopId: null }]
        .concat(located.map((s) => ({ lat: s.lat, lng: s.lng, _stopId: s.id })));
      // origin may lack coords (GPS denied) — fall back to first stop as start
      let startIdx = 0;
      if (points[0].lat == null) { points.shift(); startIdx = -1; }
      const lastStop = state.stops.find((s) => s.isLast && s.lat != null);
      const lastIdx = lastStop ? points.findIndex((p) => p._stopId === lastStop.id) : null;

      setStatus('Optimizing route…');
      const { order, source } = await RouteCore.optimizeRouteAsync(points, {
        startIdx: Math.max(0, startIdx), lastIdx, fetchFn: fetch.bind(window),
      });
      const byId = Object.fromEntries(state.stops.map((s) => [s.id, s]));
      const ordered = order
        .map((pi) => points[pi]._stopId)
        .filter((id) => id && byId[id])
        .map((id) => byId[id]);
      state.stops = ordered.concat(unlocated); // unlocated ride at the end
      state.optimized = true;
      state.matrixSource = source;
      save(); render();
      if (settings.saveHistory) saveHistory(source);
      toast(source === 'osrm' ? '⚡ Optimized by drive time' : '⚡ Optimized (straight-line — offline mode)');
    } catch (e) {
      console.warn(e);
      toast('Optimization hit a snag — try again');
      render();
    } finally {
      btn.disabled = false;
    }
  };

  function saveHistory(source) {
    try {
      const h = JSON.parse(localStorage.getItem(LS_HIST) || '[]');
      h.unshift({
        date: new Date().toISOString(),
        count: state.stops.length,
        source,
        stops: state.stops.map((s) => ({ label: stopLabel(s), jobType: s.jobType })),
      });
      localStorage.setItem(LS_HIST, JSON.stringify(h.slice(0, 30)));
    } catch (e) {}
  }

  /* ---------- Google Maps ---------- */
  function originLabel() {
    if (state.origin.lat != null) return state.origin.lat.toFixed(5) + ',' + state.origin.lng.toFixed(5);
    return state.origin.label || 'Current location';
  }
  $('mapsBtn').onclick = () => {
    const remaining = state.stops.filter((s) => !s.done);
    if (!remaining.length) { toast('No remaining stops'); return; }
    // pass the stop objects themselves — core.js stopLabel() builds the address text
    const ordered = remaining.slice();
    if (settings.returnToStart) ordered.push({ street: originLabel() });
    const avoid = [];
    if (settings.avoidTolls) avoid.push('tolls');
    if (settings.avoidHwy) avoid.push('highways');
    const legs = RouteCore.buildMapsLinks(originLabel(), ordered, { avoid });
    if (legs.length === 1) { window.open(legs[0].url, '_blank'); return; }
    const box = $('legList');
    box.innerHTML = '';
    legs.forEach((leg) => {
      const b = document.createElement('button');
      b.className = 'btn leg-btn';
      b.innerHTML = '🗺️ ' + esc(leg.label);
      b.onclick = () => window.open(leg.url, '_blank');
      box.appendChild(b);
    });
    $('legSheet').hidden = false;
  };
  $('legClose').onclick = () => { $('legSheet').hidden = true; };

  /* ---------- share ---------- */
  $('shareBtn').onclick = async () => {
    if (!state.stops.length) { toast('Nothing to share yet'); return; }
    const payload = {
      v: 1,
      origin: { type: state.origin.type, label: state.origin.label, lat: state.origin.lat, lng: state.origin.lng },
      settings: { avoidTolls: settings.avoidTolls, avoidHwy: settings.avoidHwy, returnToStart: settings.returnToStart },
      stops: state.stops.map((s) => ({
        street: s.street, city: s.city, state: s.state, zip: s.zip,
        jobType: s.jobType, note: s.note, lat: s.lat, lng: s.lng, isLast: s.isLast,
      })),
    };
    const url = location.href.split('#')[0] + RouteCore.encodeShare(payload);
    try {
      await navigator.clipboard.writeText(url);
      toast('🔗 Route link copied — send it to anyone');
    } catch (e) {
      prompt('Copy your route link:', url);
    }
  };
  function loadSharedRoute() {
    if (!location.hash.startsWith('#r=')) return false;
    const data = RouteCore.decodeShare(location.hash);
    if (!data || !Array.isArray(data.stops)) return false;
    state.stops = data.stops.map((s) => Object.assign({
      id: uid(), done: false, isLast: !!s.isLast, source: 'shared', geocodeSource: null,
    }, s));
    if (data.origin) state.origin = data.origin;
    if (data.settings) Object.assign(settings, data.settings);
    state.optimized = false;
    history.replaceState(null, '', location.pathname + location.search);
    save(); render();
    toast('Route loaded from shared link');
    return true;
  }

  /* ---------- origin ---------- */
  $('originBtn').onclick = async () => {
    const cur = state.origin.type === 'address' ? state.origin.label : '';
    const v = prompt('Start address (blank = use current GPS location):', cur);
    if (v === null) return;
    const t = v.trim();
    if (!t) {
      state.origin = { type: 'gps', label: 'Current location', lat: null, lng: null };
    } else {
      state.origin = { type: 'address', label: t, lat: null, lng: null };
    }
    markDirty('Start updated');
  };

  /* ---------- map ---------- */
  let mapObj = null, leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return leafletLoading;
  }
  $('mapToggle').onclick = async () => {
    const w = $('mapWrap');
    if (!w.hidden) { w.hidden = true; $('mapToggle').textContent = '🗺 Map'; return; }
    try { await loadLeaflet(); } catch (e) { toast('Map needs a connection'); return; }
    w.hidden = false;
    $('mapToggle').textContent = '🗺 Hide';
    if (!mapObj) {
      mapObj = L.map('map');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19,
      }).addTo(mapObj);
      mapObj.on('click', (e) => {
        if (!state.pinModeStopId) return;
        const s = state.stops.find((x) => x.id === state.pinModeStopId);
        if (s) {
          s.lat = e.latlng.lat; s.lng = e.latlng.lng; s.geocodeSource = 'manual-pin';
          state.pinModeStopId = null;
          markDirty('📍 Pin dropped');
          toast('Pin dropped — re-optimize to re-route');
        }
      });
    }
    setTimeout(() => { mapObj.invalidateSize(); refreshMap(); }, 50);
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
    const pts = state.stops.filter((s) => s.lat != null);
    if (state.origin.lat != null) pts.unshift({ lat: state.origin.lat, lng: state.origin.lng, _origin: true });
    pts.forEach((s, i) => {
      const cls = 'pin-num' + (s.isLast ? ' last' : '') + (s.done ? ' done' : '');
      const label = s._origin ? '📍' : (s.isLast ? '🏁' : String(i + (state.origin.lat != null ? 0 : 1)));
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: '<div class="' + cls + '">' + esc(label) + '</div>', iconSize: [28, 28] }),
      }).addTo(mapObj);
      if (!s._origin) m.bindPopup(esc(stopLabel(s)));
      mapLayers.push(m);
    });
    const line = pts.filter((p) => !p._origin || true);
    if (line.length > 1) {
      const pl = L.polyline(line.map((p) => [p.lat, p.lng]), { color: '#7c5cff', weight: 4 }).addTo(mapObj);
      mapLayers.push(pl);
    }
    if (pts.length) mapObj.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.15));
  }

  /* ---------- settings ---------- */
  $('settingsBtn').onclick = () => {
    $('setStart').value = settings.defaultStart;
    $('setTolls').checked = settings.avoidTolls;
    $('setHwy').checked = settings.avoidHwy;
    $('setReturn').checked = settings.returnToStart;
    $('setHistory').checked = settings.saveHistory;
    $('settingsSheet').hidden = false;
  };
  $('settingsClose').onclick = () => {
    settings.defaultStart = $('setStart').value.trim();
    settings.avoidTolls = $('setTolls').checked;
    settings.avoidHwy = $('setHwy').checked;
    settings.returnToStart = $('setReturn').checked;
    settings.saveHistory = $('setHistory').checked;
    save();
    if (settings.defaultStart && state.origin.type === 'gps' && !state.origin.lat) {
      state.origin = { type: 'address', label: settings.defaultStart, lat: null, lng: null };
    }
    $('settingsSheet').hidden = true;
    render();
  };
  $('clearRoute').onclick = () => {
    if (!confirm('Clear all stops and reset the route?')) return;
    state.stops = []; state.optimized = false; state.matrixSource = null;
    save(); render();
    $('settingsSheet').hidden = true;
    toast('Route cleared');
  };

  /* ---------- boot ---------- */
  load();
  if (!loadSharedRoute()) render();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
