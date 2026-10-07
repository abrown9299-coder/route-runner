/* app-search.js — address search, appointment dialog, endpoint editor (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, _crumb:writable, addStops:writable, attachAddressDropdown:writable, devicePos:writable, editingEndpoint:writable, esc:writable, isWorkMode:writable, markDirty:writable, promptNickname:writable, render:writable, save:writable, settings:writable, state:writable, toast:writable, uid:writable, updateEpStar:writable */
/* exported photonBiasParams, setEndpoint, setWhich, onSearchPick, wireApptDialog, wireEndpointEditor */
'use strict';

  function photonBiasParams() {
    const src = devicePos;
    const b = RouteCore.photonBias(src);
    return b ? '&lat=' + b.lat.toFixed(4) + '&lon=' + b.lon.toFixed(4) : '';
  }
  /* Search box: universal dropdown (saved locations first, then live search).
   * Selecting an address opens the Add Appointment dialog with the address
   * pre-filled — it never adds a stop directly. */
  function onSearchPick(v) {
    $('searchInput').value = '';
    openApptDialog(v);
  }
  /* 2026-10-06 (module split): moved to the end of app-saved.js — it must run
   * AFTER attachAddressDropdown is defined (was hoisted in the single IIFE). */
  /* ---------- add: manual form ---------- */
  // NOTE: the old inline manualForm is kept hidden for backwards compat.
  // The Add Appointment dialog is now opened by selecting an address from
  // the search bar (openApptDialog), not by a standalone button.

  /* ---------- add appointment dialog (spec §5) ---------- */
  let apptPicked = null; // {label, street, city, state, zip, lat, lng} from dropdown
  function openApptDialog(pick) {
    const work = isWorkMode();
    $('apptTitle').textContent = work ? '➕ Add Appointment' : '➕ Add Stop';
    $('apptSave').textContent = work ? 'Add Appointment' : 'Add Stop';
    $('apptJobRow').style.display = work ? '' : 'none';
    $('apptTime').value = '';
    $('apptAnytime').checked = false;
    $('apptTime').disabled = false;
    if (pick) {
      $('apptAddr').value = pick.label || '';
      apptPicked = pick;
    } else {
      $('apptAddr').value = '';
      apptPicked = null;
    }
    $('apptNewJobWrap').hidden = true;
    $('apptNewJob').value = '';
    refreshApptJobTypes();
    updateApptStar();
    $('apptAddr')._ddClose && $('apptAddr')._ddClose();
    $('apptSheet').hidden = false;
    setTimeout(() => $('apptAddr').focus(), 50);
  }
  function refreshApptJobTypes() {
    const sel = $('apptJob');
    const types = RouteCore.collectAllJobTypes(
      settings.serviceTimes.known, settings.customJobTypes, state.stops);
    sel.innerHTML = '<option value="">— No type —</option>' +
      types.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('') +
      '<option value="__new__">＋ Add new type…</option>';
  }
  function updateApptStar() {
    const btn = $('apptStar');
    const q = $('apptAddr').value.trim();
    const loc = apptPicked
      ? { name: apptPicked.label, address: apptPicked.label, lat: apptPicked.lat, lng: apptPicked.lng }
      : (q ? { name: q, address: q, lat: null, lng: null } : null);
    const on = loc && RouteCore.isSavedLocation(settings.savedLocations, loc);
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? '⭐' : '☆';
  }
  // Wire the address dropdown once (idempotent).
  let apptDdWired = false;
  function wireApptDialog() {
    if (apptDdWired) return;
    apptDdWired = true;
    attachAddressDropdown('apptAddr', 'apptAddrSuggest', 'apptAddrWrap', (v) => {
      $('apptAddr').value = v.label;
      apptPicked = v;
      updateApptStar();
    });
    $('apptAddr').addEventListener('input', () => {
      if (apptPicked && $('apptAddr').value.trim() !== apptPicked.label) apptPicked = null;
      updateApptStar();
    });
    $('apptAnytime').addEventListener('change', () => {
      $('apptTime').disabled = $('apptAnytime').checked;
      if ($('apptAnytime').checked) $('apptTime').value = '';
    });
    $('apptJob').addEventListener('change', () => {
      $('apptNewJobWrap').hidden = $('apptJob').value !== '__new__';
      if ($('apptJob').value === '__new__') setTimeout(() => $('apptNewJob').focus(), 50);
    });
    $('apptNewJobAdd').onclick = () => {
      const name = $('apptNewJob').value.trim();
      if (!name) { toast('Enter a job type name'); return; }
      settings.customJobTypes = RouteCore.addCustomJobType(settings.customJobTypes, name);
      save();
      refreshApptJobTypes();
      $('apptJob').value = name;
      $('apptNewJobWrap').hidden = true;
      $('apptNewJob').value = '';
      toast('Job type added');
    };
    $('apptStar').onclick = () => {
      const q = $('apptAddr').value.trim();
      const loc = apptPicked
        ? { name: apptPicked.label, address: apptPicked.label, lat: apptPicked.lat, lng: apptPicked.lng }
        : (q ? { name: q, address: q, lat: null, lng: null } : null);
      if (!loc) { toast('Enter an address first'); return; }
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); updateApptStar(); render();
      toast(r.added ? '⭐ Saved' : '☆ Unsaved');
    };
    $('apptSave').onclick = () => {
      const addr = $('apptAddr').value.trim();
      if (!addr && !apptPicked) { toast('Enter an address'); return; }
      const work = isWorkMode();
      const anytime = $('apptAnytime').checked;
      const timeVal = $('apptTime').value;
      let apptMin = null, twStart = null, twEnd = null, confirmed = false;
      if (!anytime && timeVal) {
        apptMin = RouteCore.parseClockToMin(timeVal);
        if (work) { confirmed = true; twStart = apptMin; twEnd = apptMin + 120; }
      }
      let jobType = '';
      if (work) {
        const jv = $('apptJob').value;
        jobType = jv === '__new__' ? '' : jv;
      }
      const p = apptPicked || {};
      const s = {
        id: uid(),
        street: p.street || addr, city: p.city || '', state: p.state || '', zip: p.zip || '',
        jobType, note: '',
        lat: typeof p.lat === 'number' ? p.lat : null,
        lng: typeof p.lng === 'number' ? p.lng : null,
        geocodeSource: p.lat != null ? 'appt-dialog' : null,
        done: false, isLast: false, isFirst: false,
        confirmed, twStart, twEnd, apptMin,
        source: 'appt-dialog',
      };
      const added = addStops([s]);
      $('apptSheet').hidden = true;
      if (added) {
        // Work mode adds an appointment, personal mode adds a stop.
        _crumb(work ? 'adding_appointment' : 'adding_stop');
        toast(work ? 'Appointment added' : 'Stop added');
      }
    };
    const closeAppt = () => { $('apptSheet').hidden = true; };
    $('apptClose').onclick = closeAppt;
    $('apptCancel').onclick = closeAppt;
  }
  /* 2026-10-06 (module split): moved to the end of app-saved.js — wireApptDialog
   * calls attachAddressDropdown, which is defined in a later-loaded module. */

  /* ---------- endpoint editor wiring (spec §1) ---------- */
  let epDdWired = false, epPicked = null;
  function wireEndpointEditor() {
    if (epDdWired) return;
    epDdWired = true;
    attachAddressDropdown('epInput', 'epSuggest', 'epWrap', (v) => {
      $('epInput').value = v.label;
      epPicked = v;
      updateEpStar();
    });
    $('epInput').addEventListener('input', () => { epPicked = null; updateEpStar(); });
    $('epStar').onclick = () => {
      const q = $('epInput').value.trim();
      const loc = epPicked
        ? { name: epPicked.label, address: epPicked.label, lat: epPicked.lat, lng: epPicked.lng }
        : (q ? { name: q, address: q, lat: null, lng: null } : null);
      if (!loc) { toast('Enter an address first'); return; }
      if (RouteCore.isSavedLocation(settings.savedLocations, loc)) {
        const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
        settings.savedLocations = r.saved;
        save(); updateEpStar(); render();
        toast('☆ Unsaved');
        return;
      }
      // 2026-10-05: saving prompts for a nickname.
      promptNickname(loc, (nickname) => {
        const r = RouteCore.toggleSavedLocation(settings.savedLocations,
          { name: nickname, address: loc.address, lat: loc.lat, lng: loc.lng });
        settings.savedLocations = r.saved;
        save(); updateEpStar(); render();
        toast('⭐ Saved "' + nickname + '"');
      });
    };
    $('epGps').onclick = () => {
      if (!devicePos) { toast('No GPS fix yet'); return; }
      // Reverse-geocode for a human label, but keep coords regardless.
      const lat = devicePos.lat, lng = devicePos.lng;
      fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng,
        { headers: { 'Accept': 'application/json' } })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          const a = j && j.address;
          const label = a ? [(a.house_number || ''), (a.road || '')].filter(Boolean).join(' ') +
            ((a.city || a.town || a.village) ? ', ' + (a.city || a.town || a.village) : '')
            : 'Current location';
          setEndpoint(editingEndpoint, { label: label.trim() || 'Current location', lat, lng });
        })
        .catch(() => setEndpoint(editingEndpoint, { label: 'Current location', lat, lng }));
    };
    $('epSave').onclick = () => {
      const q = $('epInput').value.trim();
      if (epPicked) {
        setEndpoint(editingEndpoint, { label: epPicked.label, lat: epPicked.lat, lng: epPicked.lng });
      } else if (q) {
        // Typed but not picked from dropdown — save as unlabeled, geocode in background.
        setEndpoint(editingEndpoint, { label: q, lat: null, lng: null });
        geocodeEndpoint(editingEndpoint);
      } else {
        setEndpoint(editingEndpoint, null);
      }
    };
    $('epClose').onclick = () => { $('epSheet').hidden = true; editingEndpoint = null; };
  }
  function setEndpoint(which, ep) {
    const norm = RouteCore.normalizeEndpoint(ep);
    if (which === 'start') state.tripStart = norm; else state.tripEnd = norm;
    $('epSheet').hidden = true;
    $('setSheet').hidden = true;
    setWhich = null;
    editingEndpoint = null; epPicked = null;
    markDirty(which === 'start' ? 'Beginning location updated' : 'Ending location updated');
  }
  // Geocode a typed-but-unpicked endpoint address in the background.
  async function geocodeEndpoint(which) {
    const ep = which === 'start' ? state.tripStart : state.tripEnd;
    if (!ep || ep.lat != null || !ep.label) return;
    try {
      const r = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(ep.label) +
        '&limit=1' + photonBiasParams());
      const j = r.ok ? await r.json() : null;
      const f = j && j.features && j.features[0];
      if (f && f.geometry && f.geometry.coordinates) {
        const [lng, lat] = f.geometry.coordinates;
        if (which === 'start') state.tripStart = { label: ep.label, lat, lng };
        else state.tripEnd = { label: ep.label, lat, lng };
        save(); render();
      }
    } catch { /* offline — stays unlabeled */ }
  }
  /* 2026-10-06 (module split): moved to the end of app-saved.js — wireEndpointEditor
   * calls attachAddressDropdown, which is defined in a later-loaded module. */

  /* ---------- set-start/set-end chooser (2026-10-05) ---------- */
  // One menu, three options: current location, saved locations (nicknames),
  // add an address. Serves both built-in rows.
  let setWhich = null; // 'start' | 'end' | null
