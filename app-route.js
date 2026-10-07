/* app-route.js — reset, proximity check-in, drive-away (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, APP_VERSION:writable, LS_ROUTE:writable, LS_SET:writable, _crumb:writable, _event:writable, applyUpdate:writable, checkinAtGps:writable, devMode:writable, endLegTracking:writable, endResolved:writable, geocodeInflight:writable, isWorkMode:writable, maybeAutoReopt:writable, render:writable, renderSavedLocations:writable, renderServiceTimes:writable, save:writable, saveUIState:writable, serviceMinFor:writable, settings:writable, state:writable, stopLabel:writable, toast:writable, trackDepartureLeg:writable, updateModeHint:writable, wipeRouteData:writable */ // eslint-disable-line no-unused-vars
/* exported resetRoute, haversineM, checkProximityCheckin, clearDriveAway, evaluateDriveAway, driveAwayAtGps, startDriveAwayWatch, startAutoCheckinWatch, stopAutoCheckinWatch */
'use strict';

  function resetRoute(fromSettings) {
    if (!state.stops.length) return;
    if (!confirm('Clear all ' + state.stops.length + ' stops and start a fresh route?')) return;
    _crumb('clearing_route');
    state.stops = [];
    state.optimized = false;
    state.tripStart = null; // reset: START reverts to live GPS ("Current location")
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
    clearDriveAway();
    state.lastSchedule = null;
    state.returnActive = false; state.endActive = false;
    endResolved = null; // item 4: no stale end point survives a route clear
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
      clearDriveAway(); // new service: fresh window
      _crumb('checking_in');
      _event('check_in', {});
      save(); render();
      toast('📍 Auto checked in — ' + serviceMinFor(best) + ' min service timer running');
      maybeAutoReopt('checkin');
    }
  }
  /* ---------- drive-away auto-complete (six items item 2, 2026-10-05) ----------
   * Fires in BOTH work and personal modes whenever a check-in is active.
   * The window evaluator (RouteCore.driveAwayWindowFires) demands all four
   * gates: 5+ min of service, 4 consecutive ≤75 m-accuracy readings all
   * >150 m from the stop, monotonic recession (or clearly receding), and an
   * independent speed signal > 2.5 m/s. A parked phone with drifting fixes
   * cannot satisfy all four. On fire, the manual check-out sequence runs:
   * the stop is marked done, the leg to the next stop starts tracking
   * (traffic learning), and the route re-optimizes. */
  let driveAwayBuf = []; // ring of recent readings: {at, d, accuracy, speed}
  let driveAwayPollId = null;
  function clearDriveAway() { driveAwayBuf = []; }
  function evaluateDriveAway(lat, lng, accuracy, speedMps, atMs) {
    const ci = state.checkedIn;
    if (!ci) { clearDriveAway(); return; }
    const s = state.stops.find((x) => x.id === ci.stopId);
    if (!s) { state.checkedIn = null; clearDriveAway(); return; } // stop deleted mid-service
    if (s.done || typeof s.lat !== 'number' || typeof s.lng !== 'number') {
      clearDriveAway();
      return;
    }
    driveAwayBuf.push({
      at: atMs,
      d: haversineM(s.lat, s.lng, lat, lng),
      accuracy: accuracy,
      speed: speedMps,
    });
    if (driveAwayBuf.length > 16) driveAwayBuf.splice(0, driveAwayBuf.length - 16);
    if (driveAwayBuf.length < 4) return;
    // Dev sim: readings arrive seconds apart — waive the 5-minute minimum so
    // the drive-away path is testable without wall-clock waiting. Production
    // behavior is untouched (devMode never activates in normal use).
    const minServiceMs = devMode.active ? 0 : 300000;
    if (!RouteCore.driveAwayWindowFires(driveAwayBuf, ci.startedAt, atMs, minServiceMs)) return;
    // Fire: exactly the manual check-out sequence, plus departure tracking.
    state.checkedIn = null;
    clearDriveAway();
    s.done = true;
    _event('stop_completed', {});
    trackDepartureLeg();
    if (state.stops.length && state.stops.every((x) => x.done)) {
      state.completedAt = Date.now();
    }
    save(); render();
    maybeAutoReopt('done');
    toast('✅ Auto-completed — drove away from ' + stopLabel(s));
  }
  /* Route one GPS fix through the drive-away evaluator. Dev override wins
   * when active so the simulator drives the test. */
  function driveAwayAtGps(pos) {
    if (!state.checkedIn) return;
    if (devMode.active && devMode.pos) {
      evaluateDriveAway(devMode.pos.lat, devMode.pos.lng, 5, null, Date.now());
    } else if (pos && pos.coords) {
      const sp = pos.coords.speed;
      evaluateDriveAway(pos.coords.latitude, pos.coords.longitude,
        pos.coords.accuracy,
        (typeof sp === 'number' && isFinite(sp)) ? sp : null,
        Date.now());
    }
  }
  /* Background delivery: iOS suspends watchPosition when backgrounded, so a
   * 60 s getCurrentPosition poll (same pattern as the auto-check-in fallback)
   * plus a visibilitychange evaluation covers the checked-in state. No new
   * permissions; the poll no-ops unless a check-in is active. */
  function startDriveAwayWatch() {
    if (driveAwayPollId != null || !('geolocation' in navigator)) return;
    try {
      driveAwayPollId = setInterval(() => {
        if (!state.checkedIn) return;
        navigator.geolocation.getCurrentPosition((pos) => {
          driveAwayAtGps(pos);
        }, () => {}, { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 });
      }, 60000);
    } catch {}
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
    _crumb('opening_settings');
    $('setTolls').checked = settings.avoidTolls;
    $('setHwy').checked = settings.avoidHwy;
    $('setReturn').checked = settings.returnToStart;
    $('setHistory').checked = settings.saveHistory;
    $('setAutoCheckin').checked = !!settings.autoCheckin;
    $('setAutoConfirm').checked = !!settings.autoConfirmAll;
    $('setEarlySuggest').checked = settings.earlySuggest !== false;
    $('setMode').value = settings.mode || 'work';
    updateModeHint();
    renderServiceTimes();
    renderSavedLocations();
    $('settingsSheet').hidden = false;
  };
  /* ---------- saved locations settings UI (spec §2) ---------- */
