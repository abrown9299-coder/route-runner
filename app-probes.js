/* app-probes.js — anonymous traffic probe capture (split 2026-10-07)
 *
 * Samples GPS fixes into coarse, anonymous traffic probes uploaded to the
 * backend for segment-speed learning. Privacy (non-negotiable):
 *  - Coordinates coarsened to 3 decimals (~110m) AT CAPTURE — the precise
 *    fix never leaves the device.
 *  - Probes carry {lat, lon, spd, hdg, t, acc} and nothing else. No stop IDs,
 *    no route IDs, no names, no addresses.
 *  - Glitch filtering: fixes worse than 100m accuracy are dropped; the
 *    first 2 fixes after GPS re-acquire are dropped (warm-up wander).
 *  - Dwell filtering (E3): parked at a planned stop = work, not traffic.
 *    Probes near a planned stop while stationary are dropped locally.
 *
 * Adaptive sampling (E2): base 20s moving / 60s stationary, immediate sample
 * on speed swing > 3 m/s or heading change > 45°, relax to 45s on steady
 * cruise. Bounds: 5s min, 120s max. Zero extra GPS wakeups — hooks the
 * existing watchPosition callback in app-gps.js.
 *
 * Kill switch: probeIntervalMs = 0 disables all sampling (set from the
 * /v1/events response by stats-report.js).
 */
