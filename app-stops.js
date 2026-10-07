/* app-stops.js — stops list, service times, render (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, LiveEta:writable, _crumb:writable, _event:writable, clearDriveAway:writable, endLegTracking:writable, endResolved:writable, ensureGeocoded:writable, esc:writable, geocodeInflight:writable, isWorkMode:writable, legTrack:writable, locatedPoints:writable, mapObj:writable, matrixCache:writable, maybeAutoReopt:writable, openMapForPin:writable, openSetSheet:writable, openWindowPopup:writable, originLabel:writable, promptNickname:writable, refreshMap:writable, save:writable, settings:writable, state:writable, trackDepartureLeg:writable, wipeRouteData:writable */ // eslint-disable-line no-unused-vars
/* exported stopLabel, SVC_MIN, SVC_MAX, SVC_STEP, serviceMinFor, collectJobTypes, departMinForOpt, markDirty, schedulePreDriveTime, toast, editingEndpoint, openEndpointEditor, updateEpStar, render, winStopId */
'use strict';

  /* Live-ETA accessor with fallback. app-live.js loads after this module, so
   * the check must happen at call time, not load time. When app-live.js is
   * absent (some test harnesses), render falls back to raw schedule values
   * instead of throwing. */
  var LiveEtaFallback = {
    driveMin: function (sid) {
      var s = state.lastSchedule;
      return (s && s.driveTo && s.driveTo[sid] != null) ? s.driveTo[sid] : null;
    },
    arrivalMin: function (sid) {
      var s = state.lastSchedule;
      return (s && s.arrivals && s.arrivals[sid] != null) ? s.arrivals[sid] : null;
    },
    isLate: function (st) {
      if (!st || st.done || !st.confirmed || st.twEnd == null) return false;
      var a = LiveEtaFallback.arrivalMin(st.id);
      return a != null && a > st.twEnd;
    },
    fmtDrive: function (min) {
      return '🚗 ' + Math.round(min) + ' min';
    },
  };
  function LE() {
    return (typeof LiveEta !== 'undefined') ? LiveEta : LiveEtaFallback;
  }

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
   * haversine guess once the Valhalla duration matrix arrives. */
  let preDriveTimer = null, preDriveToken = 0;
  // Point-set signature of the last successful pre-drive fetch — edits
  // that don't move points (pin, reorder, done) skip the refetch entirely.
  // Only set on drive-time success: a failed gateway keeps retrying later.
  let lastPreDriveSig = null;
  function schedulePreDriveTime() {
    if (preDriveTimer) clearTimeout(preDriveTimer);
    preDriveTimer = setTimeout(refreshPreDriveTime, 2000);
  }
  async function refreshPreDriveTime() {
    preDriveTimer = null;
    if (state.optimized) return;
    const pts = locatedPoints();
    if (pts.length < 2) return;
    const sig = RouteCore.matrixCacheKey(pts);
    if (sig === lastPreDriveSig) return; // points unchanged — no refetch
    const my = ++preDriveToken;
    try {
      const r = await RouteCore.cachedDurationMatrix(pts, fetch.bind(window), matrixCache);
      if (my !== preDriveToken || state.optimized) return; // superseded
      if (!RouteCore.isSecondsSource(r.source)) { _crumb('predrive_osrm_fallback'); return; } // haversine fallback adds nothing new (crumb name kept for dashboard continuity)
      lastPreDriveSig = sig;
      state.preDriveMin = RouteCore.routeMinutesForOrder(
        r.matrix, pts.map((_, i) => i), r.source);
      state.preDriveSource = r.source;
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
      b.onclick = () => { if (action.label === 'Undo') _crumb('undoing_action'); action.fn(); t.hidden = true; };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2800);
  }

  /* ---------- built-in beginning/ending location rows ---------- */
  // 2026-10-05: dedicated rows — beginning pinned above the appointments,
  // ending pinned below them (never attached to appointment rows). Each has
  // a "set" button opening the one-menu chooser (current location / saved
  // locations / add address). Unset start silently falls back to GPS at
  // optimize time (ensureGeocoded); unset end is skipped silently.
  function endpointDisplay(which) {
    const ep = which === 'start' ? state.tripStart : state.tripEnd;
    return RouteCore.normalizeEndpoint(ep);
  }
  function renderEndpointRow(ul, which) {
    const isStart = which === 'start';
    const disp = endpointDisplay(which);
    // isSavedLocation keys on address/coords — build the same shape the
    // click handler uses, or a coord-less saved endpoint renders ☆ (audit 2026-10-05).
    const dispLoc = disp ? { name: disp.label, address: disp.label, lat: disp.lat, lng: disp.lng } : null;
    const saved = dispLoc && RouteCore.isSavedLocation(settings.savedLocations, dispLoc);
    const li = document.createElement('li');
    li.className = 'stop endpoint-row' + (isStart ? '' : ' end-row');
    li.dataset.endpoint = which;
    const title = isStart ? 'Beginning location' : 'Ending location';
    // Perf/UX spec 2026-10-05: the set button is redundant once the endpoint
    // is fully set (row-body tap already opens the chooser). It stays visible
    // for unset endpoints AND for the "📍 no location — tap set" chip state
    // (label but no coords) so the chip text stays literal.
    const setVisible = !disp || disp.lat == null;
    li.innerHTML =
      '<span class="num">' + (isStart ? '▶' : '■') + '</span>' +
      '<div class="info"><div class="addr">' + esc(disp ? disp.label : title) + '</div>' +
      '<div class="meta">' +
        (disp
          ? (disp.lat == null ? '<span class="chip warn">📍 no location — tap set</span>' : '')
          : '<span class="chip warn">not set</span>') +
      '</div></div>' +
      '<div class="acts">' +
        (setVisible
          ? '<button class="pill set-btn" data-act="set-endpoint" data-which="' + which + '" title="Set the ' +
            (isStart ? 'beginning' : 'ending') + ' location">set</button>'
          : '') +
        '<button class="star-btn' + (saved ? ' on' : '') + '" data-act="star-endpoint" data-which="' + which + '" title="' +
          (saved ? 'Unsave this location' : 'Save this location') + '">' + (saved ? '⭐' : '☆') + '</button>' +
        (disp ? '<button data-act="clear-endpoint" data-which="' + which + '" title="Clear">✕</button>' : '') +
      '</div>';
    ul.appendChild(li);
  }
  // Tap an endpoint row body → open the set chooser sheet.
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
    // Same address-keyed shape as renderEndpointRow (audit 2026-10-05).
    const loc = q ? { name: q, address: q, lat: null, lng: null }
      : (disp ? { name: disp.label, address: disp.label, lat: disp.lat, lng: disp.lng } : null);
    const on = loc && RouteCore.isSavedLocation(settings.savedLocations, loc);
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? '⭐' : '☆';
    btn.title = on ? 'Unsave this location' : 'Save this location';
  }

  /* ---------- render ---------- */
  // Route-list open tracking (stats): the stop list is the route list; it
  // "opens" when it transitions from empty to having stops.
  let routeListWasOpen = false;
  function render() {
    $('routeDate').textContent = new Date().toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    $('originLabel').textContent = state.origin.label || 'Current location';

    const total = state.stops.length;
    if (total > 0 && !routeListWasOpen) _crumb('opening_route_list');
    routeListWasOpen = total > 0;
    const done = state.stops.filter((s) => s.done).length;
    $('progressText').textContent = done + '/' + total;
    $('progressRing').style.strokeDashoffset = total
      ? 113 - (113 * done / total) : 113;
    $('stopCount').textContent = total ? '(' + total + ')' : '';
    $('listTitle').textContent = isWorkMode() ? 'Appointments' : 'Stops';
    $('clearAllBtn').style.display = total ? '' : 'none';

    const ul = $('stopList');
    ul.innerHTML = '';
    // Built-in beginning row: pinned at the top, above the appointments.
    renderEndpointRow(ul, 'start');
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
          (!s.done && state.optimized && LE().arrivalMin(s.id) != null
            ? '<span class="chip eta" data-chip="eta">→ arr ~' + esc(RouteCore.formatClock(Math.round(LE().arrivalMin(s.id)))) + '</span>' : '') +
          (!s.done && state.optimized && LE().driveMin(s.id) != null
            ? '<span class="chip drive" data-chip="drive">' + LE().fmtDrive(LE().driveMin(s.id)) + '</span>' : '') +
          /* 2026-10-07: late-window indicator. Shows when the projected
           * arrival falls after the confirmed appointment window so a missed
           * notification is still visible at a glance. Vanishes with the
           * stop (only rendered for !s.done). Live-evaluated: it can appear
           * or clear as the drive clock moves. */
          (LE().isLate(s)
            ? '<span class="chip late" data-chip="late" title="Projected arrival is after this appointment window">⚠️ late</span>' : '') +
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
    // Built-in ending row: pinned below the appointments (manual or imported).
    renderEndpointRow(ul, 'end');
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
      if (RouteCore.isSecondsSource(state.preDriveSource) && state.preDriveMin > 0) {
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
      let t = (RouteCore.isSecondsSource(state.matrixSource) ? 'Optimized by drive time'
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
    // Built-in beginning/ending rows: handled separately from stops.
    if (li.dataset.endpoint) {
      const which = li.dataset.endpoint;
      const act = btn ? btn.dataset.act : null;
      if (act === 'star-endpoint') {
        const disp = endpointDisplay(which);
        if (!disp) { toast('Set the location first'); return; }
        const loc = { name: disp.label, address: disp.label, lat: disp.lat, lng: disp.lng };
        if (RouteCore.isSavedLocation(settings.savedLocations, loc)) {
          if (!confirm('Unsave "' + loc.name + '"?')) return;
          const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
          settings.savedLocations = r.saved;
          save(); render();
          toast('☆ Unsaved');
          return;
        }
        promptNickname(loc, (nickname) => {
          const r = RouteCore.toggleSavedLocation(settings.savedLocations,
            { name: nickname, address: loc.address, lat: loc.lat, lng: loc.lng });
          settings.savedLocations = r.saved;
          save(); render();
          toast('⭐ Saved "' + nickname + '"');
        });
        return;
      }
      if (act === 'clear-endpoint') {
        if (which === 'start') state.tripStart = null; else state.tripEnd = null;
        markDirty(which === 'start' ? 'Beginning cleared — will use GPS' : 'Ending cleared');
        return;
      }
      // Set button or body tap → the one-menu chooser.
      openSetSheet(which);
      return;
    }
    const s = state.stops.find((x) => x.id === li.dataset.id);
    if (!s) return;
    if (!btn) { // tapped body — if needs pin, enter pin mode
      _crumb('selecting_stop');
      if (s.lat == null) openMapForPin(s.id);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'check') {
      s.done = !s.done;
      if (s.done && state.checkedIn && state.checkedIn.stopId === s.id) {
        state.checkedIn = null; // service finished with the stop
        clearDriveAway();
      }
      // Departure: start tracking the drive to the next stop for traffic learning.
      if (s.done) {
        trackDepartureLeg();
        _event('stop_completed', {});
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
      if (RouteCore.isSavedLocation(settings.savedLocations, loc)) {
        // Confirm unsave when the route is optimized (location is in active use).
        if (state.optimized && !confirm('Unsave "' + loc.name + '"?')) return;
        const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
        settings.savedLocations = r.saved;
        save(); render();
        toast('☆ Unsaved');
        return;
      }
      // 2026-10-05: saving a location prompts for a nickname (Home, Office, …).
      promptNickname(loc, (nickname) => {
        const r = RouteCore.toggleSavedLocation(settings.savedLocations,
          { name: nickname, address: loc.address, lat: loc.lat, lng: loc.lng });
        settings.savedLocations = r.saved;
        save(); render();
        toast('⭐ Saved "' + nickname + '"');
      });
    }
    else if (act === 'checkin') {
      const ci = state.checkedIn;
      clearDriveAway(); // manual service change: a new window starts fresh
      if (ci && ci.stopId === s.id) {
        state.checkedIn = null;
        // Ending the service timer completes the stop, same as the checkmark.
        if (!s.done) {
          s.done = true;
          _event('stop_completed', {});
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
        _crumb('checking_in');
        _event('check_in', {});
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
      if (n !== null) { s.note = n.trim(); save(); render(); _crumb('editing_stop'); }
    }
    else if (act === 'del') {
      if (state.checkedIn && state.checkedIn.stopId === s.id) { state.checkedIn = null; clearDriveAway(); }
      const idx = state.stops.indexOf(s);
      state.stops.splice(idx, 1);
      _crumb('deleting_stop');
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
        endResolved = null; // no stale end point survives the cleanup
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
