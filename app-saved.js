/* app-saved.js — saved-locations settings UI (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, _crumb:writable, endResolved:writable, esc:writable, geocodeArcGIS:writable, geocodeCacheLookup:writable, geocodeCacheStore:writable, isWorkMode:writable, load:writable, onOriginPick:writable, onSearchPick:writable, photonBiasParams:writable, render:writable, renderServiceTimes:writable, resetRoute:writable, save:writable, settings:writable, startAutoCheckinWatch:writable, state:writable, stopAutoCheckinWatch:writable, toast:writable, wireApptDialog:writable, wireEndpointEditor:writable */ // eslint-disable-line no-unused-vars
/* exported renderSavedLocations, attachAddressDropdown, updateModeHint */
'use strict';

  function renderSavedLocations() {
    const ul = $('savedList');
    if (!ul) return;
    ul.innerHTML = '';
    if (!settings.savedLocations.length) {
      ul.innerHTML = '<li class="fine">No saved locations yet. Tap ⭐ on any address to save it.</li>';
      return;
    }
    settings.savedLocations.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'saved-row';
      li.innerHTML =
        '<span class="saved-star">⭐</span>' +
        '<div class="info"><div class="addr">' + esc(s.name) + '</div>' +
        (s.address && s.address !== s.name ? '<div class="meta"><span class="chip">' + esc(s.address) + '</span></div>' : '') +
        '</div>' +
        '<div class="acts">' +
          '<button data-sact="rename" title="Rename">✏️</button>' +
          '<button data-sact="del" title="Remove">✕</button>' +
        '</div>';
      ul.appendChild(li);
    });
  }
  // Delegate rename/delete clicks for the saved list.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sact]');
    if (!btn) return;
    const li = btn.closest('li.saved-row');
    if (!li) return;
    const nameEl = li.querySelector('.addr');
    const name = nameEl ? nameEl.textContent : '';
    const loc = settings.savedLocations.find((s) => s.name === name);
    if (!loc) return;
    const key = RouteCore.savedLocationKey(loc);
    if (btn.dataset.sact === 'del') {
      if (!confirm('Remove "' + loc.name + '" from saved locations?')) return;
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); renderSavedLocations(); render();
      toast('☆ Unsaved');
    } else if (btn.dataset.sact === 'rename') {
      const nn = prompt('Rename saved location:', loc.name);
      if (nn === null) return;
      settings.savedLocations = RouteCore.renameSavedLocation(settings.savedLocations, key, nn);
      save(); renderSavedLocations(); render();
      toast('Renamed');
    }
  });

  /* ---------- add saved location sheet (six items item 6, 2026-10-05) ----------
   * "＋ Add location" in settings → address (shared dropdown) + nickname →
   * geocode (ArcGIS score ≥ 80, then Nominatim with GPS bias) →
   * toggleSavedLocation. Ungeocodable addresses are REFUSED ("Couldn't find
   * that address") — coord-less saved locations break the address/coords
   * keying. All rendered strings are esc()'d (XSS, §2). */
  let addSavedPick = null; // {label, address, lat, lng} from the dropdown pick
  function openAddSavedSheet() {
    addSavedPick = null;
    $('addSavedAddr').value = '';
    $('addSavedNick').value = '';
    $('addSavedSuggest').hidden = true;
    $('addSavedSheet').hidden = false;
    setTimeout(() => { try { $('addSavedAddr').focus(); } catch {} }, 50);
  }
  function closeAddSavedSheet() { $('addSavedSheet').hidden = true; addSavedPick = null; }
  attachAddressDropdown('addSavedAddr', 'addSavedSuggest', 'addSavedAddrWrap', (v) => {
    addSavedPick = {
      label: v.label,
      address: v.address || v.label,
      lat: v.lat, lng: v.lng,
    };
    $('addSavedAddr').value = addSavedPick.address;
    if (!$('addSavedNick').value.trim() && v.fromSaved) $('addSavedNick').value = v.label || '';
  });
  // A typed edit invalidates the picked coords — only a real pick carries them.
  $('addSavedAddr').addEventListener('input', () => { addSavedPick = null; });
  $('addSavedBtn').onclick = openAddSavedSheet;
  $('addSavedClose').onclick = closeAddSavedSheet;
  $('addSavedCancel').onclick = closeAddSavedSheet;
  /* Geocode a raw address string: ArcGIS (score ≥ 80) → Nominatim (GPS bias).
   * Returns {lat, lng} or null. Every fetch path is failure-guarded. */
  async function geocodeAddressString(q) {
    const key = RouteCore.normalizeGeocodeKey(q);
    const hit = geocodeCacheLookup(key);
    if (hit) return hit;
    const tmp = { street: q, city: '', state: '', zip: '' };
    try {
      if (await geocodeArcGIS(tmp, q)) {
        geocodeCacheStore(key, tmp.lat, tmp.lng);
        return { lat: tmp.lat, lng: tmp.lng };
      }
    } catch {}
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
        encodeURIComponent(q) + photonBiasParams(), { headers: { 'Accept': 'application/json' } });
      const j = await r.json();
      if (j && j[0] && j[0].lat && j[0].lon) {
        const lat = parseFloat(j[0].lat), lng = parseFloat(j[0].lon);
        geocodeCacheStore(key, lat, lng);
        return { lat: lat, lng: lng };
      }
    } catch {}
    return null;
  }
  $('addSavedSave').onclick = async () => {
    const btn = $('addSavedSave');
    const q = $('addSavedAddr').value.trim();
    if (!q) { toast('Enter an address first'); return; }
    // Nickname falls back to the address, capped at the load sanitizer's
    // 120 chars. Everything is esc()'d at render time (XSS, §2).
    const nickname = $('addSavedNick').value.trim().slice(0, 120) || q.slice(0, 120);
    btn.disabled = true;
    try {
      let lat = null, lng = null, address = q;
      if (addSavedPick && typeof addSavedPick.lat === 'number' && typeof addSavedPick.lng === 'number') {
        lat = addSavedPick.lat; lng = addSavedPick.lng; address = addSavedPick.address;
      } else {
        const g = await geocodeAddressString(q);
        if (!g) { toast("Couldn't find that address"); return; }
        lat = g.lat; lng = g.lng;
      }
      if (!isFinite(lat) || !isFinite(lng)) { toast("Couldn't find that address"); return; }
      const loc = { name: nickname, address: address, lat: lat, lng: lng };
      if (RouteCore.isSavedLocation(settings.savedLocations, loc)) {
        toast('Already saved');
        return;
      }
      const r = RouteCore.toggleSavedLocation(settings.savedLocations, loc);
      settings.savedLocations = r.saved;
      save(); renderSavedLocations(); render();
      closeAddSavedSheet();
      _crumb('saving_location');
      toast('⭐ Saved "' + nickname + '"');
    } finally {
      btn.disabled = false;
    }
  };

  /* ---------- precision banner (Issue 2) ---------- */
  $('precisionBannerClose').onclick = () => { $('precisionBanner').hidden = true; };
  /* ---------- universal address dropdown (spec §3) ----------
   * attachAddressDropdown(inputEl, listEl, wrapEl, onSelect)
   * - Empty + focus → shows saved locations (⭐ rows) first.
   * - Typing (debounced 300ms) → live Photon + Nominatim results.
   * - onSelect({label, street, city, state, zip, lat, lng}) on pick.
   * - Keyboard: ↑/↓ navigate, Enter selects, Esc dismisses. */
  function attachAddressDropdown(inputEl, listEl, wrapEl, onSelect) {
    const input = typeof inputEl === 'string' ? $(inputEl) : inputEl;
    const list = typeof listEl === 'string' ? $(listEl) : listEl;
    const wrap = typeof wrapEl === 'string' ? $(wrapEl) : wrapEl;
    if (!input || !list) return;
    let timer = null, tok = 0, activeIdx = -1;

    function close() { list.hidden = true; list.innerHTML = ''; activeIdx = -1; }
    function highlight() {
      const items = list.querySelectorAll('li[data-idx]');
      items.forEach((li, i) => li.classList.toggle('active', i === activeIdx));
      const act = items[activeIdx];
      if (act) act.scrollIntoView({ block: 'nearest' });
    }
    function pick(idx) {
      const li = list.querySelectorAll('li[data-idx]')[idx];
      if (!li || !li._pick) return;
      const v = li._pick;
      close();
      if (typeof onSelect === 'function') onSelect(v);
    }

    function renderSaved(filter) {
      const matches = RouteCore.filterSavedLocations(settings.savedLocations, filter);
      list.innerHTML = '';
      activeIdx = -1;
      if (!matches.length) { list.hidden = true; return; }
      const head = document.createElement('li');
      head.className = 'dd-head';
      head.innerHTML = '⭐ Saved locations';
      list.appendChild(head);
      matches.forEach((s, i) => {
        const li = document.createElement('li');
        li.dataset.idx = i;
        li.innerHTML = '⭐ <b>' + esc(s.name) + '</b><small>' + esc(s.address || '') + '</small>';
        li._pick = {
          label: s.name, address: s.address,
          street: s.address || '', city: '', state: '', zip: '',
          lat: s.lat, lng: s.lng, fromSaved: true,
        };
        li.onclick = () => pick(i);
        list.appendChild(li);
      });
      list.hidden = false;
    }

    async function searchLive(q, myToken) {
      try {
        list.innerHTML = '';
        const hasHouseNum = /^\d+\s+\S/.test(q);
        const photonP = fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) +
          '&limit=6' + photonBiasParams()).then((r) => r.json()).catch(() => null);
        const censusP = hasHouseNum
          ? fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=' + encodeURIComponent(q))
              .then((r) => r.json()).catch(() => null)
          : Promise.resolve(null);
        const [pj, cj] = await Promise.all([photonP, censusP]);
        if (myToken !== tok) return; // stale
        list.innerHTML = '';
        activeIdx = -1;
        let idx = 0;
        const addRow = (html, pickData) => {
          const li = document.createElement('li');
          li.dataset.idx = idx++;
          li.innerHTML = html;
          li._pick = pickData;
          li.onclick = () => pick(li.dataset.idx);
          list.appendChild(li);
        };
        const nm = cj && cj[0];
        if (nm && nm.address && nm.address.house_number) {
          const a = nm.address;
          const street = [(a.house_number || ''), (a.road || '')].filter(Boolean).join(' ');
          const city = a.city || a.town || a.village || '';
          const cleanAddr = [street, city, [a.state_code || a.state || '', a.postcode || ''].filter(Boolean).join(' ')]
            .filter(Boolean).join(', ');
          addRow('✓ <b>' + esc(cleanAddr) + '</b><small>Exact address match</small>', {
            label: cleanAddr, street, city,
            state: a.state_code || a.state || '', zip: a.postcode || '',
            lat: parseFloat(nm.lat), lng: parseFloat(nm.lon),
          });
        }
        (pj && pj.features || []).forEach((f) => {
          const p = f.properties || {};
          const label = [p.name, p.street, p.city, p.state, p.postcode].filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i).join(', ');
          const qNum = (q.match(/^\d+/) || [])[0] || '';
          let street = [p.housenumber, p.street].filter(Boolean).join(' ') ||
                       [p.name, p.street].filter(Boolean).join(' ') || label;
          if (qNum && street && !new RegExp('^' + qNum + '\\b').test(street)) {
            const qStreet = q.replace(/^\d+\s+/, '').toLowerCase();
            if (street.toLowerCase().includes(qStreet.split(' ')[0])) {
              street = qNum + ' ' + street;
            }
          }
          const addr = [street, p.city, [p.state, p.postcode].filter(Boolean).join(' ')]
            .filter(Boolean).join(', ');
          const coords = f.geometry && f.geometry.coordinates;
          addRow(esc(label || 'Unnamed place') +
            '<small>' + esc([p.city, p.state].filter(Boolean).join(', ')) + '</small>', {
            label: addr || label, street,
            city: p.city || '', state: p.state || '', zip: p.postcode || '',
            lat: coords ? coords[1] : null, lng: coords ? coords[0] : null,
          });
        });
        list.hidden = !list.children.length;
      } catch { /* offline — suggestions unavailable */ }
    }

    input.addEventListener('focus', () => {
      renderSaved('');
    });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { renderSaved(''); return; }
      const myToken = ++tok;
      timer = setTimeout(() => searchLive(q, myToken), 300);
    });
    input.addEventListener('keydown', (e) => {
      const items = list.querySelectorAll('li[data-idx]');
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % items.length; highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % items.length; highlight(); }
      else if (e.key === 'Enter') { if (activeIdx >= 0) { e.preventDefault(); pick(activeIdx); } }
      else if (e.key === 'Escape') { close(); }
    });
    document.addEventListener('click', (e) => {
      if (wrap && !e.target.closest('#' + (wrap.id || '')) && e.target !== input) close();
      else if (!wrap && !input.contains(e.target) && !list.contains(e.target)) close();
    });
    // Expose a close handle for programmatic dismissal.
    input._ddClose = close;
  }

  function updateModeHint() {
    const h = $('modeHint');
    if (h) h.textContent = isWorkMode()
      ? 'Work profile: confirmed windows, check-in, notes, job types.'
      : 'Personal profile: just stops — first/last pins stay, work features hide.';
    const acr = $('setAutoCheckinRow');
    if (acr) acr.style.display = isWorkMode() ? '' : 'none';
    const acfr = $('setAutoConfirmRow');
    if (acfr) acfr.style.display = isWorkMode() ? '' : 'none';
  }
  $('setMode').addEventListener('change', () => {
    settings.mode = $('setMode').value === 'personal' ? 'personal' : 'work';
    save(); updateModeHint(); renderServiceTimes(); render();
    if (settings.mode === 'personal') stopAutoCheckinWatch();
    else if (settings.autoCheckin) startAutoCheckinWatch();
    _crumb('changing_setting');
    toast(settings.mode === 'personal' ? 'Personal profile — work features hidden' : 'Work profile');
  });
  $('settingsClose').onclick = () => {
    _crumb('changing_setting'); // checkbox settings apply on close
    const retBefore = settings.returnToStart;
    settings.avoidTolls = $('setTolls').checked;
    settings.avoidHwy = $('setHwy').checked;
    settings.returnToStart = $('setReturn').checked;
    settings.saveHistory = $('setHistory').checked;
    const acBefore = !!settings.autoCheckin;
    settings.autoCheckin = $('setAutoCheckin').checked;
    const acfBefore = !!settings.autoConfirmAll;
    settings.autoConfirmAll = $('setAutoConfirm').checked;
    settings.earlySuggest = $('setEarlySuggest').checked;
    if (settings.returnToStart !== retBefore) {
      // the route shape changed (return leg added/removed) — re-optimize needed
      state.optimized = false; state.returnActive = false; state.endActive = false;
      endResolved = null;
    }
    save();
    if (settings.autoCheckin !== acBefore) {
      if (settings.autoCheckin) startAutoCheckinWatch();
      else stopAutoCheckinWatch();
      toast(settings.autoCheckin ? 'Auto check-in on — GPS will check you in at stops' : 'Auto check-in off');
    }
    if (settings.autoConfirmAll && !acfBefore) {
      // Just turned on: confirm all stops that have a screenshot time.
      let n = 0;
      for (const s of state.stops) {
        if (!s.confirmed && s.apptMin != null) {
          s.confirmed = true; s.twStart = s.apptMin;
          s.twEnd = s.twEnd != null ? s.twEnd : s.apptMin + 120;
          n++;
        }
      }
      if (n) { save(); toast('✓ ' + n + ' stop' + (n === 1 ? '' : 's') + ' auto-confirmed'); }
    }
    if (settings.returnToStart !== retBefore) {
      toast(settings.returnToStart
        ? 'Return to start on — tap ⚡ Optimize to rebuild the route'
        : 'Return to start off — tap ⚡ Optimize to rebuild the route');
    }
    $('settingsSheet').hidden = true;
    render();
  };
  $('clearRoute').onclick = () => resetRoute(true);

  /* ---------- service times (v1.9): per-job-type durations ----------
   * Job types are learned from imports over time. Each gets a dropdown
   * (15, 20, 25, … minutes); unadjusted types use the default (45).
   * Nothing resets on its own — only the explicit reset controls. */

  /* 2026-10-06 (module split): address-dropdown wiring for the search bar, the
   * appointment dialog, the endpoint editor, and the origin editor. These ran at
   * app.js top level where hoisting made attachAddressDropdown available; as
   * separate classic scripts they must run AFTER this module defines it — hence
   * here, in their original relative order. onSearchPick (app-search.js) and
   * onOriginPick (app-optimize.js) both load earlier. */
  attachAddressDropdown('searchInput', 'suggestList', 'searchWrap', onSearchPick);
  wireApptDialog();
  wireEndpointEditor();
  attachAddressDropdown('originSearchInput', 'originSuggestList', 'originSearchWrap', onOriginPick);
