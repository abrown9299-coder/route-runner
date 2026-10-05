/* RouteRunner app.js — UI wiring. Pure-algorithm work lives in core.js (window.RouteCore). */
/* global RouteCore: readonly */
(function () {
  'use strict';
  // Stamped by deploy.py. If this ever disagrees with the index.html meta
  // version at boot, the JS is stale and we force a clean reload.
  const RR_BUILD = '20261005-040202';
  const $ = (id) => document.getElementById(id);
  const LS_ROUTE = 'rr.route.v1', LS_SET = 'rr.settings.v1', LS_HIST = 'rr.history.v1';
  const LS_TRAFFIC = 'rr.traffic.learn.v1';

  const state = {
    stops: [],           // display order = route order
    origin: { type: 'gps', label: 'Current location', lat: null, lng: null },
    tripStart: null,     // {label, lat, lng} | null — pinned Start row. Null = auto from GPS at optimize time.
    tripEnd: null,       // {label, lat, lng} | null — pinned End row. Null = skipped silently on optimize.
    optimized: false,
    matrixSource: null,  // 'osrm' | 'haversine'
    pinModeStopId: null,
    preEstimateMin: 0,   // rough haversine drive estimate, pre-optimization
    preDriveMin: null,   // real OSRM drive time for current order (verified in background)
    preDriveSource: null, // 'osrm' when preDriveMin is a real routed time
    lastEstimate: null,  // {beforeMin, afterMin, savedMin, source} post-optimization
    geocoding: false,    // background geocode in flight
    geocodeStatus: '',
    warnSuppressed: false, // "don't warn me again" for at-risk windows, per route
    lastSchedule: null,  // {at, arrivals: {stopId: arrivalMin}} from last optimize
    checkedIn: null,     // {stopId, startedAt} — currently being serviced (v1.9)
    returnActive: false, // return-to-start was baked into the current optimization
    endActive: false, // default end address was baked into the current optimization
    completedAt: null,   // timestamp when the last stop was marked done (auto-delete next day)
    locationPrecision: 'unknown', // 'precise' | 'approximate' | 'unknown' — from GPS accuracy
  };
  const settings = {
    defaultStart: '', defaultEnd: '', avoidTolls: false, avoidHwy: false,
    returnToStart: false, saveHistory: false, autoCheckin: false, autoConfirmAll: false, mode: 'work', // 'work' | 'personal'
    serviceTimes: { default: 45, byJobType: {}, known: [] },
    earlySuggest: true, // suggest early-arrival swaps that save drive time
    homeLocation: null, // {city, state, lat, lng} — user's base area for geocode bias. Null = not set yet.
    savedLocations: [], // [{name, address, lat, lng}] — starred saved places
    customJobTypes: [], // user-added job types for the appointment dialog
  };
  const isWorkMode = () => settings.mode !== 'personal';

  /* ---------- persistence ---------- */
  function save() {
    try {
      localStorage.setItem(LS_ROUTE, JSON.stringify({
        stops: state.stops, origin: state.origin,
        tripStart: state.tripStart, tripEnd: state.tripEnd,
        optimized: state.optimized, matrixSource: state.matrixSource,
        preEstimateMin: state.preEstimateMin, lastEstimate: state.lastEstimate,
        preDriveMin: state.preDriveMin, preDriveSource: state.preDriveSource,
        warnSuppressed: state.warnSuppressed, lastSchedule: state.lastSchedule,
        checkedIn: state.checkedIn, returnActive: state.returnActive,
        endActive: state.endActive,
        completedAt: state.completedAt,
      }));
      localStorage.setItem(LS_SET, JSON.stringify(settings));
    } catch { /* storage full/blocked — app still works for the session */ }
  }
  function load() {
    try {
      const rawSettings = localStorage.getItem(LS_SET);
      const s = JSON.parse(rawSettings || 'null');
      if (s) {
        // Forward-migration across updates: keep stored values only for
        // settings this version still defines, and only when the type still
        // matches. Removed or re-typed settings fall back to defaults
        // instead of leaking stale values into new logic.
        for (const k of Object.keys(settings)) {
          if (s[k] !== undefined && typeof s[k] === typeof settings[k]) settings[k] = s[k];
        }
        if (settings.mode !== 'work' && settings.mode !== 'personal') settings.mode = 'work';
      }
      // Home location: optional manual override only. GPS is the source of
      // truth — never default to any city, never prompt. If a stored value
      // is malformed, fall back to null (unbiased).
      var hl = settings.homeLocation;
      var hlValid = hl && typeof hl === 'object' &&
        typeof hl.city === 'string' && hl.city.trim() &&
        typeof hl.state === 'string' && hl.state.trim();
      if (!hlValid) {
        settings.homeLocation = null;
      }
      const r = JSON.parse(localStorage.getItem(LS_ROUTE) || 'null');
      if (r) {
        state.stops = r.stops || [];
        state.origin = r.origin || state.origin;
        state.tripStart = RouteCore.normalizeEndpoint(r.tripStart);
        state.tripEnd = RouteCore.normalizeEndpoint(r.tripEnd);
        state.optimized = !!r.optimized;
        state.completedAt = r.completedAt || null;
        // auto-delete: a route completed on a previous calendar day is wiped
        if (state.completedAt && !isSameDay(state.completedAt, Date.now()) &&
            state.stops.length && state.stops.every((x) => x.done)) {
          wipeRouteData();
          state.stops = [];
          state.completedAt = null;
          state.optimized = false;
          state.lastSchedule = null;
          state.returnActive = false; state.endActive = false;
          state.checkedIn = null;
        }
        state.matrixSource = r.matrixSource || null;
        state.preEstimateMin = r.preEstimateMin || 0;
        state.preDriveMin = (r.preDriveMin != null) ? r.preDriveMin : null;
        state.preDriveSource = r.preDriveSource || null;
        state.lastEstimate = r.lastEstimate || null;
        state.warnSuppressed = !!r.warnSuppressed;
        state.checkedIn = null;
        if (r.checkedIn && r.checkedIn.stopId != null && r.checkedIn.startedAt) {
          const cs = state.stops.find((x) => x.id === r.checkedIn.stopId);
          if (cs && !cs.done &&
              RouteCore.remainingServiceMin(serviceMinFor(cs), r.checkedIn.startedAt, Date.now()) > 0) {
            state.checkedIn = { stopId: r.checkedIn.stopId, startedAt: r.checkedIn.startedAt };
          }
        }
        if (r.checkedIn && !state.checkedIn) save(); // persist dropping a stale check-in
        state.lastSchedule = r.lastSchedule || null;
        state.returnActive = !!r.returnActive;
        state.endActive = !!r.endActive;
      }
    } catch {}
    /* sanitize service-time settings (forward-migration safe) */
    try {
      const st = settings.serviceTimes || {};
      settings.serviceTimes = {
        default: (typeof st.default === 'number' && st.default >= 15 && st.default <= 480) ? st.default : 45,
        byJobType: (st.byJobType && typeof st.byJobType === 'object') ? st.byJobType : {},
        known: Array.isArray(st.known) ? st.known.filter((x) => typeof x === 'string').slice(0, 60) : [],
      };
      Object.keys(settings.serviceTimes.byJobType).forEach((k) => {
        const v = settings.serviceTimes.byJobType[k];
        if (typeof v !== 'number' || v < 15 || v > 480) delete settings.serviceTimes.byJobType[k];
      });
    } catch {
      settings.serviceTimes = { default: 45, byJobType: {}, known: [] };
    }
    if (settings.defaultStart && state.origin.type === 'gps' && !state.origin.lat) {
      state.origin = { type: 'address', label: settings.defaultStart, lat: null, lng: null };
    }
    // Sanitize saved locations and custom job types (forward-migration safe).
    try {
      settings.savedLocations = (Array.isArray(settings.savedLocations) ? settings.savedLocations : [])
        .filter((s) => s && typeof s === 'object' && typeof s.name === 'string')
        .slice(0, 100)
        .map((s) => ({
          name: String(s.name).trim().slice(0, 120),
          address: String(s.address || '').trim().slice(0, 300),
          lat: typeof s.lat === 'number' && isFinite(s.lat) ? s.lat : null,
          lng: typeof s.lng === 'number' && isFinite(s.lng) ? s.lng : null,
        }));
      settings.customJobTypes = (Array.isArray(settings.customJobTypes) ? settings.customJobTypes : [])
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => String(t).trim().slice(0, 80))
        .slice(0, 60);
    } catch {
      settings.savedLocations = [];
      settings.customJobTypes = [];
    }
  }

  /* ---------- helpers ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function isSameDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() &&
           da.getMonth() === db.getMonth() &&
           da.getDate() === db.getDate();
  }
  function wipeRouteData() {
    // erase all route traces from the device (auto-delete or manual clear)
    try {
      localStorage.removeItem(LS_ROUTE);
      localStorage.removeItem('rr.route.backup');
      localStorage.removeItem(LS_HIST);
    } catch {}
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- install gate (v1.9.2): the app must run installed ----------
   * The inline script in index.html already showed #installGate when not
   * standalone; here we fill in the platform-specific steps. There is no
   * dismiss — the gate stays until the app is opened from the home screen. */
  (function installGateSteps() {
    let standalone = false, isMobile = false;
    try {
      standalone = window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;
      const ua = String(navigator.userAgent || '');
      isMobile = /iPad|iPhone|iPod|Android/i.test(ua) ||
                 (navigator.maxTouchPoints > 1 && /Mac/i.test(ua));
    } catch {}
    // desktop browsers are exempt — the gate is for phones only
    if (standalone || !isMobile) return;
    const ua = String(navigator.userAgent || '');
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);
    const steps = isIOS ? [
      'Tap the Share button at the bottom of Safari (the box with an arrow pointing up).',
      'Scroll down and tap "Add to Home Screen".',
      'Tap "Add" in the top-right corner.',
      'Open RouteRunner from your home screen — you only have to do this once.',
    ] : isAndroid ? [
      'Tap the ⋮ menu in the top-right corner of the browser.',
      'Tap "Install app" (or "Add to Home screen").',
      'Open RouteRunner from your home screen — you only have to do this once.',
    ] : [
      'Open this page on your phone.',
      'iPhone: Share → Add to Home Screen. Android: ⋮ menu → Install app.',
      'Open RouteRunner from your home screen — you only have to do this once.',
    ];
    const box = $('installSteps');
    if (box) box.innerHTML = steps.map((s) => '<li>' + esc(s) + '</li>').join('');
    const gate = $('installGate');
    if (gate) gate.hidden = false; // belt-and-braces: the inline script should have shown it already
  })();
  function stopLabel(s) {
    const a = [s.street, s.city, s.state && s.zip ? s.state + ' ' + s.zip : (s.state || s.zip)]
      .filter(Boolean).join(', ').replace(/,(\s*,)+/g, ',').trim();
    if (a) return a;
    if (s.lat != null && s.lng != null) return s.lat.toFixed(5) + ',' + s.lng.toFixed(5);
    return 'Unknown address';
  }

  /* ---------- service times (v1.9) ---------- */
  const SVC_MIN = 15, SVC_MAX = 180, SVC_STEP = 5, SVC_DEFAULT = 45;
  function serviceMinFor(s) {
    if (!isWorkMode()) return 0; // personal mode: ETAs are pure drive time
    const st = settings.serviceTimes;
    const jt = s && s.jobType ? String(s.jobType) : '';
    if (jt && st.byJobType[jt] != null) return st.byJobType[jt];
    return st.default || SVC_DEFAULT;
  }
  /* Learn job types over time so each can get its own service duration. */
  function collectJobTypes(stops) {
    const st = settings.serviceTimes;
    let changed = false;
    (stops || []).forEach((s) => {
      const jt = s && s.jobType ? String(s.jobType).trim() : '';
      if (jt && st.known.indexOf(jt) === -1 && st.known.length < 60) {
        st.known.push(jt); changed = true;
      }
    });
    return changed;
  }
  /* Departure for schedule math: right now, unless checked into a stop — then
   * departures begin when the remaining service time runs out. */
  function departMinForOpt() {
    const n = new Date();
    let depart = n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60;
    const ci = state.checkedIn;
    if (ci) {
      const s = state.stops.find((x) => x.id === ci.stopId);
      if (s && !s.done) {
        depart += RouteCore.remainingServiceMin(serviceMinFor(s), ci.startedAt, Date.now());
      }
    }
    return depart;
  }
  function fmtWindow(s) {
    if (s.twStart == null || s.twEnd == null) return '';
    return RouteCore.formatClock(s.twStart) + '–' + RouteCore.formatClock(s.twEnd);
  }
  function markDirty(msg) {
    state.optimized = false; state.matrixSource = null;
    state.lastEstimate = null;
    state.preDriveMin = null; state.preDriveSource = null;
    state.returnActive = false; state.endActive = false;
    // refresh the rough pre-optimization estimate from whatever is located
    const pts = locatedPoints();
    state.preEstimateMin = pts.length > 1 ? RouteCore.estimateMinutesHaversine(pts) : 0;
    save(); render();
    schedulePreDriveTime(); // upgrade the guess to a real drive time in background
    if (msg) toast(msg);
  }

  /* Verify the real drive time for the current stop order in the background
   * (debounced so rapid edits collapse into one routing call). Replaces the
   * haversine guess once the OSRM duration matrix arrives. */
  let preDriveTimer = null, preDriveToken = 0;
  function schedulePreDriveTime() {
    if (preDriveTimer) clearTimeout(preDriveTimer);
    preDriveTimer = setTimeout(refreshPreDriveTime, 2000);
  }
  async function refreshPreDriveTime() {
    preDriveTimer = null;
    if (state.optimized) return;
    const pts = locatedPoints();
    if (pts.length < 2) return;
    const my = ++preDriveToken;
    try {
      const r = await RouteCore.buildDurationMatrix(pts, fetch.bind(window));
      if (my !== preDriveToken || state.optimized) return; // superseded
      if (r.source !== 'osrm') return; // haversine fallback adds nothing new
      state.preDriveMin = RouteCore.routeMinutesForOrder(
        r.matrix, pts.map((_, i) => i), 'osrm');
      state.preDriveSource = 'osrm';
      save(); render();
    } catch { /* keep the rough estimate */ }
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

  /* ---------- start/end pinned rows (spec §1) ---------- */
  // Auto-fill label from GPS when the endpoint is unset.
  function endpointDisplay(which) {
    const ep = which === 'start' ? state.tripStart : state.tripEnd;
    const norm = RouteCore.normalizeEndpoint(ep);
    if (norm) return norm;
    // Fall back to live GPS for the Start row only.
    if (which === 'start' && devicePos) {
      return { label: 'Current location', lat: devicePos.lat, lng: devicePos.lng };
    }
    return null;
  }
  function renderEndpointRows(ul) {
    [['start', '▶', 'Start'], ['end', '■', 'End']].forEach(([which, icon, word]) => {
      const disp = endpointDisplay(which);
      const saved = disp && RouteCore.isSavedLocation(settings.savedLocations, disp);
      const li = document.createElement('li');
      li.className = 'stop endpoint-row' + (which === 'end' ? ' end-row' : '');
      li.dataset.endpoint = which;
      li.innerHTML =
        '<span class="num">' + icon + '</span>' +
        '<div class="info"><div class="addr">' + esc(disp ? disp.label : word + ' — not set') + '</div>' +
        '<div class="meta"><span class="chip">' + (which === 'start' ? '▶ start' : '■ end') + '</span>' +
        (disp && disp.lat == null ? '<span class="chip warn">📍 no location</span>' : '') +
        '</div></div>' +
        '<div class="acts">' +
          '<button class="star-btn' + (saved ? ' on' : '') + '" data-act="star-endpoint" data-which="' + which + '" title="' +
            (saved ? 'Unsave this location' : 'Save this location') + '">' + (saved ? '⭐' : '☆') + '</button>' +
          (disp ? '<button data-act="clear-endpoint" data-which="' + which + '" title="Clear">✕</button>' : '') +
        '</div>';
      ul.appendChild(li);
    });
  }
  // Tap an endpoint row body → open the address editor sheet.
  let editingEndpoint = null; // 'start' | 'end' | null
  function openEndpointEditor(which) {
    editingEndpoint = which;
    const disp = endpointDisplay(which);
    $('epTitle').textContent = (which === 'start' ? '▶ Start location' : '■ End location');
    $('epInput').value = disp && disp.label !== 'Current location' ? disp.label : '';
    $('epInput')._ddClose && $('epInput')._ddClose();
    $('epSheet').hidden = false;
    setTimeout(() => $('epInput').focus(), 50);
    updateEpStar();
  }
  function updateEpStar() {
    const btn = $('epStar');
    const q = $('epInput').value.trim();
    const disp = editingEndpoint ? endpointDisplay(editingEndpoint) : null;
    const loc = q ? { name: q, address: q, lat: null, lng: null } : disp;
    const on = loc && RouteCore.isSavedLocation(settings.savedLocations, loc);
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? '⭐' : '☆';
    btn.title = on ? 'Unsave this location' : 'Save this location';
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
    $('listTitle').textContent = isWorkMode() ? 'Appointments' : 'Stops';
    $('clearAllBtn').style.display = total ? '' : 'none';

    const ul = $('stopList');
    ul.innerHTML = '';
    // Pinned Start / End rows (spec §1): always at the top, above stop #1.
    renderEndpointRows(ul);
    $('emptyHint').style.display = total ? 'none' : 'block';
    if (!total) {
      $('emptyHint').textContent = isWorkMode()
        ? 'No appointments yet — add screenshots of your schedule or search an address above.'
        : 'No stops yet — search an address above to add one.';
    }
    // Overall remaining drive time summary (only when we have schedule data).
    const ds = $('driveSummary');
    if (ds) {
      const sched = state.lastSchedule;
      // Belt-and-suspenders: no stops means no summary, regardless of stale schedule.
      if (!state.stops.length) ds.hidden = true;
      else if (state.optimized && sched && sched.driveTo) {
        let remaining = 0, count = 0;
        for (const s of state.stops) {
          if (!s.done && sched.driveTo[s.id] != null) {
            remaining += sched.driveTo[s.id]; count++;
          }
        }
        if (count > 0) {
          const hrs = Math.floor(remaining / 60), mins = Math.round(remaining % 60);
          const txt = hrs > 0 ? hrs + 'h ' + mins + 'm' : mins + ' min';
          ds.innerHTML = '🚗 <strong>' + txt + '</strong> driving left · ' + count + ' stop' + (count === 1 ? '' : 's') + ' to go';
          ds.hidden = false;
        } else ds.hidden = true;
      } else ds.hidden = true;
    }
    state.stops.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'stop' + (s.done ? ' done' : '') + (s.isLast ? ' is-last' : '') + (s.isFirst ? ' is-first' : '');
      li.dataset.id = s.id;
      const needsPin = s.lat == null || s.lng == null;
      const work = isWorkMode(); // personal mode hides confirmed/check-in/notes/job types
      li.innerHTML =
        '<span class="drag" title="Drag to reorder">⠿</span>' +
        '<span class="num">' + (s.isFirst ? '🚩' : (s.isLast ? '🏁' : (i + 1))) + '</span>' +
        '<div class="info"><div class="addr">' + esc(stopLabel(s)) + '</div>' +
        '<div class="meta">' +
          (work && s.jobType ? '<span class="chip">' + esc(s.jobType) + '</span>' : '') +
          (s.isFirst ? '<span class="chip first">🚩 first stop</span>' : '') +
          (s.isLast ? '<span class="chip last">🏁 last stop</span>' : '') +
          (work && s.confirmed && s.twStart != null && s.twEnd != null
            ? '<span class="chip confirm">✓ ' + esc(fmtWindow(s)) + '</span>' : '') +
          (!s.done && state.optimized && state.lastSchedule && state.lastSchedule.arrivals &&
           state.lastSchedule.arrivals[s.id] != null
            ? '<span class="chip eta">→ arr ~' + esc(RouteCore.formatClock(Math.round(state.lastSchedule.arrivals[s.id]))) + '</span>' : '') +
          (!s.done && state.optimized && state.lastSchedule && state.lastSchedule.driveTo &&
           state.lastSchedule.driveTo[s.id] != null
            ? '<span class="chip drive">🚗 ' + Math.round(state.lastSchedule.driveTo[s.id]) + ' min</span>' : '') +
          (needsPin ? '<span class="chip warn">📍 no location — tap to drop pin</span>' : '') +
          (!needsPin && s.approx ? '<span class="chip">≈ area</span>' : '') +
          (work && s.note ? '<span class="chip">📝 ' + esc(s.note) + '</span>' : '') +
          (work && !s.done
            ? (state.checkedIn && state.checkedIn.stopId === s.id
              ? '<button class="pill checkin on" data-act="checkin" title="End the service timer">⏳ In service — tap to end</button>'
              : '<button class="pill checkin" data-act="checkin" title="Start the service timer — departures wait until it finishes">▶ Check in</button>')
            : '') +
        '</div></div>' +
        '<div class="acts">' +
          (work ? '<button class="confirm-btn' + (s.confirmed ? ' on' : '') + '" data-act="confirm" title="Confirm appointment window">⏰</button>' : '') +
          (() => { const sv = RouteCore.isSavedLocation(settings.savedLocations, { address: stopLabel(s), lat: s.lat, lng: s.lng }); return '<button class="star-btn' + (sv ? ' on' : '') + '" data-act="star" title="' + (sv ? 'Unsave this location' : 'Save this location') + '">' + (sv ? '⭐' : '☆') + '</button>'; })() +
          '<button class="check-btn' + (s.done ? ' on' : '') + '" data-act="check" title="' + (s.done ? 'Reopen stop' : 'Mark done') + '">✓</button>' +
          '<button data-act="first" title="Set as first stop">🚩</button>' +
          '<button data-act="last" title="Set as last stop">🏁</button>' +
          (work ? '<button data-act="note" title="Add note">📝</button>' : '') +
          '<button data-act="del" title="Remove stop">✕</button>' +
        '</div>';
      if (needsPin) li.querySelector('.meta').style.cursor = 'pointer';
      ul.appendChild(li);
    });
    // return-to-start footer: the optimized route ends back at the origin
    if (state.returnActive && state.optimized) {
      const li = document.createElement('li');
      li.className = 'stop is-last return-row';
      li.innerHTML =
        '<span class="num">🏁</span>' +
        '<div class="info"><div class="addr">↩ Return to start</div>' +
        '<div class="meta"><span class="chip last">🏁 last stop</span></div></div>';
      ul.appendChild(li);
    }
    if (state.endActive && state.optimized) {
      const endLabel = (state.tripEnd && state.tripEnd.label) || settings.defaultEnd || '';
      if (endLabel) {
        const li = document.createElement('li');
        li.className = 'stop is-last return-row';
        li.innerHTML =
          '<span class="num">🏠</span>' +
          '<div class="info"><div class="addr">' + esc(endLabel) + '</div>' +
          '<div class="meta"><span class="chip last">🏠 home</span></div></div>';
        ul.appendChild(li);
      }
    }

    // status line
    const st = $('routeStatus');
    const unlocated = state.stops.filter((s) => s.lat == null).length;
    const approx = state.stops.filter((s) => s.lat != null && s.approx).length;
    if (!total) { st.textContent = ''; st.className = 'status-line'; }
    else if (state.geocoding && !state.optimized) {
      st.textContent = state.geocodeStatus || 'Locating addresses…';
      st.className = 'status-line warn';
    }
    else if (!state.optimized) {
      if (state.preDriveSource === 'osrm' && state.preDriveMin > 0) {
        st.textContent = 'Est. drive ≈ ' + RouteCore.formatMins(state.preDriveMin) +
          ' (drive time) — tap ⚡ Optimize when ready.';
      } else {
        st.textContent = state.preEstimateMin > 0
          ? 'Est. drive ≈ ' + RouteCore.formatMins(state.preEstimateMin) +
            ' (rough, no traffic) — tap ⚡ Optimize when ready.'
          : 'Not optimized yet — tap ⚡ Optimize when ready.';
      }
      st.className = 'status-line warn';
    } else {
      const e = state.lastEstimate;
      let t = (state.matrixSource === 'osrm' ? 'Optimized by drive time'
          : 'Optimized by straight-line distance') + ' · ' + total + ' stops';
      if (e && e.afterMin > 0) {
        t += ' · ≈' + RouteCore.formatMins(e.afterMin);
        if (e.savedMin >= 1) t += ' · saves ~' + RouteCore.formatMins(e.savedMin) + ' vs original';
      }
      if (approx) t += ' · ' + approx + ' approx. area';
      if (unlocated) t += ' · ' + unlocated + ' need a pin';
      st.textContent = t;
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
    // Pinned start/end rows (spec §1): handled separately from stops.
    if (li.dataset.endpoint) {
      const which = li.dataset.endpoint;
      const act = btn ? btn.dataset.act : null;
      if (act === 'star-endpoint') {
        const disp = endpointDisplay(which);
        const loc = disp ? { name: disp.label, address: disp.label, lat: disp.lat, lng: disp.lng }
                         : { name: which === 'start' ? 'Start' : 'End', address: '', lat: null, lng: null };
        const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
        settings.savedLocations = r.saved;
        save(); render();
        toast(r.added ? '⭐ Saved "' + loc.name + '"' : '☆ Unsaved');
        return;
      }
      if (act === 'clear-endpoint') {
        if (which === 'start') state.tripStart = null; else state.tripEnd = null;
        markDirty(which === 'start' ? 'Start cleared — will use GPS' : 'End cleared');
        return;
      }
      // Tap body → open the address editor.
      openEndpointEditor(which);
      return;
    }
    const s = state.stops.find((x) => x.id === li.dataset.id);
    if (!s) return;
    if (!btn) { // tapped body — if needs pin, enter pin mode
      if (s.lat == null) openMapForPin(s.id);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'check') {
      s.done = !s.done;
      if (s.done && state.checkedIn && state.checkedIn.stopId === s.id) {
        state.checkedIn = null; // service finished with the stop
      }
      // Departure: start tracking the drive to the next stop for traffic learning.
      if (s.done) {
        const next = state.stops.find((x) => !x.done && x.lat != null);
        if (next) {
          // free-flow estimate from the last schedule, if available
          const ff = (state.lastSchedule && state.lastSchedule.driveTo &&
            state.lastSchedule.driveTo[next.id]) || 15;
          startLegTracking(next, ff);
        }
      } else {
        legTrack = null; // reopened — discard the leg
      }
      // track completion: all stops done -> auto-delete next day
      if (state.stops.length && state.stops.every((x) => x.done)) {
        state.completedAt = Date.now();
      } else {
        state.completedAt = null;
      }
      save(); render();
      if (s.done) maybeAutoReopt('done'); // fresh times + re-route around confirmed windows
    }
    else if (act === 'confirm') {
      openWindowPopup(s); // new or edit: popup offers confirm/update/remove
    }
    else if (act === 'star') {
      const loc = {
        name: stopLabel(s), address: stopLabel(s),
        lat: typeof s.lat === 'number' ? s.lat : null,
        lng: typeof s.lng === 'number' ? s.lng : null,
      };
      // Confirm unsave when the route is optimized (location is in active use).
      if (RouteCore.isSavedLocation(settings.savedLocations, loc) && state.optimized) {
        if (!confirm('Unsave "' + loc.name + '"?')) return;
      }
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); render();
      toast(r.added ? '⭐ Saved' : '☆ Unsaved');
    }
    else if (act === 'checkin') {
      const ci = state.checkedIn;
      if (ci && ci.stopId === s.id) {
        state.checkedIn = null;
        // Ending the service timer completes the stop, same as the checkmark.
        if (!s.done) {
          s.done = true;
          toast('✅ Service done — on to the next stop');
          if (state.stops.length && state.stops.every((x) => x.done)) {
            state.completedAt = Date.now();
          }
        } else {
          toast('Service timer stopped');
        }
      } else {
        // one active service at a time: checking in here ends any other
        // Arrival: end the tracked leg (traffic learning).
        endLegTracking(s.id);
        state.checkedIn = { stopId: s.id, startedAt: Date.now() };
        toast('⏳ Checked in — ' + serviceMinFor(s) + ' min service timer running');
      }
      save(); render();
      maybeAutoReopt('checkin'); // departure moved: re-route around it
    }
    else if (act === 'first') {      state.stops.forEach((x) => { if (x !== s) x.isFirst = false; });
      s.isFirst = !s.isFirst;
      if (s.isFirst) s.isLast = false; // a stop can't be both first and last
      markDirty(s.isFirst ? '🚩 will be routed first' : 'First-stop pin removed');
    }
    else if (act === 'last') {
      state.stops.forEach((x) => { if (x !== s) x.isLast = false; });
      s.isLast = !s.isLast;
      if (s.isLast) s.isFirst = false; // a stop can't be both first and last
      markDirty(s.isLast ? '🏁 will be routed last' : 'Last-stop pin removed');
    }
    else if (act === 'note') {
      const n = prompt('Note for this stop:', s.note || '');
      if (n !== null) { s.note = n.trim(); save(); render(); }
    }
    else if (act === 'del') {
      if (state.checkedIn && state.checkedIn.stopId === s.id) state.checkedIn = null;
      const idx = state.stops.indexOf(s);
      state.stops.splice(idx, 1);
      // Last stop deleted: full cleanup so no stale schedule/summary survives.
      // (The drive summary must disappear when the route is empty.)
      if (!state.stops.length) {
        state.optimized = false;
        state.matrixSource = null;
        state.lastEstimate = null;
        state.preEstimateMin = 0;
        state.preDriveMin = null; state.preDriveSource = null;
        state.lastSchedule = null;
        state.returnActive = false; state.endActive = false;
        state.geocoding = false;
        state.geocodeStatus = '';
        state.pinModeStopId = null;
        geocodeInflight = null;
        state.warnSuppressed = false;
        wipeRouteData();
      }
      markDirty();
      toast('Stop removed', { label: 'Undo', fn: () => {
        state.stops.splice(Math.min(idx, state.stops.length), 0, s);
        markDirty();
      }});
    }
  });

  // drag reorder (touch-friendly via SortableJS)
  if (typeof Sortable !== 'undefined') {
    new Sortable($('stopList'), {
    handle: '.drag', animation: 150, delay: 120, delayOnTouchOnly: true,
    onEnd: () => {
      const order = [...$('stopList').children].map((li) => li.dataset.id);
      state.stops.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      markDirty('Order updated — re-optimize to re-route');
    },
    });
  }

  /* ---------- confirmed-stop time window popup (v1.9) ---------- */
  let winStopId = null;
  function minToInput(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function inputToMin(v) {
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }
  function plannedArrivalMin(s) {
    if (s.apptMin != null) return s.apptMin; // the appointment's original time
    const arr = state.lastSchedule && state.lastSchedule.arrivals;
    if (arr && arr[s.id] != null) return Math.round(arr[s.id]);
    return null;
  }
  function openWindowPopup(s) {
    winStopId = s.id;
    $('winAddr').textContent = stopLabel(s);
    if (s.confirmed && s.twStart != null && s.twEnd != null) {
      // editing an existing window: start from its current times
      $('winStart').value = minToInput(s.twStart);
      $('winEnd').value = minToInput(s.twEnd);
      $('winOk').textContent = '✓ Update window';
      $('winRemove').hidden = false;
    } else {
      // New window: prefer the screenshot's appointment time if we have one,
      // otherwise fall back to planned arrival. Always a 2-hour window.
      let start = s.apptMin != null ? s.apptMin : plannedArrivalMin(s);
      if (start == null) {
        const n = new Date();
        start = Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 15) * 15 % 1440;
      }
      $('winStart').value = minToInput(start);
      $('winEnd').value = minToInput(start + 120); // auto: 2-hour window
      $('winOk').textContent = '✓ Confirm window';
      $('winRemove').hidden = true;
    }
    $('winSheet').hidden = false;
  }
  /* Editing the start keeps a 2-hour window (end follows the start);
   * editing the end is free — it may be shorter or longer than 2 hours. */
  $('winStart').onchange = () => {
    const st = inputToMin($('winStart').value);
    if (st != null) $('winEnd').value = minToInput(st + 120);
  };
  function closeWindowPopup() {
    winStopId = null;
    $('winSheet').hidden = true;
  }
  $('winCancel').onclick = closeWindowPopup;
  $('winRemove').onclick = () => {
    const s = state.stops.find((x) => x.id === winStopId);
    if (s) {
      s.confirmed = false; s.twStart = null; s.twEnd = null;
      save(); render();
      toast('Window removed — stop can be scheduled anytime');
      maybeAutoReopt('window');
    }
    closeWindowPopup();
  };
  $('winOk').onclick = () => {
    const s = state.stops.find((x) => x.id === winStopId);
    if (!s) { closeWindowPopup(); return; }
    const st = inputToMin($('winStart').value), en = inputToMin($('winEnd').value);
    if (st == null || en == null) { toast('Pick a start and end time'); return; }
    if (en <= st) { toast('End time must be after start time'); return; }
    const was = s.confirmed;
    s.confirmed = true; s.twStart = st; s.twEnd = en;
    closeWindowPopup();
    save(); render();
    toast((was ? '✓ Window updated ' : '✓ Window confirmed ') +
      RouteCore.formatClock(st) + '–' + RouteCore.formatClock(en));
    maybeAutoReopt('window'); // re-route now around the new constraint
  };

  /* ---------- at-risk warning popup (v1.9) ---------- */
  function showRiskWarning(risks) {
    if (!risks.length || state.warnSuppressed) return;
    const ul = $('riskList');
    ul.innerHTML = '';
    risks.forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="addr">' + esc(stopLabel(r.stop)) + '</div>' +
        '<div class="meta">arr ~' + esc(RouteCore.formatClock(r.arrivalMin)) +
        ' · window ' + esc(RouteCore.formatClock(r.winStart)) + '–' + esc(RouteCore.formatClock(r.winEnd)) +
        ' <span class="chip warn">may miss</span></div>';
      ul.appendChild(li);
    });
    $('riskMute').checked = false;
    $('riskSheet').hidden = false;
  }
  $('riskOk').onclick = () => {
    if ($('riskMute').checked) {
      state.warnSuppressed = true; // resets on new route / route reset
      save();
    }
    $('riskSheet').hidden = true;
  };

  /* ---------- add: search ---------- */
  /* Geocode query suffix: GPS is the source of truth — when we have a fix,
   * no city suffix is needed (coordinate bias handles it). The optional
   * homeLocation override still appends its city for disambiguation. */
  function homeSuffix() {
    if (devicePos) return '';
    return RouteCore.geocodeSuffix(settings.homeLocation);
  }
  /* Photon API bias params: GPS fix first, then homeLocation override,
   * then no bias. Never hardcoded. */
  function photonBiasParams() {
    const src = devicePos || settings.homeLocation;
    const b = RouteCore.photonBias(src);
    return b ? '&lat=' + b.lat.toFixed(4) + '&lon=' + b.lon.toFixed(4) : '';
  }
  /* Search box: universal dropdown (saved locations first, then live search).
   * Selecting an address opens the Add Appointment dialog with the address
   * pre-filled — it never adds a stop directly. */
  function onSearchPick(v) {
    $('searchInput').value = '';
    openApptDialog(v);
  }
  attachAddressDropdown('searchInput', 'suggestList', 'searchWrap', onSearchPick);

  /* ---------- add: manual form ---------- */
  // NOTE: the old inline manualForm is kept hidden for backwards compat.
  // The Add Appointment dialog is now opened by selecting an address from
  // the search bar (openApptDialog), not by a standalone button.

  /* ---------- add appointment dialog (spec §5) ---------- */
  let apptPicked = null; // {label, street, city, state, zip, lat, lng} from dropdown
  function openApptDialog(pick) {
    const work = isWorkMode();
    $('apptTitle').textContent = work ? '➕ Add Appointment' : '➕ Add Stop';
    $('apptSave').textContent = work ? 'Add Appointment' : 'Add Stop';
    $('apptJobRow').style.display = work ? '' : 'none';
    $('apptTime').value = '';
    $('apptAnytime').checked = false;
    $('apptTime').disabled = false;
    if (pick) {
      $('apptAddr').value = pick.label || '';
      apptPicked = pick;
    } else {
      $('apptAddr').value = '';
      apptPicked = null;
    }
    $('apptNewJobWrap').hidden = true;
    $('apptNewJob').value = '';
    refreshApptJobTypes();
    updateApptStar();
    $('apptAddr')._ddClose && $('apptAddr')._ddClose();
    $('apptSheet').hidden = false;
    setTimeout(() => $('apptAddr').focus(), 50);
  }
  function refreshApptJobTypes() {
    const sel = $('apptJob');
    const types = RouteCore.collectAllJobTypes(
      settings.serviceTimes.known, settings.customJobTypes, state.stops);
    sel.innerHTML = '<option value="">— No type —</option>' +
      types.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('') +
      '<option value="__new__">＋ Add new type…</option>';
  }
  function updateApptStar() {
    const btn = $('apptStar');
    const q = $('apptAddr').value.trim();
    const loc = apptPicked
      ? { name: apptPicked.label, address: apptPicked.label, lat: apptPicked.lat, lng: apptPicked.lng }
      : (q ? { name: q, address: q, lat: null, lng: null } : null);
    const on = loc && RouteCore.isSavedLocation(settings.savedLocations, loc);
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? '⭐' : '☆';
  }
  // Wire the address dropdown once (idempotent).
  let apptDdWired = false;
  function wireApptDialog() {
    if (apptDdWired) return;
    apptDdWired = true;
    attachAddressDropdown('apptAddr', 'apptAddrSuggest', 'apptAddrWrap', (v) => {
      $('apptAddr').value = v.label;
      apptPicked = v;
      updateApptStar();
    });
    $('apptAddr').addEventListener('input', () => {
      if (apptPicked && $('apptAddr').value.trim() !== apptPicked.label) apptPicked = null;
      updateApptStar();
    });
    $('apptAnytime').addEventListener('change', () => {
      $('apptTime').disabled = $('apptAnytime').checked;
      if ($('apptAnytime').checked) $('apptTime').value = '';
    });
    $('apptJob').addEventListener('change', () => {
      $('apptNewJobWrap').hidden = $('apptJob').value !== '__new__';
      if ($('apptJob').value === '__new__') setTimeout(() => $('apptNewJob').focus(), 50);
    });
    $('apptNewJobAdd').onclick = () => {
      const name = $('apptNewJob').value.trim();
      if (!name) { toast('Enter a job type name'); return; }
      settings.customJobTypes = RouteCore.addCustomJobType(settings.customJobTypes, name);
      save();
      refreshApptJobTypes();
      $('apptJob').value = name;
      $('apptNewJobWrap').hidden = true;
      $('apptNewJob').value = '';
      toast('Job type added');
    };
    $('apptStar').onclick = () => {
      const q = $('apptAddr').value.trim();
      const loc = apptPicked
        ? { name: apptPicked.label, address: apptPicked.label, lat: apptPicked.lat, lng: apptPicked.lng }
        : (q ? { name: q, address: q, lat: null, lng: null } : null);
      if (!loc) { toast('Enter an address first'); return; }
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); updateApptStar(); render();
      toast(r.added ? '⭐ Saved' : '☆ Unsaved');
    };
    $('apptSave').onclick = () => {
      const addr = $('apptAddr').value.trim();
      if (!addr && !apptPicked) { toast('Enter an address'); return; }
      const work = isWorkMode();
      const anytime = $('apptAnytime').checked;
      const timeVal = $('apptTime').value;
      let apptMin = null, twStart = null, twEnd = null, confirmed = false;
      if (!anytime && timeVal) {
        apptMin = RouteCore.parseClockToMin(timeVal);
        if (work) { confirmed = true; twStart = apptMin; twEnd = apptMin + 120; }
      }
      let jobType = '';
      if (work) {
        const jv = $('apptJob').value;
        jobType = jv === '__new__' ? '' : jv;
      }
      const p = apptPicked || {};
      const s = {
        id: uid(),
        street: p.street || addr, city: p.city || '', state: p.state || '', zip: p.zip || '',
        jobType, note: '',
        lat: typeof p.lat === 'number' ? p.lat : null,
        lng: typeof p.lng === 'number' ? p.lng : null,
        geocodeSource: p.lat != null ? 'appt-dialog' : null,
        done: false, isLast: false, isFirst: false,
        confirmed, twStart, twEnd, apptMin,
        source: 'appt-dialog',
      };
      const added = addStops([s]);
      $('apptSheet').hidden = true;
      if (added) toast(work ? 'Appointment added' : 'Stop added');
    };
    const closeAppt = () => { $('apptSheet').hidden = true; };
    $('apptClose').onclick = closeAppt;
    $('apptCancel').onclick = closeAppt;
  }
  wireApptDialog();

  /* ---------- endpoint editor wiring (spec §1) ---------- */
  let epDdWired = false, epPicked = null;
  function wireEndpointEditor() {
    if (epDdWired) return;
    epDdWired = true;
    attachAddressDropdown('epInput', 'epSuggest', 'epWrap', (v) => {
      $('epInput').value = v.label;
      epPicked = v;
      updateEpStar();
    });
    $('epInput').addEventListener('input', () => { epPicked = null; updateEpStar(); });
    $('epStar').onclick = () => {
      const q = $('epInput').value.trim();
      const loc = epPicked
        ? { name: epPicked.label, address: epPicked.label, lat: epPicked.lat, lng: epPicked.lng }
        : (q ? { name: q, address: q, lat: null, lng: null } : null);
      if (!loc) { toast('Enter an address first'); return; }
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); updateEpStar(); render();
      toast(r.added ? '⭐ Saved' : '☆ Unsaved');
    };
    $('epGps').onclick = () => {
      if (!devicePos) { toast('No GPS fix yet'); return; }
      // Reverse-geocode for a human label, but keep coords regardless.
      const lat = devicePos.lat, lng = devicePos.lng;
      fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng,
        { headers: { 'Accept': 'application/json' } })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          const a = j && j.address;
          const label = a ? [(a.house_number || ''), (a.road || '')].filter(Boolean).join(' ') +
            ((a.city || a.town || a.village) ? ', ' + (a.city || a.town || a.village) : '')
            : 'Current location';
          setEndpoint(editingEndpoint, { label: label.trim() || 'Current location', lat, lng });
        })
        .catch(() => setEndpoint(editingEndpoint, { label: 'Current location', lat, lng }));
    };
    $('epSave').onclick = () => {
      const q = $('epInput').value.trim();
      if (epPicked) {
        setEndpoint(editingEndpoint, { label: epPicked.label, lat: epPicked.lat, lng: epPicked.lng });
      } else if (q) {
        // Typed but not picked from dropdown — save as unlabeled, geocode in background.
        setEndpoint(editingEndpoint, { label: q, lat: null, lng: null });
        geocodeEndpoint(editingEndpoint);
      } else {
        setEndpoint(editingEndpoint, null);
      }
    };
    $('epClose').onclick = () => { $('epSheet').hidden = true; editingEndpoint = null; };
  }
  function setEndpoint(which, ep) {
    const norm = RouteCore.normalizeEndpoint(ep);
    if (which === 'start') state.tripStart = norm; else state.tripEnd = norm;
    $('epSheet').hidden = true;
    editingEndpoint = null; epPicked = null;
    markDirty(which === 'start' ? 'Start updated' : 'End updated');
  }
  // Geocode a typed-but-unpicked endpoint address in the background.
  async function geocodeEndpoint(which) {
    const ep = which === 'start' ? state.tripStart : state.tripEnd;
    if (!ep || ep.lat != null || !ep.label) return;
    try {
      const r = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(ep.label) +
        '&limit=1' + photonBiasParams());
      const j = r.ok ? await r.json() : null;
      const f = j && j.features && j.features[0];
      if (f && f.geometry && f.geometry.coordinates) {
        const [lng, lat] = f.geometry.coordinates;
        if (which === 'start') state.tripStart = { label: ep.label, lat, lng };
        else state.tripEnd = { label: ep.label, lat, lng };
        save(); render();
      }
    } catch { /* offline — stays unlabeled */ }
  }
  wireEndpointEditor();

  $('mAdd').onclick = async () => {
    const street = $('mStreet').value.trim();
    if (!street) { toast('Enter at least a street address'); return; }
    const s = {
      id: uid(), street, city: $('mCity').value.trim(), state: $('mState').value.trim(),
      zip: $('mZip').value.trim(), jobType: $('mJob').value.trim(), note: '',
      lat: null, lng: null, geocodeSource: null, done: false, isLast: false, isFirst: false, confirmed: false, twStart: null, twEnd: null, apptMin: null, source: 'manual',
    };
    const added = addStops([s]);
    $('mStreet').value = ''; $('mZip').value = ''; $('mJob').value = '';
    toast(added > 0 ? 'Stop added — locating it now' : 'That address is already on your route');
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
          // schedule format first (work); fall back to freeform addresses
          // (notes, GPS apps) — works in both Personal and Work mode
          let parsed = RouteCore.parseOcrText(text);
          if (!parsed.length) {
            parsed = RouteCore.parseFreeformAddresses(text).map((p) => ({
              street: p.street, city: p.city, state: p.state, zip: p.zip,
              jobType: '', apptMin: null,
            }));
          }
          parsed.forEach((p) => {
            // 🔒 next to the time = confirmed appointment, always. Otherwise
            // the Work setting controls auto-confirm.
            const autoConfirm = (p.locked || settings.autoConfirmAll) && p.apptMin != null;
            all.push({
              id: uid(), street: p.street, city: p.city, state: p.state, zip: p.zip,
              jobType: p.jobType || '', note: '', lat: null, lng: null, geocodeSource: null,
              done: false, isLast: false, isFirst: false,
              confirmed: autoConfirm,
              twStart: autoConfirm ? p.apptMin : null,
              twEnd: autoConfirm ? (p.twEnd != null ? p.twEnd : p.apptMin + 120) : null,
              apptMin: (p.apptMin != null ? p.apptMin : null), source: 'ocr',
            });
          });
        } catch (err) { console.warn('OCR failed for one image', err); }
      }
      await RR_OCR.done();
    } catch {
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
    if (collectJobTypes(state.stops)) save(); // learn job types for service-time settings
    markDirty('Added ' + added + ' stop' + (added === 1 ? '' : 's') +
      (merged.removed ? ' · ' + merged.removed + ' duplicate' + (merged.removed === 1 ? '' : 's') + ' skipped' : ''));
    geocodeInBackground();
  });

  function addStops(arr) {
    if (!arr.length) return 0;
    if (state.stops.length + arr.length > 20) {
      toast('20-stop ceiling reached — remove a stop first');
      arr = arr.slice(0, 20 - state.stops.length);
      if (!arr.length) return 0;
    }
    const before = state.stops.length;
    const merged = RouteCore.dedupeStops(state.stops.concat(arr));
    state.stops = merged.stops;
    const added = state.stops.length - before;
    if (collectJobTypes(state.stops)) save(); // learn job types for service-time settings
    markDirty('Added ' + added + ' stop' + (added === 1 ? '' : 's') +
      (merged.removed ? ', ' + merged.removed + ' duplicate' + (merged.removed === 1 ? '' : 's') + ' skipped' : ''));
    geocodeInBackground();
    return added;
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

  // End coordinates for optimization (spec §1): tripEnd wins; falls back to
  // legacy settings.defaultEnd. Returns null when unset (skipped silently).
  let endCoordsCache = null, endCoordsFor = null;
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
    // Legacy fallback: settings.defaultEnd.
    const addr = (settings.defaultEnd || '').trim();
    if (!addr) return null;
    if (endCoordsCache && endCoordsFor === addr) return endCoordsCache;
    const tmp = { street: addr, city: '', state: '', zip: '' };
    const ok = await geocodeCensusOne(tmp).catch(() => false) ||
               await geocodeNominatim(tmp).catch(() => false);
    if (ok && tmp.lat != null) {
      endCoordsCache = { lat: tmp.lat, lng: tmp.lng };
      endCoordsFor = addr;
      return endCoordsCache;
    }
    return null;
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
  function startDeviceTracking() {
    if (!('geolocation' in navigator) || deviceWatchId != null) return;
    try {
      deviceWatchId = navigator.geolocation.watchPosition((pos) => {
        setDevicePosFromGps(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          pos.coords.accuracy
        );
        if (deviceDot && mapObj) deviceDot.setLatLng([devicePos.lat, devicePos.lng]);
        adoptDevicePos();
        noteLegPosition(devicePos); // traffic learning: stationary detection
      }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
    } catch {}
  }
  /* Adopt the device position as the GPS origin (once known). */
  function adoptDevicePos() {
    if (devicePos && state.origin.type === 'gps' && state.origin.lat == null) {
      state.origin.lat = devicePos.lat; state.origin.lng = devicePos.lng;
      markDirty(); // recompute pre-estimate, save, re-render — no toast
      refreshMap();
    }
  }

  /* ---------- GPS developer mode (hidden testing tool) ----------
   * Activation: 5 rapid taps on the header brand (logo/title). No visible
   * button — undiscoverable in normal use. While a virtual position is set,
   * real GPS fixes are dropped so every devicePos consumer (blue dot,
   * proximity check-in, leg tracking, origin adoption) operates on
   * simulated data. Inactive: every dev path short-circuits — production
   * behavior is untouched. Nothing here is ever written to localStorage. */
  const devMode = {
    active: false,        // panel opened via the tap sequence (enables dev writes)
    pos: null,            // {lat, lng} virtual position, or null = no override
    sim: false,           // simulation running
    simTimer: null,
    simIdx: 0,            // next waypoint index
    simWaypoints: [],     // [{lat, lng}] remaining stops in route order
  };
  const DEV_TAPS_NEEDED = 5, DEV_TAP_WINDOW_MS = 2500;
  const DEV_WALK_MPS = 1.4; // ~5 km/h walking pace (sim base speed)
  let devTapTimes = [];

  /* DEV badge: shown whenever dev mode is active, so simulated GPS is
   * never mistaken for real. Reads "SIM GPS" while an override is in
   * effect, plain "DEV" while active with no override set. */
  function devUpdateBadge() {
    const b = $('devBadge');
    if (!b) return;
    b.hidden = !devMode.active;
    b.textContent = (devMode.active && devMode.pos) ? 'DEV · SIM GPS' : 'DEV';
  }
  /* Single entry point for virtual position writes (manual set + sim tick).
   * Short-circuits when inactive: zero production behavior change. */
  function devSetPos(lat, lng) {
    if (!devMode.active) return;
    if (!isFinite(lat) || !isFinite(lng)) return;
    devMode.pos = { lat, lng };
    devicePos = { lat, lng };
    devUpdateBadge();
    const line = $('devPosLine');
    if (line) line.textContent = 'Virtual position: ' + lat.toFixed(6) + ', ' + lng.toFixed(6) +
      (devMode.sim ? ' · simulating' : '');
    if (deviceDot && mapObj) deviceDot.setLatLng([lat, lng]);
    adoptDevicePos();
    noteLegPosition(devicePos); // traffic learning: stationary detection
    // Auto check-in against the virtual position (tests the 100m radius).
    checkProximityCheckin(lat, lng, 5);
  }
  /* Real GPS fixes route through here so a background fix can't clobber an
   * active override. Inactive: identical to a plain write.
   * Also classifies location precision from the accuracy reading (Issue 2:
   * iOS "Precise Location" toggle). accuracy in meters or null. */
  function setDevicePosFromGps(p, accuracy) {
    if (devMode.active && devMode.pos) return;
    devicePos = p;
    if (accuracy !== undefined) {
      updateLocationPrecision(accuracy);
    }
  }
  /* Classify precision and show/hide the approximate-location banner.
   * Non-blocking: the app works fine on approximate fixes, just warns. */
  var precisionBannerShown = false;
  function updateLocationPrecision(accuracy) {
    var cls = RouteCore.classifyPrecision(accuracy);
    if (cls === 'unknown') return; // no reading — don't change state
    state.locationPrecision = cls;
    var banner = $('precisionBanner');
    if (cls === 'approximate') {
      if (banner) {
        banner.hidden = false;
        // Only toast once per session to avoid nagging.
        if (!precisionBannerShown) {
          precisionBannerShown = true;
          toast('Approximate location — enable Precise Location for best routing');
        }
      }
    } else if (banner) {
      banner.hidden = true;
    }
  }
  /* Dev-aware check-in: with an override active, real fixes are swapped for
   * the virtual position so auto check-in tests simulated data. Inactive:
   * behaves exactly like the original callback. */
  function checkinAtGps(pos) {
    if (devMode.active && devMode.pos) checkProximityCheckin(devMode.pos.lat, devMode.pos.lng, 5);
    else checkProximityCheckin(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
  }
  /* Remaining stops in the current route's stop order. */
  function devSimWaypoints() {
    return state.stops
      .filter((s) => !s.done && s.lat != null && s.lng != null)
      .map((s) => ({ lat: s.lat, lng: s.lng }));
  }
  /* Step `stepM` meters from `from` toward `to`; snap if within reach. */
  function devMoveToward(from, to, stepM) {
    const d = haversineM(from.lat, from.lng, to.lat, to.lng);
    if (d <= stepM) return { lat: to.lat, lng: to.lng, arrived: true };
    const R = 6371000, toRad = (x) => x * Math.PI / 180, toDeg = (x) => x * 180 / Math.PI;
    const x = toRad(to.lat - from.lat);
    const y = toRad(to.lng - from.lng) * Math.cos(toRad((from.lat + to.lat) / 2));
    const len = Math.sqrt(x * x + y * y) || 1;
    return {
      lat: from.lat + toDeg((x / len) * (stepM / R)),
      lng: from.lng + toDeg((y / len) * (stepM / R) / Math.cos(toRad(from.lat))),
      arrived: false,
    };
  }
  function devSimTick() {
    if (!devMode.sim || !devMode.pos) return;
    const mult = parseFloat($('devSpeed').value) || 10;
    const wp = devMode.simWaypoints[devMode.simIdx];
    if (!wp) { devSimStop('Simulation complete'); return; }
    const next = devMoveToward(devMode.pos, wp, DEV_WALK_MPS * mult);
    devSetPos(next.lat, next.lng);
    if (next.arrived) devMode.simIdx++;
    if (devMode.simIdx >= devMode.simWaypoints.length) { devSimStop('Simulation complete'); return; }
    const s = $('devSimStatus');
    if (s) s.textContent = 'Simulating ' + mult + '× — heading to stop ' +
      (devMode.simIdx + 1) + ' of ' + devMode.simWaypoints.length;
  }
  function devSimStart() {
    if (!devMode.active || devMode.sim) return;
    // No override yet? Promote the current (real) position to virtual first.
    if (!devMode.pos) {
      if (!devicePos) { toast('No position yet — set one manually first'); return; }
      devMode.pos = { lat: devicePos.lat, lng: devicePos.lng };
    }
    const wps = devSimWaypoints();
    if (!wps.length) { toast('No remaining stops to simulate'); return; }
    devMode.simWaypoints = wps; devMode.simIdx = 0; devMode.sim = true;
    devMode.simTimer = setInterval(devSimTick, 1000);
    devSetPos(devMode.pos.lat, devMode.pos.lng);
    const s = $('devSimStatus');
    if (s) s.textContent = 'Simulating…';
  }
  function devSimStop(msg) {
    devMode.sim = false;
    if (devMode.simTimer) { clearInterval(devMode.simTimer); devMode.simTimer = null; }
    const s = $('devSimStatus');
    if (s) s.textContent = msg || 'Simulation stopped';
    if (msg) toast(msg);
    // Redraw the route line from the final virtual position.
    if (mapObj && $('mapWrap') && !$('mapWrap').hidden) refreshMap();
  }
  /* Clear the override and hand control back to real GPS. Dev mode stays
   * enabled (badge drops back to plain "DEV") so another position can be
   * set without re-tapping. */
  function devClear() {
    devSimStop('');
    devMode.pos = null;
    devUpdateBadge();
    devicePos = null; // drop the virtual fix; a fresh real one lands below
    ensureDevicePos().then((p) => {
      if (p && deviceDot && mapObj) deviceDot.setLatLng([p.lat, p.lng]);
      adoptDevicePos();
      if (mapObj && !$('mapWrap').hidden) refreshMap();
    });
    const line = $('devPosLine');
    if (line) line.textContent = 'Virtual position: —';
    if ($('devLat')) $('devLat').value = '';
    if ($('devLng')) $('devLng').value = '';
    toast('Override cleared — real GPS restored');
  }
  function devExit() {
    devSimStop('');
    devMode.pos = null;
    devMode.active = false;
    devUpdateBadge();
    devicePos = null;
    ensureDevicePos().then((p) => {
      if (p && deviceDot && mapObj) deviceDot.setLatLng([p.lat, p.lng]);
      adoptDevicePos();
      if (mapObj && !$('mapWrap').hidden) refreshMap();
    });
    $('devSheet').hidden = true;
    toast('Dev mode off — real GPS restored');
  }
  function openDevSheet() {
    devMode.active = true;
    devUpdateBadge();
    const line = $('devPosLine');
    if (line) line.textContent = devMode.pos
      ? 'Virtual position: ' + devMode.pos.lat.toFixed(6) + ', ' + devMode.pos.lng.toFixed(6)
      : 'Virtual position: —';
    $('devSheet').hidden = false;
  }
  function wireDevMode() {
    // Hidden activation: 5 rapid taps on the header brand. No feedback per
    // tap — undiscoverable in normal use. Plain taps are no-ops otherwise.
    const brand = document.querySelector('#topbar .brand');
    if (brand) brand.addEventListener('click', () => {
      const now = Date.now();
      while (devTapTimes.length && now - devTapTimes[0] > DEV_TAP_WINDOW_MS) devTapTimes.shift();
      devTapTimes.push(now);
      if (devTapTimes.length >= DEV_TAPS_NEEDED) { devTapTimes.length = 0; openDevSheet(); }
    });
    $('devClose').onclick = () => { $('devSheet').hidden = true; };
    $('devSetPos').onclick = () => {
      const lat = parseFloat($('devLat').value), lng = parseFloat($('devLng').value);
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        toast('Enter a valid lat/lng'); return;
      }
      devSimStop(''); // a manual set cancels a running simulation
      devSetPos(lat, lng);
      if (mapObj && !$('mapWrap').hidden) refreshMap();
      toast('Virtual position set');
    };
    $('devClear').onclick = devClear;
    $('devSimStart').onclick = devSimStart;
    $('devSimStop').onclick = () => devSimStop('Simulation stopped');
    $('devExit').onclick = devExit;
  }
  wireDevMode();

  /* ---------- traffic learning: actual vs predicted drive times ----------
   * Tracks each drive leg (stop completion -> next check-in). If the device
   * sits stationary 5+ min mid-leg (gas station, restroom), the leg is
   * discarded — it doesn't reflect traffic. Clean legs feed a per-area,
   * per-time-of-day model that sharpens future estimates. */
  let legTrack = null; // {departAt, fromLat, fromLng, toLat, toLng, freeFlowMin, stationaryMs, lastPos, lastMoveAt}
  const STATIONARY_DISCARD_MS = 5 * 60 * 1000; // 5 min stopped mid-leg -> discard

  function loadTrafficLearn() {
    try {
      const raw = localStorage.getItem(LS_TRAFFIC);
      if (!raw) return { buckets: {} };
      const d = JSON.parse(raw);
      return d && d.buckets ? d : { buckets: {} };
    } catch { return { buckets: {} }; }
  }
  function saveTrafficLearn(d) {
    try { localStorage.setItem(LS_TRAFFIC, JSON.stringify(d)); } catch {}
  }
  /* ---------- weather: rain impact on drive times ---------- */
  let weatherCache = null; // {precipMm, fetchedAt}
  const WEATHER_TTL_MS = 15 * 60 * 1000; // refresh every 15 min
  async function fetchWeather() {
    try {
      // Location priority: live GPS > route origin > home location.
      // No hardcoded city fallback — if none available, skip (assume dry).
      const hl = settings.homeLocation;
      const lat = devicePos ? devicePos.lat
        : (state.origin.lat != null ? state.origin.lat
        : (hl && typeof hl.lat === 'number' ? hl.lat : null));
      const lng = devicePos ? devicePos.lng
        : (state.origin.lng != null ? state.origin.lng
        : (hl && typeof hl.lng === 'number' ? hl.lng : null));
      if (lat == null || lng == null) {
        weatherCache = { precipMm: 0, fetchedAt: Date.now() };
        return weatherCache;
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&current=precipitation&timezone=auto`;
      const r = await fetchJson(url, {}, 8000);
      const precip = r && r.current && typeof r.current.precipitation === 'number' ? r.current.precipitation : 0;
      weatherCache = { precipMm: precip, fetchedAt: Date.now() };
    } catch {
      // weather unavailable — assume dry (factor 1.0)
      weatherCache = { precipMm: 0, fetchedAt: Date.now() };
    }
    return weatherCache;
  }
  function currentRainFactor() {
    if (!weatherCache || Date.now() - weatherCache.fetchedAt > WEATHER_TTL_MS) {
      fetchWeather(); // refresh in background
      return weatherCache ? RouteCore.rainFactorFor(weatherCache.precipMm) : 1.0;
    }
    return RouteCore.rainFactorFor(weatherCache.precipMm);
  }

  /* Effective traffic factor closure for the optimizer: base pattern blended
   * with learned data (local + imported model) for this area + time,
   * multiplied by the current rain factor. */
  function makeTrafficFn() {
    const local = loadTrafficLearn();
    const imported = loadTrafficModel();
    const combined = { buckets: { ...(local.buckets || {}) } };
    if (imported && imported.buckets) {
      for (const k in imported.buckets) {
        const ib = imported.buckets[k];
        if (!ib || !ib.n || !ib.ratio) continue;
        const cb = combined.buckets[k] || { n: 0, sum: 0 };
        cb.n += ib.n;
        cb.sum += ib.ratio * ib.n;
        combined.buckets[k] = cb;
      }
    }
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const rainF = currentRainFactor();
    return (departMin, lat, lng) => {
      return RouteCore.learnedTrafficFactorAt(departMin, isWeekend, combined, lat, lng) * rainF;
    };
  }
  function startLegTracking(toStop, freeFlowMin) {
    if (!toStop || toStop.lat == null) return;
    const from = devicePos || (state.origin.lat != null ? { lat: state.origin.lat, lng: state.origin.lng } : null);
    legTrack = {
      departAt: Date.now(),
      fromLat: from ? from.lat : null, fromLng: from ? from.lng : null,
      toLat: toStop.lat, toLng: toStop.lng,
      toStopId: toStop.id,
      freeFlowMin: freeFlowMin || 0,
      rainFactor: currentRainFactor(), // normalize learning for weather
      stationaryMs: 0,
      lastPos: devicePos ? { ...devicePos } : null,
      lastPosAt: Date.now(),
      lastMoveAt: Date.now(),
    };
  }
  function noteLegPosition(pos) {
    if (!legTrack || !pos) return;
    const now = Date.now();
    if (legTrack.lastPos) {
      // haversine distance in meters
      const R = 6371000;
      const dLat = (pos.lat - legTrack.lastPos.lat) * Math.PI / 180;
      const dLng = (pos.lng - legTrack.lastPos.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(legTrack.lastPos.lat * Math.PI / 180) * Math.cos(pos.lat * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      const distM = 2 * R * Math.asin(Math.sqrt(a));
      if (distM > 50) {
        // moved significantly — reset the continuous-stationary clock.
        // Stop-and-go traffic resets; a gas station stop doesn't.
        legTrack.lastMoveAt = now;
        legTrack.stationaryMs = 0;
      } else {
        legTrack.stationaryMs = now - legTrack.lastMoveAt;
      }
    }
    legTrack.lastPos = { ...pos };
    legTrack.lastPosAt = now;
  }
  function endLegTracking(arrivedStopId) {
    if (!legTrack) return;
    const leg = legTrack;
    legTrack = null;
    try {
      // Only learn from legs that match: we arrived where we expected.
      if (arrivedStopId !== leg.toStopId) return;
      const actualMin = (Date.now() - leg.departAt) / 60000;
      // Discard: stationary 5+ min mid-leg (gas station, restroom, errand).
      if (leg.stationaryMs >= STATIONARY_DISCARD_MS) return;
      // Discard: absurd ratios (GPS glitch, forgot to check in, etc.)
      if (!leg.freeFlowMin || leg.freeFlowMin < 1) return;
      const rainF = leg.rainFactor || 1.0;
      const actualNorm = actualMin / rainF;
      const ratioNorm = actualNorm / leg.freeFlowMin;
      if (ratioNorm < 0.4 || ratioNorm > 3.0) return;
      // Normalize for weather and base traffic:
      // adjustment = (actual / rainFactor) / (free * base).
      // This keeps rainy drives from polluting the "normal" buckets.
      const departDate = new Date(leg.departAt);
      const departMin = departDate.getHours() * 60 + departDate.getMinutes();
      const isWeekend = departDate.getDay() === 0 || departDate.getDay() === 6;
      const base = RouteCore.trafficFactorAt(departMin);
      const adjustment = ratioNorm / base;
      const key = RouteCore.trafficBucketKey(departMin, isWeekend, leg.toLat, leg.toLng);
      const learn = loadTrafficLearn();
      RouteCore.recordTrafficSample(learn, key, adjustment);
      saveTrafficLearn(learn);
    } catch (e) { console.warn('traffic learn failed', e); }
  }

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
    // stops: Census batch -> ArcGIS -> Nominatim -> suffix retry -> ZIP area
    const missing = state.stops.filter((s) => s.lat == null);
    if (missing.length) {
      statusFn('Locating ' + missing.length + ' address' +
        (missing.length === 1 ? '' : 'es') + '…');
      try { await geocodeCensusBatch(missing); } catch { /* fall through */ }
      let still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        try { await geocodeArcGIS(s); } catch {}
        await sleep(400);
      }
      still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        try { await geocodeNominatim(s); } catch {}
        await sleep(1100); // nominatim politeness
      }
      still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        const expanded = RouteCore.expandStreetSuffix(s.street || '');
        if (expanded && expanded !== s.street) {
          const q = [expanded, s.city, s.state, s.zip].filter(Boolean).join(', ');
          try { await geocodeArcGIS(s, q); } catch {}
          await sleep(400);
        }
      }
      still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        await geocodeZipApprox(s);
        await sleep(300);
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
  async function doOptimize(auto) {
    if (!state.stops.length) { if (!auto) toast('Add some stops first'); return; }
    if (optInFlight) return;
    optInFlight = true;
    const btn = $('optimizeBtn');
    btn.disabled = true;
    const setStatus = (t) => { $('routeStatus').textContent = t; $('routeStatus').className = 'status-line warn'; };
    try {
      if (geocodeInflight) {
        setStatus('Finishing locating addresses…');
        try { await geocodeInflight; } catch {}
      }
      await ensureGeocoded(setStatus);
      // Done stops stay visible for history but leave the active route.
      const active = state.stops.filter((s) => !s.done);
      const doneStops = state.stops.filter((s) => s.done);
      const located = active.filter((s) => s.lat != null);
      const unlocated = active.filter((s) => s.lat == null);
      if (!located.length) {
        toast(active.length ? 'Could not locate any addresses' : 'All stops done — nice work!');
        return;
      }
      // checked-in stop: you're AT it — finish service there, then depart from
      // it. It becomes the effective origin, never a future destination.
      const ci = state.checkedIn;
      const ciStop = ci ? located.find((s) => s.id === ci.stopId && !s.done) : null;
      const destStops = ciStop ? located.filter((s) => s.id !== ciStop.id) : located;
      const points = [{
        lat: ciStop ? ciStop.lat : state.origin.lat,
        lng: ciStop ? ciStop.lng : state.origin.lng,
        _stopId: null,
      }].concat(destStops.map((s) => ({ lat: s.lat, lng: s.lng, _stopId: s.id })));
      // origin may lack coords (GPS denied) — fall back to first stop as start
      let startIdx = 0;
      if (points[0].lat == null) { points.shift(); startIdx = -1; }
      // return-to-start: the origin becomes a pinned final destination so the
      // optimized route ends where the day began (needs origin coordinates)
      const returnPt = (settings.returnToStart && state.origin.lat != null && state.origin.lng != null)
        ? { lat: state.origin.lat, lng: state.origin.lng, _stopId: '__return' } : null;
      if (returnPt) points.push(returnPt);
      const lastStop = active.find((s) => s.isLast && s.lat != null);
      let lastIdx = lastStop ? points.findIndex((p) => p._stopId === lastStop.id) : null;
      if (returnPt) lastIdx = points.length - 1; // the return always comes last
      // End address: pinned final destination after the last stop.
      // tripEnd wins; legacy settings.defaultEnd as fallback. Skipped silently if unset.
      let endPt = null;
      const tripEndSet = !!RouteCore.normalizeEndpoint(state.tripEnd);
      if ((tripEndSet || settings.defaultEnd) && !returnPt) {
        const ec = await getEndCoords();
        if (ec) {
          endPt = { lat: ec.lat, lng: ec.lng, _stopId: '__end' };
          points.push(endPt);
          lastIdx = points.length - 1; // the end address always comes last
        }
      }
      const firstStop = active.find((s) => s.isFirst && s.lat != null);
      const firstIdx = firstStop ? points.findIndex((p) => p._stopId === firstStop.id) : null;

      setStatus('Optimizing route…');
      const beforeOrder = points.map((_, i) => i); // current (import) order
      const byStopId = Object.fromEntries(state.stops.map((s) => [s.id, s]));
      // time windows: confirmed stops only; arrival must land in [start, end-30m]
      const windows = points.map((p) => {
        const s = p._stopId ? byStopId[p._stopId] : null;
        return (s && s.confirmed && s.twStart != null && s.twEnd != null)
          ? { start: s.twStart, end: s.twEnd } : null;
      });
      const serviceMin = points.map((p) => {
        const s = p._stopId ? byStopId[p._stopId] : null;
        return s ? serviceMinFor(s) : 0;
      });
      const departMin = departMinForOpt();
      const { order, source, matrix, durMin, schedule } = await RouteCore.optimizeRouteAsync(points, {
        startIdx: Math.max(0, startIdx), firstIdx, lastIdx, fetchFn: fetch.bind(window),
        windows, serviceMin, departMin: departMin, bufferMin: 30,
        forceSchedule: !isWorkMode(), // personal mode: ETAs from pure drive time
        trafficFn: makeTrafficFn(),
      });
      // before/after from the SAME matrix: apples-to-apples savings
      const beforeMin = RouteCore.routeMinutesForOrder(matrix, beforeOrder, source);
      const afterMin = RouteCore.routeMinutesForOrder(matrix, order, source);
      const ordered = order
        .map((pi) => points[pi]._stopId)
        .filter((id) => id && byStopId[id])
        .map((id) => byStopId[id]);
      const applyOptimization = () => {
        state.lastEstimate = {
          beforeMin: beforeMin,
          afterMin: afterMin,
          savedMin: Math.max(0, beforeMin - afterMin),
          source: source,
        };
        state.preEstimateMin = 0;
        // the checked-in stop stays visible at the front (you're there now); it
        // was the effective origin, not a destination, so re-attach it here.
        // Done stops sink to the bottom — visible history, out of the route.
        state.stops = (ciStop ? [ciStop] : []).concat(ordered).concat(unlocated).concat(doneStops);
        state.optimized = true;
        lastOptAt = Date.now(); // manual optimizes count for the auto-reopt anti-spam gate
        state.matrixSource = source;
        state.returnActive = !!returnPt;
        state.endActive = !!endPt;
        // Early-arrival suggestion: check if swapping a consecutive pair to
        // arrive early (<=30 min) at the next stop would save 10+ min driving.
        // The user decides — never auto-applies.
        state.earlyOpportunity = null;
        if (settings.earlySuggest !== false && schedule && windows.some(Boolean)) {
          try {
            const simCtx = { windows, departMin, serviceMin, bufferMin: 30, trafficFn: makeTrafficFn(), pointCoords: points.map((p) => ({ lat: p.lat, lng: p.lng })) };
            const opp = RouteCore.findEarlyArrivalOpportunity(order, durMin, simCtx);
            if (opp) {
              const earlyPt = points[opp.earlyStop];
              const earlyStop = earlyPt && earlyPt._stopId ? byStopId[earlyPt._stopId] : null;
              const otherPt = points[order[opp.swapIdx]];
              const otherStop = otherPt && otherPt._stopId ? byStopId[otherPt._stopId] : null;
              if (earlyStop && otherStop) {
                state.earlyOpportunity = {
                  earlyStop, otherStop,
                  earlyByMin: opp.earlyByMin,
                  savedMin: opp.savedMin,
                  newOrder: opp.newOrder,
                };
              }
            }
          } catch (e) { console.warn('early-arrival check failed', e); }
        }
      // remember per-stop projected arrivals (popup defaults, at-risk checks)
      let risks = [];
      if (schedule) {
        const arrivals = {}, driveTo = {};
        schedule.legs.forEach((leg) => {
          const pid = points[leg.point] && points[leg.point]._stopId;
          if (pid) {
            arrivals[pid] = leg.arrivalMin;
            if (leg.driveMin != null && isFinite(leg.driveMin)) driveTo[pid] = leg.driveMin;
          }
        });
        state.lastSchedule = { at: Date.now(), arrivals, driveTo };
        risks = schedule.violations
          .map((v) => {
            const pid = points[v.point] && points[v.point]._stopId;
            const stop = pid ? byStopId[pid] : null;
            return stop ? { stop, arrivalMin: v.arrivalMin,
                            winStart: v.winStart, winEnd: v.winEnd } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.winStart - b.winStart); // earliest window first
      } else {
        state.lastSchedule = null;
      }
      save(); render();
      if (settings.saveHistory) saveHistory(source);
      if (risks.length) {
        toast(auto ? '⚠ Auto re-optimized — ' + risks.length + ' confirmed stop' +
          (risks.length === 1 ? '' : 's') + ' may miss ' +
          (risks.length === 1 ? 'its' : 'their') + ' window'
          : '⚠ Optimized — ' + risks.length + ' confirmed stop' +
          (risks.length === 1 ? '' : 's') + ' may miss ' +
          (risks.length === 1 ? 'its' : 'their') + ' window');
        showRiskWarning(risks);
      } else if (windows.some(Boolean)) {
        toast(auto ? '⚡ Auto re-optimized — all confirmed windows on track'
                   : '⚡ Optimized — all confirmed windows on track');
      } else {
        toast(source === 'osrm' ? '⚡ Optimized by drive time' : '⚡ Optimized (straight-line — offline mode)');
      }
      }; // end applyOptimization
      /* Re-opt prompt (v1.9.1): true only when the auto engine found a reorder
       * that would improve confirmed-window outcomes vs the current order. */
      const reoptKey = () => state.stops.map((s) => s.id + (s.done ? 'd' : '') +
        (s.confirmed ? `w${s.twStart}-${s.twEnd}` : '')).join(',');
      const shouldPromptReopt = () => {
        if (!windows.some(Boolean) || !schedule) return false;
        const curIds = destStops.map((s) => s.id).join(',');
        const newIds = ordered.map((s) => s.id).join(',');
        if (curIds === newIds) return false; // no reorder needed
        if (reoptDeclinedKey === reoptKey()) return false; // already said "keep as is"
        const simCtx = { windows, departMin, serviceMin, bufferMin: 30, trafficFn: makeTrafficFn(), pointCoords: points.map((p) => ({ lat: p.lat, lng: p.lng })) };
        const curSim = RouteCore.simulateSchedule(beforeOrder, durMin, simCtx);
        const late = (vs) => vs.reduce((a, v) => a + (v.lateMin || 0), 0);
        const nv = schedule.violations, cv = curSim.violations;
        return nv.length < cv.length ||
          (nv.length === cv.length && late(nv) < late(cv));
      };
      const showReoptPrompt = () => {
        const names = [];
        try {
          const simCtx = { windows, departMin, serviceMin, bufferMin: 30, trafficFn: makeTrafficFn(), pointCoords: points.map((p) => ({ lat: p.lat, lng: p.lng })) };
          const curSim = RouteCore.simulateSchedule(beforeOrder, durMin, simCtx);
          curSim.violations.slice(0, 2).forEach((v) => {
            const pid = points[v.point] && points[v.point]._stopId;
            const s = pid ? byStopId[pid] : null;
            if (s) names.push(stopLabel(s));
          });
        } catch {}
        $('reoptText').textContent = names.length
          ? `You're running behind on ${names.join(' · ')} — reordering stops could get you there on time.`
          : `You're running behind on a confirmed appointment — reordering stops could get you there on time.`;
        $('reoptSheet').hidden = false;
      };
      // v1.9.1: the auto engine asks before reordering to save a confirmed
      // window — "Re-optimizing route for confirmed appointment?" Yes / Keep as is.
      // Manual taps always apply immediately; only automatic re-orders prompt.
      if (auto && shouldPromptReopt()) {
        pendingReopt = { apply: applyOptimization, key: reoptKey() };
        showReoptPrompt();
        return;
      }
      applyOptimization();
      // Show early-arrival suggestion: manual optimizes always; auto-optimizes
      // only when a stop was just completed (the natural decision point).
      // Never more than 30 min early (enforced in findEarlyArrivalOpportunity).
      const showEarly = !auto || lastAutoReason === 'done' || lastAutoReason === 'checkin';
      if (state.earlyOpportunity && showEarly) {
        showEarlySuggestion(state.earlyOpportunity);
      }
    } catch (e) {
      console.warn(e);
      if (!auto) toast('Optimization hit a snag — try again');
      render();
    } finally {
      btn.disabled = false;
      optInFlight = false;
    }
  }

  /* Re-opt prompt state (v1.9.1): the pending reorder + the situation key the
   * user declined, so "Keep as is" isn't re-asked until something changes. */
  let pendingReopt = null, reoptDeclinedKey = null;
  $('reoptYes').onclick = () => {
    $('reoptSheet').hidden = true;
    const p = pendingReopt; pendingReopt = null;
    if (p) p.apply();
  };
  $('reoptNo').onclick = () => {
    $('reoptSheet').hidden = true;
    if (pendingReopt) reoptDeclinedKey = pendingReopt.key;
    pendingReopt = null;
    lastOptAt = Date.now(); // treated as handled for the anti-spam gate
    toast('Keeping your current order');
  };

  /* Early-arrival suggestion: show the tradeoff, let the user decide. */
  let pendingEarly = null;
  function showEarlySuggestion(opp) {
    pendingEarly = opp;
    const fmtTime = (mins) => {
      const h = Math.floor(mins / 60), m = Math.round(mins % 60);
      const ap = h >= 12 ? 'PM' : 'AM';
      const hh = h % 12 || 12;
      return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
    };
    const earlyAddr = stopLabel(opp.earlyStop);
    const otherAddr = stopLabel(opp.otherStop);
    const winEnd = opp.otherStop.twEnd != null ? fmtTime(opp.otherStop.twEnd) : '';
    $('earlyText').textContent =
      'Head to ' + earlyAddr + ' first — arrive ~' + opp.earlyByMin +
      ' min early, save ~' + opp.savedMin + ' min of driving. ' +
      'You\'d still make ' + otherAddr + (winEnd ? ' by ' + winEnd : '') + '.';
    $('earlySheet').hidden = false;
  }
  $('earlyYes').onclick = () => {
    $('earlySheet').hidden = true;
    const opp = pendingEarly; pendingEarly = null;
    if (!opp) return;
    try {
      // Swap the two stops' positions in state.stops.
      const iA = state.stops.findIndex((s) => s.id === opp.otherStop.id);
      const iB = state.stops.findIndex((s) => s.id === opp.earlyStop.id);
      if (iA >= 0 && iB >= 0) {
        const tmp = state.stops[iA];
        state.stops[iA] = state.stops[iB];
        state.stops[iB] = tmp;
        state.earlyOpportunity = null;
        save(); render(); refreshMap();
        toast('⚡ Route updated — ~' + opp.savedMin + ' min saved');
      }
    } catch (e) { console.warn('early-apply failed', e); }
  };
  $('earlyNo').onclick = () => {
    $('earlySheet').hidden = true;
    pendingEarly = null;
    state.earlyOpportunity = null;
  };

  /* ---------- automatic re-optimization engine (v1.9) ----------
   * Fires when: a stop is marked done, a window is confirmed/changed, the
   * app is opened/reopened after 15+ minutes, or the user interacts after
   * 15+ minutes idle. Pulls fresh drive times and re-optimizes around
   * confirmed windows — automatic and seamless. */
  let autoTimer = null, autoInFlight = false, lastAutoReason = null;
  let lastOptAt = 0; // last optimize of any kind (manual or auto) — anti-spam baseline
  let lastInteractionAt = Date.now();
  const AUTO_IDLE_MS = 15 * 60 * 1000;
  function confirmedWindowed() {
    return state.stops.filter((s) => s.confirmed && s.twStart != null && s.twEnd != null &&
                                     s.lat != null && s.lng != null);
  }
  function maybeAutoReopt(reason, attempt, idleProven) {
    if (!confirmedWindowed().length) return;      // nothing to protect
    if (autoInFlight || optInFlight || state.geocoding) {
      // boot/reopen must not silently die on geocoding: retry a few times
      if ((reason === 'boot' || reason === 'visible') && (attempt || 0) < 6) {
        setTimeout(() => maybeAutoReopt(reason, (attempt || 0) + 1), 5000);
      }
      return;
    }
    if (!$('winSheet').hidden || !$('riskSheet').hidden || !$('reoptSheet').hidden) return; // user mid-flow
    const now = Date.now();
    const immediate = (reason === 'done' || reason === 'window' || reason === 'checkin');
    const reopen = (reason === 'boot' || reason === 'visible');
    // true idle gate: 15+ minutes since the last real interaction…
    if (!immediate && !reopen && !idleProven && now - lastInteractionAt < AUTO_IDLE_MS) return;
    // …and 15+ minutes since the last optimize of any kind (anti-spam)…
    if (!immediate && !reopen && now - lastOptAt < AUTO_IDLE_MS) return;
    // …but reopening ALWAYS refreshes, even if the last optimize was recent
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      autoInFlight = true;
      lastAutoReason = reason; // so doOptimize knows whether to surface suggestions
      doOptimize(true).catch(() => {}).finally(() => {
        autoInFlight = false;
        lastAutoReason = null;
      });
    }, immediate ? 1500 : 2500);
  }
  function noteInteraction() {
    const now = Date.now();
    const idleFor = now - lastInteractionAt;
    lastInteractionAt = now;
    // came back and touched the app after 15+ min idle: times are stale.
    // idleProven=true because we measured the gap before updating the stamp.
    if (idleFor >= AUTO_IDLE_MS) maybeAutoReopt('idle', 0, true);
  }
  document.addEventListener('pointerdown', noteInteraction, { passive: true });
  document.addEventListener('keydown', noteInteraction);
  // the app sitting open but untouched for 15+ min: refresh in the background
  setInterval(() => {
    if (!document.hidden && Date.now() - lastInteractionAt >= AUTO_IDLE_MS) {
      maybeAutoReopt('idle');
    }
  }, 60000);

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
    } catch {}
  }

  /* ---------- traffic model import/export ---------- */
  const LS_TRAFFIC_MODEL = 'rr.traffic.model.v1'; // imported aggregated model
  function exportTrafficData() {
    try {
      const learn = loadTrafficLearn();
      const buckets = learn.buckets || {};
      const keys = Object.keys(buckets);
      if (!keys.length) {
        $('trafficStatus').textContent = 'No traffic data to export.';
        return;
      }
      const text = JSON.stringify({ buckets }, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'routerunner-traffic-' + Date.now() + '.json';
      a.click();
      URL.revokeObjectURL(url);
      $('trafficStatus').textContent = `Exported ${keys.length} buckets.`;
    } catch {
      $('trafficStatus').textContent = 'Export failed.';
    }
  }
  function importTrafficModel(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const model = JSON.parse(r.result);
        if (!model.buckets || typeof model.buckets !== 'object') throw new Error('bad model');
        localStorage.setItem(LS_TRAFFIC_MODEL, JSON.stringify(model));
        const n = Object.keys(model.buckets).length;
        $('trafficStatus').textContent = `Imported model with ${n} buckets.`;
        toast('Traffic model updated');
      } catch {
        $('trafficStatus').textContent = 'Invalid model file.';
      }
    };
    r.readAsText(file);
  }
  function loadTrafficModel() {
    try {
      const raw = localStorage.getItem(LS_TRAFFIC_MODEL);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /* ---------- Google Maps ---------- */
  function originLabel() {
    // If origin is GPS/current location, return empty so Google Maps uses
    // the device's live location (raw coordinates become "Dropped pin").
    if (state.origin.type === 'gps') return '';
    if (state.origin.lat != null) return state.origin.lat.toFixed(5) + ',' + state.origin.lng.toFixed(5);
    return state.origin.label || 'Current location';
  }
  $('mapsBtn').onclick = () => {
    const remaining = state.stops.filter((s) => !s.done);
    if (!remaining.length) { toast('No remaining stops'); return; }
    // pass the stop objects themselves — core.js stopLabel() builds the address text
    const ordered = remaining.slice();
    if (settings.returnToStart) ordered.push({ street: originLabel() });
    else if (settings.defaultEnd) ordered.push({ street: settings.defaultEnd });
    const avoid = [];
    if (settings.avoidTolls) avoid.push('tolls');
    if (settings.avoidHwy) avoid.push('highways');
    const legs = RouteCore.buildMapsLinks(originLabel(), ordered, { avoid });
    // Navigate the app itself (not a popup) so the browser back button
    // returns directly to RouteRunner — no intermediate blank page.
    if (legs.length === 1) { location.href = legs[0].url; return; }
    const box = $('legList');
    box.innerHTML = '';
    legs.forEach((leg) => {
      const b = document.createElement('button');
      b.className = 'btn leg-btn';
      b.innerHTML = '🗺️ ' + esc(leg.label);
      b.onclick = () => { location.href = leg.url; };
      box.appendChild(b);
    });
    $('legSheet').hidden = false;
  };
  $('legClose').onclick = () => { $('legSheet').hidden = true; };

  /* ---------- share ---------- */
  $('shareBtn').onclick = async () => {
    // Share the app itself — never the route data (privacy: everything stays on the phone)
    const url = 'https://abrown9299-coder.github.io/route-runner/';
    try {
      await navigator.clipboard.writeText(url);
      toast('🔗 App link copied — send it to anyone');
    } catch {
      prompt('Copy the app link:', url);
    }
  };

  /* ---------- diagnostics download (developer mode) ---------- */
  $('diagBtn').onclick = async () => {
    const diag = {
      app: 'RouteRunner',
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      settings: {
        mode: settings.mode,
        defaultStart: settings.defaultStart || '',
        defaultEnd: settings.defaultEnd || '',
        defaultStartCoords: null, /* startCoordsCache was removed; always null */
        defaultEndCoords: (typeof endCoordsCache !== 'undefined' && endCoordsCache) ? { lat: +endCoordsCache.lat.toFixed(6), lng: +endCoordsCache.lng.toFixed(6) } : null,
        autoConfirmAll: !!settings.autoConfirmAll,
        returnToStart: !!settings.returnToStart,
      },
      route: {
        stopCount: state.stops.length,
        optimized: !!state.optimized,
        hasSchedule: !!state.lastSchedule,
        origin: state.origin ? { type: state.origin.type, label: state.origin.label } : null,
        endActive: !!state.endActive,
        stops: state.stops.map((s) => ({
          street: s.street, city: s.city, state: s.state, zip: s.zip,
          lat: s.lat != null ? +s.lat.toFixed(6) : null,
          lng: s.lng != null ? +s.lng.toFixed(6) : null,
          geocodeSource: s.geocodeSource || '',
          done: !!s.done, confirmed: !!s.confirmed,
          appt: s.apptMin != null ? s.apptMin : null,
        })),
      },
      errors: (window.__rrErrors || []).slice(-20),
    };
    const text = JSON.stringify(diag, null, 2);
    // In the installed PWA there's no Safari downloader. Show a modal with
    // the JSON plus Copy and Share buttons — bulletproof on iOS.
    let modal = $('diagModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'diagModal';
      // Inline styles — no dependency on stylesheet classes.
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML =
        '<div style="background:#151a2e;border:1px solid #2a3350;border-radius:16px;padding:16px;width:100%;max-width:500px;max-height:85vh;display:flex;flex-direction:column;gap:10px">' +
        '<h3 style="margin:0;color:#fff">Diagnostics</h3>' +
        '<textarea id="diagText" readonly style="flex:1;min-height:220px;font-family:monospace;font-size:11px;background:#0a0c14;color:#c0c8e0;border:1px solid #2a3350;border-radius:8px;padding:8px"></textarea>' +
        '<div style="display:flex;gap:8px">' +
        '<button id="diagCopy" class="btn">📋 Copy</button>' +
        '<button id="diagShare" class="btn">📤 Share</button>' +
        '<button id="diagClose" class="btn">Close</button>' +
        '</div></div>';
      document.body.appendChild(modal);
      $('diagClose').onclick = () => { modal.style.display = 'none'; };
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    }
    $('diagText').value = text;
    modal.style.display = 'flex';
    // Wire copy/share each time (modal is created once).
    $('diagCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('diagText').value);
        toast('Copied — paste it to Vesper');
      } catch {
        $('diagText').select();
        toast('Select all and copy manually');
      }
    };
    $('diagShare').onclick = async () => {
      const f = new File([$('diagText').value], 'routerunner-diagnostics.json', { type: 'application/json' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [f] })) {
          await navigator.share({ files: [f], title: 'RouteRunner diagnostics' });
        } else if (navigator.share) {
          await navigator.share({ title: 'RouteRunner diagnostics', text: $('diagText').value });
        } else {
          toast('Sharing not available — use Copy');
        }
      } catch { /* dismissed */ }
    };
  };
  // Capture JS errors for diagnostics.
  window.__rrErrors = window.__rrErrors || [];
  window.addEventListener('error', (e) => {
    window.__rrErrors.push({ t: new Date().toISOString(), msg: String(e.message || e.error), src: String(e.filename || '') + ':' + (e.lineno || '') });
    if (window.__rrErrors.length > 50) window.__rrErrors.shift();
  });

  /* ---------- manual update check ---------- */
  $('updateBtn').onclick = async () => {
    toast('Checking for updates…');
    try {
      const resp = await fetch('version.json', { cache: 'no-store' });
      const info = resp.ok ? await resp.json() : null;
      if (!info || !info.version) { toast('Could not check — try again'); return; }
      if (info.version === APP_VERSION) {
        // Versions match, but the JS may still be stale (Safari caches
        // app.js aggressively). Force a clean reload to be sure.
        toast('Refreshing to the newest code…');
        ssDel('rr.updating'); ssDel('rr.updating_at');
        applyUpdate(info.version);
      } else {
        // Clear the stale-update guard so the update always runs.
        ssDel('rr.updating'); ssDel('rr.updating_at');
        applyUpdate(info.version);
      }
    } catch {
      toast('Could not check — are you online?');
    }
  };
  function loadSharedRoute() {
    if (!location.hash.startsWith('#r=')) return false;
    const data = RouteCore.decodeShare(location.hash);
    if (!data || !Array.isArray(data.stops)) return false;
    state.stops = data.stops.map((s) => Object.assign({
      id: uid(), done: false, isLast: !!s.isLast, isFirst: !!s.isFirst, source: 'shared', geocodeSource: null,
      confirmed: !!s.confirmed, twStart: (s.twStart != null ? s.twStart : null),
      twEnd: (s.twEnd != null ? s.twEnd : null), apptMin: (s.apptMin != null ? s.apptMin : null),
    }, s));
    if (data.origin) state.origin = data.origin;
    if (data.settings) Object.assign(settings, data.settings);
    if (collectJobTypes(state.stops)) save();
    state.warnSuppressed = false; // a shared route is a new route: warnings back on
    state.checkedIn = null; // service timer doesn't survive a shared route
    state.optimized = false;
    history.replaceState(null, '', location.pathname + location.search);
    save(); render();
    toast('Route loaded from shared link');
    return true;
  }

  /* ---------- origin ---------- */
  $('originBtn').onclick = async () => {
    $('originSearchInput').value = state.origin.type === 'address' ? (state.origin.label || '') : '';
    $('originSuggestList').innerHTML = '';
    $('originSuggestList').hidden = true;
    $('originSheet').hidden = false;
    setTimeout(() => $('originSearchInput').focus(), 50);
  };
  $('originClose').onclick = () => { $('originSheet').hidden = true; };
  $('originUseGps').onclick = () => {
    state.origin = { type: 'gps', label: 'Current location', lat: null, lng: null };
    $('originSheet').hidden = true;
    markDirty('Start updated — using GPS');
  };
  /* Origin search: universal dropdown (saved locations first, then live search).
   * onOriginPick replicates the legacy set-origin behavior. */
  function onOriginPick(v) {
    state.origin = {
      type: 'address',
      label: v.label || v.address || '',
      lat: v.lat, lng: v.lng,
    };
    $('originSheet').hidden = true;
    markDirty('Start updated');
    toast('\u2713 Start updated');
  }
  attachAddressDropdown('originSearchInput', 'originSuggestList', 'originSearchWrap', onOriginPick);

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
  async function showMap() {
    const w = $('mapWrap');
    if (!w.hidden) return;
    await loadLeaflet(); // throws when offline -> caller toasts
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
    // default end address: show it as the final destination
    if (state.endActive && state.optimized && endCoordsCache) {
      pts.push({ lat: endCoordsCache.lat, lng: endCoordsCache.lng, _end: true });
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
      if (s._end) m.bindPopup('🏠 ' + esc(settings.defaultEnd || 'Home'));
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
  function resetRoute(fromSettings) {
    if (!state.stops.length) return;
    if (!confirm('Clear all ' + state.stops.length + ' stops and start a fresh route?')) return;
    state.stops = [];
    state.optimized = false;
    state.matrixSource = null;
    state.lastEstimate = null;
    state.preEstimateMin = 0;
    state.preDriveMin = null; state.preDriveSource = null;
    state.geocoding = false;
    state.geocodeStatus = '';
    state.pinModeStopId = null;
    geocodeInflight = null; // a clear must not leave a stale in-flight geocode
    state.warnSuppressed = false; // new route: at-risk warnings come back
    state.checkedIn = null;
    state.lastSchedule = null;
    state.returnActive = false; state.endActive = false;
    $('mapWrap').hidden = true;
    $('mapToggle').textContent = '🗺 Map';
    wipeRouteData();
    save(); render();
    if (fromSettings) $('settingsSheet').hidden = true;
    toast('All stops cleared — fresh route ready');
  }
  $('clearAllBtn').onclick = () => resetRoute(false);

  /* ---------- manual refresh: stops are saved AND backed up before anything
   * navigates, so a failed refresh can never lose them. ---------- */
  $('refreshBtn').onclick = async () => {
    try {
      save(); saveUIState();
      const r = localStorage.getItem(LS_ROUTE);
      if (r) localStorage.setItem('rr.route.backup', r);
      const s = localStorage.getItem(LS_SET);
      if (s) localStorage.setItem('rr.settings.backup', s);
    } catch {}
    try {
      toast('Checking for updates…');
      const resp = await fetch('version.json', { cache: 'no-store' });
      const info = resp.ok ? await resp.json() : null;
      if (info && info.version && info.version !== APP_VERSION) {
        applyUpdate(info.version); // toasts, backs up again, reloads
        return;
      }
    } catch { /* offline or check failed — plain reload is still safe */ }
    saveUIState();
    location.reload();
  };

  /* ---------- auto check-in (work mode, GPS proximity) ---------- */
  let autoCheckinWatchId = null;
  function haversineM(aLat, aLng, bLat, bLng) {
    const R = 6371000, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function checkProximityCheckin(lat, lng, accuracy) {
    if (!isWorkMode() || !settings.autoCheckin) return;
    if (state.checkedIn) return; // already in service somewhere
    // Reject inaccurate fixes: a 500m-accuracy reading "near" a stop is meaningless.
    if (accuracy != null && accuracy > 75) return;
    // find the nearest not-done stop with coordinates within 100m
    let best = null, bestD = 100;
    for (const s of state.stops) {
      if (s.done || s.lat == null || s.lng == null) continue;
      const d = haversineM(lat, lng, s.lat, s.lng);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) {
      endLegTracking(best.id); // arrival: traffic learning
      state.checkedIn = { stopId: best.id, startedAt: Date.now(), auto: true };
      save(); render();
      toast('📍 Auto checked in — ' + serviceMinFor(best) + ' min service timer running');
      maybeAutoReopt('checkin');
    }
  }
  let proximityIntervalId = null;
  function startAutoCheckinWatch() {
    stopAutoCheckinWatch();
    if (!('geolocation' in navigator)) return;
    if (!isWorkMode() || !settings.autoCheckin) return;
    try {
      autoCheckinWatchId = navigator.geolocation.watchPosition((pos) => {
        checkinAtGps(pos);
      }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
      // Fallback: iOS suspends watchPosition when backgrounded. Poll every 60s
      // and check immediately when the app becomes visible.
      proximityIntervalId = setInterval(() => {
        if (!isWorkMode() || !settings.autoCheckin || state.checkedIn) return;
        navigator.geolocation.getCurrentPosition((pos) => {
          checkinAtGps(pos);
        }, () => {}, { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 });
      }, 60000);
    } catch {}
  }
  function stopAutoCheckinWatch() {
    if (proximityIntervalId != null) { clearInterval(proximityIntervalId); proximityIntervalId = null; }
    if (autoCheckinWatchId != null && 'geolocation' in navigator) {
      try { navigator.geolocation.clearWatch(autoCheckinWatchId); } catch {}
    }
    autoCheckinWatchId = null;
  }

  /* ---------- settings ---------- */
  $('settingsBtn').onclick = () => {
    $('setStart').value = settings.defaultStart;
    $('setEnd').value = settings.defaultEnd || '';
    $('setTolls').checked = settings.avoidTolls;
    $('setHwy').checked = settings.avoidHwy;
    $('setReturn').checked = settings.returnToStart;
    $('setHistory').checked = settings.saveHistory;
    $('setAutoCheckin').checked = !!settings.autoCheckin;
    $('setAutoConfirm').checked = !!settings.autoConfirmAll;
    $('setEarlySuggest').checked = settings.earlySuggest !== false;
    $('trafficStatus').textContent = '';
    $('trafficExport').onclick = exportTrafficData;
    $('trafficImport').onclick = () => $('trafficFile').click();
    $('trafficFile').onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importTrafficModel(f);
      e.target.value = '';
    };
    $('setMode').value = settings.mode || 'work';
    updateModeHint();
    renderServiceTimes();
    renderHomeLocationSetting();
    renderSavedLocations();
    $('settingsSheet').hidden = false;
  };
  /* ---------- home location setting (Issue 1) ---------- */
  function renderHomeLocationSetting() {
    const hl = settings.homeLocation;
    $('homeLocationDisplay').textContent = hl && hl.city
      ? 'Current: ' + hl.city + (hl.state ? ', ' + hl.state : '')
      : 'Not set — GPS is used when available.';
    $('setHome').value = '';
    $('setHome').placeholder = hl && hl.city
      ? hl.city + (hl.state ? ', ' + hl.state : '')
      : 'e.g. Austin, TX (optional override)';
  }
  /* ---------- saved locations settings UI (spec §2) ---------- */
  function renderSavedLocations() {
    const ul = $('savedList');
    if (!ul) return;
    ul.innerHTML = '';
    if (!settings.savedLocations.length) {
      ul.innerHTML = '<li class="fine">No saved locations yet. Tap ⭐ on any address to save it.</li>';
      return;
    }
    settings.savedLocations.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'saved-row';
      li.innerHTML =
        '<span class="saved-star">⭐</span>' +
        '<div class="info"><div class="addr">' + esc(s.name) + '</div>' +
        (s.address && s.address !== s.name ? '<div class="meta"><span class="chip">' + esc(s.address) + '</span></div>' : '') +
        '</div>' +
        '<div class="acts">' +
          '<button data-sact="rename" title="Rename">✏️</button>' +
          '<button data-sact="del" title="Remove">✕</button>' +
        '</div>';
      ul.appendChild(li);
    });
  }
  // Delegate rename/delete clicks for the saved list.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sact]');
    if (!btn) return;
    const li = btn.closest('li.saved-row');
    if (!li) return;
    const nameEl = li.querySelector('.addr');
    const name = nameEl ? nameEl.textContent : '';
    const loc = settings.savedLocations.find((s) => s.name === name);
    if (!loc) return;
    const key = RouteCore.savedLocationKey(loc);
    if (btn.dataset.sact === 'del') {
      if (!confirm('Remove "' + loc.name + '" from saved locations?')) return;
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); renderSavedLocations(); render();
      toast('☆ Unsaved');
    } else if (btn.dataset.sact === 'rename') {
      const nn = prompt('Rename saved location:', loc.name);
      if (nn === null) return;
      settings.savedLocations = RouteCore.renameSavedLocation(settings.savedLocations, key, nn);
      save(); renderSavedLocations(); render();
      toast('Renamed');
    }
  });
  let homeSuggestTimer = null, homeSuggestToken = 0;
  $('setHome').addEventListener('input', (e) => {
    clearTimeout(homeSuggestTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('setHomeSuggest').hidden = true; return; }
    homeSuggestTimer = setTimeout(() => searchHomeCity(q, ++homeSuggestToken, 'setHomeSuggest', 'setHome', (sel) => {
      settings.homeLocation = sel;
      save();
      renderHomeLocationSetting();
      toast('✓ Home location set to ' + sel.city + (sel.state ? ', ' + sel.state : ''));
    }), 350);
  });
  /* City search via Photon: returns {city, state, lat, lng} candidates. */
  async function searchHomeCity(q, myToken, listId, inputId, onPick) {
    try {
      const list = $(listId);
      list.innerHTML = '';
      const j = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=5')
        .then((r) => r.json()).catch(() => null);
      if (myToken !== homeSuggestToken) return;
      list.innerHTML = '';
      (j && j.features || []).forEach((f) => {
        const p = f.properties || {};
        const city = p.city || p.town || p.village || p.name || '';
        const state = p.state || '';
        if (!city) return;
        const [lng, lat] = f.geometry.coordinates;
        const label = city + (state ? ', ' + state : '');
        const li = document.createElement('li');
        li.innerHTML = '📍 <b>' + esc(label) + '</b>';
        li.onclick = () => {
          onPick({ city: city, state: state, lat: lat, lng: lng });
          $(inputId).value = '';
          list.hidden = true;
        };
        list.appendChild(li);
      });
      list.hidden = !list.children.length;
    } catch { /* offline */ }
  }
  $('setHomeGps').onclick = async () => {
    if (!('geolocation' in navigator)) { toast('GPS not available'); return; }
    toast('Getting your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const lat = pos.coords.latitude.toFixed(4), lon = pos.coords.longitude.toFixed(4);
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
          { headers: { 'Accept': 'application/json' } });
        const j = r.ok ? await r.json() : null;
        const a = j && j.address ? j.address : null;
        if (a) {
          const city = a.city || a.town || a.village || '';
          const state = a.state_code || a.state || '';
          if (city) {
            settings.homeLocation = {
              city: city, state: state,
              lat: pos.coords.latitude, lng: pos.coords.longitude,
            };
            save();
            renderHomeLocationSetting();
            toast('✓ Home location set to ' + city + (state ? ', ' + state : ''));
            return;
          }
        }
        toast('Could not determine city from GPS');
      } catch { toast('Could not determine city from GPS'); }
    }, () => toast('GPS not available'), { timeout: 10000 });
  };
  $('setHomeClear').onclick = () => {
    settings.homeLocation = null;
    save();
    renderHomeLocationSetting();
    toast('Home location cleared');
  };
  /* ---------- precision banner (Issue 2) ---------- */
  $('precisionBannerClose').onclick = () => { $('precisionBanner').hidden = true; };
  $('setStartGps').onclick = () => {
    // Capture current GPS position and reverse-geocode it into the field,
    // so "default start" becomes the office (or wherever you are now).
    if (!('geolocation' in navigator)) { toast('GPS not available'); return; }
    toast('Getting your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude.toFixed(6), lon = pos.coords.longitude.toFixed(6);
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
          { headers: { 'Accept': 'application/json' } });
        const j = r.ok ? await r.json() : null;
        const a = j && j.address ? j.address : null;
        if (a) {
          const num = a.house_number || '', road = a.road || '',
                city = a.city || a.town || a.village || '',
                state = a.state_code || a.state || '', zip = a.postcode || '';
          const line1 = [num, road].filter(Boolean).join(' ').trim();
          const line2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ').trim();
          const addr = [line1, line2].filter(Boolean).join(', ');
          if (addr) { $('setStart').value = addr; toast('Start address set to current location'); return; }
        }
        toast('Could not find address for this location');
      } catch { toast('Address lookup failed'); }
    }, () => toast('Location unavailable'), { timeout: 10000 });
  };

  /* Address autofill for the default start/end fields (Photon + Census exact match). */
  /* ---------- universal address dropdown (spec §3) ----------
   * attachAddressDropdown(inputEl, listEl, wrapEl, onSelect)
   * - Empty + focus → shows saved locations (⭐ rows) first.
   * - Typing (debounced 300ms) → live Photon + Nominatim results.
   * - onSelect({label, street, city, state, zip, lat, lng}) on pick.
   * - Keyboard: ↑/↓ navigate, Enter selects, Esc dismisses. */
  function attachAddressDropdown(inputEl, listEl, wrapEl, onSelect) {
    const input = typeof inputEl === 'string' ? $(inputEl) : inputEl;
    const list = typeof listEl === 'string' ? $(listEl) : listEl;
    const wrap = typeof wrapEl === 'string' ? $(wrapEl) : wrapEl;
    if (!input || !list) return;
    let timer = null, tok = 0, activeIdx = -1;

    function close() { list.hidden = true; list.innerHTML = ''; activeIdx = -1; }
    function highlight() {
      const items = list.querySelectorAll('li[data-idx]');
      items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
      const act = items[activeIdx];
      if (act) act.scrollIntoView({ block: 'nearest' });
    }
    function pick(idx) {
      const li = list.querySelectorAll('li[data-idx]')[idx];
      if (!li || !li._pick) return;
      const v = li._pick;
      close();
      if (typeof onSelect === 'function') onSelect(v);
    }

    function renderSaved(filter) {
      const matches = RouteCore.filterSavedLocations(settings.savedLocations, filter);
      list.innerHTML = '';
      activeIdx = -1;
      if (!matches.length) { list.hidden = true; return; }
      const head = document.createElement('li');
      head.className = 'dd-head';
      head.innerHTML = '⭐ Saved locations';
      list.appendChild(head);
      matches.forEach((s, i) => {
        const li = document.createElement('li');
        li.dataset.idx = i;
        li.innerHTML = '⭐ <b>' + esc(s.name) + '</b><small>' + esc(s.address || '') + '</small>';
        li._pick = {
          label: s.name, address: s.address,
          street: s.address || '', city: '', state: '', zip: '',
          lat: s.lat, lng: s.lng, fromSaved: true,
        };
        li.onclick = () => pick(i);
        list.appendChild(li);
      });
      list.hidden = false;
    }

    async function searchLive(q, myToken) {
      try {
        list.innerHTML = '';
        const hasHouseNum = /^\d+\s+\S/.test(q);
        const photonP = fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) +
          '&limit=6' + photonBiasParams()).then((r) => r.json()).catch(() => null);
        const censusP = hasHouseNum
          ? fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=' + encodeURIComponent(q + homeSuffix()))
              .then((r) => r.json()).catch(() => null)
          : Promise.resolve(null);
        const [pj, cj] = await Promise.all([photonP, censusP]);
        if (myToken !== tok) return; // stale
        list.innerHTML = '';
        activeIdx = -1;
        let idx = 0;
        const addRow = (html, pickData) => {
          const li = document.createElement('li');
          li.dataset.idx = idx++;
          li.innerHTML = html;
          li._pick = pickData;
          li.onclick = () => pick(li.dataset.idx);
          list.appendChild(li);
        };
        const nm = cj && cj[0];
        if (nm && nm.address && nm.address.house_number) {
          const a = nm.address;
          const street = [(a.house_number || ''), (a.road || '')].filter(Boolean).join(' ');
          const city = a.city || a.town || a.village || '';
          const cleanAddr = [street, city, [a.state_code || a.state || '', a.postcode || ''].filter(Boolean).join(' ')]
            .filter(Boolean).join(', ');
          addRow('✓ <b>' + esc(cleanAddr) + '</b><small>Exact address match</small>', {
            label: cleanAddr, street, city,
            state: a.state_code || a.state || '', zip: a.postcode || '',
            lat: parseFloat(nm.lat), lng: parseFloat(nm.lon),
          });
        }
        (pj && pj.features || []).forEach((f) => {
          const p = f.properties || {};
          const label = [p.name, p.street, p.city, p.state, p.postcode].filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i).join(', ');
          const qNum = (q.match(/^\d+/) || [])[0] || '';
          let street = [p.housenumber, p.street].filter(Boolean).join(' ') ||
                       [p.name, p.street].filter(Boolean).join(' ') || label;
          if (qNum && street && !new RegExp('^' + qNum + '\\b').test(street)) {
            const qStreet = q.replace(/^\d+\s+/, '').toLowerCase();
            if (street.toLowerCase().includes(qStreet.split(' ')[0])) {
              street = qNum + ' ' + street;
            }
          }
          const addr = [street, p.city, [p.state, p.postcode].filter(Boolean).join(' ')]
            .filter(Boolean).join(', ');
          const coords = f.geometry && f.geometry.coordinates;
          addRow(esc(label || 'Unnamed place') +
            '<small>' + esc([p.city, p.state].filter(Boolean).join(', ')) + '</small>', {
            label: addr || label, street,
            city: p.city || '', state: p.state || '', zip: p.postcode || '',
            lat: coords ? coords[1] : null, lng: coords ? coords[0] : null,
          });
        });
        list.hidden = !list.children.length;
      } catch { /* offline — suggestions unavailable */ }
    }

    input.addEventListener('focus', () => {
      renderSaved('');
    });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { renderSaved(''); return; }
      const myToken = ++tok;
      timer = setTimeout(() => searchLive(q, myToken), 300);
    });
    input.addEventListener('keydown', (e) => {
      const items = list.querySelectorAll('li[data-idx]');
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % items.length; highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % items.length; highlight(); }
      else if (e.key === 'Enter') { if (activeIdx >= 0) { e.preventDefault(); pick(activeIdx); } }
      else if (e.key === 'Escape') { close(); }
    });
    document.addEventListener('click', (e) => {
      if (wrap && !e.target.closest('#' + (wrap.id || '')) && e.target !== input) close();
      else if (!wrap && !input.contains(e.target) && !list.contains(e.target)) close();
    });
    // Expose a close handle for programmatic dismissal.
    input._ddClose = close;
  }

  function wireSettingsAutocomplete(inputId, listId, wrapId) {
    let timer = null, tok = 0;
    $(inputId).addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (q.length < 4) { $(listId).hidden = true; return; }
      const myToken = ++tok;
      timer = setTimeout(async () => {
        try {
          const list = $(listId);
          list.innerHTML = '';
          const hasHouseNum = /^\d+\s+\S/.test(q);
          // Run Photon and Census in parallel. Census is authoritative for
          // house numbers — show a placeholder so the user knows it's coming.
          let censusLi = null;
          if (hasHouseNum) {
            censusLi = document.createElement('li');
            censusLi.innerHTML = '🔍 <i>Looking up exact address…</i>';
            censusLi.style.opacity = '0.6';
            list.appendChild(censusLi);
          }
          const photonP = fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) +
            '&limit=6' + photonBiasParams()).then((r) => r.json()).catch(() => null);
          const censusP = hasHouseNum
            ? fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=' + encodeURIComponent(q + homeSuffix()))
                .then((r) => r.json()).catch(() => null)
            : Promise.resolve(null);
          const [pj, cj] = await Promise.all([photonP, censusP]);
          // Stale response guard: if the user kept typing, drop this result.
          if (myToken !== tok) return;
          list.innerHTML = '';
          // Nominatim exact match FIRST.
          const nm = cj && cj[0];
          if (nm && nm.address && nm.address.house_number) {
            const a = nm.address;
            const street = [(a.house_number || ''), (a.road || '')].filter(Boolean).join(' ');
            const cleanAddr = [street, (a.city || a.town || a.village || ((settings.homeLocation && settings.homeLocation.city) || '')), 'TN ' + (a.postcode || '')].filter(Boolean).join(', ');
            const li = document.createElement('li');
            li.innerHTML = '✓ <b>' + esc(cleanAddr) + '</b><small>Exact address match</small>';
            li.onclick = () => {
              $(inputId).value = cleanAddr;
              list.hidden = true;
            };
            list.appendChild(li);
          }
          (pj && pj.features || []).forEach((f) => {
            const p = f.properties || {};
            const label = [p.name, p.street, p.city, p.state, p.postcode].filter(Boolean)
              .filter((v, i, a) => a.indexOf(v) === i).join(', ');
            const li = document.createElement('li');
            li.innerHTML = esc(label || 'Unnamed place') +
              '<small>' + esc([p.city, p.state].filter(Boolean).join(', ')) + '</small>';
            li.onclick = () => {
              // Preserve the house number from the query if the result lacks one.
              // Photon often returns street-only results; the user typed the number.
              const qNum = (q.match(/^\d+/) || [])[0] || '';
              let street = [p.housenumber, p.street].filter(Boolean).join(' ');
              if (!street) street = [p.name, p.street].filter(Boolean).join(' ');
              if (qNum && street && !new RegExp('^' + qNum + '\\b').test(street)) {
                // Result has a street but no house number — prepend the typed one.
                // Only if the street name matches what was typed (avoid wrong numbers).
                const qStreet = q.replace(/^\d+\s+/, '').toLowerCase();
                if (street.toLowerCase().includes(qStreet.split(' ')[0])) {
                  street = qNum + ' ' + street;
                }
              }
              const addr = [street, p.city,
                            [p.state, p.postcode].filter(Boolean).join(' ')]
                .filter(Boolean).join(', ');
              $(inputId).value = addr || label;
              list.hidden = true;
            };
            list.appendChild(li);
          });
          list.hidden = !list.children.length;
        } catch { /* offline — suggestions unavailable */ }
      }, 350);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#' + wrapId)) $(listId).hidden = true;
    });
  }
  wireSettingsAutocomplete('setStart', 'setStartSuggest', 'setStartWrap');
  wireSettingsAutocomplete('setEnd', 'setEndSuggest', 'setEndWrap');
  $('setEndGps').onclick = () => {
    // Capture current GPS position and reverse-geocode it into the end field,
    // so "default end" becomes home (or wherever you're headed after work).
    if (!('geolocation' in navigator)) { toast('GPS not available'); return; }
    toast('Getting your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = pos.coords.latitude.toFixed(6), lon = pos.coords.longitude.toFixed(6);
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
          { headers: { 'Accept': 'application/json' } });
        const j = r.ok ? await r.json() : null;
        const a = j && j.address ? j.address : null;
        if (a) {
          const num = a.house_number || '', road = a.road || '',
                city = a.city || a.town || a.village || '',
                state = a.state_code || a.state || '', zip = a.postcode || '';
          const line1 = [num, road].filter(Boolean).join(' ').trim();
          const line2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ').trim();
          const addr = [line1, line2].filter(Boolean).join(', ');
          if (addr) { $('setEnd').value = addr; toast('End address set to current location'); return; }
        }
        toast('Could not find address for this location');
      } catch { toast('Address lookup failed'); }
    }, () => toast('Location unavailable'), { timeout: 10000 });
  };
  function updateModeHint() {
    const h = $('modeHint');
    if (h) h.textContent = isWorkMode()
      ? 'Work profile: confirmed windows, check-in, notes, job types.'
      : 'Personal profile: just stops — first/last pins stay, work features hide.';
    const acr = $('setAutoCheckinRow');
    if (acr) acr.style.display = isWorkMode() ? '' : 'none';
    const acfr = $('setAutoConfirmRow');
    if (acfr) acfr.style.display = isWorkMode() ? '' : 'none';
  }
  $('setMode').addEventListener('change', () => {
    settings.mode = $('setMode').value === 'personal' ? 'personal' : 'work';
    save(); updateModeHint(); renderServiceTimes(); render();
    if (settings.mode === 'personal') stopAutoCheckinWatch();
    else if (settings.autoCheckin) startAutoCheckinWatch();
    toast(settings.mode === 'personal' ? 'Personal profile — work features hidden' : 'Work profile');
  });
  $('settingsClose').onclick = () => {
    const retBefore = settings.returnToStart;
    settings.defaultStart = $('setStart').value.trim();
    settings.defaultEnd = $('setEnd').value.trim();
    settings.avoidTolls = $('setTolls').checked;
    settings.avoidHwy = $('setHwy').checked;
    settings.returnToStart = $('setReturn').checked;
    settings.saveHistory = $('setHistory').checked;
    const acBefore = !!settings.autoCheckin;
    settings.autoCheckin = $('setAutoCheckin').checked;
    const acfBefore = !!settings.autoConfirmAll;
    settings.autoConfirmAll = $('setAutoConfirm').checked;
    settings.earlySuggest = $('setEarlySuggest').checked;
    if (settings.returnToStart !== retBefore) {
      // the route shape changed (return leg added/removed) — re-optimize needed
      state.optimized = false; state.returnActive = false; state.endActive = false;
    }
    save();
    if (settings.autoCheckin !== acBefore) {
      if (settings.autoCheckin) startAutoCheckinWatch();
      else stopAutoCheckinWatch();
      toast(settings.autoCheckin ? 'Auto check-in on — GPS will check you in at stops' : 'Auto check-in off');
    }
    if (settings.autoConfirmAll && !acfBefore) {
      // Just turned on: confirm all stops that have a screenshot time.
      let n = 0;
      for (const s of state.stops) {
        if (!s.confirmed && s.apptMin != null) {
          s.confirmed = true; s.twStart = s.apptMin;
          s.twEnd = s.twEnd != null ? s.twEnd : s.apptMin + 120;
          n++;
        }
      }
      if (n) { save(); toast('✓ ' + n + ' stop' + (n === 1 ? '' : 's') + ' auto-confirmed'); }
    }
    if (settings.returnToStart !== retBefore) {
      toast(settings.returnToStart
        ? 'Return to start on — tap ⚡ Optimize to rebuild the route'
        : 'Return to start off — tap ⚡ Optimize to rebuild the route');
    }
    if (settings.defaultStart && state.origin.type === 'gps' && !state.origin.lat) {
      state.origin = { type: 'address', label: settings.defaultStart, lat: null, lng: null };
    }
    $('settingsSheet').hidden = true;
    render();
  };
  $('clearRoute').onclick = () => resetRoute(true);

  /* ---------- service times (v1.9): per-job-type durations ----------
   * Job types are learned from imports over time. Each gets a dropdown
   * (15, 20, 25, … minutes); unadjusted types use the default (45).
   * Nothing resets on its own — only the explicit reset controls. */
  function svcOptions(selected) {
    let html = '';
    for (let m = SVC_MIN; m <= SVC_MAX; m += SVC_STEP) {
      html += '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + ' min</option>';
    }
    return html;
  }
  function renderServiceTimes() {
    const sec = $('svcSec');
    if (sec) sec.style.display = isWorkMode() ? '' : 'none';
    if (!isWorkMode()) return; // personal mode: no service-time settings at all
    const st = settings.serviceTimes;
    $('setSvcDefault').innerHTML = svcOptions(st.default);
    const box = $('svcRows');
    box.innerHTML = '';
    const known = st.known.slice().sort();
    if (!known.length) {
      box.innerHTML = '<p class="fine">No job types yet — they appear here as you import routes.</p>';
    }
    known.forEach((jt) => {
      const row = document.createElement('div');
      row.className = 'svc-row';
      const cur = st.byJobType[jt] != null ? st.byJobType[jt] : st.default;
      const isCustom = st.byJobType[jt] != null;
      row.innerHTML =
        '<span class="svc-name">' + esc(jt) + (isCustom ? '' : ' <small>(default)</small>') + '</span>' +
        '<select data-jt="' + esc(jt) + '">' + svcOptions(cur) + '</select>' +
        (isCustom ? '<button class="link" data-reset="' + esc(jt) + '">reset</button>' : '');
      box.appendChild(row);
    });
  }
  $('svcRows').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-jt]');
    if (!sel) return;
    const v = Number(sel.value);
    if (v >= SVC_MIN && v <= SVC_MAX) {
      settings.serviceTimes.byJobType[sel.dataset.jt] = v;
      save(); renderServiceTimes();
      toast('Service time saved');
      maybeAutoReopt('window');
    }
  });
  $('svcRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-reset]');
    if (!btn) return;
    delete settings.serviceTimes.byJobType[btn.dataset.reset];
    save(); renderServiceTimes();
    toast('Reset to default');
  });
  $('setSvcDefault').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v >= SVC_MIN && v <= SVC_MAX) {
      settings.serviceTimes.default = v;
      save(); renderServiceTimes();
      toast('Default service time: ' + v + ' min');
      maybeAutoReopt('window');
    }
  });
  $('svcResetAll').onclick = () => {
    if (!confirm('Reset every job type back to the default service time?')) return;
    settings.serviceTimes.byJobType = {};
    save(); renderServiceTimes();
    toast('All service times reset to default');
  };

  /* ---------- auto-update: newest version on every open, place restored ----------
   * version.json (never cached) is compared against the APP_VERSION stamped
   * into index.html at deploy time. On mismatch the UI state is snapshotted,
   * the new service worker is activated, and the page reloads onto the new
   * build — route data (already in localStorage) plus UI state are restored.
   * Offline or failed check = silent no-op. */
  const APP_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';
  // Self-healing: if the loaded JS build doesn't match the page build,
  // Safari served a stale app.js — force a cache-busting reload once.
  try {
    if (RR_BUILD && RR_BUILD !== '20261005-040202' && APP_VERSION && APP_VERSION !== 'dev' &&
        RR_BUILD !== APP_VERSION && !/[?&]v=/.test(location.search) &&
        !sessionStorage.getItem('rr.selfheal')) {
      sessionStorage.setItem('rr.selfheal', '1');
      const u = new URL(location.href);
      u.searchParams.set('v', APP_VERSION);
      location.replace(u.toString());
    }
  } catch {}
  const UI_KEY = 'rr.ui.v1';
  function saveUIState() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        y: window.scrollY || 0,
        mapOpen: !$('mapWrap').hidden,
        settingsOpen: !$('settingsSheet').hidden,
        draft: $('searchInput') ? $('searchInput').value : '',
      }));
    } catch { /* storage unavailable — restore just skips */ }
  }
  function restoreUIState() {
    let ui = null;
    try { ui = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch {}
    if (!ui) return;
    if (ui.draft && $('searchInput')) $('searchInput').value = ui.draft;
    if (ui.mapOpen && $('mapWrap').hidden) showMap().catch(() => {});
    if (ui.settingsOpen && $('settingsSheet').hidden) $('settingsBtn').click();
    if (ui.y) window.scrollTo(0, ui.y);
  }
  let lastUpdateCheck = 0;
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch {} }
  function checkForUpdate() {
    const now = Date.now();
    if (now - lastUpdateCheck < 30000) return; // throttle foreground checks
    lastUpdateCheck = now;
    if (typeof fetch !== 'function') return;
    // If a previous update attempt stalled (flag set but no reload in 30s),
    // clear the flag so we retry instead of staying stuck.
    const updatingSince = Number(ssGet('rr.updating_at') || 0);
    if (ssGet('rr.updating') && updatingSince && now - updatingSince > 30000) {
      ssDel('rr.updating'); ssDel('rr.updating_at');
    }
    fetch('version.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || !info.version) return;
        if (info.version === APP_VERSION) { ssDel('rr.updating'); ssDel('rr.updating_at'); return; }
        if (ssGet('rr.updating')) return;
        ssSet('rr.updating_at', String(Date.now()));
        // Give a just-resumed webview a beat to settle before navigating away.
        setTimeout(() => applyUpdate(info.version), 1500);
      })
      .catch(() => {});
  }
  function applyUpdate(serverVersion) {
    // Guard: never run two updates at once (rapid taps froze the app).
    if (window.__rrUpdating) return;
    window.__rrUpdating = true;
    ssSet('rr.updating', '1');
    try {
      const route = localStorage.getItem(LS_ROUTE);
      if (route) localStorage.setItem('rr.route.backup', route);
      const set = localStorage.getItem(LS_SET);
      if (set) localStorage.setItem('rr.settings.backup', set);
    } catch {}
    saveUIState();
    toast('Updating to the latest version…');
    let done = false;
    const cacheBust = () => {
      if (done) return; done = true;
      try {
        const u = new URL(location.href);
        u.searchParams.set('v', serverVersion);
        location.href = u.toString();
      } catch { location.reload(); }
    };
    // The old SW serves stale cached files on plain reload. Unregister all
    // workers first, then cache-bust — guarantees the new shell loads.
    try {
      const unreg = ('serviceWorker' in navigator) && navigator.serviceWorker.getRegistrations
        ? navigator.serviceWorker.getRegistrations()
            .then((regs) => Promise.all(regs.map((r) => r.unregister().catch(() => {}))))
            .catch(() => {})
        : Promise.resolve();
      Promise.resolve(unreg).then(cacheBust).catch(cacheBust);
      setTimeout(cacheBust, 4000); // backstop if unregistration stalls
    } catch {
      cacheBust();
    }
  }

  /* ---------- boot ---------- */
  load();
  if (!loadSharedRoute()) render();
  try { const av = $('appVer'); if (av) av.textContent = APP_VERSION; } catch {}
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('v')) {
      u.searchParams.delete('v');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch {}
  restoreUIState();
  checkForUpdate();
  // Resume auto check-in watch if it was on (work mode only).
  if (settings.autoCheckin && isWorkMode()) startAutoCheckinWatch();
  // Live blue-dot tracking: keep the map's "you are here" dot moving.
  startDeviceTracking();
  // Ask for location services right on launch: the permission prompt appears
  // immediately, and the map can show "you are here" before optimize runs.
  if (state.origin.type === 'gps' && state.origin.lat == null) {
    ensureDevicePos().then(adoptDevicePos);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveUIState(); }
    else {
      // auto-delete check: a route completed yesterday is wiped on return
      if (state.completedAt && !isSameDay(state.completedAt, Date.now()) &&
          state.stops.length && state.stops.every((x) => x.done)) {
        wipeRouteData();
        state.stops = []; state.completedAt = null;
        state.optimized = false; state.lastSchedule = null; state.returnActive = false; state.endActive = false;
        save(); render();
        toast('Yesterday\'s completed route was cleared');
      }
      checkForUpdate(); maybeAutoReopt('visible');
      // Proximity check on return: iOS suspends geolocation in background,
      // so check immediately when the app becomes visible.
      if (isWorkMode() && settings.autoCheckin && !state.checkedIn && 'geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition((pos) => {
          checkinAtGps(pos);
        }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
      }
    } // reopened: fresh times + re-route
  });
  window.addEventListener('pagehide', saveUIState);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
  // A restored/share-booted route with stops: verify the real drive time too
  // (markDirty only fires on edits, not on boot).
  if (state.stops.length && !state.optimized) schedulePreDriveTime();
  // Closed and reopened: fresh transport times + automatic re-optimization
  // around confirmed windows (settled after GPS/geocode get a beat).
  setTimeout(() => maybeAutoReopt('boot'), 4000);
  window.__rrBooted = true; // boot watchdog in index.html stands down
})();
