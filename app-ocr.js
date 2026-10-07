/* app-ocr.js — OCR screenshot import (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, _crumb:writable, collectJobTypes:writable, geocodeInBackground:writable, load:writable, markDirty:writable, ocrPendingFiles:writable, save:writable, settings:writable, state:writable, toast:writable, uid:writable */ // eslint-disable-line no-unused-vars
/* exported addStops */
'use strict';

  async function runOcrImport(files) {
    if (!files || !files.length) { toast('No screenshots selected'); return; }
    if (state.stops.length + files.length * 8 > 40) { /* soft guard */ }
    _crumb('ocr_started');
    $('ocrTitle').textContent = 'Reading screenshots…';
    $('ocrActions').hidden = true;
    $('ocrBarFill').style.width = '0%';
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
    } catch {
      $('ocrTitle').textContent = 'Text reader failed';
      $('ocrStatus').textContent = 'The text reader could not start — check your connection and retry.';
      $('ocrActions').hidden = false;
      toast('Could not load the text reader — check connection and retry');
      _crumb('ocr_finished');
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
    _crumb('ocr_finished');
  }
  // Picker-cancel detection (2026-10-05): dismissing the native picker fires no
  // `change` event, so the only signal is the window refocus that follows. We
  // record when ocrBtn opened the picker; a focus within ~2.5s with no
  // `change` in between means the user picked nothing. `change` always fires
  // before `focus` on a real selection, so it cannot false-positive there.
  let ocrPickerOpenedAt = 0;
  $('ocrBtn').onclick = () => { ocrPickerOpenedAt = Date.now(); $('fileInput').click(); };
  $('fileInput').addEventListener('change', (e) => {
    ocrPickerOpenedAt = 0; // files arrived — not a cancel
    ocrPendingFiles = [...e.target.files];
    e.target.value = '';
    _crumb('importing_screenshots');
    runOcrImport(ocrPendingFiles);
  });
  window.addEventListener('focus', () => {
    if (!ocrPickerOpenedAt) return;
    const openedAt = ocrPickerOpenedAt; ocrPickerOpenedAt = 0;
    if (Date.now() - openedAt > 2500) return; // stale — not our picker
    toast('No screenshots selected');
  });
  $('ocrRetry').onclick = () => runOcrImport(ocrPendingFiles);
  $('ocrDismiss').onclick = () => { $('ocrOverlay').hidden = true; };

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

  /* ---------- client-side geocode + matrix caches (perf spec 2026-10-05) ---------- */
  // localStorage probe: iOS private mode throws on write — fall back to
  // memory-only so a dead cache is a pure slowdown, never an error.
  // Privacy (§5): keys are the user's own addresses on their own device;
  // nothing here is logged or leaves the device.
