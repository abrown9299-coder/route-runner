/* stats-report.js — reporting pipeline + window.Stats (split from stats.js 2026-10-06) */
/* global BATCH_MAX, CRUMB_NAMES, CRUMB_SET, ENGINES, ERRORS_PATH, ERROR_KINDS, ERR_QUEUE_CAP, ERR_RATE_MAX, ERR_RATE_WINDOW_MS, EVENTS_PATH, EVENT_META_KEYS, EVENT_TYPES, FLUSH_MS, PROBE_BATCH_MAX, PROBE_FLUSH_MS, GATEWAY, GATEWAY_PLACEHOLDER, INGEST_KEY, KEY_PLACEHOLDER, LS_CRUMBS, LS_DROPPED, LS_ERRORS, LS_ERR_WINDOW, LS_PROBE_QUEUE, LS_QUEUE, QUEUE_CAP, appVersion, basename, deviceType, getDeviceId, lsJsonGet, lsJsonSet, sanitizeMessage, sanitizeStack, setProbeIntervalMs: readonly */
'use strict';


  function statsEnabled() {
    if (!INGEST_KEY || INGEST_KEY === KEY_PLACEHOLDER) return false;
    if (!GATEWAY || GATEWAY === GATEWAY_PLACEHOLDER) return false;
    var v = appVersion();
    if (!v || v === 'dev' || v.indexOf('__BUILD__') !== -1) return false;
    return true;
  }

  /* ---------- module state ---------- */
  var S = {
    inited: false,
    enabled: false,
    deviceId: null,
    appVer: null,
    crumbs: [],
    flushing: false,
    inErrorHandler: false, // re-entrancy guard: reporting must never report itself
  };

  function basePayload() {
    return {
      device_id: S.deviceId,
      app_version: S.appVer,
      device_type: deviceType(),
      ingest_key: INGEST_KEY, // body field: beacon-compatible (sendBeacon can't set headers)
    };
  }

  /* ---------- transport ---------- */
  function postJson(url, body) {
    // Every fetch path handles failure: resolve false, never reject, never throw.
    try {
      if (typeof fetch === 'undefined') return Promise.resolve(false);
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (resp) {
        if (!resp || !resp.ok) return false;
        return resp.json().then(
          function (j) { return !!(j && j.ok); },
          function () { return false; }
        );
      }).catch(function () { return false; });
    } catch { return Promise.resolve(false); }
  }

  function tryBeacon(url, body) {
    try {
      if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
      var payload = body;
      try { payload = new Blob([body], { type: 'application/json' }); } catch {}
      return !!navigator.sendBeacon(url, payload);
    } catch { return false; }
  }

  function tryKeepalive(url, body) {
    try {
      if (typeof fetch === 'undefined') return false;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
      return true; // dispatched; the page is going away — treat as sent
    } catch { return false; }
  }

  function beaconSend(url, obj) {
    var body;
    try { body = JSON.stringify(obj); } catch { return false; }
    if (tryBeacon(url, body)) return true;
    return tryKeepalive(url, body);
  }

  /* ---------- event queue ---------- */
  function enqueueEvent(type, meta) {
    var q = lsJsonGet(LS_QUEUE, []);
    if (!Array.isArray(q)) q = [];
    q.push({ type: type, ts: Date.now(), meta: meta });
    while (q.length > QUEUE_CAP) q.shift(); // drop oldest on overflow
    lsJsonSet(LS_QUEUE, q);
  }

  function flushEvents() {
    // Returns 'sent' | 'empty' | 'failed' (failure keeps the queue for the next trigger).
    var q = lsJsonGet(LS_QUEUE, []);
    if (!Array.isArray(q) || !q.length) return Promise.resolve('empty');
    var batch = q.slice(0, BATCH_MAX);
    var payload = basePayload();
    payload.events = batch;
    return postJsonFull(GATEWAY + EVENTS_PATH, payload).then(function (res) {
      if (!res || !res.ok) return 'failed';
      applyProbeKillSwitch(res.body);
      // Re-read: the queue may have grown during the POST. Remove exactly
      // the sent slice (new events append at the end).
      var rest = lsJsonGet(LS_QUEUE, []);
      if (Array.isArray(rest)) lsJsonSet(LS_QUEUE, rest.slice(batch.length));
      return 'sent';
    });
  }

  /* POST returning {ok, body} so callers can read server directives
   * (the probe kill switch). Never rejects, never throws. */
  function postJsonFull(url, body) {
    try {
      if (typeof fetch === 'undefined') return Promise.resolve(null);
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (resp) {
        if (!resp || !resp.ok) return null;
        return resp.json().then(
          function (j) { return { ok: !!(j && j.ok), body: j }; },
          function () { return { ok: false, body: null }; }
        );
      }).catch(function () { return null; });
    } catch { return Promise.resolve(null); }
  }

  /* Server kill switch for probe sampling: /v1/events may return
   * {probe_interval_s: N}. 0 disables sampling; positive sets a fixed
   * cadence; absent/negative leaves adaptive mode. Never throws. */
  function applyProbeKillSwitch(body) {
    try {
      if (!body || typeof body.probe_interval_s === 'undefined') return;
      var s = body.probe_interval_s;
      if (typeof s !== 'number' || !isFinite(s) || s < 0) return;
      if (typeof setProbeIntervalMs === 'function') {
        setProbeIntervalMs(s === 0 ? 0 : Math.round(s * 1000));
      }
    } catch {}
  }

  /* Queue raw probes to the dedicated probe queue (separate from the stats
   * event queue — probes flush to /v1/traffic/probes on their own cadence).
   * Probes must already be coarsened/filtered by app-probes.js. */
  function queueProbes(probes) {
    if (!S.inited || !S.enabled) return false;
    if (!Array.isArray(probes) || !probes.length) return false;
    var q = lsJsonGet(LS_PROBE_QUEUE, []);
    if (!Array.isArray(q)) q = [];
    for (var i = 0; i < probes.length; i++) q.push(probes[i]);
    while (q.length > QUEUE_CAP) q.shift(); // drop oldest on overflow
    lsJsonSet(LS_PROBE_QUEUE, q);
    return true;
  }

  var PROBES_PATH = '/v1/traffic/probes';

  /* Flush the probe queue to /v1/traffic/probes. Same semantics as
   * flushEvents: failure keeps the queue for the next trigger. */
  function flushProbes() {
    if (!S.inited || !S.enabled) return Promise.resolve(false);
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
    } catch {}
    var q = lsJsonGet(LS_PROBE_QUEUE, []);
    if (!Array.isArray(q) || !q.length) return Promise.resolve('empty');
    var batch = q.slice(0, PROBE_BATCH_MAX);
    var payload = basePayload();
    payload.probes = batch;
    return postJson(GATEWAY + PROBES_PATH, payload).then(function (ok) {
      if (!ok) return 'failed';
      var rest = lsJsonGet(LS_PROBE_QUEUE, []);
      if (Array.isArray(rest)) lsJsonSet(LS_PROBE_QUEUE, rest.slice(batch.length));
      return 'sent';
    });
  }

  function flushErrors() {
    // Returns 'sent' | 'empty' | 'failed'. Individual POSTs, in order (errors
    // are rare; each carries its own stack). Stops at the first failure.
    var q = lsJsonGet(LS_ERRORS, []);
    if (!Array.isArray(q) || !q.length) return Promise.resolve('empty');
    var seq = Promise.resolve('empty');
    var failed = false;
    q.forEach(function (rep) {
      seq = seq.then(function (status) {
        if (failed) return status;
        return postJson(GATEWAY + ERRORS_PATH, rep).then(function (ok) {
          if (!ok) { failed = true; return 'failed'; }
          var rest = lsJsonGet(LS_ERRORS, []);
          if (Array.isArray(rest) && rest.length) lsJsonSet(LS_ERRORS, rest.slice(1));
          return 'sent';
        });
      });
    });
    return seq;
  }

  function flush() {
    if (!S.inited || !S.enabled) return Promise.resolve(false);
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
    } catch {}
    // Overlapping flushes are skipped: the in-flight flush re-reads both
    // queues before settling, so work queued mid-flush is still picked up.
    if (S.flushing) return Promise.resolve(false);
    S.flushing = true;
    var settle = function (r) { S.flushing = false; return r; };
    var batches = 0;
    var loop = function () {
      batches++;
      return flushEvents().then(function (evRes) {
        return flushErrors().then(function (errRes) {
          if (evRes === 'failed' || errRes === 'failed') return true; // keep for the next trigger
          if (batches >= 10) return true; // bound the work per flush call (10 x 50 = the queue cap)
          var q = lsJsonGet(LS_QUEUE, []), eq = lsJsonGet(LS_ERRORS, []);
          var pending = (Array.isArray(q) && q.length > 0) || (Array.isArray(eq) && eq.length > 0);
          return pending ? loop() : true;
        });
      });
    };
    return loop().then(
      function () { return settle(true); },
      function () { return settle(false); }
    );
  }

  /* pagehide: final best-effort flush. sendBeacon first, fetch(keepalive)
   * fallback — both work on iOS Safari >= 11.1 and Android Chrome. */
  function flushBeacon() {
    if (!S.inited || !S.enabled) return;
    try {
      var q = lsJsonGet(LS_QUEUE, []);
      if (Array.isArray(q) && q.length) {
        var batch = q.slice(0, BATCH_MAX);
        var payload = basePayload();
        payload.events = batch;
        if (beaconSend(GATEWAY + EVENTS_PATH, payload)) {
          var rest = lsJsonGet(LS_QUEUE, []);
          if (Array.isArray(rest)) lsJsonSet(LS_QUEUE, rest.slice(batch.length));
        }
      }
      var eq = lsJsonGet(LS_ERRORS, []);
      if (Array.isArray(eq) && eq.length) {
        var kept = [];
        for (var i = 0; i < eq.length; i++) {
          if (!beaconSend(GATEWAY + ERRORS_PATH, eq[i])) kept.push(eq[i]);
        }
        lsJsonSet(LS_ERRORS, kept);
      }
      // Probe queue: best-effort beacon flush on pagehide.
      var pq = lsJsonGet(LS_PROBE_QUEUE, []);
      if (Array.isArray(pq) && pq.length) {
        var pb = pq.slice(0, PROBE_BATCH_MAX);
        var ppayload = basePayload();
        ppayload.probes = pb;
        if (beaconSend(GATEWAY + PROBES_PATH, ppayload)) {
          var prest = lsJsonGet(LS_PROBE_QUEUE, []);
          if (Array.isArray(prest)) lsJsonSet(LS_PROBE_QUEUE, prest.slice(pb.length));
        }
      }
    } catch {}
  }

  /* ---------- breadcrumbs ---------- */
  function crumb(name) {
    if (!S.inited || !S.enabled) return false;
    if (!CRUMB_SET[name]) return false; // unknown names silently ignored — never stored, never sent
    S.crumbs.push(name);
    if (S.crumbs.length > 10) S.crumbs = S.crumbs.slice(-10);
    lsJsonSet(LS_CRUMBS, S.crumbs); // persisted so a crash-reload keeps the trail
    return true;
  }

  /* ---------- events ---------- */
  function validMeta(type, meta) {
    var allowed = EVENT_META_KEYS[type];
    for (var k in meta) {
      if (Object.prototype.hasOwnProperty.call(meta, k) && allowed.indexOf(k) === -1) return null;
    }
    var clean = {};
    for (var i = 0; i < allowed.length; i++) {
      var key = allowed[i];
      if (!Object.prototype.hasOwnProperty.call(meta, key)) continue;
      var v = meta[key];
      if (key === 'stop_count') {
        if (!Number.isInteger(v) || v < 0 || v > 500) return null;
        clean[key] = v;
      } else if (key === 'had_windows') {
        if (typeof v !== 'boolean') return null;
        clean[key] = v;
      } else if (key === 'engine') {
        if (ENGINES.indexOf(v) === -1) return null;
        clean[key] = v;
      } else if (key === 'probes') {
        // traffic_probes: array of probe objects, max PROBE_BATCH_MAX.
        // Each probe: {lat, lon, spd, hdg, t, acc} — validated field by field;
        // the whole event is dropped if any probe is malformed (never poison).
        if (!Array.isArray(v) || !v.length || v.length > PROBE_BATCH_MAX) return null;
        var cleanProbes = [];
        for (var pi = 0; pi < v.length; pi++) {
          var p = v[pi];
          if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
          var plat = p.lat, plon = p.lon;
          if (typeof plat !== 'number' || typeof plon !== 'number' ||
              !isFinite(plat) || !isFinite(plon) ||
              Math.abs(plat) > 90 || Math.abs(plon) > 180) return null;
          // Must already be coarsened (3 decimals) — reject precise coords.
          if (Math.round(plat * 1000) !== plat * 1000 ||
              Math.round(plon * 1000) !== plon * 1000) return null;
          var pspd = p.spd, phdg = p.hdg, pt = p.t, pacc = p.acc;
          if (typeof pspd !== 'number' || !isFinite(pspd) || pspd < 0 || pspd > 80) return null;
          if (phdg !== null && (typeof phdg !== 'number' || !isFinite(phdg) || phdg < 0 || phdg >= 360)) return null;
          if (!Number.isInteger(pt) || pt <= 0) return null;
          if (pacc !== null && (typeof pacc !== 'number' || !isFinite(pacc) || pacc < 0 || pacc > 1000)) return null;
          // No extra keys — probes carry exactly the 6 allowed fields.
          for (var pk in p) {
            if (Object.prototype.hasOwnProperty.call(p, pk) &&
                ['lat', 'lon', 'spd', 'hdg', 't', 'acc'].indexOf(pk) === -1) return null;
          }
          cleanProbes.push({ lat: plat, lon: plon, spd: pspd, hdg: phdg, t: pt, acc: pacc });
        }
        clean[key] = cleanProbes;
      }
    }
    return clean;
  }

  function trackEvent(type, meta) {
    if (!S.inited || !S.enabled) return false;
    if (EVENT_TYPES.indexOf(type) === -1) return false;
    if (meta == null) meta = {};
    if (typeof meta !== 'object' || Array.isArray(meta)) return false;
    var clean = validMeta(type, meta);
    if (clean == null) return false; // invalid meta: drop locally, never poison the queue
    enqueueEvent(type, clean);
    return true;
  }

  /* ---------- error reporting ---------- */
  function numOrNull(v) {
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.floor(v) : null;
  }

  // Sliding window: max 10 error reports/hour per device. The 11th+ is dropped
  // locally and counted in rr.stats.dropped_errors, attached to the next
  // accepted report (anonymous, useful for spotting error storms).
  function errorRateAllow() {
    var now = Date.now();
    var win = lsJsonGet(LS_ERR_WINDOW, []);
    if (!Array.isArray(win)) win = [];
    win = win.filter(function (t) { return typeof t === 'number' && now - t < ERR_RATE_WINDOW_MS; });
    if (win.length >= ERR_RATE_MAX) {
      var d = lsJsonGet(LS_DROPPED, 0);
      lsJsonSet(LS_DROPPED, (typeof d === 'number' ? d : 0) + 1);
      lsJsonSet(LS_ERR_WINDOW, win);
      return false;
    }
    win.push(now);
    lsJsonSet(LS_ERR_WINDOW, win);
    return true;
  }

  function reportError(kind, rawMessage, rawStack, rawSource, lineno, colno) {
    if (!S.inited || !S.enabled) return false;
    if (ERROR_KINDS.indexOf(kind) === -1) return false;
    var message = sanitizeMessage(rawMessage);
    if (!message) return false; // nothing meaningful to report (e.g. resource-load noise)
    if (!errorRateAllow()) return false; // over the 10/hr cap: counted in dropped_errors
    var error = {
      kind: kind,
      message: message,
      stack: rawStack ? sanitizeStack(rawStack) : '',
      source: basename(rawSource),
      lineno: numOrNull(lineno),
      colno: numOrNull(colno),
      breadcrumbs: S.crumbs.slice(-10),
      occurred_at: Date.now(),
    };
    var dropped = lsJsonGet(LS_DROPPED, 0);
    if (typeof dropped === 'number' && dropped > 0) {
      error.dropped_errors = Math.floor(dropped);
      lsJsonSet(LS_DROPPED, 0);
    }
    var payload = basePayload();
    payload.error = error;
    var q = lsJsonGet(LS_ERRORS, []);
    if (!Array.isArray(q)) q = [];
    q.push(payload);
    while (q.length > ERR_QUEUE_CAP) q.shift(); // drop oldest on overflow
    lsJsonSet(LS_ERRORS, q);
    return true;
  }

  function installErrorHandlers() {
    if (!S.inited || !S.enabled) return false;
    try {
      if (typeof window === 'undefined' || !window.addEventListener) return false;
      window.addEventListener('error', function (e) {
        if (S.inErrorHandler) return; // a failure to report must not generate a new report
        S.inErrorHandler = true;
        try {
          var err = (e && e.error) || null;
          var msg = (e && e.message) || (err && err.message) || '';
          var stack = (err && err.stack) || '';
          reportError('onerror', msg, stack, (e && e.filename) || '', e && e.lineno, e && e.colno);
        } catch {} finally { S.inErrorHandler = false; }
      });
      window.addEventListener('unhandledrejection', function (e) {
        if (S.inErrorHandler) return;
        S.inErrorHandler = true;
        try {
          var r = e && e.reason;
          var msg, stack;
          if (r instanceof Error) {
            msg = r.message || String(r);
            stack = r.stack || '';
          } else if (r == null) {
            msg = 'unhandled rejection (no reason given)';
            stack = '';
          } else {
            try { msg = String(r); } catch { msg = 'unhandled rejection'; }
            stack = '';
          }
          reportError('unhandledrejection', msg, stack, '', null, null);
        } catch {} finally { S.inErrorHandler = false; }
      });
      return true;
    } catch { return false; }
  }

  /* ---------- init ---------- */
  function init() {
    if (S.inited) return true;
    S.inited = true;
    try {
      S.appVer = appVersion();
      S.enabled = statsEnabled();
      if (!S.enabled) return true; // dev build or no key: every method below is a safe no-op
      S.deviceId = getDeviceId();
      var saved = lsJsonGet(LS_CRUMBS, []);
      S.crumbs = (Array.isArray(saved) ? saved : [])
        .filter(function (c) { return CRUMB_SET[c]; })
        .slice(-10);
      try {
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('online', function () { flush(); });
          window.addEventListener('pagehide', function () { flushBeacon(); });
        }
      } catch {}
      try { setInterval(function () { flush(); }, FLUSH_MS); } catch {}
      try { setInterval(function () { flushProbes(); }, PROBE_FLUSH_MS); } catch {}
      flush(); // boot flush: picks up anything queued while offline
      flushProbes();
    } catch {}
    return true;
  }

  function isEnabled() {
    return !!(S.inited && S.enabled);
  }

  /* Every public method wrapped: stats must never break the app or throw. */
  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch { return undefined; }
    };
  }

  /* Build-stamped gateway config for non-stats callers (core.js reads these
   * for the Valhalla /v1/matrix path). Null when the build left the
   * placeholder — never throws. Independent of the stats opt-out: a user
   * who disables stats still gets drive-time routing. */
  function stampedGatewayUrl() {
    try {
      if (!GATEWAY || GATEWAY === GATEWAY_PLACEHOLDER) return null;
      return GATEWAY;
    } catch { return null; }
  }
  function stampedIngestKey() {
    try {
      if (!INGEST_KEY || INGEST_KEY === KEY_PLACEHOLDER) return null;
      return INGEST_KEY;
    } catch { return null; }
  }

  // Scoped in an IIFE: a top-level `var Stats` here would collide with app-state.js's
  // `const Stats` (module-split 2026-10-06) — `var`+`const` on the same global name is a
  // SyntaxError and would kill the entire boot. window.Stats is still published below.
  (function () {
  var Stats = {
    CRUMB_NAMES: CRUMB_NAMES,
    init: safe(init),
    isEnabled: safe(isEnabled),
    trackEvent: safe(trackEvent),
    queueProbes: safe(queueProbes),
    flushProbes: safe(flushProbes),
    crumb: safe(crumb),
    reportError: safe(reportError),
    installErrorHandlers: safe(installErrorHandlers),
    flush: safe(flush),
    sanitizeMessage: safe(sanitizeMessage),
    sanitizeStack: safe(sanitizeStack),
    gatewayUrl: safe(stampedGatewayUrl),
    ingestKey: safe(stampedIngestKey),
  };

  if (typeof window !== 'undefined') {
    try { window.Stats = Stats; } catch {}
  }
  // CJS interop for the Vitest suite (same pattern as core.js).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Stats;
  }
  })();
