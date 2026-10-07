/* app-settings.js — settings, service times, update check (split from app.js 2026-10-06) */
/* global $:writable, LS_ROUTE:writable, LS_SET:writable, RR_BUILD:writable, SVC_MAX:writable, SVC_MIN:writable, SVC_STEP:writable, _crumb:writable, esc:writable, isWorkMode:writable, load:writable, maybeAutoReopt:writable, save:writable, settings:writable, showMap:writable, state:writable, toast:writable */ // eslint-disable-line no-unused-vars
/* exported renderServiceTimes, APP_VERSION, saveUIState, restoreUIState, ssDel, checkForUpdate, applyUpdate */
'use strict';

  function svcOptions(selected) {
    let html = '';
    for (let m = SVC_MIN; m <= SVC_MAX; m += SVC_STEP) {
      html += '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + ' min</option>';
    }
    return html;
  }
  function renderServiceTimes() {
    const sec = $('svcSec');
    if (sec) sec.style.display = isWorkMode() ? '' : 'none';
    if (!isWorkMode()) return; // personal mode: no service-time settings at all
    const st = settings.serviceTimes;
    $('setSvcDefault').innerHTML = svcOptions(st.default);
    const box = $('svcRows');
    box.innerHTML = '';
    const known = st.known.slice().sort();
    if (!known.length) {
      box.innerHTML = '<p class="fine">No job types yet — they appear here as you import routes.</p>';
    }
    known.forEach((jt) => {
      const row = document.createElement('div');
      row.className = 'svc-row';
      const cur = st.byJobType[jt] != null ? st.byJobType[jt] : st.default;
      const isCustom = st.byJobType[jt] != null;
      row.innerHTML =
        '<span class="svc-name">' + esc(jt) + (isCustom ? '' : ' <small>(default)</small>') + '</span>' +
        '<select data-jt="' + esc(jt) + '">' + svcOptions(cur) + '</select>' +
        (isCustom ? '<button class="link" data-reset="' + esc(jt) + '">reset</button>' : '');
      box.appendChild(row);
    });
  }
  $('svcRows').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-jt]');
    if (!sel) return;
    const v = Number(sel.value);
    if (v >= SVC_MIN && v <= SVC_MAX) {
      settings.serviceTimes.byJobType[sel.dataset.jt] = v;
      save(); renderServiceTimes();
      _crumb('changing_setting');
      toast('Service time saved');
      maybeAutoReopt('window');
    }
  });
  $('svcRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-reset]');
    if (!btn) return;
    delete settings.serviceTimes.byJobType[btn.dataset.reset];
    save(); renderServiceTimes();
    toast('Reset to default');
  });
  $('setSvcDefault').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v >= SVC_MIN && v <= SVC_MAX) {
      settings.serviceTimes.default = v;
      save(); renderServiceTimes();
      _crumb('changing_setting');
      toast('Default service time: ' + v + ' min');
      maybeAutoReopt('window');
    }
  });
  $('svcResetAll').onclick = () => {
    if (!confirm('Reset every job type back to the default service time?')) return;
    settings.serviceTimes.byJobType = {};
    save(); renderServiceTimes();
    toast('All service times reset to default');
  };

  /* ---------- auto-update: newest version on every open, place restored ----------
   * version.json (never cached) is compared against the APP_VERSION stamped
   * into index.html at deploy time. On mismatch the UI state is snapshotted,
   * the new service worker is activated, and the page reloads onto the new
   * build — route data (already in localStorage) plus UI state are restored.
   * Offline or failed check = silent no-op. */
  const APP_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';
  // Self-healing: if the loaded JS build doesn't match the page build,
  // Safari served a stale app.js — force a cache-busting reload once.
  try {
    if (RR_BUILD && RR_BUILD !== '__BUILD__' && APP_VERSION && APP_VERSION !== 'dev' &&
        RR_BUILD !== APP_VERSION && !/[?&]v=/.test(location.search) &&
        !sessionStorage.getItem('rr.selfheal')) {
      sessionStorage.setItem('rr.selfheal', '1');
      const u = new URL(location.href);
      u.searchParams.set('v', APP_VERSION);
      location.replace(u.toString());
    }
  } catch {}
  const UI_KEY = 'rr.ui.v1';
  function saveUIState() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        y: window.scrollY || 0,
        mapOpen: !$('mapWrap').hidden,
        settingsOpen: !$('settingsSheet').hidden,
        draft: $('searchInput') ? $('searchInput').value : '',
      }));
    } catch { /* storage unavailable — restore just skips */ }
  }
  function restoreUIState() {
    let ui = null;
    try { ui = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch {}
    if (!ui) return;
    if (ui.draft && $('searchInput')) $('searchInput').value = ui.draft;
    if (ui.mapOpen && $('mapWrap').hidden) showMap().catch(() => {});
    if (ui.settingsOpen && $('settingsSheet').hidden) $('settingsBtn').click();
    if (ui.y) window.scrollTo(0, ui.y);
  }
  let lastUpdateCheck = 0;
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch {} }
  function checkForUpdate() {
    // Dev tree (unstamped __BUILD__): version.json belongs to some other
    // build — never "update" here, or the page reload-loops every ~30s.
    // Mirrors the stale-code gate in index.html.
    if (!APP_VERSION || APP_VERSION === 'dev' || APP_VERSION.indexOf('__BUILD__') !== -1) return;
    const now = Date.now();
    if (now - lastUpdateCheck < 30000) return; // throttle foreground checks
    lastUpdateCheck = now;
    if (typeof fetch !== 'function') return;
    // If a previous update attempt stalled (flag set but no reload in 30s),
    // clear the flag so we retry instead of staying stuck.
    const updatingSince = Number(ssGet('rr.updating_at') || 0);
    if (ssGet('rr.updating') && updatingSince && now - updatingSince > 30000) {
      ssDel('rr.updating'); ssDel('rr.updating_at');
    }
    fetch('version.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || !info.version) return;
        if (info.version === APP_VERSION) { ssDel('rr.updating'); ssDel('rr.updating_at'); return; }
        if (ssGet('rr.updating')) return;
        ssSet('rr.updating_at', String(Date.now()));
        // Give a just-resumed webview a beat to settle before navigating away.
        setTimeout(() => applyUpdate(info.version), 1500);
      })
      .catch(() => {});
  }
  function applyUpdate(serverVersion) {
    // Guard: never run two updates at once (rapid taps froze the app).
    if (window.__rrUpdating) return;
    window.__rrUpdating = true;
    ssSet('rr.updating', '1');
    try {
      const route = localStorage.getItem(LS_ROUTE);
      if (route) localStorage.setItem('rr.route.backup', route);
      const set = localStorage.getItem(LS_SET);
      if (set) localStorage.setItem('rr.settings.backup', set);
    } catch {}
    saveUIState();
    toast('Updating to the latest version…');
    let done = false;
    const cacheBust = () => {
      if (done) return; done = true;
      try {
        const u = new URL(location.href);
        u.searchParams.set('v', serverVersion);
        location.href = u.toString();
      } catch { location.reload(); }
    };
    // The old SW serves stale cached files on plain reload. Unregister all
    // workers first, then cache-bust — guarantees the new shell loads.
    try {
      const unreg = ('serviceWorker' in navigator) && navigator.serviceWorker.getRegistrations
        ? navigator.serviceWorker.getRegistrations()
            .then((regs) => Promise.all(regs.map((r) => r.unregister().catch(() => {}))))
            .catch(() => {})
        : Promise.resolve();
      Promise.resolve(unreg).then(cacheBust).catch(cacheBust);
      setTimeout(cacheBust, 4000); // backstop if unregistration stalls
    } catch {
      cacheBust();
    }
  }

  /* ---------- boot (gated on the install system, IR15) ---------- */
  // The install/update screen (install.js) runs before any app UI, OCR
  // init, or GPS prompt. If install.js failed to load, boot degraded
  // rather than dead.
