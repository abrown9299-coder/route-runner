/* app-gps.js — device GPS tracking, dev-mode simulator (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, checkProximityCheckin:writable, deviceDot:writable, devicePos:writable, deviceWatchId:writable, driveAwayAtGps:writable, ensureDevicePos:writable, evaluateDriveAway:writable, haversineM:writable, mapObj:writable, markDirty:writable, noteLegPosition:writable, refreshMap:writable, render:writable, save:writable, state:writable, toast:writable */ // eslint-disable-line no-unused-vars
/* exported startDeviceTracking, adoptDevicePos, devMode, setDevicePosFromGps, checkinAtGps, legTrack, STATIONARY_DISCARD_MS */
'use strict';

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
        driveAwayAtGps(pos); // drive-away auto-complete (no-op unless checked in)
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
   * Short-circuits when inactive: zero production behavior change.
   * speedMps: simulated speed (devSimTick passes the effective speed) so the
   * drive-away speed gate can be exercised. */
  function devSetPos(lat, lng, speedMps) {
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
    // Drive-away auto-complete against the virtual position (tests the 4-gate trigger).
    evaluateDriveAway(lat, lng, 5,
      (typeof speedMps === 'number' && isFinite(speedMps)) ? speedMps : null,
      Date.now());
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
    devSetPos(next.lat, next.lng, DEV_WALK_MPS * mult);
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

