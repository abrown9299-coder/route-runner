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
    completedAt: null,   // timestamp when the last stop was marked done (auto-delete next day)
  };
  const settings = {
    defaultStart: '', avoidTolls: false, avoidHwy: false,
    returnToStart: false, saveHistory: false, autoCheckin: false, autoConfirmAll: false, mode: 'work', // 'work' | 'personal'
    serviceTimes: { default: 45, byJobType: {}, known: [] },
  };
  const isWorkMode = () => settings.mode !== 'personal';

  /* ---------- persistence ---------- */
  function save() {
    try {
      localStorage.setItem(LS_ROUTE, JSON.stringify({
        stops: state.stops, origin: state.origin,
        optimized: state.optimized, matrixSource: state.matrixSource,
        preEstimateMin: state.preEstimateMin, lastEstimate: state.lastEstimate,
        preDriveMin: state.preDriveMin, preDriveSource: state.preDriveSource,
        warnSuppressed: state.warnSuppressed, lastSchedule: state.lastSchedule,
        checkedIn: state.checkedIn, returnActive: state.returnActive,
        completedAt: state.completedAt,
      }));
      localStorage.setItem(LS_SET, JSON.stringify(settings));
    } catch (e) { /* storage full/blocked — app still works for the session */ }
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SET) || 'null');
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
      const r = JSON.parse(localStorage.getItem(LS_ROUTE) || 'null');
      if (r) {
        state.stops = r.stops || [];
        state.origin = r.origin || state.origin;
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
          state.returnActive = false;
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
      }
    } catch (e) {}
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
    } catch (e) {
      settings.serviceTimes = { default: 45, byJobType: {}, known: [] };
    }
    if (settings.defaultStart && state.origin.type === 'gps' && !state.origin.lat) {
      state.origin = { type: 'address', label: settings.defaultStart, lat: null, lng: null };
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
    } catch (e) {}
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
    } catch (e) {}
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
  function nowMinutes() {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
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
    state.returnActive = false;
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
    } catch (e) { /* keep the rough estimate */ }
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
    $('listTitle').textContent = isWorkMode() ? 'Appointments' : 'Stops';
    $('clearAllBtn').style.display = total ? '' : 'none';

    const ul = $('stopList');
    ul.innerHTML = '';
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
            done: false, isLast: false, isFirst: false, confirmed: false, twStart: null, twEnd: null, apptMin: null, source: 'search',
          }]);
          $('searchInput').value = '';
          list.hidden = true;
        };
        list.appendChild(li);
      });
      // "Use what I typed" — Photon often lacks house numbers; Nominatim
      // usually has the full address. Geocode the raw text directly.
      if (q.match(/^\d+\s+\S/)) {
        const li = document.createElement('li');
        li.innerHTML = '➕ <b>Use "' + esc(q) + '"</b><small>Look up this exact address</small>';
        li.onclick = async () => {
          toast('Looking up address…');
          try {
            const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
              encodeURIComponent(q + ', Nashville, TN');
            const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
            const j = await r.json();
            if (!j.length) { toast('Could not find that address'); return; }
            const a = j[0].address || {};
            addStops([{
              id: uid(),
              street: [a.house_number, a.road].filter(Boolean).join(' ') || q,
              city: a.city || a.town || a.village || 'Nashville',
              state: a.state_code || 'TN', zip: a.postcode || '',
              jobType: '', note: '',
              lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon),
              geocodeSource: 'nominatim-manual',
              done: false, isLast: false, isFirst: false,
              confirmed: false, twStart: null, twEnd: null, apptMin: null, source: 'search',
            }]);
            $('searchInput').value = '';
            list.hidden = true;
            toast('✓ Stop added');
          } catch (e) { toast('Lookup failed — are you online?'); }
        };
        list.appendChild(li);
      }
      list.hidden = !(j.features || []).length && !q.match(/^\d+\s+\S/);
    } catch (e) { /* offline — suggestions unavailable */ }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchWrap')) $('suggestList').hidden = true;
  });

  /* ---------- add: manual form ---------- */
  $('manualBtn').onclick = () => {
    const f = $('manualForm');
    f.hidden = !f.hidden;
    $('mJob').style.display = isWorkMode() ? '' : 'none'; // job type is a work concept
    if (!f.hidden) $('mStreet').focus();
  };
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

  function getGps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null), { timeout: 9000, maximumAge: 60000 });
    });
  }

  /* Last known device position (in-memory; refreshed on boot and map open).
   * Powers the "you are here" dot before optimize ever runs. */
  let devicePos = null;
  async function ensureDevicePos() {
    if (devicePos) return devicePos;
    try { devicePos = await getGps(); } catch (e) { devicePos = null; }
    return devicePos;
  }
  /* Adopt the device position as the GPS origin (once known). */
  function adoptDevicePos() {
    if (devicePos && state.origin.type === 'gps' && state.origin.lat == null) {
      state.origin.lat = devicePos.lat; state.origin.lng = devicePos.lng;
      markDirty(); // recompute pre-estimate, save, re-render — no toast
      refreshMap();
    }
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
    } catch (e) { /* fall through — stays unlocated */ }
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
    // origin
    if (state.origin.type === 'gps' && state.origin.lat == null && !o.skipGps) {
      statusFn('Getting your location…');
      const g = await getGps();
      if (g) { state.origin.lat = g.lat; state.origin.lng = g.lng; }
      else { state.origin.label = 'Current location (GPS unavailable)'; }
    } else if (state.origin.type === 'address' && state.origin.lat == null) {
      statusFn('Locating start address…');
      const tmp = { street: state.origin.label };
      if (await geocodeNominatim(tmp).catch(() => false)) {
        state.origin.lat = tmp.lat; state.origin.lng = tmp.lng;
      } else {
        try {
          if (await geocodeArcGIS(tmp)) {
            state.origin.lat = tmp.lat; state.origin.lng = tmp.lng;
          }
        } catch (e) {}
      }
    }
    // stops: Census batch -> ArcGIS -> Nominatim -> suffix retry -> ZIP area
    const missing = state.stops.filter((s) => s.lat == null);
    if (missing.length) {
      statusFn('Locating ' + missing.length + ' address' +
        (missing.length === 1 ? '' : 'es') + '…');
      try { await geocodeCensusBatch(missing); } catch (e) { /* fall through */ }
      let still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        try { await geocodeArcGIS(s); } catch (e) {}
        await sleep(400);
      }
      still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        try { await geocodeNominatim(s); } catch (e) {}
        await sleep(1100); // nominatim politeness
      }
      still = missing.filter((s) => s.lat == null);
      for (const s of still) {
        const expanded = RouteCore.expandStreetSuffix(s.street || '');
        if (expanded && expanded !== s.street) {
          const q = [expanded, s.city, s.state, s.zip].filter(Boolean).join(', ');
          try { await geocodeArcGIS(s, q); } catch (e) {}
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
        try { await showMap(); } catch (e) { /* map needs a connection */ }
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
        try { await geocodeInflight; } catch (e) {}
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
        const simCtx = { windows, departMin, serviceMin, bufferMin: 30 };
        const curSim = RouteCore.simulateSchedule(beforeOrder, durMin, simCtx);
        const late = (vs) => vs.reduce((a, v) => a + (v.lateMin || 0), 0);
        const nv = schedule.violations, cv = curSim.violations;
        return nv.length < cv.length ||
          (nv.length === cv.length && late(nv) < late(cv));
      };
      const showReoptPrompt = () => {
        const names = [];
        try {
          const simCtx = { windows, departMin, serviceMin, bufferMin: 30 };
          const curSim = RouteCore.simulateSchedule(beforeOrder, durMin, simCtx);
          curSim.violations.slice(0, 2).forEach((v) => {
            const pid = points[v.point] && points[v.point]._stopId;
            const s = pid ? byStopId[pid] : null;
            if (s) names.push(stopLabel(s));
          });
        } catch (e) {}
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

  /* ---------- automatic re-optimization engine (v1.9) ----------
   * Fires when: a stop is marked done, a window is confirmed/changed, the
   * app is opened/reopened after 15+ minutes, or the user interacts after
   * 15+ minutes idle. Pulls fresh drive times and re-optimizes around
   * confirmed windows — automatic and seamless. */
  let autoTimer = null, autoInFlight = false, lastAutoOptAt = 0;
  let lastOptAt = 0; // last optimize of any kind (manual or auto) — anti-spam baseline
  let lastInteractionAt = Date.now(), hiddenAt = 0;
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
      doOptimize(true).catch(() => {}).finally(() => {
        autoInFlight = false;
        lastAutoOptAt = Date.now();
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
    } catch (e) {
      prompt('Copy the app link:', url);
    }
  };

  /* ---------- manual update check ---------- */
  $('updateBtn').onclick = async () => {
    toast('Checking for updates…');
    try {
      const resp = await fetch('version.json', { cache: 'no-store' });
      const info = resp.ok ? await resp.json() : null;
      if (!info || !info.version) { toast('Could not check — try again'); return; }
      if (info.version === APP_VERSION) {
        toast('✓ You are on the newest version');
      } else {
        // Clear the stale-update guard so the update always runs.
        ssDel('rr.updating'); ssDel('rr.updating_at');
        applyUpdate(info.version);
      }
    } catch (e) {
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
  let originSearchTimer = null;
  $('originSearchInput').addEventListener('input', (e) => {
    clearTimeout(originSearchTimer);
    const q = e.target.value.trim();
    if (q.length < 4) { $('originSuggestList').hidden = true; return; }
    originSearchTimer = setTimeout(() => searchOriginPhoton(q), 350);
  });
  async function searchOriginPhoton(q) {
    try {
      const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) +
        '&limit=6&lat=36.1627&lon=-86.7816';
      const r = await fetch(url);
      const j = await r.json();
      const list = $('originSuggestList');
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
          state.origin = { type: 'address', label: label, lat, lng };
          $('originSheet').hidden = true;
          markDirty('Start updated');
        };
        list.appendChild(li);
      });
      if (q.match(/^\d+\s+\S/)) {
        const li = document.createElement('li');
        li.innerHTML = '➕ <b>Use "' + esc(q) + '"</b><small>Look up this exact address</small>';
        li.onclick = async () => {
          toast('Looking up address…');
          try {
            const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
              encodeURIComponent(q + ', Nashville, TN');
            const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
            const j = await r.json();
            if (!j.length) { toast('Could not find that address'); return; }
            state.origin = {
              type: 'address', label: j[0].display_name.split(',').slice(0, 2).join(','),
              lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon),
            };
            $('originSheet').hidden = true;
            markDirty('Start updated');
            toast('✓ Start updated');
          } catch (e) { toast('Lookup failed — are you online?'); }
        };
        list.appendChild(li);
      }
      list.hidden = !(j.features || []).length && !q.match(/^\d+\s+\S/);
    } catch (e) { /* offline — suggestions unavailable */ }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#originSearchWrap')) $('originSuggestList').hidden = true;
  });

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
      } catch (e) { /* map draw failures must never break the app */ }
    }, 50);
  }
  $('mapToggle').onclick = async () => {
    const w = $('mapWrap');
    if (!w.hidden) { w.hidden = true; $('mapToggle').textContent = '🗺 Map'; return; }
    try { await showMap(); } catch (e) { toast('Map needs a connection'); }
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
    // return-to-start: show the origin again as the final destination
    if (state.returnActive && state.optimized && state.origin.lat != null) {
      pts.push({ lat: state.origin.lat, lng: state.origin.lng, _return: true });
    }
    pts.forEach((s, i) => {
      const cls = 'pin-num' + (s.isLast ? ' last' : '') + (s.isFirst ? ' first' : '') + (s.done ? ' done' : '') + (s._return ? ' ret' : '');
      const label = s._origin ? '📍' : s._return ? '↩' : (s.isFirst ? '🚩' : (s.isLast ? '🏁' : String(i + (state.origin.lat != null ? 0 : 1))));
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: '<div class="' + cls + '">' + esc(label) + '</div>', iconSize: [28, 28] }),
      }).addTo(mapObj);
      if (!s._origin && !s._return) m.bindPopup(esc(stopLabel(s)));
      if (s._return) m.bindPopup('↩ Return to start');
      mapLayers.push(m);
    });
    const line = pts.filter((p) => !p._origin || true);
    if (line.length > 1) {
      const pl = L.polyline(line.map((p) => [p.lat, p.lng]), { color: '#7c5cff', weight: 4 }).addTo(mapObj);
      mapLayers.push(pl);
    }
    // "You are here" dot — drawn when the device position is known and isn't
    // already represented by the GPS origin marker.
    const originIsDevice = state.origin.type === 'gps' && state.origin.lat != null;
    if (devicePos && !originIsDevice) {
      const dot = L.circleMarker([devicePos.lat, devicePos.lng], {
        radius: 9, color: '#ffffff', weight: 2, fillColor: '#2f7bff', fillOpacity: 1,
      }).addTo(mapObj);
      dot.bindPopup('You are here');
      mapLayers.push(dot);
    }
    const boundPts = pts.map((p) => [p.lat, p.lng]);
    if (devicePos && !originIsDevice) boundPts.push([devicePos.lat, devicePos.lng]);
    if (boundPts.length) mapObj.fitBounds(L.latLngBounds(boundPts).pad(0.15));
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
    state.returnActive = false;
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
    } catch (e) {}
    try {
      toast('Checking for updates…');
      const resp = await fetch('version.json', { cache: 'no-store' });
      const info = resp.ok ? await resp.json() : null;
      if (info && info.version && info.version !== APP_VERSION) {
        applyUpdate(info.version); // toasts, backs up again, reloads
        return;
      }
    } catch (e) { /* offline or check failed — plain reload is still safe */ }
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
  function startAutoCheckinWatch() {
    stopAutoCheckinWatch();
    if (!('geolocation' in navigator)) return;
    if (!isWorkMode() || !settings.autoCheckin) return;
    try {
      autoCheckinWatchId = navigator.geolocation.watchPosition((pos) => {
        if (!isWorkMode() || !settings.autoCheckin) return;
        if (state.checkedIn) return; // already in service somewhere
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        // find the nearest not-done stop with coordinates within 100m
        let best = null, bestD = 100;
        for (const s of state.stops) {
          if (s.done || s.lat == null || s.lng == null) continue;
          const d = haversineM(lat, lng, s.lat, s.lng);
          if (d < bestD) { bestD = d; best = s; }
        }
        if (best) {
          state.checkedIn = { stopId: best.id, startedAt: Date.now(), auto: true };
          save(); render();
          toast('📍 Auto checked in — ' + serviceMinFor(best) + ' min service timer running');
          maybeAutoReopt('checkin');
        }
      }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
    } catch (e) {}
  }
  function stopAutoCheckinWatch() {
    if (autoCheckinWatchId != null && 'geolocation' in navigator) {
      try { navigator.geolocation.clearWatch(autoCheckinWatchId); } catch (e) {}
    }
    autoCheckinWatchId = null;
  }

  /* ---------- settings ---------- */
  $('settingsBtn').onclick = () => {
    $('setStart').value = settings.defaultStart;
    $('setTolls').checked = settings.avoidTolls;
    $('setHwy').checked = settings.avoidHwy;
    $('setReturn').checked = settings.returnToStart;
    $('setHistory').checked = settings.saveHistory;
    $('setAutoCheckin').checked = !!settings.autoCheckin;
    $('setAutoConfirm').checked = !!settings.autoConfirmAll;
    $('setMode').value = settings.mode || 'work';
    updateModeHint();
    renderServiceTimes();
    $('settingsSheet').hidden = false;
  };
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
      } catch (e) { toast('Address lookup failed'); }
    }, () => toast('Location unavailable'), { timeout: 10000 });
  };
  function updateModeHint() {
    const h = $('modeHint');
    if (h) h.textContent = isWorkMode()
      ? 'Work mode: confirmed windows, check-in, notes, job types.'
      : 'Personal mode: just stops — first/last pins stay, work features hide.';
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
    toast(settings.mode === 'personal' ? 'Personal mode — work features hidden' : 'Work mode');
  });
  $('settingsClose').onclick = () => {
    const retBefore = settings.returnToStart;
    settings.defaultStart = $('setStart').value.trim();
    settings.avoidTolls = $('setTolls').checked;
    settings.avoidHwy = $('setHwy').checked;
    settings.returnToStart = $('setReturn').checked;
    settings.saveHistory = $('setHistory').checked;
    const acBefore = !!settings.autoCheckin;
    settings.autoCheckin = $('setAutoCheckin').checked;
    const acfBefore = !!settings.autoConfirmAll;
    settings.autoConfirmAll = $('setAutoConfirm').checked;
    if (settings.returnToStart !== retBefore) {
      // the route shape changed (return leg added/removed) — re-optimize needed
      state.optimized = false; state.returnActive = false;
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
  const UI_KEY = 'rr.ui.v1';
  function saveUIState() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        y: window.scrollY || 0,
        mapOpen: !$('mapWrap').hidden,
        settingsOpen: !$('settingsSheet').hidden,
        draft: $('searchInput') ? $('searchInput').value : '',
      }));
    } catch (e) { /* storage unavailable — restore just skips */ }
  }
  function restoreUIState() {
    let ui = null;
    try { ui = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) {}
    if (!ui) return;
    if (ui.draft && $('searchInput')) $('searchInput').value = ui.draft;
    if (ui.mapOpen && $('mapWrap').hidden) showMap().catch(() => {});
    if (ui.settingsOpen && $('settingsSheet').hidden) $('settingsBtn').click();
    if (ui.y) window.scrollTo(0, ui.y);
  }
  let lastUpdateCheck = 0;
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
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
    ssSet('rr.updating', '1');
    try {
      const route = localStorage.getItem(LS_ROUTE);
      if (route) localStorage.setItem('rr.route.backup', route);
      const set = localStorage.getItem(LS_SET);
      if (set) localStorage.setItem('rr.settings.backup', set);
    } catch (e) {}
    saveUIState();
    toast('Updating to the latest version…');
    let done = false;
    const cacheBust = () => {
      if (done) return; done = true;
      try {
        const u = new URL(location.href);
        u.searchParams.set('v', serverVersion);
        location.href = u.toString();
      } catch (e) { location.reload(); }
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
    } catch (e) {
      cacheBust();
    }
  }

  /* ---------- boot ---------- */
  load();
  if (!loadSharedRoute()) render();
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('v')) {
      u.searchParams.delete('v');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch (e) {}
  restoreUIState();
  checkForUpdate();
  // Resume auto check-in watch if it was on (work mode only).
  if (settings.autoCheckin && isWorkMode()) startAutoCheckinWatch();
  // Ask for location services right on launch: the permission prompt appears
  // immediately, and the map can show "you are here" before optimize runs.
  if (state.origin.type === 'gps' && state.origin.lat == null) {
    ensureDevicePos().then(adoptDevicePos);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); saveUIState(); }
    else {
      // auto-delete check: a route completed yesterday is wiped on return
      if (state.completedAt && !isSameDay(state.completedAt, Date.now()) &&
          state.stops.length && state.stops.every((x) => x.done)) {
        wipeRouteData();
        state.stops = []; state.completedAt = null;
        state.optimized = false; state.lastSchedule = null; state.returnActive = false;
        save(); render();
        toast('Yesterday\'s completed route was cleared');
      }
      checkForUpdate(); maybeAutoReopt('visible');
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
