/* app-boot.js — boot sequence (split from app.js 2026-10-06) */
/* global $:writable, APP_VERSION:writable, Stats:writable, adoptDevicePos:writable, checkForUpdate:writable, checkinAtGps:writable, driveAwayAtGps:writable, ensureDevicePos:writable, isSameDay:writable, isWorkMode:writable, load:writable, loadSharedRoute:writable, markDirty:writable, maybeAutoReopt:writable, render:writable, restoreUIState:writable, save:writable, saveTileMeta:writable, saveUIState:writable, schedulePreDriveTime:writable, settings:writable, startAutoCheckinWatch:writable, startDeviceTracking:writable, startDriveAwayWatch:writable, state:writable, toast:writable, wipeRouteData:writable */ // eslint-disable-line no-unused-vars
'use strict';

  function bootApp() {
    // Stats first: init (device id, queue flush), then the global error
    // handlers before any other boot work, then the boot event + breadcrumb.
    try {
      if (Stats) {
        Stats.init();
        Stats.installErrorHandlers();
        Stats.crumb('app_boot');
        Stats.trackEvent('app_boot', {});
      }
    } catch {}
    load();
    if (!loadSharedRoute()) render();
    try { const av = $('appVer'); if (av) av.textContent = APP_VERSION; } catch {}
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('v')) {
        u.searchParams.delete('v');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch {}
    restoreUIState();
    checkForUpdate();
    // Resume auto check-in watch if it was on (work mode only).
    if (settings.autoCheckin && isWorkMode()) startAutoCheckinWatch();
    // Live blue-dot tracking: keep the map's "you are here" dot moving.
    startDeviceTracking();
    // Drive-away auto-complete delivery while checked in (both modes):
    // 60 s poll + visibilitychange cover iOS background suspension.
    startDriveAwayWatch();
    // Ask for location services right on launch: the permission prompt appears
    // immediately, and the map can show "you are here" before optimize runs.
    if (state.origin.type === 'gps' && state.origin.lat == null) {
      ensureDevicePos().then(adoptDevicePos);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { saveUIState(); }
      else {
        // auto-delete check: a route completed yesterday is wiped on return
        if (state.completedAt && !isSameDay(state.completedAt, Date.now()) &&
            state.stops.length && state.stops.every((x) => x.done)) {
          wipeRouteData();
          state.stops = []; state.completedAt = null;
          state.optimized = false; state.lastSchedule = null; state.returnActive = false; state.endActive = false;
          save(); render();
          toast('Yesterday\'s completed route was cleared');
        }
        checkForUpdate(); maybeAutoReopt('visible');
        // Proximity check on return: iOS suspends geolocation in background,
        // so check immediately when the app becomes visible.
        if (isWorkMode() && settings.autoCheckin && !state.checkedIn && 'geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition((pos) => {
            checkinAtGps(pos);
          }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
        }
        // Drive-away auto-complete on return: the same suspension applies
        // while checked in — evaluate the fresh fix immediately.
        if (state.checkedIn && 'geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition((pos) => {
            driveAwayAtGps(pos);
          }, () => {}, { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 });
        }
      } // reopened: fresh times + re-route
    });
    window.addEventListener('pagehide', () => { saveUIState(); saveTileMeta(); });
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
    // A restored/share-booted route with stops: verify the real drive time too
    // (markDirty only fires on edits, not on boot).
    if (state.stops.length && !state.optimized) schedulePreDriveTime();
    // Closed and reopened: fresh transport times + automatic re-optimization
    // around confirmed windows (settled after GPS/geocode get a beat).
    setTimeout(() => maybeAutoReopt('boot'), 4000);
    window.__rrBooted = true; // boot watchdog in index.html stands down
  }
  function bootWhenReady() {
    function go() { try { bootApp(); } catch (e) { console.error(e); } }
    try {
      var inst = (typeof window !== 'undefined') ? window.RRInstall : null;
      if (inst && inst.ready && typeof inst.ready.then === 'function') {
        inst.ready.then(go, go);
      } else { go(); }
    } catch { go(); }
  }
  bootWhenReady();
