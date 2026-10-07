/* app-optimize.js — route optimization flow (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, APP_VERSION:writable, LS_HIST:writable, LS_TRAFFIC:writable, _crumb:writable, _event:writable, applyUpdate:writable, attachAddressDropdown:writable, clearDriveAway:writable, collectJobTypes:writable, departMinForOpt:writable, devicePos:writable, endResolved:writable, ensureDevicePos:writable, ensureGeocoded:writable, esc:writable, geocodeInflight:writable, getEndCoords:writable, isWorkMode:writable, makeTrafficFn:writable, markDirty:writable, matrixCache:writable, optInFlight:writable, refreshMap:writable, render:writable, save:writable, serviceMinFor:writable, settings:writable, showRiskWarning:writable, ssDel:writable, state:writable, stopLabel:writable, toast:writable, uid:writable */ // eslint-disable-line no-unused-vars
/* exported doOptimize, maybeAutoReopt, saveHistory, loadTrafficModel, originLabel, loadSharedRoute, TILE_TEMPLATE, TILES_CACHE, LS_TILE_META, LS_TILE_CFG, TILE_BUDGET_BYTES, TILE_BUDGET_TILES, tileMeta, tileMetaDirty, onOriginPick */
'use strict';

  async function doOptimize(auto) {
    if (!state.stops.length) { if (!auto) toast('Add some stops first'); return; }
    if (optInFlight) return;
    optInFlight = true;
    const btn = $('optimizeBtn');
    btn.disabled = true;
    _crumb('optimizing_route');
    const setStatus = (t) => { $('routeStatus').textContent = t; $('routeStatus').className = 'status-line warn'; };
    try {
      if (geocodeInflight) {
        setStatus('Finishing locating addresses…');
        try { await geocodeInflight; } catch {}
      }
      // Cheap guard: ensureGeocoded is pure overhead when nothing needs
      // locating (stops all set, start set or GPS-ready, origin settled).
      if (RouteCore.ensureGeocodeNeeded(state.stops,
          RouteCore.normalizeEndpoint(state.tripStart), state.origin)) {
        await ensureGeocoded(setStatus);
      }
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
      // 2026-10-07: live-origin fix. state.origin.lat/lng is adopted ONCE from
      // the first GPS fix (app-gps.js) and goes stale as the driver moves, so
      // ETAs/drive-times were computed from where the driver WAS, not where
      // they ARE (e.g. "25 min" shown when 4 min away). At optimize time,
      // prefer the live device position for a 'gps' origin. A user-set
      // address origin is always respected, and state.origin itself is never
      // mutated (return-to-start still targets the adopted origin).
      let originLat = state.origin.lat, originLng = state.origin.lng;
      if (!ciStop && state.origin.type === 'gps') {
        let live = (typeof devicePos !== 'undefined') ? devicePos : null;
        if (!live) {
          try { live = await ensureDevicePos(); } catch { live = null; }
        }
        if (live && live.lat != null && live.lng != null) {
          originLat = live.lat; originLng = live.lng;
        }
      }
      const points = [{
        lat: ciStop ? ciStop.lat : originLat,
        lng: ciStop ? ciStop.lng : originLng,
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
      // The tripEnd end block wins. Skipped silently if unset.
      let endPt = null;
      const tripEndSet = !!RouteCore.normalizeEndpoint(state.tripEnd);
      if (tripEndSet && !returnPt) {
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
      const beforeOrder = points.map((_, i) => i); // current order (identity over points)
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
      const { order, source, matrix, durMin, schedule, traffic } = await RouteCore.optimizeRouteAsync(points, {
        startIdx: Math.max(0, startIdx), firstIdx, lastIdx, fetchFn: fetch.bind(window),
        matrixCache: matrixCache, // 1h client-side matrix cache (perf spec 2026-10-05)
        windows, serviceMin, departMin: departMin, bufferMin: 30,
        forceSchedule: !isWorkMode(), // personal mode: ETAs from pure drive time
        trafficFn: makeTrafficFn(),
        seedOrder: beforeOrder, // idempotency: re-optimize keeps a stable route (2026-10-06)
      });
      if (!RouteCore.isSecondsSource(source)) _crumb('optimize_osrm_fallback'); // silent gateway failure looks like "offline" otherwise (crumb name kept for dashboard continuity)
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
        _crumb('optimize_finished');
        // Engine is local-only today (RouteCore on-device); the enum reserves 'backend'.
        _event('route_optimized', {
          stop_count: ordered.length,
          had_windows: windows.some(Boolean),
          engine: 'local',
        });
        state.returnActive = !!returnPt;
        state.endActive = !!endPt;
        // Item 4: the map draws from the resolved end point, never the geocode cache.
        const teNorm = RouteCore.normalizeEndpoint(state.tripEnd);
        endResolved = endPt
          ? { lat: endPt.lat, lng: endPt.lng, label: (teNorm && teNorm.label) || 'Home' }
          : null;
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
        var trafficBadge = '';
        try {
          // 2026-10-07: live-traffic confidence badge (E6). Shows when the
          // backend had real probe data behind the drive times.
          var conf = traffic && traffic.confidence;
          if (conf) {
            var levels = Object.keys(conf);
            var live = levels.filter(function (k) { return conf[k].level === 'live'; }).length;
            var recent = levels.filter(function (k) { return conf[k].level === 'recent'; }).length;
            if (live > 0) trafficBadge = ' · 🟢 live traffic (' + live + ' legs)';
            else if (recent > 0) trafficBadge = ' · 🟡 recent traffic (' + recent + ' legs)';
          }
          var inc = traffic && traffic.incidents;
          if (inc && inc.length) {
            trafficBadge += ' · 🔴 ' + inc.length + ' slowdown' + (inc.length === 1 ? '' : 's') + ' reported';
          }
        } catch {}
        toast(RouteCore.isSecondsSource(source) ? '⚡ Optimized by drive time' + trafficBadge : '⚡ Optimized (straight-line — offline mode)');
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

  /* ---------- traffic model (always-on, local-only learning) ----------
   * Traffic learning is unconditional — there is no on/off toggle and no
   * settings UI (removed 2026-10-05). Samples live in localStorage under
   * LS_TRAFFIC, keyed by 3-hour bucket × 0.1° grid cell (coarse, anonymous).
   * LS_TRAFFIC_MODEL / loadTrafficModel stay for models imported before the
   * export/import UI was removed; makeTrafficFn merges them when present. */
  const LS_TRAFFIC_MODEL = 'rr.traffic.model.v1'; // imported aggregated model
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
    _crumb('starting_navigation');
    const remaining = state.stops.filter((s) => !s.done);
    if (!remaining.length) { toast('No remaining stops'); return; }
    // pass the stop objects themselves — core.js stopLabel() builds the address text
    const ordered = remaining.slice();
    if (settings.returnToStart) ordered.push({ street: originLabel() });
    else {
      // End block value (label, or lat,lng when that's all we have).
      const te = RouteCore.normalizeEndpoint(state.tripEnd);
      if (te) ordered.push({ street: te.lat != null ? te.lat.toFixed(5) + ',' + te.lng.toFixed(5) : te.label });
    }
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
    _crumb('sharing_route');
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
        // Start/end live on the main UI blocks now (settings defaults removed
        // 2026-10-05) — snapshot the actual endpoints.
        tripStart: state.tripStart || null,
        tripEnd: state.tripEnd || null,
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
    _crumb('checking_update');
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
  // Offline map tiles (INSTALL_SPEC.md IR8/IR19): on-demand refresh for the
  // current location (merge, never wipe) and a secondary clear option.
  $('tilesRefresh').onclick = async () => {
    const inst = window.__rrInstall;
    if (!inst || !inst.refreshTiles) { toast('Tile refresh unavailable'); return; }
    $('tilesStatus').textContent = 'Fetching tiles for your current location…';
    const res = await inst.refreshTiles();
    if (res && res.ok) {
      $('tilesStatus').textContent = (res.notes && res.notes[0]) || 'Tiles refreshed.';
    } else {
      $('tilesStatus').textContent = 'Tile refresh failed: ' + ((res && res.error) || 'unknown error');
    }
  };
  $('tilesClear').onclick = async () => {
    const inst = window.__rrInstall;
    if (!inst || !inst.clearTiles) { toast('Tile clearing unavailable'); return; }
    if (!confirm('Delete all saved offline map tiles? The map will still work online.')) return;
    await inst.clearTiles();
    $('tilesStatus').textContent = 'Offline map tiles cleared.';
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
    clearDriveAway();
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
  /* 2026-10-06 (module split): moved to the end of app-saved.js — it must run
   * AFTER attachAddressDropdown is defined (was hoisted in the single IIFE). */
  /* ---------- offline tiles (INSTALL_SPEC.md IR11) ---------- */
  // Same template the install manifest pre-fetches with — deploy.py
  // asserts this matches the manifest tile template so cache hits align.
  const TILE_TEMPLATE = 'https://stopflow.io:8443/tiles/bright/{z}/{x}/{y}.png'; // stamped at deploy time by dev/deploy.py (TILE_URL env)
  const TILES_CACHE = 'routerunner-tiles-v1';
  const LS_TILE_META = 'rr.tiles.meta.v1';
  const LS_TILE_CFG = 'rr.tiles.cfg.v1';
  const TILE_BUDGET_BYTES = 157286400; // fallback; the installer refreshes from the manifest
  const TILE_BUDGET_TILES = 3000;

  let tileMeta = null; // [{u, b, t}] oldest-first; persisted on pagehide
  let tileMetaDirty = false;