/* global state: readonly */
/* exported noteProbeFix, bufferProbe, flushProbeBuffer, coarsen3, probeShouldSample, probeDwellCheck, probeGlitchCheck, resetProbeState, resetProbeCapture, setProbeIntervalMs, getProbeIntervalMs */
'use strict';

  /* ---------- tunables (from stats-config.js when present) ---------- */
  var PROBE_MIN_MS = 5000;    // never sample faster than this
  var PROBE_MAX_MS = 120000;  // never sample slower than this
  var PROBE_BASE_MOVING_MS = 20000;
  var PROBE_BASE_STATIONARY_MS = 60000;
  var PROBE_RELAXED_MS = 45000; // steady cruise cadence
  var PROBE_EVENT_SPEED_DELTA = 3;   // m/s swing vs EMA -> immediate sample
  var PROBE_EVENT_HEADING_DELTA = 45; // degrees -> immediate sample
  var PROBE_STEADY_N = 5;      // consecutive steady fixes before relaxing
  var PROBE_STEADY_TOL = 1;    // m/s
  var PROBE_EMA_ALPHA = 0.3;
  var PROBE_GLITCH_ACC_M = 100; // drop fixes worse than this
  var PROBE_WARMUP_N = 2;       // drop first N fixes after re-acquire
  var PROBE_DWELL_SPEED = 1.5;  // m/s — below this counts as stopped
  var PROBE_DWELL_MS = 3 * 60 * 1000; // stopped this long near a stop = dwell
  var PROBE_DWELL_RADIUS_M = 150;     // within this of a planned stop

  var probeIntervalMs = -1; // -1 = adaptive (default); 0 = kill switch off; >0 = fixed override

  function setProbeIntervalMs(ms) {
    probeIntervalMs = (typeof ms === 'number' && isFinite(ms) && ms >= 0) ? ms : -1;
  }
  function getProbeIntervalMs() { return probeIntervalMs; }

  /* ---------- pure helpers (exported for tests) ---------- */

  function coarsen3(x) {
    if (typeof x !== 'number' || !isFinite(x)) return null;
    return Math.round(x * 1000) / 1000;
  }

  function haversineM(aLat, aLng, bLat, bLng) {
    var R = 6371000, toRad = function (x) { return x * Math.PI / 180; };
    var dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function headingDelta(a, b) {
    if (a == null || b == null) return 0;
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* Should this fix be dropped as a glitch? Pure function of the fix +
   * warmup counter. Returns {drop, warmupCount}. */
  function probeGlitchCheck(accuracy, warmupCount) {
    if (typeof accuracy === 'number' && accuracy > PROBE_GLITCH_ACC_M) {
      return { drop: true, warmupCount: warmupCount };
    }
    if (warmupCount < PROBE_WARMUP_N) {
      return { drop: true, warmupCount: warmupCount + 1 };
    }
    return { drop: false, warmupCount: warmupCount };
  }

  /* Dwell check (E3). state: {dwellStartAt, dwellLat, dwellLng} or null.
   * Returns {drop, state}. Drops only when stopped 3+ min within 150m of a
   * planned stop. Slow/stopped elsewhere = congestion -> upload. */
  function probeDwellCheck(dwellState, fix, stops, now) {
    var speed = fix.speed;
    var stopped = (typeof speed === 'number' && speed < PROBE_DWELL_SPEED);
    if (!stopped) return { drop: false, state: null };
    var nearStop = false;
    if (Array.isArray(stops)) {
      for (var i = 0; i < stops.length; i++) {
        var s = stops[i];
        if (s && s.lat != null && s.lng != null && !s.done) {
          if (haversineM(fix.lat, fix.lng, s.lat, s.lng) <= PROBE_DWELL_RADIUS_M) {
            nearStop = true;
            break;
          }
        }
      }
    }
    if (!nearStop) return { drop: false, state: null }; // congestion signal
    if (!dwellState) {
      return { drop: false, state: { dwellStartAt: now, dwellLat: fix.lat, dwellLng: fix.lng } };
    }
    // Moved away? Reset.
    if (haversineM(fix.lat, fix.lng, dwellState.dwellLat, dwellState.dwellLng) > PROBE_DWELL_RADIUS_M) {
      return { drop: false, state: null };
    }
    if (now - dwellState.dwellStartAt >= PROBE_DWELL_MS) {
      return { drop: true, state: dwellState }; // service dwell: drop
    }
    return { drop: false, state: dwellState };
  }

  /* Adaptive sampling decision (E2). fix: {lat, lng, speed, heading, t}.
   * st: {emaSpeed, lastProbeAt, lastProbeHeading, steadyCount} (mutated).
   * Returns true when a probe should be captured now. */
  function probeShouldSample(st, fix) {
    var now = fix.t;
    if (probeIntervalMs === 0) return false; // kill switch
    if (probeIntervalMs > 0) {
      // Fixed override (server-directed cadence).
      if (st.lastProbeAt == null || now - st.lastProbeAt >= probeIntervalMs) {
        st.lastProbeAt = now;
        return true;
      }
      return false;
    }
    var speed = (typeof fix.speed === 'number' && isFinite(fix.speed)) ? fix.speed : 0;
    // Update EMA.
    st.emaSpeed = (st.emaSpeed == null) ? speed
      : st.emaSpeed + PROBE_EMA_ALPHA * (speed - st.emaSpeed);
    var since = (st.lastProbeAt == null) ? Infinity : now - st.lastProbeAt;
    // Event triggers: sharp speed swing or turn -> sample now.
    var swing = Math.abs(speed - st.emaSpeed);
    var hdg = headingDelta(st.lastProbeHeading, fix.heading);
    if (st.lastProbeAt != null && since >= PROBE_MIN_MS &&
        (swing > PROBE_EVENT_SPEED_DELTA || hdg > PROBE_EVENT_HEADING_DELTA)) {
      st.lastProbeAt = now;
      st.lastProbeHeading = (typeof fix.heading === 'number') ? fix.heading : st.lastProbeHeading;
      st.steadyCount = 0;
      return true;
    }
    // Steady-cruise detection -> relax cadence.
    if (Math.abs(speed - st.emaSpeed) < PROBE_STEADY_TOL) st.steadyCount++;
    else st.steadyCount = 0;
    var moving = speed > PROBE_DWELL_SPEED;
    var base = moving ? PROBE_BASE_MOVING_MS : PROBE_BASE_STATIONARY_MS;
    if (st.steadyCount >= PROBE_STEADY_N) base = PROBE_RELAXED_MS;
    if (base > PROBE_MAX_MS) base = PROBE_MAX_MS;
    if (st.lastProbeAt == null || since >= base) {
      st.lastProbeAt = now;
      st.lastProbeHeading = (typeof fix.heading === 'number') ? fix.heading : st.lastProbeHeading;
      return true;
    }
    return false;
  }

  function resetProbeState() {
    return { emaSpeed: null, lastProbeAt: null, lastProbeHeading: null, steadyCount: 0 };
  }

  /* ---------- capture entry point (called from app-gps.js watchPosition) ---------- */

  var _probeState = resetProbeState();
  var _dwellState = null;
  var _warmupCount = PROBE_WARMUP_N; // start warm: first fixes are wander-prone

  /* fix: {lat, lng, accuracy, speed, heading, t}. Returns the probe object
   * or null (dropped / not due / kill switch). Never throws. */
  function noteProbeFix(fix) {
    try {
      if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number') return null;
      if (!isFinite(fix.lat) || !isFinite(fix.lng)) return null;
      if (Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) return null;
      var now = (typeof fix.t === 'number') ? fix.t : Date.now();
      // Glitch filter.
      var g = probeGlitchCheck(fix.accuracy, _warmupCount);
      _warmupCount = g.warmupCount;
      if (g.drop) return null;
      // Dwell filter (needs the route's stop list; app-state's `state`).
      var stops = [];
      try { stops = (typeof state !== 'undefined' && state && state.stops) || []; } catch {}
      var d = probeDwellCheck(_dwellState, {
        lat: fix.lat, lng: fix.lng,
        speed: (typeof fix.speed === 'number') ? fix.speed : 0,
      }, stops, now);
      _dwellState = d.state;
      if (d.drop) return null;
      // Adaptive cadence.
      var f = {
        lat: fix.lat, lng: fix.lng,
        speed: (typeof fix.speed === 'number' && isFinite(fix.speed)) ? fix.speed : 0,
        heading: (typeof fix.heading === 'number' && isFinite(fix.heading)) ? fix.heading : null,
        t: now,
      };
      if (!probeShouldSample(_probeState, f)) return null;
      // Coarsen AT CAPTURE — precise fix never serialized.
      var clat = coarsen3(fix.lat), clng = coarsen3(fix.lng);
      if (clat == null || clng == null) return null;
      var acc = (typeof fix.accuracy === 'number' && isFinite(fix.accuracy) && fix.accuracy >= 0)
        ? Math.round(fix.accuracy) : null;
      return { lat: clat, lon: clng, spd: Math.round(f.speed * 10) / 10, hdg: f.heading, t: Math.floor(now / 1000), acc: acc };
    } catch { return null; }
  }

  /* Probe buffer: accumulate probes from noteProbeFix and hand them to the
   * stats queue in small batches (avoids a localStorage write per fix). */
  var _probeBuffer = [];
  var PROBE_BUFFER_FLUSH_N = 10;

  function bufferProbe(probe) {
    if (!probe) return;
    _probeBuffer.push(probe);
    if (_probeBuffer.length >= PROBE_BUFFER_FLUSH_N) flushProbeBuffer();
  }

  function flushProbeBuffer() {
    if (!_probeBuffer.length) return;
    try {
      if (typeof window !== 'undefined' && window.Stats &&
          typeof window.Stats.queueProbes === 'function') {
        window.Stats.queueProbes(_probeBuffer);
      }
    } catch {}
    _probeBuffer = [];
  }

  /* Reset module state (tests + GPS re-acquire). */
  function resetProbeCapture() {
    _probeState = resetProbeState();
    _dwellState = null;
    _warmupCount = 0; // explicit reset (e.g. test) skips the boot warmup
    _probeBuffer = [];
  }

  /* CJS interop for Vitest (same pattern as core.js / stats-report.js). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      coarsen3: coarsen3,
      haversineM: haversineM,
      headingDelta: headingDelta,
      probeGlitchCheck: probeGlitchCheck,
      probeDwellCheck: probeDwellCheck,
      probeShouldSample: probeShouldSample,
      resetProbeState: resetProbeState,
      noteProbeFix: noteProbeFix,
      bufferProbe: bufferProbe,
      flushProbeBuffer: flushProbeBuffer,
      resetProbeCapture: resetProbeCapture,
      setProbeIntervalMs: setProbeIntervalMs,
      getProbeIntervalMs: getProbeIntervalMs,
    };
  }
