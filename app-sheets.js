/* app-sheets.js — set start/end sheets, nickname sheet (split from app.js 2026-10-06) */
/* global $:writable, _crumb:writable, addStops:writable, esc:writable, getGps:writable, openEndpointEditor:writable, save:writable, setEndpoint:writable, setWhich:writable, settings:writable, state:writable, toast:writable, uid:writable */ // eslint-disable-line no-unused-vars
/* exported openSetSheet, promptNickname, ocrPendingFiles */
'use strict';

  function openSetSheet(which) {
    setWhich = which;
    $('setTitle').textContent = which === 'start' ? 'Set beginning location' : 'Set ending location';
    renderSetSavedList();
    // Expand the saved list right away when there's something in it (item 1);
    // the toggle still collapses it. Empty state stays hidden until asked.
    $('setSavedList').hidden = !(settings.savedLocations && settings.savedLocations.length);
    $('setSheet').hidden = false;
  }
  function closeSetSheet() { $('setSheet').hidden = true; setWhich = null; }
  function renderSetSavedList() {
    const ul = $('setSavedList');
    ul.innerHTML = '';
    const list = settings.savedLocations || [];
    if (!list.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="fine">No saved locations yet — tap ☆ on any stop to save one with a nickname.</span>';
      ul.appendChild(li);
      return;
    }
    list.forEach((s) => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="addr">' + esc(s.name || s.address || 'Saved location') + '</div>' +
        ((s.name && s.address && s.name !== s.address)
          ? '<div class="fine">' + esc(s.address) + '</div>' : '');
      li.style.cursor = 'pointer';
      li.onclick = () => {
        setEndpoint(setWhich, { label: s.name || s.address, lat: s.lat, lng: s.lng });
      };
      ul.appendChild(li);
    });
  }
  $('setClose').onclick = closeSetSheet;
  $('setSavedToggle').onclick = () => { const l = $('setSavedList'); l.hidden = !l.hidden; };
  $('setGps').onclick = async () => {
    const btn = $('setGps');
    btn.disabled = true;
    try {
      const g = await getGps();
      if (g && g.lat != null && g.lng != null) {
        setEndpoint(setWhich, { label: 'Current location', lat: g.lat, lng: g.lng });
      } else {
        toast('Could not get your location — check GPS and retry');
      }
    } finally { btn.disabled = false; }
  };
  $('setAdd').onclick = () => {
    const w = setWhich;
    closeSetSheet();
    openEndpointEditor(w); // existing address search sheet
  };

  /* ---------- nickname popup for newly saved locations (2026-10-05) ---------- */
  let nickCb = null;
  function promptNickname(loc, cb) {
    nickCb = cb;
    $('nickInput').value = loc.name || loc.address || '';
    $('nickAddr').textContent = loc.address || '';
    $('nickSheet').hidden = false;
    setTimeout(() => { try { $('nickInput').focus(); $('nickInput').select(); } catch {} }, 50);
  }
  function closeNickSheet() { $('nickSheet').hidden = true; nickCb = null; }
  $('nickCancel').onclick = closeNickSheet;
  $('nickCancel2').onclick = closeNickSheet;
  $('nickSave').onclick = () => {
    const name = $('nickInput').value.trim();
    if (!name) { toast('Give it a nickname'); return; }
    const cb = nickCb;
    closeNickSheet();
    if (cb) { cb(name); _crumb('saving_location'); }
  };

  $('mAdd').onclick = async () => {
    const street = $('mStreet').value.trim();
    if (!street) { toast('Enter at least a street address'); return; }
    const s = {
      id: uid(), street, city: $('mCity').value.trim(), state: $('mState').value.trim(),
      zip: $('mZip').value.trim(), jobType: $('mJob').value.trim(), note: '',
      lat: null, lng: null, geocodeSource: null, done: false, isLast: false, isFirst: false, confirmed: false, twStart: null, twEnd: null, apptMin: null, source: 'manual',
    };
    const added = addStops([s]);
    $('mStreet').value = ''; $('mZip').value = ''; $('mJob').value = '';
    if (added > 0) _crumb('adding_stop');
    toast(added > 0 ? 'Stop added — locating it now' : 'That address is already on your route');
  };

  /* ---------- add: screenshots / OCR ---------- */
  let ocrPendingFiles = [];
