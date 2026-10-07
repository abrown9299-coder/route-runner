/* app-live.js — live ETA: movement-gated drive clock + silent matrix refresh.
 * Keeps stop-card drive times ("🚗 X min") and arrival times ("arr ~H:MM")
 * fresh with zero user action. See dev/LIVE_ETA_SPEC.md.
 *
 * Two mechanisms:
 *  1. A 15 s tick advances a drive clock ONLY while the device is actually
 *     moving (position delta > 25 m between ticks). Parked time never burns
 *     drive time. Chips update in place — no full re-render, no scroll jump.
 *  2. Every 5 min (visible tab + live position) a silent 2-point matrix
 *     refresh re-bases the current leg's drive time and shifts downstream
 *     arrivals. No reorder, no toast. Failures are silent; the clock keeps
 *     working.
 *
 * The current leg target is re-detected every tick (first open stop with a
 * scheduled drive time), so stop close-outs and re-optimizes need no hooks —
 * a changed target simply starts a new leg with a zeroed clock. */
/* global RouteCore: readonly */
/* global state: writable, devicePos: writable, devMode: writable, haversineM: writable, makeTrafficFn: writable */
/* exported LiveEta, startLiveEta */
'use strict';

  var LIVE_TICK_MS = 15000;
  var LIVE_MOVE_M = 25;              // position delta per tick that counts as "moving"
  var LIVE_REFRESH_MS = 5 * 60 * 1000;

  var live = {
    firstId: null,      // current leg target stop id (null = none)
    drivenMin: 0,       // drive clock: minutes of actual movement on this leg
    lastPos: null,      // last seen live position (movement gate)
    timer: null,
    lastRefreshAt: 0,
    refreshInFlight: false,
  };

  /* Live position: dev-mode virtual position wins when set (so the drive
   * simulator exercises the exact production path), else the GPS fix. */
  function livePos() {
    if (typeof devMode !== 'undefined' && devMode && devMode.active && devMode.pos) {
      return { lat: devMode.pos.lat, lng: devMode.pos.lng };
    }
    if (typeof devicePos !== 'undefined' && devicePos) return devicePos;
    return null;
  }

  /* Current leg target: first open stop with a scheduled drive time. */
  function liveFirst() {
    var sched = state.lastSchedule;
    if (!sched || !state.optimized || !sched.driveTo) return null;
    return state.stops.find(function (s) {
      return !s.done && sched.driveTo[s.id] != null;
    }) || null;
  }

  /* Self-healing leg detection: a changed target means a new leg began
   * (stop closed out, re-optimize) — zero the clock, adopt the target. */
  function ensureLiveLeg() {
    var first = liveFirst();
    var fid = first ? first.id : null;
    if (fid !== live.firstId) {
      live.firstId = fid;
      live.drivenMin = 0;
    }
    return first;
  }

  /* Remaining drive minutes for a stop. The leg target counts down with the
   * drive clock; later legs show their scheduled time (their leg hasn't
   * started). Null when there is no scheduled drive time. */
  function liveDriveMin(stopId) {
    var sched = state.lastSchedule;
    if (!sched || !sched.driveTo || sched.driveTo[stopId] == null) return null;
    var first = ensureLiveLeg();
    if (first && first.id === stopId) {
      return Math.max(0, sched.driveTo[stopId] - live.drivenMin);
    }
    return sched.driveTo[stopId];
  }

  function liveShiftMin() {
    var sched = state.lastSchedule;
    var first = ensureLiveLeg();
    if (!first || !sched.driveTo || sched.driveTo[first.id] == null) return 0;
    return Math.max(0, sched.driveTo[first.id] - live.drivenMin) - sched.driveTo[first.id];
  }

  /* Projected arrival (minutes since midnight). The whole downstream day
   * slides with the current leg's reality. */
  function liveArrivalMin(stopId) {
    var sched = state.lastSchedule;
    if (!sched || !sched.arrivals || sched.arrivals[stopId] == null) return null;
    return sched.arrivals[stopId] + liveShiftMin();
  }

  function liveIsLate(s) {
    if (!s || s.done || !s.confirmed || s.twEnd == null) return false;
    var arr = liveArrivalMin(s.id);
    return arr != null && arr > s.twEnd;
  }

  function fmtDrive(min) {
    if (min <= 0) return '🏁 arriving';
    return '🚗 ' + Math.round(min) + ' min';
  }

  /* In-place chip updates for every open stop. Full renders go through
   * liveDriveMin/liveArrivalMin instead, so both paths agree. */
  function updateStopChips() {
    var ul = document.getElementById('stopList');
    if (!ul) return;
    for (var i = 0; i < state.stops.length; i++) {
      var s = state.stops[i];
      if (s.done) continue;
      var li = ul.querySelector('[data-id="' + s.id + '"]');
      if (!li) continue;
      var dm = liveDriveMin(s.id);
      var dc = li.querySelector('[data-chip="drive"]');
      if (dc && dm != null) dc.textContent = fmtDrive(dm);
      var am = liveArrivalMin(s.id);
      var ac = li.querySelector('[data-chip="eta"]');
      if (ac && am != null) {
        ac.textContent = '→ arr ~' + RouteCore.formatClock(Math.round(am));
      }
      var late = liveIsLate(s);
      var lc = li.querySelector('[data-chip="late"]');
      if (late && !lc) {
        var meta = li.querySelector('.meta');
        if (meta) {
          var span = document.createElement('span');
          span.className = 'chip late';
          span.setAttribute('data-chip', 'late');
          span.title = 'Projected arrival is after this appointment window';
          span.textContent = '⚠️ late';
          meta.appendChild(span);
        }
      } else if (!late && lc) {
        lc.remove();
      }
    }
  }

  /* Silent drift correction: fresh 2-point matrix (live position -> current
   * target), re-base the leg, shift downstream arrivals. No reorder, no
   * toast, no risk sheet. A failed refresh is invisible — the clock keeps
   * the numbers moving. */
  function maybeRefreshMatrix() {
    var now = Date.now();
    if (now - live.lastRefreshAt < LIVE_REFRESH_MS) return;
    if (live.refreshInFlight) return;
    var p = livePos();
    var first = liveFirst();
    if (!p || !first || first.lat == null || first.lng == null) return;
    live.refreshInFlight = true;
    RouteCore.optimizeRouteAsync(
      [{ lat: p.lat, lng: p.lng }, { lat: first.lat, lng: first.lng }],
      { startIdx: 0, fetchFn: fetch.bind(window) }
    ).then(function (r) {
      var raw = r.durMin && r.durMin[0] && r.durMin[0][1];
      var fresh = (raw != null && isFinite(raw) && raw >= 0) ? raw : null;
      /* Match the schedule's convention: drive times carry the learned
       * traffic factor (simulateSchedule applies it per leg). */
      if (fresh != null) {
        try {
          var tfFn = makeTrafficFn();
          var nowMin = (Date.now() / 60000) % 1440;
          fresh = fresh * tfFn(nowMin, (p.lat + first.lat) / 2, (p.lng + first.lng) / 2);
        } catch {}
      }
      if (fresh != null && isFinite(fresh) && fresh >= 0) {
        var sched = state.lastSchedule;
        if (sched && sched.driveTo && sched.driveTo[first.id] != null) {
          var delta = fresh - sched.driveTo[first.id];
          sched.driveTo[first.id] = fresh;
          Object.keys(sched.arrivals).forEach(function (k) {
            sched.arrivals[k] += delta;
          });
          live.drivenMin = 0;
          live.lastRefreshAt = now;
          updateStopChips();
        }
      }
    }).catch(function () {}).finally(function () {
      live.refreshInFlight = false;
    });
  }

  function liveTick() {
    if (typeof document !== 'undefined' && document.hidden) return;
    var first = ensureLiveLeg();
    if (!first) return;
    var p = livePos();
    if (p && live.lastPos) {
      try {
        if (haversineM(live.lastPos.lat, live.lastPos.lng, p.lat, p.lng) > LIVE_MOVE_M) {
          live.drivenMin += LIVE_TICK_MS / 60000;
        }
      } catch {}
    }
    if (p) live.lastPos = { lat: p.lat, lng: p.lng };
    updateStopChips();
    maybeRefreshMatrix();
  }

  function startLiveEta() {
    if (live.timer) return;
    live.timer = setInterval(liveTick, LIVE_TICK_MS);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) liveTick();
      });
    }
  }

  /* Public surface (also the dev-mode test hooks). */
  var LiveEta = {
    driveMin: liveDriveMin,
    arrivalMin: liveArrivalMin,
    isLate: liveIsLate,
    fmtDrive: fmtDrive,
    tick: liveTick,
    refresh: maybeRefreshMatrix,
    /* Dev-mode: advance the drive clock without moving (tests the countdown,
     * arrival slide, and late-chip appearance directly). */
    advance: function (min) {
      ensureLiveLeg();
      live.drivenMin = Math.max(0, live.drivenMin + min);
      updateStopChips();
    },
    debug: function () {
      var first = ensureLiveLeg();
      var dm = first ? liveDriveMin(first.id) : null;
      return {
        firstId: live.firstId,
        drivenMin: Math.round(live.drivenMin * 100) / 100,
        remainingMin: dm == null ? null : Math.round(dm * 100) / 100,
        shiftMin: Math.round(liveShiftMin() * 100) / 100,
        lastRefreshAt: live.lastRefreshAt,
      };
    },
  };
