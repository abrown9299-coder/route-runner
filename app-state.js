/* app-state.js — shared state, settings, storage, install-gate steps (split from app.js 2026-10-06) */
/* global endResolved:writable, saveHistory:writable, serviceMinFor:writable */ // eslint-disable-line no-unused-vars
/* exported RR_BUILD, Stats, _crumb, _event, LS_ROUTE, LS_SET, LS_HIST, LS_TRAFFIC, state, settings, isWorkMode, save, load, uid, isSameDay, wipeRouteData, esc, $ */
'use strict';

/* RouteRunner app.js — UI wiring. Pure-algorithm work lives in core.js (window.RouteCore). */
/* global RouteCore: readonly */
  'use strict';
  // Stamped by deploy.py. If this ever disagrees with the index.html meta
  // version at boot, the JS is stale and we force a clean reload.
  const RR_BUILD = '20261007-165229';
  const $ = (id) => document.getElementById(id);
  // Anonymous stats (app/stats.js, loaded before this file): safe wrappers —
  // stats.js may fail to load or self-disable (dev build), and Stats never
  // throws by contract. Breadcrumbs are fixed allowlist names only (no data).
  const Stats = (typeof window !== 'undefined' && window.Stats) || null;
  const _crumb = (n) => { try { if (Stats) Stats.crumb(n); } catch {} };
  const _event = (t, m) => { try { if (Stats) Stats.trackEvent(t, m); } catch {} };
  const LS_ROUTE = 'rr.route.v1', LS_SET = 'rr.settings.v1', LS_HIST = 'rr.history.v1';
  const LS_TRAFFIC = 'rr.traffic.learn.v1';

  const state = {
    stops: [],           // display order = route order
    origin: { type: 'gps', label: 'Current location', lat: null, lng: null },
    tripStart: null,     // {label, lat, lng} | null — pinned Start row. Null = auto from GPS at optimize time.
    tripEnd: null,       // {label, lat, lng} | null — pinned End row. Null = skipped silently on optimize.
    optimized: false,
    matrixSource: null,  // 'valhalla' | 'haversine' ('osrm' legacy in old caches)
    pinModeStopId: null,
    preEstimateMin: 0,   // rough haversine drive estimate, pre-optimization
    preDriveMin: null,   // real drive time for current order (verified in background via Valhalla)
    preDriveSource: null, // seconds-source label when preDriveMin is a real routed time
    lastEstimate: null,  // {beforeMin, afterMin, savedMin, source} post-optimization
    geocoding: false,    // background geocode in flight
    geocodeStatus: '',
    warnSuppressed: false, // "don't warn me again" for at-risk windows, per route
    lastSchedule: null,  // {at, arrivals: {stopId: arrivalMin}} from last optimize
    checkedIn: null,     // {stopId, startedAt} — currently being serviced (v1.9)
    returnActive: false, // return-to-start was baked into the current optimization
    endActive: false, // the tripEnd end-address block was baked into the current optimization
    completedAt: null,   // timestamp when the last stop was marked done (auto-delete next day)
    locationPrecision: 'unknown', // 'precise' | 'approximate' | 'unknown' — from GPS accuracy
  };
  const settings = {
    avoidTolls: false, avoidHwy: false,
    returnToStart: false, saveHistory: false, autoCheckin: false, autoConfirmAll: false, mode: 'work', // 'work' | 'personal'
    serviceTimes: { default: 45, byJobType: {}, known: [] },
    earlySuggest: true, // suggest early-arrival swaps that save drive time
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
      // Home location removed 2026-10-05 (six items item 5): GPS is the
      // source of truth for geocode bias; no manual override remains.
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
          endResolved = null; // auto-deleted route leaves no stale end point
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
