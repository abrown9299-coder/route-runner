/* stats-store.js — localStorage helpers + device identity (split from stats.js 2026-10-06) */
/* global LS_DEVICE: readonly */
'use strict';
/* exported lsJsonGet, lsJsonSet, getDeviceId, deviceType, appVersion */

  /* ---------- storage (quota-safe: every access guarded) ---------- */
  function lsGet(k) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      var v = window.localStorage.getItem(k);
      return v == null ? null : v;
    } catch { return null; }
  }
  function lsSet(k, v) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      window.localStorage.setItem(k, v);
      return true;
    } catch { return false; }
  }
  function lsJsonGet(k, fb) {
    try {
      var raw = lsGet(k);
      if (raw == null) return fb;
      var v = JSON.parse(raw);
      return v == null ? fb : v;
    } catch { return fb; }
  }
  function lsJsonSet(k, v) {
    try { return lsSet(k, JSON.stringify(v)); } catch { return false; }
  }

  /* ---------- device identity / environment ---------- */
  function getCrypto() {
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) return crypto;
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) return window.crypto;
    } catch {}
    return null;
  }

  function randomHex16() {
    var bytes = new Uint8Array(16);
    var c = getCrypto();
    if (c) {
      c.getRandomValues(bytes);
    } else {
      // Non-secure fallback (never expected in practice): still 128-bit and anonymous.
      for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var s = '';
    for (var j = 0; j < 16; j++) s += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
    return s;
  }

  function getDeviceId() {
    var id = lsGet(LS_DEVICE);
    if (id && /^[0-9a-f]{32}$/.test(id)) return id;
    id = randomHex16();
    lsSet(LS_DEVICE, id); // best-effort persist; the id is still used for this session
    return id;
  }

  function deviceType() {
    var ua = '';
    try { ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''; } catch {}
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'other';
  }

  function appVersion() {
    try {
      if (typeof document === 'undefined') return 'dev';
      var m = document.querySelector('meta[name="app-version"]');
      var v = m && m.getAttribute('content');
      return v || 'dev';
    } catch { return 'dev'; }
  }
