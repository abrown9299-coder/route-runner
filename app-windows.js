/* app-windows.js — confirmed-stop time-window popup (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, _crumb:writable, esc:writable, maybeAutoReopt:writable, render:writable, save:writable, state:writable, stopLabel:writable, toast:writable, winStopId:writable */
/* exported openWindowPopup, showRiskWarning */
'use strict';

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
    _crumb('editing_appointment');
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
  /* Photon API bias params: live GPS fix when available, otherwise no bias.
   * (homeLocation was removed 2026-10-05 — GPS is the source of truth.) */
