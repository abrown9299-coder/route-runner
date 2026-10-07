/* app-traffic.js — traffic learning, weather factor, leg tracking (split from app.js 2026-10-06) */
/* global RouteCore: readonly */
/* global $:writable, LS_TRAFFIC:writable, STATIONARY_DISCARD_MS:writable, devicePos:writable, fetchJson:writable, legTrack:writable, loadTrafficModel:writable, state:writable */ // eslint-disable-line no-unused-vars
/* exported makeTrafficFn, trackDepartureLeg, noteLegPosition, endLegTracking */
'use strict';

  function loadTrafficLearn() {
    try {
      const raw = localStorage.getItem(LS_TRAFFIC);
      if (!raw) return { buckets: {} };
      const d = JSON.parse(raw);
      return d && d.buckets ? d : { buckets: {} };
    } catch { return { buckets: {} }; }
  }
  function saveTrafficLearn(d) {
    try { localStorage.setItem(LS_TRAFFIC, JSON.stringify(d)); } catch {}
  }
  /* ---------- weather: rain impact on drive times ---------- */
  let weatherCache = null; // {precipMm, fetchedAt}
  const WEATHER_TTL_MS = 15 * 60 * 1000; // refresh every 15 min
  async function fetchWeather() {
    try {
      // Location priority: live GPS > route origin. No hardcoded city
      // fallback — if none available, skip (assume dry).
      const lat = devicePos ? devicePos.lat
        : (state.origin.lat != null ? state.origin.lat : null);
      const lng = devicePos ? devicePos.lng
        : (state.origin.lng != null ? state.origin.lng : null);
      if (lat == null || lng == null) {
        weatherCache = { precipMm: 0, fetchedAt: Date.now() };
        return weatherCache;
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&current=precipitation&timezone=auto`;
      const r = await fetchJson(url, {}, 8000);
      const precip = r && r.current && typeof r.current.precipitation === 'number' ? r.current.precipitation : 0;
      weatherCache = { precipMm: precip, fetchedAt: Date.now() };
    } catch {
      // weather unavailable — assume dry (factor 1.0)
      weatherCache = { precipMm: 0, fetchedAt: Date.now() };
    }
    return weatherCache;
  }
  function currentRainFactor() {
    if (!weatherCache || Date.now() - weatherCache.fetchedAt > WEATHER_TTL_MS) {
      fetchWeather(); // refresh in background
      return weatherCache ? RouteCore.rainFactorFor(weatherCache.precipMm) : 1.0;
    }
    return RouteCore.rainFactorFor(weatherCache.precipMm);
  }

  /* Effective traffic factor closure for the optimizer: base pattern blended
   * with learned data (local + imported model) for this area + time,
   * multiplied by the current rain factor. */
  function makeTrafficFn() {
    const local = loadTrafficLearn();
    const imported = loadTrafficModel();
    const combined = { buckets: { ...(local.buckets || {}) } };
    if (imported && imported.buckets) {
      for (const k in imported.buckets) {
        const ib = imported.buckets[k];
        if (!ib || !ib.n || !ib.ratio) continue;
        const cb = combined.buckets[k] || { n: 0, sum: 0 };
        cb.n += ib.n;
        cb.sum += ib.ratio * ib.n;
        combined.buckets[k] = cb;
      }
    }
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const rainF = currentRainFactor();
    return (departMin, lat, lng) => {
      return RouteCore.learnedTrafficFactorAt(departMin, isWeekend, combined, lat, lng) * rainF;
    };
  }
  /* Departure: start tracking the drive to the next undone stop for traffic
   * learning. Free-flow estimate comes from the last schedule when
   * available. Shared by manual completion and drive-away auto-complete. */
  function trackDepartureLeg() {
    const next = state.stops.find((x) => !x.done && x.lat != null);
    if (next) {
      const ff = (state.lastSchedule && state.lastSchedule.driveTo &&
        state.lastSchedule.driveTo[next.id]) || 15;
      startLegTracking(next, ff);
    }
  }
  function startLegTracking(toStop, freeFlowMin) {
    if (!toStop || toStop.lat == null) return;
    const from = devicePos || (state.origin.lat != null ? { lat: state.origin.lat, lng: state.origin.lng } : null);
    legTrack = {
      departAt: Date.now(),
      fromLat: from ? from.lat : null, fromLng: from ? from.lng : null,
      toLat: toStop.lat, toLng: toStop.lng,
      toStopId: toStop.id,
      freeFlowMin: freeFlowMin || 0,
      rainFactor: currentRainFactor(), // normalize learning for weather
      stationaryMs: 0,
      lastPos: devicePos ? { ...devicePos } : null,
      lastPosAt: Date.now(),
      lastMoveAt: Date.now(),
    };
  }
  function noteLegPosition(pos) {
    if (!legTrack || !pos) return;
    const now = Date.now();
    if (legTrack.lastPos) {
      // haversine distance in meters
      const R = 6371000;
      const dLat = (pos.lat - legTrack.lastPos.lat) * Math.PI / 180;
      const dLng = (pos.lng - legTrack.lastPos.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(legTrack.lastPos.lat * Math.PI / 180) * Math.cos(pos.lat * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      const distM = 2 * R * Math.asin(Math.sqrt(a));
      if (distM > 50) {
        // moved significantly — reset the continuous-stationary clock.
        // Stop-and-go traffic resets; a gas station stop doesn't.
        legTrack.lastMoveAt = now;
        legTrack.stationaryMs = 0;
      } else {
        legTrack.stationaryMs = now - legTrack.lastMoveAt;
      }
    }
    legTrack.lastPos = { ...pos };
    legTrack.lastPosAt = now;
  }
  function endLegTracking(arrivedStopId) {
    if (!legTrack) return;
    const leg = legTrack;
    legTrack = null;
    try {
      // Only learn from legs that match: we arrived where we expected.
      if (arrivedStopId !== leg.toStopId) return;
      const actualMin = (Date.now() - leg.departAt) / 60000;
      // Discard: stationary 5+ min mid-leg (gas station, restroom, errand).
      if (leg.stationaryMs >= STATIONARY_DISCARD_MS) return;
      // Discard: absurd ratios (GPS glitch, forgot to check in, etc.)
      if (!leg.freeFlowMin || leg.freeFlowMin < 1) return;
      const rainF = leg.rainFactor || 1.0;
      const actualNorm = actualMin / rainF;
      const ratioNorm = actualNorm / leg.freeFlowMin;
      if (ratioNorm < 0.4 || ratioNorm > 3.0) return;
      // Normalize for weather and base traffic:
      // adjustment = (actual / rainFactor) / (free * base).
      // This keeps rainy drives from polluting the "normal" buckets.
      const departDate = new Date(leg.departAt);
      const departMin = departDate.getHours() * 60 + departDate.getMinutes();
      const isWeekend = departDate.getDay() === 0 || departDate.getDay() === 6;
      const base = RouteCore.trafficFactorAt(departMin);
      const adjustment = ratioNorm / base;
      const key = RouteCore.trafficBucketKey(departMin, isWeekend, leg.toLat, leg.toLng);
      const learn = loadTrafficLearn();
      RouteCore.recordTrafficSample(learn, key, adjustment);
      saveTrafficLearn(learn);
    } catch (e) { console.warn('traffic learn failed', e); }
  }

