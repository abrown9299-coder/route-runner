/* RouteRunner core — pure, dependency-free algorithms.
 *
 * No DOM, no fetch at module scope, no AI, no dependencies.
 * Works in node (module.exports) and in the browser (window.RouteCore).
 *
 * Functions:
 *   parseOcrText(text)          OCR blob  -> [{street, city, state, zip, jobType}]
 *   normalizeStop(stop)         stop      -> canonical dedupe key
 *   dedupeStops(stops)           stops     -> {stops, removed}
 *   haversineMi(a, b)           {lat,lng}x2 -> miles
 *   buildHaversineMatrix(points) -> n x n mile matrix
 *   optimizeOrder(matrix, {start, first, last}) -> index order (NN + 2-opt; `first` pinned right after start, `last` pinned at end)
 *   optimizeOrder opts (v1.9): {windows, durMin, source, departMin, serviceMin, bufferMin}
 *   optimizeOrder opts (2026-10-06): + seedOrder — current route order used
 *     as a second 2-opt seed; ties prefer it, making re-optimize idempotent.
 *     windows[i] = null | {start, end} arrival window in minutes-from-midnight;
 *     effective deadline is end - bufferMin (30). Early arrival waits.
 *   simulateSchedule(order, durMin, schedCtx) -> {legs, driveMin, violations}
 *   minutesMatrix(matrix, source) -> drive-minute matrix parallel to matrix
 *   parseClockToMin("9:00 AM") -> 540 ; formatClock(540) -> "9:00 AM"
 *   buildDurationMatrix(points, fetchFn) -> Promise<{matrix, source}>
 *   cachedDurationMatrix(points, fetchFn, cache) -> Promise<{matrix, source}>
 *   optimizeRouteAsync(points, {startIdx, firstIdx, lastIdx, fetchFn, matrixCache})
 *     -> Promise<{order, source}>
 *   normalizeGeocodeKey(address) -> cache key for an address string
 *   parallelLimit(items, limit, fn) -> Promise (≤limit tasks in flight)
 *   matrixCacheKey(points) -> point-set signature string
 *   makeTtlCache(storageKey, ttlMs, maxEntries, store, opts) -> TTL LRU cache
 *   ensureGeocodeNeeded(stops, startEp, origin) -> bool (doOptimize skip guard)
 *   buildMapsLinks(originLabel, orderedStops, {avoid}) -> [{label, url}]
 *   encodeShare(payload) / decodeShare(str) -> shareable '#r=...' links
 */

'use strict';

/* ------------------------------------------------------------------ */
/* 6.1 OCR parse                                                       */
/* ------------------------------------------------------------------ */

/* Arrow schedule cards repeat this block per stop:
 *   <customer name>   <- DISCARDED, never stored
 *   <time e.g. 9:00 AM> <- captured as apptMin (minutes from midnight)
 *   <street e.g. "1014 Kirkwood Ave">
 *   <city, ST ZIP e.g. "Nashville, TN 37204-2516">
 *   <job type e.g. "Sentricon Guarantee/Coverage">
 * Output objects NEVER carry a `name` field. Appointment times ARE stored
 * (Aaron authorized 2026-10-01); names are not.
 */
var CITY_ZIP_RE = /^(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;
/* Street line: house number + street name. The name may start with a letter
 * ("Clairmont Pl") OR an ordinal number ("14th Ave", "5th St", "2nd Ave") —
 * 2026-10-05: "1710 14th Ave N" was rejected by the letter-only version and a
 * whole stop silently never imported. The ordinal branch requires trailing
 * letters so a bare number ("123 456") still doesn't count as a street. */
var STREET_RE = /^\d+\s+(?:[A-Za-z]|\d+[A-Za-z])/;

/* Known pest-control job types for detection in schedule text.
 * These are service labels, not addresses — matched to populate jobType. */
var KNOWN_JOB_TYPES = [
  'General Pest Control', 'General Pest', 'Pest Control',
  'Termite Protection', 'Termite', 'Sentricon', 'Termidor', 'Trelona',
  'Mosquito Control', 'Mosquito', 'Bed Bug Treatment', 'Bed Bug', 'Bed Bugs',
  'Rodent Control', 'Rodent', 'Wasp', 'Stinging Insect', 'Fleas', 'Ticks',
  'Quarterly', 'Bi-monthly', 'Bimonthly', 'Monthly', 'Annual',
  'Initial Service', 'Initial', 'Re-treatment', 'Retreatment', 'Callback',
  'Inspection', 'Warranty Service', 'Exterior', 'Interior', 'Perimeter',
];

/* Labeled address field patterns: "Service Address: ...", "Address: ..." */
var LABEL_RE = /^(?:Service\s+Address|Property\s+Address|Site\s+Address|Location|Address)\s*:\s*(.+)$/i;

/* Time window: "9:00 AM - 11:00 AM" or "9:00-11:00 AM" — extract the start */
function parseTimeWindow(s) {
  var m = String(s).match(/(\d{1,2}:\d{2}\s*[APap]\.?\s*[Mm]\.?)\s*[-\u2013\u2014]\s*(\d{1,2}:\d{2}\s*[APap]\.?\s*[Mm]\.?)/);
  if (m) {
    var start = parseClockToMin(m[1]);
    var end = parseClockToMin(m[2]);
    if (start !== null && end !== null) return { start: start, end: end };
  }
  // "between 10 and 12" or "10am-12pm"
  m = String(s).match(/between\s+(\d{1,2})\s*(am|pm)?\s+and\s+(\d{1,2})\s*(am|pm)/i);
  if (m) {
    var s1 = parseClockToMin(m[1] + ':00 ' + (m[2] || m[4] || 'AM'));
    var e1 = parseClockToMin(m[3] + ':00 ' + (m[4] || 'PM'));
    if (s1 !== null && e1 !== null) return { start: s1, end: e1 };
  }
  return null;
}

/* "3-5" style short window: given the appointment hour, "3-5" means 3 PM - 5 PM.
 * Returns {start, end} or null. The apptMin provides the AM/PM context.
 * Finds the pattern anywhere in the line (OCR often merges it with the street). */
function parseShortWindow(s, apptMin) {
  var m = String(s).match(/\b(\d{1,2})\s*[-\u2013\u2014]\s*(\d{1,2})\b/);
  if (!m || apptMin == null) return null;
  var sh = Number(m[1]), eh = Number(m[2]);
  // The window start hour should match the appointment hour (12h clock).
  var apptH12 = Math.floor(apptMin / 60) % 12;
  if (apptH12 === 0) apptH12 = 12;
  if (sh !== apptH12) return null;
  // Infer AM/PM from the appointment time.
  var isPM = apptMin >= 720 && apptMin < 1440;
  // Handle noon/midnight edge: 12 PM = 720, 12 AM = 0
  var startH = sh % 12, endH = eh % 12;
  if (isPM) { startH += 12; endH += 12; if (startH === 24) startH = 12; if (endH === 24) endH = 12; }
  else { if (startH === 12) startH = 0; if (endH === 12) endH = 0; }
  // Overnight windows (e.g. 11-1) are unlikely for appointments; reject.
  if (endH * 60 <= startH * 60) return null;
  return { start: startH * 60, end: endH * 60 };
}

/* Lock detection: 🔒 emoji, the word "lock", or common OCR artifacts.
 * A lock next to the time means the stop is a confirmed appointment. */
function hasLockIndicator(s) {
  var t = String(s);
  if (t.indexOf('🔒') !== -1) return true;
  if (t.indexOf('🔐') !== -1) return true; // closed lock variant
  if (/\block\b/i.test(t)) return true;
  // OCR often renders 🔒 as a small square/bracket artifact near the time
  if (/[\u25A0-\u25FF]/.test(t) && /\d{1,2}:\d{2}/.test(t)) return true;
  return false;
}

/* Stop number: "3.", "3)", "Stop 3", "3 of 14" — returns the number or null */
/* Freeform address extractor for screenshots of notes, GPS apps, etc.
 * Finds street addresses anywhere in the text, not just schedule format.
 * Returns [{street, city, state, zip}] — no job types, times, or names. */
function parseFreeformAddresses(text) {
  var lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
  var out = [];
  var seen = {};
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // single-line: "123 Main St, Nashville, TN 37201"
    var full = line.match(/^(\d+\s+[A-Za-z0-9\s.'-]+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    if (full) {
      var key = full[1] + '|' + full[4];
      if (!seen[key]) {
        seen[key] = true;
        out.push({ street: full[1].trim(), city: full[2].trim(), state: full[3], zip: full[4] });
      }
      continue;
    }
    // multi-line: street on one line, "City, ST ZIP" on the next
    if (STREET_RE.test(line) && i + 1 < lines.length) {
      var cm = lines[i + 1].match(CITY_ZIP_RE);
      if (cm) {
        var key2 = line + '|' + cm[3];
        if (!seen[key2]) {
          seen[key2] = true;
          out.push({ street: line, city: cm[1].trim(), state: cm[2], zip: cm[3] });
        }
      }
    }
  }
  return out;
}
var TIME_RE = /^\d{1,2}:\d{2}/;

/* "9:00 AM" -> 540, "2:30pm" -> 870, "14:30" -> 870, "9 AM" -> 540, garbage -> null. */
function parseClockToMin(s) {
  var t = String(s == null ? '' : s).trim();
  var m = t.match(/^(\d{1,2}):(\d{2})/);
  var h, mm;
  if (m) {
    h = Number(m[1]); mm = Number(m[2]);
    if (mm > 59) return null;
    var rest = t.slice(m[0].length).trim();
    var ap = rest.match(/^([APap])\.?\s*[Mm]\.?/);
    if (ap) {
      if (h < 1 || h > 12) return null;
      var isPM = ap[1].toUpperCase() === 'P';
      if (isPM && h !== 12) h += 12;
      if (!isPM && h === 12) h = 0;
    } else if (rest.length > 0 || h > 23) {
      return null; /* trailing garbage or bad 24h hour */
    }
    return h * 60 + mm;
  }
  // hour-only: "9 AM" -> 540
  m = t.match(/^(\d{1,2})\s*([APap])\.?\s*[Mm]\.?$/);
  if (m) {
    h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    var isPM2 = m[2].toUpperCase() === 'P';
    if (isPM2 && h !== 12) h += 12;
    if (!isPM2 && h === 12) h = 0;
    return h * 60;
  }
  return null;
}

/* 540 -> "9:00 AM", 870 -> "2:30 PM". */
function formatClock(min) {
  var m = ((Math.round(min) % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60), mm = m % 60;
  var ap = h < 12 ? 'AM' : 'PM';
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ap;
}

/* Remaining service minutes for a checked-in stop: the full service duration
 * minus elapsed time since check-in, floored at 0. Pure helper so the app can
 * compute an honest departure time ("depart when this service finishes"). */
function remainingServiceMin(serviceMin, startedAtMs, nowMs) {
  var elapsedMin = (nowMs - startedAtMs) / 60000;
  return Math.max(0, serviceMin - elapsedMin);
}

function parseOcrText(text) {
  var lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });

  /* Merge split city/ZIP lines: "Nashville, TN" + "37209-4655"
   * -> "Nashville, TN 37209-4655". Some schedule apps wrap the ZIP. */
  var merged = [];
  for (var mi = 0; mi < lines.length; mi++) {
    var cur = lines[mi];
    var nxt = lines[mi + 1] || '';
    if (/^(.+?),\s*([A-Z]{2})$/.test(cur) && /^\d{5}(?:-\d{4})?$/.test(nxt)) {
      merged.push(cur + ' ' + nxt);
      mi++; // skip the ZIP line
    } else {
      merged.push(cur);
    }
  }
  lines = merged;

  var out = [];
  var seen = {}; // dedupe by street+zip across formats

  function pushStop(street, city, state, zip, jobType, apptMin, twEnd, locked) {
    var key = (street + '|' + zip).toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push({
      street: street, city: city, state: state, zip: zip,
      jobType: jobType || '', apptMin: apptMin != null ? apptMin : null,
      twEnd: twEnd != null ? twEnd : null,
      locked: !!locked, // 🔒 next to the time = confirmed appointment
    });
  }

  function matchKnownJobType(s) {
    var low = String(s).toLowerCase();
    for (var i = 0; i < KNOWN_JOB_TYPES.length; i++) {
      if (low.indexOf(KNOWN_JOB_TYPES[i].toLowerCase()) !== -1) return KNOWN_JOB_TYPES[i];
    }
    return '';
  }

  /* Pass 1: labeled fields — "Service Address: 123 Main St, Nashville, TN 37201" */
  for (var li = 0; li < lines.length; li++) {
    var lm = lines[li].match(LABEL_RE);
    if (!lm) continue;
    var addr = lm[1].trim();
    // try single-line first
    var fm = addr.match(/^(\d+\s+[A-Za-z0-9\s.'-]+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    if (fm) {
      pushStop(fm[1].trim(), fm[2].trim(), fm[3], fm[4], '', null, null);
      continue;
    }
    // two-line: label on one line, city on the next
    if (STREET_RE.test(addr) && li + 1 < lines.length) {
      var cm = lines[li + 1].match(CITY_ZIP_RE);
      if (cm) pushStop(addr, cm[1].trim(), cm[2], cm[3], '', null, null);
    }
  }

  var prevCity = -1; /* index of the previous stop's city line: block boundary */
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(CITY_ZIP_RE);
    if (!m) continue;

    /* street = nearest PRECEDING line that starts with a house number.
     * Strip a leading stop number ("3. 123 Main St" -> "123 Main St").
     * Also strip a leading time ("9:00 AM 1014 Kirkwood Ave" -> street). */
    var street = '', streetLineIdx = -1;
    for (var k = i - 1; k >= 0; k--) {
      var cand = lines[k].replace(/^(?:Stop\s+)?\d{1,2}[.)]\s+/, '');
      // strip leading time: "9:00 AM 1014 Kirkwood Ave" -> "1014 Kirkwood Ave"
      cand = cand.replace(/^\d{1,2}:\d{2}\s*[APap]\.?\s*[Mm]\.?\s+/, '');
      cand = cand.replace(/^\d{1,2}\s*[APap]\.?\s*[Mm]\.?\s+/, '');
      if (STREET_RE.test(cand)) { street = cand; streetLineIdx = k; break; }
      if (CITY_ZIP_RE.test(lines[k])) break; /* previous stop's block */
    }
    if (!street) continue; /* city line without a street is not a stop */

    /* apptMin: search for times in the block. Handles:
     * - time on its own line or with the name ("Sean Shelby  9:00 AM")
     * - time merged with the street line ("1014 Kirkwood Ave 9:00 AM")
     * - time on a line between street and city
     * - hour-only ("9 AM") */
    var apptMin = null, twEnd = null;
    function extractTime(line) {
      var win = parseTimeWindow(line);
      if (win) return win;
      var tm = line.match(/\b(\d{1,2}:\d{2}\s*[APap]\.?\s*[Mm]\.?)\b/);
      if (!tm) tm = line.match(/\b(\d{1,2}:\d{2})\b/);
      if (!tm) tm = line.match(/\b(\d{1,2}\s*[APap]\.?\s*[Mm]\.?)\b/);
      if (tm) {
        var pv = parseClockToMin(tm[1]);
        if (pv !== null) return { start: pv, end: null };
      }
      return null;
    }
    // Check the street line itself first (time merged with street)
    var streetTime = extractTime(lines[streetLineIdx]);
    var timeLineIdx = -1;
    if (streetTime) {
      apptMin = streetTime.start; twEnd = streetTime.end;
      timeLineIdx = streetLineIdx;
      // strip the time from the street so geocoding isn't polluted
      street = street.replace(/\s*\b\d{1,2}:\d{2}\s*[APap]\.?\s*[Mm]\.?\b/, '')
                     .replace(/\s*\b\d{1,2}\s*[APap]\.?\s*[Mm]\.?\b/, '')
                     .replace(/\s*\b\d{1,2}\s*[-\u2013\u2014]\s*\d{1,2}\b/, '').trim();
    } else {
      // Search lines above the street
      for (var t = k - 1; t > prevCity; t--) {
        if (CITY_ZIP_RE.test(lines[t])) break;
        var found = extractTime(lines[t]);
        if (found) { apptMin = found.start; twEnd = found.end; timeLineIdx = t; break; }
      }
      // If not found above, check lines between street and city
      if (apptMin === null) {
        for (var t2 = streetLineIdx + 1; t2 < i; t2++) {
          var found2 = extractTime(lines[t2]);
          if (found2) { apptMin = found2.start; twEnd = found2.end; timeLineIdx = t2; break; }
        }
      }
    }
    // Lock detection: scan the whole block (time line, street, nearby lines)
    // for 🔒. A lock means confirmed appointment, regardless of settings.
    // A time WINDOW also means confirmed — unconfirmed stops have odd ETA
    // times, not windows.
    var locked = twEnd != null;
    var blockStart = Math.max(0, (timeLineIdx >= 0 ? timeLineIdx : streetLineIdx) - 2);
    for (var bl = blockStart; bl <= i && bl < lines.length; bl++) {
      if (hasLockIndicator(lines[bl])) { locked = true; break; }
    }
    // Short window: "3-5" on a nearby line means 3 PM - 5 PM (uses apptMin's AM/PM).
    // A short window is itself a confirmation signal — unconfirmed stops
    // don't have windows, only odd ETA times.
    if (apptMin != null && twEnd == null) {
      for (var wl = blockStart; wl <= Math.min(i + 1, lines.length - 1); wl++) {
        var sw = parseShortWindow(lines[wl], apptMin);
        if (sw) {
          twEnd = sw.end; locked = true;
          // Strip the window from the street if it was merged there.
          street = street.replace(/\s*\b\d{1,2}\s*[-\u2013\u2014]\s*\d{1,2}\b/, '').trim();
          break;
        }
      }
    }

    /* jobType: first try the following-line heuristic (finds specific text like
     * "Sentricon Guarantee/Coverage"), then fall back to known-type scanning.
     * Stop at the next stop's block. Never leak names. */
    var jobType = '';
    for (var j = i + 1; j < lines.length; j++) {
      var ln = lines[j];
      if (CITY_ZIP_RE.test(ln) || STREET_RE.test(ln)) break;
      if (TIME_RE.test(ln)) continue;
      if (ln.length >= 60) continue; /* OCR garbage line, keep scanning */
      var next = lines[j + 1] || '';
      if (TIME_RE.test(next)) break; /* candidate is a name -> no jobType */
      jobType = ln;
      break;
    }
    // if heuristic found nothing, scan nearby text for known job types
    if (!jobType) {
      jobType = matchKnownJobType(lines.slice(Math.max(0, k - 2), i + 2).join(' '));
    }

    pushStop(street, m[1].trim(), m[2], m[3], jobType, apptMin, twEnd, locked);
    prevCity = i;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 6.2 Dedupe                                                           */
/* ------------------------------------------------------------------ */

var ABBR = {
  street: 'st', avenue: 'ave', drive: 'dr', court: 'ct', boulevard: 'blvd',
  lane: 'ln', road: 'rd', heights: 'hts', place: 'pl', terrace: 'ter',
  parkway: 'pkwy', circle: 'cir', trail: 'trl', pike: 'pk'
};

/* Canonical key: normStreet|zip5. City/state intentionally excluded so a
 * missing/OCR-mangled city still dedupes against the same street+ZIP.
 * OCR_FIX: Tesseract often reads "Pl" (Place) as "PI" (lowercase-L vs
 * capital-i confusion) — 2026-10-05: "2001 Convent PI Unit 6" vs
 * "2001 Convent Pl Unit 6" failed to dedupe across two screenshots of the
 * same schedule. A standalone "pi" token is ~always this error, never a
 * real street word, so it normalizes to "pl". */
var OCR_FIX = { pi: 'pl' };
function normalizeStop(s) {
  var raw = (s && s.street) ? String(s.street) : '';
  var t = raw.toLowerCase().replace(/[''`]/g, '');
  t = t.replace(/[^\w\s]/g, ' ');          /* strip punctuation */
  t = t.split(/\s+/).filter(Boolean)
       .map(function (w) { return OCR_FIX[w] || ABBR[w] || w; }) /* OCR + USPS-abbrev normalize */
       .join(' ');
  var zipm = ((s && s.zip) ? String(s.zip) : '').match(/\d{5}/);
  var zip5 = zipm ? zipm[0] : '';           /* ZIP+4 -> 5 digits */
  return t + '|' + zip5;
}

/* Keep first occurrence of each normalized key; count the rest as removed. */
function dedupeStops(stops) {
  var seen = {};
  var kept = [];
  var removed = 0;
  (stops || []).forEach(function (s) {
    var key = normalizeStop(s);
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      removed++;
      return;
    }
    seen[key] = true;
    kept.push(s);
  });
  return { stops: kept, removed: removed };
}

/* ------------------------------------------------------------------ */
/* Distance helpers                                                    */
/* ------------------------------------------------------------------ */

function haversineMi(a, b) {
  var R = 3958.8; /* earth radius, miles */
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(b.lat - a.lat);
  var dLng = toRad(b.lng - a.lng);
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildHaversineMatrix(points) {
  var n = (points || []).length;
  var m = new Array(n);
  for (var i = 0; i < n; i++) {
    m[i] = new Array(n);
    for (var j = 0; j < n; j++) {
      m[i][j] = (i === j) ? 0 : haversineMi(points[i], points[j]);
    }
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* 6.4 Optimize — nearest neighbor + 2-opt, `last` pinned at the end   */
/* ------------------------------------------------------------------ */

function pathCost(order, matrix) {
  var c = 0;
  for (var k = 0; k < order.length - 1; k++) {
    var d = matrix[order[k]][order[k + 1]];
    c += (d === null || d === undefined) ? Infinity : d;
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* 6.4b Time-window scheduling (v1.9)                                    */
/*                                                                     */
/* Confirmed stops carry an arrival window {start, end} (minutes from   */
/* midnight). The effective deadline is end - bufferMin (30): the      */
/* driver should ARRIVE by then, with the 30-minute buffer absorbing    */
/* the "should be there" vs "must be there" gap. Arriving early is      */
/* fine (the driver waits); arriving late accrues a heavy penalty.      */
/* Unconfirmed stops have no window and move freely.                   */
/* ------------------------------------------------------------------ */

var DEFAULT_SERVICE_MIN = 45;
var WINDOW_BUFFER_MIN = 30;

/* Drive-minute matrix parallel to `matrix`: osrm holds seconds,
 * haversine holds miles. Unreachable legs become Infinity. */
function minutesMatrix(matrix, source) {
  var m = matrix || [];
  return m.map(function (row) {
    return (row || []).map(function (v) {
      if (v === null || v === undefined || !isFinite(v)) return Infinity;
      return (source === 'osrm') ? v / 60 : v * HAVERSINE_MIN_PER_MI;
    });
  });
}

/* Time-of-day traffic multiplier for Nashville. OSRM gives free-flow times;
 * this adjusts toward the average drive time for that time of day. Not
 * real-time, but much closer than free-flow. Based on typical Nashville
 * congestion patterns; refined over time from actual drive data. */
function trafficFactorAt(departMin) {
  var t = ((departMin % 1440) + 1440) % 1440; /* minutes since midnight */
  var h = t / 60;
  if (h < 6) return 1.0;    /* overnight: free flow */
  if (h < 7) return 1.1;   /* early morning buildup */
  if (h < 9) return 1.35;  /* morning rush */
  if (h < 11) return 1.15; /* mid-morning */
  if (h < 13) return 1.1;   /* lunch */
  if (h < 16) return 1.15;  /* afternoon */
  if (h < 18.5) return 1.4; /* evening rush */
  if (h < 20) return 1.2;   /* evening wind-down */
  return 1.05;              /* late evening */
}

/* Rain impact on drive times. Based on transportation research:
 * light rain ~10% slower, moderate ~20%, heavy 40%+.
 * precipMm: mm/hour from weather API. */
function rainFactorFor(precipMm) {
  var p = Number(precipMm);
  if (!isFinite(p) || p <= 0) return 1.0;
  if (p < 0.5) return 1.05;  /* drizzle */
  if (p < 2.5) return 1.15;  /* light rain */
  if (p < 7.5) return 1.3;   /* moderate rain */
  return 1.5;                /* heavy rain */
}

/* Learned traffic: bucket key for a departure time + destination area.
 * 8 time buckets of 3 hours x weekday/weekend x geo cell (0.1° ~ 7x5.5 mi).
 * Different Nashville areas learn different rush patterns — downtown peaks
 * earlier than the suburbs, etc. */
function trafficBucketKey(departMin, isWeekend, lat, lng) {
  var t = ((departMin % 1440) + 1440) % 1440;
  var bucket = Math.floor(t / 180); /* 0-7 */
  var geo = '';
  if (typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng)) {
    geo = '-' + Math.floor(lat * 10) + 'x' + Math.floor(lng * 10);
  }
  return (isWeekend ? 'we' : 'wd') + '-' + bucket + geo;
}

/* Blended traffic factor: base pattern + learned personal adjustment.
 * learnData: {buckets: {key: {n, sum}}} where sum is sum of (actual/base).
 * Uses Bayesian averaging: the base factor is the prior (weight 5), learned
 * data shifts it as samples accumulate. Needs 3+ samples before the learned
 * factor has real influence. */
var LEARN_PRIOR_WEIGHT = 5;
var LEARN_MIN_SAMPLES = 3;
var LEARN_AGG_MIN_SAMPLES = 5;
var LEARN_MAX_SAMPLES = 50; /* exponential decay beyond this */

/* ---------- user home location (optional override, never required) ----------
 * homeLocation: {city, state, lat, lng} | null
 * Stored in settings.homeLocation. An OPTIONAL manual override for users who
 * want to plan routes for a different area than where they are. GPS is the
 * primary source of truth — this is only consulted when set AND no GPS fix
 * is available. Never prompted, never defaulted. */

/* Geocode query suffix: ", City, ST" when home is set, "" otherwise.
 * Never silently defaults to any city — the geocoder resolves bare queries. */
function geocodeSuffix(homeLocation) {
  if (!homeLocation || typeof homeLocation !== 'object') return '';
  var city = (homeLocation.city || '').trim();
  var st = (homeLocation.state || '').trim();
  if (!city) return '';
  return ', ' + city + (st ? ', ' + st : '');
}

/* Photon search bias coords: {lat, lon} from home, or null to omit bias.
 * Never returns hardcoded coordinates for a city the user didn't choose. */
function photonBias(homeLocation) {
  if (!homeLocation || typeof homeLocation !== 'object') return null;
  var lat = homeLocation.lat, lng = homeLocation.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: lat, lon: lng };
}

/* ---------- location precision (iOS "Precise Location" toggle) ----------
 * When precise location is off, iOS gives the browser a fuzzed fix
 * (~1-3 km accuracy). We warn but don't block. */

/* Accuracy threshold in meters: above this, the fix is "approximate". */
var PRECISE_ACCURACY_M = 100;

/* Classify a geolocation accuracy reading.
 * Returns 'precise' | 'approximate' | 'unknown' (null/undefined/invalid). */
function classifyPrecision(accuracy) {
  if (accuracy == null || typeof accuracy !== 'number' || !isFinite(accuracy) || accuracy < 0) {
    return 'unknown';
  }
  return accuracy <= PRECISE_ACCURACY_M ? 'precise' : 'approximate';
}
/* Hierarchical fallback:
 * 1. Specific (time, day, area) bucket with 3+ samples
 * 2. (time, day) aggregate across all areas with 5+ samples
 * 3. Base factor */
function learnedTrafficFactorAt(departMin, isWeekend, learnData, lat, lng) {
  var base = trafficFactorAt(departMin);
  if (!learnData || !learnData.buckets) return base;
  var buckets = learnData.buckets;
  // Level 1: specific bucket
  var key = trafficBucketKey(departMin, isWeekend, lat, lng);
  var b = buckets[key];
  if (b && b.n >= LEARN_MIN_SAMPLES) {
    return blendFactor(base, b);
  }
  // Level 2: aggregate across areas for this time+day
  var t = ((departMin % 1440) + 1440) % 1440;
  var bucket = Math.floor(t / 180);
  var prefix = (isWeekend ? 'we' : 'wd') + '-' + bucket + '-';
  var aggN = 0, aggSum = 0;
  for (var k in buckets) {
    if (k.indexOf(prefix) === 0 && buckets[k].n) {
      aggN += buckets[k].n;
      aggSum += buckets[k].sum;
    }
  }
  if (aggN >= LEARN_AGG_MIN_SAMPLES) {
    return blendFactor(base, { n: aggN, sum: aggSum });
  }
  return base;
}
function blendFactor(base, b) {
  var learnedRatio = b.sum / b.n;
  if (learnedRatio < 0.7) learnedRatio = 0.7;
  if (learnedRatio > 1.6) learnedRatio = 1.6;
  var wLearn = Math.min(b.n, LEARN_MAX_SAMPLES), wBase = LEARN_PRIOR_WEIGHT;
  return base * ((learnedRatio * wLearn + 1.0 * wBase) / (wLearn + wBase));
}
/* Record a learning sample with exponential decay. */
function recordTrafficSample(learnData, key, adjustment) {
  if (!learnData.buckets) learnData.buckets = {};
  var b = learnData.buckets[key] || { n: 0, sum: 0 };
  if (b.n >= LEARN_MAX_SAMPLES) {
    // decay: keep n at max, blend old sum down
    b.sum = b.sum * (LEARN_MAX_SAMPLES - 1) / LEARN_MAX_SAMPLES + adjustment;
  } else {
    b.n += 1;
    b.sum += adjustment;
  }
  learnData.buckets[key] = b;
  return learnData;
}

/* ---------- drive-away auto-complete (2026-10-05, six items item 2) ----------
 * Pure window evaluator: does this reading window prove the tech drove away
 * from the checked-in stop? `readings` are {at, d, accuracy, speed} with d =
 * meters from the stop (newest last). All four gates must hold:
 *  1. 5+ minutes of service (checkedInAtMs → nowMs > minServiceMs).
 *  2. Last 4 readings all qualify: accuracy <= 75 m (null accuracy passes —
 *     same gate as proximity check-in), no more than 90 s between readings.
 *  3. All 4 readings > 150 m from the stop (>> GPS drift + the 100 m
 *     auto-check-in radius), and distances are non-decreasing within the
 *     worst accuracy tolerance — OR the window spans >= 60 s with the last
 *     reading > 50 m farther than the first (sustained recession).
 *  4. Independent speed signal: speed > 2.5 m/s on >= 2 readings, or the
 *     implied speed (d[last]-d[first]) / dt > 2.5 m/s. 2.5 m/s ≈ 5.6 mph:
 *     above brisk walking, below any driving. On iOS Safari coords.speed is
 *     often null, so the implied-speed fallback is the primary signal there.
 * A parked phone with drifting fixes cannot satisfy all four. */
var DRIVE_AWAY_N = 4;          // consecutive qualifying readings required
var DRIVE_AWAY_ACCURACY_M = 75;
var DRIVE_AWAY_MIN_D_M = 150;  // must ALL be farther than this
var DRIVE_AWAY_MAX_GAP_MS = 90000;
var DRIVE_AWAY_SPEED_MPS = 2.5;
var DRIVE_AWAY_RECEDE_M = 50;   // alt. recession: d[last]-d[first] over >= 60 s
var DRIVE_AWAY_SPAN_MS = 60000;
function driveAwayWindowFires(readings, checkedInAtMs, nowMs, minServiceMs) {
  var minMs = (typeof minServiceMs === 'number' && isFinite(minServiceMs)) ? minServiceMs : 300000;
  if (!Array.isArray(readings) || readings.length < DRIVE_AWAY_N) return false;
  if (typeof nowMs !== 'number' || typeof checkedInAtMs !== 'number') return false;
  if (!(nowMs - checkedInAtMs > minMs)) return false;
  var win = readings.slice(-DRIVE_AWAY_N);
  var maxAcc = 0;
  for (var i = 0; i < win.length; i++) {
    var r = win[i];
    if (!r || typeof r.at !== 'number' || typeof r.d !== 'number') return false;
    if (r.at > nowMs) return false;
    if (i > 0 && (r.at < win[i - 1].at || r.at - win[i - 1].at > DRIVE_AWAY_MAX_GAP_MS)) return false;
    // Null accuracy passes (same gate as proximity check-in); > 75 m rejects.
    var acc = (typeof r.accuracy === 'number' && isFinite(r.accuracy)) ? r.accuracy : DRIVE_AWAY_ACCURACY_M;
    if (acc > DRIVE_AWAY_ACCURACY_M) return false;
    if (!(r.d > DRIVE_AWAY_MIN_D_M)) return false;
    if (acc > maxAcc) maxAcc = acc;
  }
  // Sustained recession: monotonic within tolerance, or clearly receding.
  var monotonic = true;
  for (var j = 1; j < win.length; j++) {
    if (win[j].d < win[j - 1].d - maxAcc) { monotonic = false; break; }
  }
  var spanMs = win[win.length - 1].at - win[0].at;
  var receding = spanMs >= DRIVE_AWAY_SPAN_MS &&
    (win[win.length - 1].d - win[0].d) > DRIVE_AWAY_RECEDE_M;
  if (!monotonic && !receding) return false;
  // Independent speed signal.
  var fast = 0;
  for (var k = 0; k < win.length; k++) {
    var sp = win[k].speed;
    if (typeof sp === 'number' && isFinite(sp) && sp > DRIVE_AWAY_SPEED_MPS) fast++;
  }
  if (fast >= 2) return true;
  var dtS = spanMs / 1000;
  if (dtS > 0 && (win[win.length - 1].d - win[0].d) / dtS > DRIVE_AWAY_SPEED_MPS) return true;
  return false;
}

function serviceMinAt(ctx, i) {
  var s = ctx ? ctx.serviceMin : null;
  var v;
  if (Array.isArray(s)) v = s[i];
  else v = s;
  return (v !== null && v !== undefined && v > 0) ? v : DEFAULT_SERVICE_MIN;
}

/* Normalized scheduling context shared by simulate/score/repair. */
function schedCtx(o, n) {
  o = o || {};
  var windows = o.windows || [];
  var maxStart = -Infinity, anyWindow = false;
  var lim = Math.max(n || 0, windows.length);
  for (var i = 0; i < lim; i++) {
    var w = windows[i];
    if (w && w.start !== null && w.start !== undefined &&
        w.end !== null && w.end !== undefined) {
      anyWindow = true;
      if (w.start > maxStart) maxStart = w.start;
    }
  }
  var departMin = (o.departMin !== null && o.departMin !== undefined) ? o.departMin : 0;
  var bufferMin = (o.bufferMin !== null && o.bufferMin !== undefined) ? o.bufferMin : WINDOW_BUFFER_MIN;
  var startIdx = (o.start === undefined || o.start === null) ? 0 : o.start;
  /* Sunk windows (2026-10-05 field bug): a stop whose window is unmakeable
   * even driving straight there from the start under free-flow times can
   * never meet its deadline in ANY order. Counting it in the miss vector
   * lets the solver demote it to last place to protect makeable windows —
   * the "10 AM stop dead last" bug. Sunk stops are excluded from the miss
   * vector; the hard window-order rule then keeps them in
   * earliest-window-first position ("the commitment stands"). */
  var sunk = {};
  var durMin = o.durMin || null;
  if (anyWindow && durMin && durMin[startIdx]) {
    for (var si = 0; si < lim; si++) {
      var sw = windows[si];
      if (sw && sw.start !== null && sw.start !== undefined &&
          sw.end !== null && sw.end !== undefined) {
        var drive = durMin[startIdx][si];
        var earliest = departMin + ((drive === null || drive === undefined) ? Infinity : drive);
        if (earliest > sw.end - bufferMin) sunk[si] = true;
      }
    }
  }
  return {
    windows: windows,
    departMin: departMin,
    serviceMin: o.serviceMin,
    bufferMin: bufferMin,
    maxStart: maxStart,
    anyWindow: anyWindow,
    sunk: sunk,
    startIdx: startIdx,
    firstIdx: (o.first === undefined) ? null : o.first,
    lastIdx: (o.last === undefined) ? null : o.last,
    trafficFn: o.trafficFn,
    pointCoords: o.pointCoords,
    traffic: o.traffic
  };
}

/* Window-order inversions (2026-10-05): pairs of windowed stops visited out
 * of earliest-window-start order. Pinned stops (first/last) and the start
 * point are excluded — pins are deliberate user overrides. This is the
 * FIRST lexicographic cost criterion: appointment order is never violated
 * for drive time, misses, or lateness. */
function windowInversions(order, ctx) {
  var c = ctx || {};
  var windows = c.windows || [];
  var pinned = {};
  [c.startIdx, c.firstIdx, c.lastIdx].forEach(function (v) {
    if (v !== null && v !== undefined) pinned[v] = true;
  });
  var seq = [];
  for (var k = 0; k < order.length; k++) {
    var pi = order[k];
    if (pinned[pi]) continue;
    var w = windows[pi];
    if (w && w.start !== null && w.start !== undefined &&
        w.end !== null && w.end !== undefined) seq.push(pi);
  }
  var inv = 0;
  for (var a = 0; a < seq.length; a++) {
    for (var b = a + 1; b < seq.length; b++) {
      if (windows[seq[a]].start > windows[seq[b]].start) inv++;
    }
  }
  return inv;
}

/* Early-arrival opportunity: sometimes going to the NEXT stop first (arriving
 * early for its window) saves meaningful drive time while still meeting the
 * current stop's window. This finds the best such swap.
 *
 * Returns null or {swapIdx, earlyStop, earlyByMin, savedMin, newOrder}.
 * - swapIdx: position in `order` of the first stop in the swapped pair
 * - earlyStop: point index of the stop you'd visit early
 * - earlyByMin: how many minutes before its window start you'd arrive
 * - savedMin: drive minutes saved vs the current order
 * - newOrder: the order with the pair swapped
 *
 * Only suggests when savings >= 10 min and earliness <= 30 min. The user
 * decides — this never auto-applies. */
var EARLY_MAX_MIN = 30;   /* never suggest more than 30 min early */
var EARLY_MIN_SAVE = 15;  /* only suggest when saving 15+ min of driving */
function findEarlyArrivalOpportunity(order, durMin, ctx) {
  var c = ctx || {};
  var windows = c.windows || [];
  var ord = order || [];
  if (ord.length < 3) return null; /* need origin + at least 2 stops */

  var best = null;
  /* Try swapping each consecutive pair (skip origin at position 0). */
  for (var i = 1; i < ord.length - 1; i++) {
    var aPt = ord[i], bPt = ord[i + 1];
    var wA = windows[aPt], wB = windows[bPt];
    /* Both stops need windows for this to make sense. */
    if (!wA || wA.start === null || wA.start === undefined) continue;
    if (!wB || wB.start === null || wB.start === undefined) continue;

    /* Build the swapped order. */
    var swapped = ord.slice();
    swapped[i] = bPt;
    swapped[i + 1] = aPt;

    /* Simulate both orders. */
    var simOrig = simulateSchedule(ord, durMin, c);
    var simSwap = simulateSchedule(swapped, durMin, c);

    /* The swapped order must not create NEW violations. */
    var origViolated = {};
    for (var v = 0; v < simOrig.violations.length; v++) origViolated[simOrig.violations[v].point] = true;
    var newViolation = false;
    for (var v2 = 0; v2 < simSwap.violations.length; v2++) {
      if (!origViolated[simSwap.violations[v2].point]) { newViolation = true; break; }
    }
    if (newViolation) continue;
    /* 2026-10-05: the swap must not introduce a window-order inversion —
     * appointment order is a hard constraint, never sacrificed for drive
     * time, even as a suggestion. */
    if (windowInversions(swapped, c) > windowInversions(ord, c)) continue;

    /* Find B's arrival in the swapped order — it should be early. */
    var bLeg = null;
    for (var l = 0; l < simSwap.legs.length; l++) {
      if (simSwap.legs[l].point === bPt) { bLeg = simSwap.legs[l]; break; }
    }
    if (!bLeg || bLeg.waitMin === null || bLeg.waitMin === undefined) continue;
    var earlyBy = bLeg.waitMin;
    if (earlyBy <= 0 || earlyBy > EARLY_MAX_MIN) continue;

    /* Drive time savings. */
    var saved = simOrig.driveMin - simSwap.driveMin;
    if (saved < EARLY_MIN_SAVE) continue;

    if (!best || saved > best.savedMin) {
      best = {
        swapIdx: i,
        earlyStop: bPt,
        earlyByMin: Math.round(earlyBy),
        savedMin: Math.round(saved),
        newOrder: swapped,
      };
    }
  }
  return best;
}

/* Walk `order` over a drive-minute matrix, applying service durations and
 * arrival windows. Returns {legs, driveMin, violations}.
 * legs[i]: {point, arrivalMin, waitMin, lateMin, winStart, winEnd, effEnd}
 * violations: subset of legs that missed their buffered deadline. */
function simulateSchedule(order, durMin, ctx) {
  var c = ctx || {};
  var windows = c.windows || [];
  var bufferMin = (c.bufferMin !== null && c.bufferMin !== undefined) ? c.bufferMin : WINDOW_BUFFER_MIN;
  var t = (c.departMin !== null && c.departMin !== undefined) ? c.departMin : 0;
  var drive = 0, legs = [], violations = [];
  var ord = order || [];
  /* The start point (order[0]) can be a STOP — not just the GPS origin — when
   * GPS is unavailable (origin dropped) or a checked-in stop is the effective
   * origin. Its "arrival" is departMin (we're already there); validate its
   * window too, or a confirmed first stop's missed window goes unreported. */
  if (ord.length > 0) {
    var sw = windows[ord[0]];
    if (sw && sw.start !== null && sw.start !== undefined &&
        sw.end !== null && sw.end !== undefined) {
      var sEffEnd = sw.end - bufferMin;
      var sLeg = { point: ord[0], arrivalMin: t, waitMin: 0, lateMin: 0,
                   winStart: sw.start, winEnd: sw.end, effEnd: sEffEnd };
      if (t > sEffEnd) {
        sLeg.lateMin = t - sEffEnd;
        violations.push({ point: ord[0], winStart: sw.start, winEnd: sw.end,
                          effEnd: sEffEnd, arrivalMin: sLeg.arrivalMin,
                          lateMin: sLeg.lateMin });
      } else if (t < sw.start) {
        sLeg.waitMin = sw.start - t;
      }
      legs.push(sLeg);
    }
  }
  for (var k = 1; k < ord.length; k++) {
    var prev = ord[k - 1], cur = ord[k];
    var row = durMin ? durMin[prev] : null;
    var d = row ? row[cur] : null;
    /* unreachable leg: astronomic drive time so no optimizer picks it */
    var baseDm = (d === null || d === undefined || !isFinite(d)) ? 1e9 : d;
    /* Traffic-aware: adjust for the time of day this leg is driven.
     * OSRM gives free-flow; this gets us to the average for that hour.
     * Disable with ctx.traffic === false (tests). Use ctx.trafficFn(t)
     * for a custom (e.g. learned) factor function. */
    var useTraffic = !c || c.traffic !== false;
    var tfFn = (c && typeof c.trafficFn === 'function') ? c.trafficFn : trafficFactorAt;
    var ptCoords = (c && c.pointCoords) || [];
    var destCoord = ptCoords[cur] || {};
    var dm = (baseDm >= 1e9 || !useTraffic) ? baseDm :
      baseDm * tfFn(t, destCoord.lat, destCoord.lng);
    drive += dm;
    t += dm;
    var w = windows[cur];
    var leg = { point: cur, arrivalMin: t, waitMin: 0, lateMin: 0,
                winStart: null, winEnd: null, effEnd: null, driveMin: dm };
    if (w && w.start !== null && w.start !== undefined &&
        w.end !== null && w.end !== undefined) {
      var effEnd = w.end - bufferMin;
      leg.winStart = w.start; leg.winEnd = w.end; leg.effEnd = effEnd;
      if (t < w.start) { leg.waitMin = w.start - t; t = w.start; }
      else if (t > effEnd) {
        leg.lateMin = t - effEnd;
        violations.push({ point: cur, winStart: w.start, winEnd: w.end,
                          effEnd: effEnd, arrivalMin: leg.arrivalMin,
                          lateMin: leg.lateMin });
      }
    }
    legs.push(leg);
    t += serviceMinAt(c, cur);
  }
  return { legs: legs, driveMin: drive, violations: violations };
}

/* Total cost of an order, compared LEXICOGRAPHICALLY (2026-10-05: window
 * order is now a HARD constraint — appointment order is never violated):
 *   0. window inversions — pairs of windowed stops visited out of
 *      earliest-window-start order (pins excluded). Fewer always wins.
 *   1. miss vector — one slot per windowed stop, sorted by window start
 *      ascending; 1 = missed its buffered deadline, 0 = met. Compared slot
 *      by slot, earliest window first. Sunk (unmakeable-in-any-order)
 *      windows don't count.
 *   2. total lateness minutes across all violations.
 *   3. window order penalty (legacy tiebreak; 0 whenever inversions are 0).
 *   4. drive minutes.
 * A scalar weight can never guarantee (0); this ordering does. */
function scheduleCost(order, durMin, ctx) {
  var sim = simulateSchedule(order, durMin, ctx);
  var winIdx = [];
  for (var i = 0; i < ctx.windows.length; i++) {
    var w = ctx.windows[i];
    if (w && w.start !== null && w.start !== undefined &&
        w.end !== null && w.end !== undefined) winIdx.push(i);
  }
  winIdx.sort(function (a, b) { return ctx.windows[a].start - ctx.windows[b].start; });
  var missed = {}, lateMin = 0;
  for (var k = 0; k < sim.violations.length; k++) {
    missed[sim.violations[k].point] = true;
    lateMin += sim.violations[k].lateMin;
  }
  /* Sunk windows (unmakeable from the start in any order) don't count as
   * misses — no order can save them, and counting them lets the solver
   * demote a doomed early appointment to last place (2026-10-05). */
  var sunk = (ctx && ctx.sunk) || {};
  var misses = winIdx.map(function (i) { return (missed[i] && !sunk[i]) ? 1 : 0; });
  // Window order penalty: for each pair of windowed stops where the earlier
  // window appears AFTER the later window in the route, add a penalty
  // proportional to the window gap. This keeps missed-window stops in
  // earliest-window-first order instead of being shoved to the end.
  var orderPenalty = 0;
  var posOf = {};
  for (var p = 0; p < order.length; p++) posOf[order[p]] = p;
  for (var a = 0; a < winIdx.length; a++) {
    for (var b = a + 1; b < winIdx.length; b++) {
      var pa = posOf[winIdx[a]], pb = posOf[winIdx[b]];
      if (pa === undefined || pb === undefined) continue;
      if (pa > pb) {
        orderPenalty += (ctx.windows[winIdx[b]].start - ctx.windows[winIdx[a]].start);
      }
    }
  }
  return { misses: misses, lateMin: lateMin, driveMin: sim.driveMin,
           orderPenalty: orderPenalty, inversions: windowInversions(order, ctx),
           violations: sim.violations, legs: sim.legs };
}
/* True if cost a is strictly better than cost b under the lexicographic order. */
function costLess(a, b) {
  var ai = a.inversions || 0, bi = b.inversions || 0;
  if (ai !== bi) return ai < bi;
  var n = Math.max(a.misses.length, b.misses.length);
  for (var i = 0; i < n; i++) {
    var am = a.misses[i] || 0, bm = b.misses[i] || 0;
    if (am !== bm) return am < bm;
  }
  if (Math.abs(a.lateMin - b.lateMin) > 1e-9) return a.lateMin < b.lateMin;
  // Window order beats drive time: a missed 11 AM stop stays ahead of a
  // 2 PM stop even if the drive is longer. The commitment stands.
  if (Math.abs((a.orderPenalty || 0) - (b.orderPenalty || 0)) > 1e-9)
    return (a.orderPenalty || 0) < (b.orderPenalty || 0);
  return a.driveMin < b.driveMin - 1e-9;
}

/* Repair pass: for still-violated confirmed stops (earliest window first),
 * try relocating each to every earlier legal position; keep improvements.
 * Pinned positions (first at 1, last at end) are never moved. */
function repairWindows(order, durMin, ctx, lo, endExclusive) {
  var ord = order.slice();
  var cost = scheduleCost(ord, durMin, ctx);
  for (var iter = 0; iter < 60; iter++) {
    var sim = simulateSchedule(ord, durMin, ctx);
    if (!sim.violations.length) break;
    var vs = sim.violations.slice().sort(function (a, b) { return a.winStart - b.winStart; });
    var improved = false;
    for (var vi = 0; vi < vs.length && !improved; vi++) {
      var pos = ord.indexOf(vs[vi].point);
      if (pos < lo || pos >= endExclusive) continue; /* pinned: cannot move */
      for (var np = lo; np < endExclusive && !improved; np++) {
        if (np === pos) continue;
        var cand = ord.slice();
        cand.splice(pos, 1);
        cand.splice(np > pos ? np - 1 : np, 0, vs[vi].point);
        var cc = scheduleCost(cand, durMin, ctx);
        if (costLess(cc, cost)) { ord = cand; cost = cc; improved = true; }
      }
    }
    if (!improved) break;
  }
  return ord;
}

function optimizeOrder(matrix, opts) {
  var o = opts || {};
  var start = (o.start === undefined || o.start === null) ? 0 : o.start;
  var first = (o.first === undefined) ? null : o.first;
  var last = (o.last === undefined) ? null : o.last;

  var n = matrix ? matrix.length : 0;
  if (n === 0) return [];
  if (n === 1) return [0];

  var pinnedFirst = first;
  if (pinnedFirst === start) pinnedFirst = null;              /* degenerate -> no pin */
  if (pinnedFirst !== null && (pinnedFirst < 0 || pinnedFirst >= n)) pinnedFirst = null;
  var pinned = last;
  if (pinned === start) pinned = null;              /* degenerate -> no pin */
  if (pinned !== null && (pinned < 0 || pinned >= n)) pinned = null;
  if (pinnedFirst !== null && pinnedFirst === pinned) pinnedFirst = null; /* can't be both */

  /* Initial order. Without windows: nearest-neighbor from `start` (original
   * behavior). With windows: windowed stops seed in earliest-window-start
   * order (2026-10-05 — appointment order is a hard constraint, never
   * violated for drive time), then nearest-neighbor fills the flexible
   * stops; the pinned-first stop is visited right after start, the
   * pinned-last stop is visited last. 2-opt below can only accept moves
   * that don't add window inversions, so the windowed subsequence stays
   * chronological while flexible stops get drive-optimized around it. */
  var order = [start];
  var used = {};
  used[start] = true;
  var cur = start;
  if (pinnedFirst !== null) {
    order.push(pinnedFirst);
    used[pinnedFirst] = true;
    cur = pinnedFirst;
  }
  if (pinned !== null) used[pinned] = true;

  var sctx0 = schedCtx(o, n);
  if (sctx0.anyWindow) {
    var winSeq = [];
    for (var wi = 0; wi < n; wi++) {
      if (used[wi]) continue;
      var ww = o.windows && o.windows[wi];
      if (ww && ww.start !== null && ww.start !== undefined &&
          ww.end !== null && ww.end !== undefined) winSeq.push(wi);
    }
    winSeq.sort(function (a, b) {
      var d = o.windows[a].start - o.windows[b].start;
      return d !== 0 ? d : a - b; /* stable */
    });
    for (var q = 0; q < winSeq.length; q++) {
      order.push(winSeq[q]);
      used[winSeq[q]] = true;
      cur = winSeq[q];
    }
  }

  var target = (pinned === null) ? n : n - 1;
  while (order.length < target) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < n; i++) {
      if (used[i]) continue;
      var d = matrix[cur][i];
      var dd = (d === null || d === undefined) ? Infinity : d;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    if (best === -1) break;
    order.push(best);
    used[best] = true;
    cur = best;
  }
  if (pinned !== null) order.push(pinned);
  for (var s = 0; s < n; s++) { if (!used[s]) order.push(s); } /* stragglers */

  /* 2-opt improvement; keep start fixed at 0, the pinned-first stop fixed at
   * position 1, and the pinned-last stop fixed at the end.
   * With time windows present the cost is lexicographic (earliest windows
   * protected first, then lateness, then drive); without windows it is the
   * original pure drive cost, bit-for-bit identical behavior to before. */
  var lo = (pinnedFirst !== null) ? 2 : 1;
  var endExclusive = (pinned !== null) ? order.length - 1 : order.length;
  var sctx = schedCtx(o, n);
  var useWindows = sctx.anyWindow;
  var durMin = useWindows ? (o.durMin || minutesMatrix(matrix, o.source)) : null;
  var costOf = useWindows
    ? function (ord) { return scheduleCost(ord, durMin, sctx); }
    : function (ord) { return pathCost(ord, matrix); };
  var better = useWindows
    ? function (a, b) { return costLess(a, b); }
    : function (a, b) { return a < b - 1e-9; };
  /* 2-opt improvement in place from a seed order; returns the final cost.
   * Keeps start fixed at 0, the pinned-first stop at position 1, and the
   * pinned-last stop at the end. */
  var improve = function (ord) {
    var curCost = costOf(ord);
    var improved = true;
    while (improved) {
      improved = false;
      for (var ii = lo; ii < endExclusive - 1 && !improved; ii++) {
        for (var j = ii + 1; j < endExclusive; j++) {
          var cand = ord.slice();
          for (var a = ii, b = j; a < b; a++, b--) {
            var tmp = cand[a]; cand[a] = cand[b]; cand[b] = tmp;
          }
          var cc = costOf(cand);
          if (better(cc, curCost)) {
            for (var q2 = 0; q2 < cand.length; q2++) ord[q2] = cand[q2];
            curCost = cc;
            improved = true;
            break;
          }
        }
      }
    }
    return curCost;
  };
  var bestCost = improve(order); /* nearest-neighbor seed lineage */
  /* 2026-10-06 idempotency: also seed 2-opt with the caller's current order
   * (o.seedOrder, e.g. the already-optimized route). The better lineage wins;
   * ties prefer the seed, so re-optimizing a stable route is a no-op and the
   * result never regresses vs the order the user already sees. */
  var seed = o.seedOrder;
  if (seed && seed.length === n) {
    var seen = {}, okSeed = true;
    for (var sd = 0; sd < n; sd++) {
      var sv = seed[sd];
      if (sv === null || sv === undefined || sv < 0 || sv >= n || seen[sv]) { okSeed = false; break; }
      seen[sv] = true;
    }
    if (okSeed) {
      var seedOrd = seed.slice();
      var seedCost = improve(seedOrd);
      if (!better(bestCost, seedCost)) { order = seedOrd; }
    }
  }
  if (useWindows) order = repairWindows(order, durMin, sctx, lo, endExclusive);
  return order;
}

/* ------------------------------------------------------------------ */
/* OSRM drive-duration matrix with haversine fallback                   */
/* ------------------------------------------------------------------ */

function buildDurationMatrix(points, fetchFn) {
  var pts = points || [];
  var n = pts.length;
  if (n === 0) return Promise.resolve({ matrix: [], source: 'haversine' });

  var impl = fetchFn ||
    (typeof globalThis !== 'undefined' && globalThis.fetch
      ? globalThis.fetch.bind(globalThis) : null);
  if (n < 2 || !impl) {
    return Promise.resolve({ matrix: buildHaversineMatrix(pts), source: 'haversine' });
  }

  var coords = pts.map(function (p) { return p.lng + ',' + p.lat; }).join(';');
  var url = 'https://router.project-osrm.org/table/v1/driving/' + coords +
            '?annotations=duration';

  return impl(url).then(function (res) {
    if (!res || res.ok === false) throw new Error('osrm: bad http response');
    return res.json();
  }).then(function (json) {
    if (!json || json.code !== 'Ok' || !Array.isArray(json.durations)) {
      throw new Error('osrm: bad payload');
    }
    var d = json.durations;
    if (d.length !== n) throw new Error('osrm: bad matrix shape');
    for (var i = 0; i < n; i++) {
      if (!Array.isArray(d[i]) || d[i].length !== n) {
        throw new Error('osrm: bad matrix shape');
      }
    }
    /* durations are in seconds; null = unreachable -> Infinity */
    var matrix = d.map(function (row) {
      return row.map(function (v) {
        return (v === null || v === undefined) ? Infinity : Number(v);
      });
    });
    return { matrix: matrix, source: 'osrm' };
  }).catch(function () {
    /* ANY failure -> offline-safe haversine fallback */
    return { matrix: buildHaversineMatrix(pts), source: 'haversine' };
  });
}

function optimizeRouteAsync(points, opts) {
  var o = opts || {};
  var startIdx = (o.startIdx === undefined || o.startIdx === null) ? 0 : o.startIdx;
  var firstIdx = (o.firstIdx === undefined) ? null : o.firstIdx;
  var lastIdx = (o.lastIdx === undefined) ? null : o.lastIdx;
  return cachedDurationMatrix(points, o.fetchFn, o.matrixCache || null).then(function (r) {
    var durMin = minutesMatrix(r.matrix, r.source);
    var pointCoords = (points || []).map(function (p) {
      return p ? { lat: p.lat, lng: p.lng } : {};
    });
    var order = optimizeOrder(r.matrix, {
      start: startIdx, first: firstIdx, last: lastIdx,
      windows: o.windows, durMin: durMin, source: r.source,
      departMin: o.departMin, serviceMin: o.serviceMin, bufferMin: o.bufferMin,
      trafficFn: o.trafficFn, pointCoords: pointCoords, seedOrder: o.seedOrder
    });
    var sctx = schedCtx({ windows: o.windows, departMin: o.departMin,
                          serviceMin: o.serviceMin, bufferMin: o.bufferMin,
                          trafficFn: o.trafficFn, pointCoords: pointCoords },
                        r.matrix.length);
    return {
      order: order,
      source: r.source,
      matrix: r.matrix, /* v1.4: exposed so callers can score any order */
      durMin: durMin,   /* v1.9: drive minutes, parallel to matrix */
      schedule: (sctx.anyWindow || o.forceSchedule) ? simulateSchedule(order, durMin, sctx) : null
    };
  });
}

/* ------------------------------------------------------------------ */
/* 6.7 Geocode helpers + drive-time estimates (v1.4)                     */
/* ------------------------------------------------------------------ */

/* Expand a trailing USPS street-suffix abbreviation:
 * "1004 Summerview Ct" -> "1004 Summerview Court". Last token only,
 * case-insensitive, tolerates a trailing period. */
var SUFFIX_EXPAND = {
  ct: 'Court', ave: 'Avenue', av: 'Avenue', dr: 'Drive', hts: 'Heights',
  ln: 'Lane', cir: 'Circle', blvd: 'Boulevard', st: 'Street', rd: 'Road',
  pl: 'Place', ter: 'Terrace', pkwy: 'Parkway', trl: 'Trail', sq: 'Square'
};
function expandStreetSuffix(street) {
  var s = String(street == null ? '' : street);
  /* the match is only the trailing token, so the replacement is just `full` —
   * replace() itself preserves everything before the match. */
  return s.replace(/\b([A-Za-z]+)\.?\s*$/, function (m, tok) {
    return SUFFIX_EXPAND[tok.toLowerCase()] || m;
  });
}

/* Esri World Geocoder — free, keyless, CORS-enabled, commercial-grade data. */
function arcgisGeocodeUrl(query) {
  return 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/' +
    'findAddressCandidates?f=json&singleLine=' + encodeURIComponent(query) +
    '&outSR=4326&maxLocations=3';
}

/* First scored candidate -> {lat, lng, score, address}; null on anything odd. */
function parseArcGisCandidates(json) {
  try {
    var c = json && json.candidates;
    if (!c || !c.length) return null;
    var best = c[0];
    if (!best || !best.location || typeof best.score !== 'number') return null;
    var lat = Number(best.location.y), lng = Number(best.location.x);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat: lat, lng: lng, score: best.score, address: best.address || '' };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 6.8 Concurrency cap + TTL caches (perf spec 2026-10-05)              */
/* ------------------------------------------------------------------ */

/* Normalized cache key for an address string: trimmed, lowercased,
 * internal whitespace collapsed. Cache keys never leave the device. */
function normalizeGeocodeKey(address) {
  return String(address == null ? '' : address).trim().toLowerCase()
    .replace(/\s+/g, ' ');
}

/* Run fn over items with at most `limit` in flight at once.
 * Resolves (undefined) when every item is done; rejects if any task
 * rejects (Promise.all semantics). limit < 1 behaves as 1. */
function parallelLimit(items, limit, fn) {
  var queue = (items || []).slice();
  var n = Math.max(1, Math.min(Math.floor(limit) || 1, queue.length));
  function pump() {
    var item = queue.shift();
    if (item === undefined) return Promise.resolve();
    return Promise.resolve().then(function () { return fn(item); }).then(pump);
  }
  var workers = [];
  for (var i = 0; i < n; i++) workers.push(pump());
  return Promise.all(workers).then(function () { return undefined; });
}

/* Point-set signature for the matrix cache: coordinates rounded to 4
 * decimals (~11 m — absorbs GPS jitter) and sorted, so the same set of
 * points in any order, or after a no-op edit, hits the same key. */
function matrixCacheKey(points) {
  var keys = (points || []).map(function (p) {
    var lat = p && p.lat != null ? Number(p.lat) : NaN;
    var lng = p && p.lng != null ? Number(p.lng) : NaN;
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return lat.toFixed(4) + ',' + lng.toFixed(4);
  }).filter(Boolean);
  keys.sort();
  return keys.join(';');
}

/* TTL key-value cache over an optional localStorage-shaped store.
 * Pure apart from the injected `store` ({getItem,setItem,removeItem} or
 * null for memory-only). One JSON blob under `storageKey`; entries are
 * {v, ts}. LRU: reads/writes move the key to the newest end; the oldest
 * entries are evicted past maxEntries. Every store access is guarded —
 * iOS private mode throws, corrupt JSON is dropped, and the cache
 * degrades to memory-only instead of breaking the caller.
 * opts: {now: () -> ms (default Date.now), revive: (v) -> v applied on read} */
function makeTtlCache(storageKey, ttlMs, maxEntries, store, opts) {
  var o = opts || {};
  var now = o.now || Date.now;
  var revive = o.revive || null;
  var cap = Math.max(1, Math.floor(maxEntries) || 1);
  var entries = new Map();
  function read(v) {
    if (revive) { try { return revive(v); } catch { return v; } }
    return v;
  }
  function persist() {
    if (!store || !storageKey) return;
    try { store.setItem(storageKey, JSON.stringify(Array.from(entries))); }
    catch { /* private mode / quota — stay memory-only */ }
  }
  (function load() {
    if (!store || !storageKey) return;
    try {
      var raw = store.getItem(storageKey);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      var t = now();
      for (var i = 0; i < arr.length; i++) {
        var k = arr[i][0], e = arr[i][1];
        if (e && typeof e.ts === 'number' && t - e.ts <= ttlMs) entries.set(k, e);
      }
      while (entries.size > cap) entries.delete(entries.keys().next().value);
    } catch { /* corrupt blob — start empty */ }
  })();
  function live(key) {
    var e = entries.get(key);
    if (!e) return null;
    if (now() - e.ts > ttlMs) { entries.delete(key); persist(); return null; }
    return e;
  }
  return {
    get: function (key) {
      var e = live(key);
      if (!e) return null;
      entries.delete(key); entries.set(key, e); /* LRU touch */
      return read(e.v);
    },
    set: function (key, value) {
      entries.delete(key);
      entries.set(key, { v: value, ts: now() });
      while (entries.size > cap) entries.delete(entries.keys().next().value);
      persist();
    },
    has: function (key) { return !!live(key); },
    clear: function () {
      entries.clear();
      if (store && storageKey) { try { store.removeItem(storageKey); } catch {} }
    },
    size: function () { return entries.size; },
  };
}

/* Point-order key for a matrix: coordinates rounded to 4 decimals, IN ORDER
 * (unlike matrixCacheKey, which sorts). Stored alongside the cached matrix
 * so a hit can be remapped to the caller's current point order. */
function matrixOrderKey(points) {
  return (points || []).map(function (p) {
    var lat = p && p.lat != null ? Number(p.lat) : NaN;
    var lng = p && p.lng != null ? Number(p.lng) : NaN;
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return lat.toFixed(4) + ',' + lng.toFixed(4);
  });
}

/* Remap a cached matrix (rows/cols in `hit.order`) to the current points
 * order. Returns the remapped matrix, or null when it can't be aligned
 * (legacy entry without order, unmatched points) — the caller refetches. */
function remapMatrixToOrder(hit, points) {
  var m = hit && hit.matrix;
  var cachedOrder = hit && hit.order;
  var cur = matrixOrderKey(points);
  var n = cur.length;
  if (!m || !cachedOrder || cachedOrder.length !== n || m.length !== n) return null;
  for (var i = 0; i < n; i++) {
    if (!m[i] || m[i].length !== n) return null;
  }
  /* perm[i] = cached index for current point i (stable against duplicates:
   * each cached slot is used at most once). */
  var used = {}, perm = [];
  for (var c = 0; c < n; c++) {
    var key = cur[c], found = -1;
    if (key) {
      for (var k = 0; k < n; k++) {
        if (!used[k] && cachedOrder[k] === key) { found = k; break; }
      }
    }
    if (found < 0) return null;
    used[found] = true;
    perm.push(found);
  }
  var out = [];
  for (var a = 0; a < n; a++) {
    var row = [];
    for (var b = 0; b < n; b++) row.push(m[perm[a]][perm[b]]);
    out.push(row);
  }
  return out;
}

/* OSRM matrix with a client-side cache (CODING_RULES §6: matrices 1h).
 * cache: a makeTtlCache whose values are {matrix, source} as returned by
 * buildDurationMatrix. Cache hits skip the network entirely. Only real
 * OSRM results are stored — a haversine fallback is never cached, so a
 * throttled demo server keeps getting retried on later edits (today's
 * behavior). Store failures are swallowed; a dead cache is a pure
 * slowdown, never an error. */
function cachedDurationMatrix(points, fetchFn, cache) {
  var sig = matrixCacheKey(points);
  var hit = null;
  if (cache && sig) { try { hit = cache.get(sig); } catch { hit = null; } }
  /* The cache key is order-independent (sorted coords), but matrix rows
   * follow the point order at fetch time. Remap the hit to the CURRENT
   * order — 2026-10-06: without this, re-optimizing after state.stops was
   * rewritten in optimized order solves a misaligned matrix and the route
   * flip-flops on every press. */
  if (hit && hit.matrix) {
    var remapped = remapMatrixToOrder(hit, points);
    if (remapped) return Promise.resolve({ matrix: remapped, source: hit.source });
    /* can't align (e.g. legacy entry) — fall through to refetch below */
  }
  return buildDurationMatrix(points, fetchFn).then(function (r) {
    if (cache && sig && r && r.source === 'osrm') {
      try { cache.set(sig, { matrix: r.matrix, source: r.source, order: matrixOrderKey(points) }); } catch { /* cache is best-effort */ }
    }
    return r;
  });
}

/* Pure skip-guard for doOptimize: true when ensureGeocoded would do real
 * work — a stop missing coords, a labeled-but-unlocated start endpoint,
 * or a legacy origin (GPS fix attempt / unlocated origin address).
 * The end endpoint is located by getEndCoords (own single-entry cache),
 * never by ensureGeocoded, so it is out of this guard's scope. */
function ensureGeocodeNeeded(stops, startEp, origin) {
  var ss = stops || [];
  for (var i = 0; i < ss.length; i++) {
    if (ss[i] && ss[i].lat == null) return true;
  }
  if (startEp) return !!(startEp.lat == null && startEp.label);
  if (origin && origin.type === 'gps' && origin.lat == null) return true;
  if (origin && origin.type === 'address' && origin.lat == null) return true;
  return false;
}

/* Total drive minutes for `order` (array of point indices) over a matrix.
 * osrm matrices hold seconds; haversine matrices hold miles
 * (road miles ~= haversine x 1.35, at 30 mph avg -> minutes = miles x 2.7).
 * Unreachable legs (Infinity) are skipped, never poison the total. */
var HAVERSINE_MIN_PER_MI = 2.7;
function routeMinutesForOrder(matrix, order, source) {
  var total = 0;
  var ord = order || [];
  for (var k = 0; k < ord.length - 1; k++) {
    var v = matrix && matrix[ord[k]] ? matrix[ord[k]][ord[k + 1]] : null;
    if (v === null || v === undefined || !isFinite(v)) continue;
    total += (source === 'osrm') ? v / 60 : v * HAVERSINE_MIN_PER_MI;
  }
  return total;
}

/* Rough pre-optimization estimate from consecutive haversine legs. */
function estimateMinutesHaversine(points) {
  var total = 0;
  var pts = points || [];
  for (var i = 0; i < pts.length - 1; i++) {
    var a = pts[i], b = pts[i + 1];
    if (a && b && a.lat != null && b.lat != null && a.lng != null && b.lng != null) {
      total += haversineMi(a, b) * HAVERSINE_MIN_PER_MI;
    }
  }
  return total;
}

/* 74 -> "1h 14m", 58 -> "58m", 0.4 -> "<1m". */
function formatMins(mins) {
  var m = Math.round(mins);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/* ------------------------------------------------------------------ */
/* 6.5 Google Maps links                                                */
/* ------------------------------------------------------------------ */

/* Label for one stop: "street, city, ST zip" — or "lat,lng" when the
 * address parts are missing (e.g. a hand-dropped map pin). */
function stopLabel(s) {
  // Prefer coordinates: Google Maps always routes to exact lat/lng, even
  // when its address database lacks the street address (e.g. "3500 Saindon St").
  if (s && typeof s.lat === 'number' && typeof s.lng === 'number') {
    return s.lat + ',' + s.lng;
  }
  if (s && s.street) {
    var city = s.city ? s.city + ', ' : '';
    var state = s.state ? s.state + ' ' : '';
    var zip = s.zip || '';
    return (s.street + ', ' + city + state + zip).replace(/\s+$/, '');
  }
  return '';
}

/* Google universal URL, chunked: <=9 waypoints per leg, leg boundaries
 * overlap (leg[i].destination === leg[i+1].origin) so no stop is lost. */
function buildMapsLinks(originLabel, orderedStops, opts) {
  var avoid = ((opts && opts.avoid) || []).filter(Boolean);
  var stops = (orderedStops || []).slice();
  var n = stops.length;
  var out = [];
  if (n === 0) return out;

  var avoidParam = avoid.length
    ? '&avoid=' + avoid.map(encodeURIComponent).join('|') : '';

  var origin = originLabel || '';
  var i = 0;            /* first stop not yet placed */
  var legNo = 0;

  for (;;) {
    legNo++;
    var remaining = n - i;
    var wps, destIdx;
    if (legNo === 1) {
      if (remaining <= 10) { wps = stops.slice(i, n - 1); destIdx = n - 1; }
      else                 { wps = stops.slice(i, i + 9); destIdx = i + 9; }
    } else {
      /* origin is stops[i]; only the stops AFTER it need placing */
      var place = remaining - 1;
      if (place <= 10) { wps = stops.slice(i + 1, n - 1); destIdx = n - 1; }
      else             { wps = stops.slice(i + 1, i + 10); destIdx = i + 10; }
    }

    var dest = stopLabel(stops[destIdx]);
    var url = 'https://www.google.com/maps/dir/?api=1' +
      (origin ? '&origin=' + encodeURIComponent(origin) : '') +
      '&destination=' + encodeURIComponent(dest) +
      (wps.length
        ? '&waypoints=' + wps.map(function (s) { return encodeURIComponent(stopLabel(s)); }).join('|')
        : '') +
      '&travelmode=driving' +
      avoidParam;

    out.push({
      label: 'Leg ' + legNo + ' \u00B7 stops ' + (i + 1) + '\u2013' + (destIdx + 1),
      url: url
    });

    if (destIdx >= n - 1 || out.length > 100) break; /* every stop placed */
    origin = dest;      /* overlap: next leg starts where this one ends */
    i = destIdx;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 6.6 Share — '#r=' + base64url(JSON)                                   */
/* ------------------------------------------------------------------ */

function b64urlEncode(json) {
  var b64;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(json, 'utf8').toString('base64');
  } else {
    /* browser: btoa needs a latin1 string -> UTF-8 round-trip */
    b64 = btoa(unescape(encodeURIComponent(json)));
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  return decodeURIComponent(escape(atob(b64)));
}

function encodeShare(payload) {
  return '#r=' + b64urlEncode(JSON.stringify(payload || {}));
}

function decodeShare(str) {
  try {
    if (typeof str !== 'string' || !str) return null;
    var s = str.trim();
    var m = s.match(/#r=([A-Za-z0-9\-_]+)/);  /* bare or inside a full URL */
    if (m) s = m[1];
    else if (s.indexOf('#r=') === 0) s = s.slice(3);
    if (!/^[A-Za-z0-9\-_]+$/.test(s)) return null;
    return JSON.parse(b64urlDecode(s));
  } catch {
    return null; /* any failure -> null, never throw */
  }
}

/* ------------------------------------------------------------------ */
/* 6.6 Saved locations, start/end, appointment dialog                    */
/* ------------------------------------------------------------------ */

/* Dedupe key for a saved location: prefer coords, fall back to address. */
function savedLocationKey(loc) {
  if (!loc || typeof loc !== 'object') return '';
  if (typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    return 'geo:' + loc.lat.toFixed(5) + ',' + loc.lng.toFixed(5);
  }
  var addr = String(loc.address || '').trim().toLowerCase();
  return addr ? 'addr:' + addr : '';
}

/* True if a location matching `loc` is in the saved list. */
function isSavedLocation(saved, loc) {
  var key = savedLocationKey(loc);
  if (!key) return false;
  return (saved || []).some(function (s) { return savedLocationKey(s) === key; });
}

/* Toggle a location in the saved list. Returns {saved: [...], added: bool}. */
function toggleSavedLocation(saved, loc) {
  var list = Array.isArray(saved) ? saved.slice() : [];
  var key = savedLocationKey(loc);
  if (!key) return { saved: list, added: false };
  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (savedLocationKey(list[i]) === key) { idx = i; break; }
  }
  if (idx >= 0) {
    list.splice(idx, 1);
    return { saved: list, added: false };
  }
  var name = (loc.name && String(loc.name).trim()) || String(loc.address || '').trim();
  list.push({
    name: name || 'Saved location',
    address: String(loc.address || '').trim(),
    lat: typeof loc.lat === 'number' ? loc.lat : null,
    lng: typeof loc.lng === 'number' ? loc.lng : null,
  });
  return { saved: list, added: true };
}

/* Rename a saved location by key. Returns new array (or original if not found). */
function renameSavedLocation(saved, key, newName) {
  var list = Array.isArray(saved) ? saved.slice() : [];
  var name = String(newName || '').trim();
  if (!name) return list;
  for (var i = 0; i < list.length; i++) {
    if (savedLocationKey(list[i]) === key) {
      list[i] = {
        name: name,
        address: list[i].address,
        lat: list[i].lat,
        lng: list[i].lng,
      };
      break;
    }
  }
  return list;
}

/* Filter saved locations for the dropdown: empty query shows all,
 * otherwise match against name + address (case-insensitive). */
function filterSavedLocations(saved, query) {
  var list = Array.isArray(saved) ? saved : [];
  var q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice();
  return list.filter(function (s) {
    return (String(s.name || '').toLowerCase().indexOf(q) >= 0) ||
            String(s.address || '').toLowerCase().indexOf(q) >= 0;
  });
}

/* Normalize a start/end endpoint for optimization.
 * Returns null when the endpoint is empty/unset (caller skips it silently). */
function normalizeEndpoint(ep) {
  if (!ep || typeof ep !== 'object') return null;
  var hasCoords = typeof ep.lat === 'number' && typeof ep.lng === 'number';
  var hasLabel = ep.label && String(ep.label).trim();
  if (!hasCoords && !hasLabel) return null;
  return {
    label: hasLabel ? String(ep.label).trim() : 'Current location',
    lat: hasCoords ? ep.lat : null,
    lng: hasCoords ? ep.lng : null,
  };
}

/* Merge job types for the appointment dialog dropdown:
 * learned types (from serviceTimes.known) + custom types + types on stops.
 * Returns a deduped, sorted array. */
function collectAllJobTypes(known, custom, stops) {
  var seen = {};
  var out = [];
  function add(t) {
    var v = String(t || '').trim();
    if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); }
  }
  (known || []).forEach(add);
  (custom || []).forEach(add);
  (stops || []).forEach(function (s) { add(s && s.jobType); });
  out.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  return out;
}

/* Add a custom job type. Returns new array (unchanged if blank/duplicate). */
function addCustomJobType(custom, name) {
  var list = Array.isArray(custom) ? custom.slice() : [];
  var v = String(name || '').trim();
  if (!v) return list;
  var dup = list.some(function (t) { return String(t).toLowerCase() === v.toLowerCase(); });
  if (!dup && list.length < 60) list.push(v);
  return list;
}

/* ------------------------------------------------------------------ */

var RouteCore = {
  parseOcrText: parseOcrText,
  parseFreeformAddresses: parseFreeformAddresses,
  normalizeStop: normalizeStop,
  dedupeStops: dedupeStops,
  haversineMi: haversineMi,
  buildHaversineMatrix: buildHaversineMatrix,
  optimizeOrder: optimizeOrder,
  buildDurationMatrix: buildDurationMatrix,
  cachedDurationMatrix: cachedDurationMatrix,
  optimizeRouteAsync: optimizeRouteAsync,
  normalizeGeocodeKey: normalizeGeocodeKey,
  parallelLimit: parallelLimit,
  makeTtlCache: makeTtlCache,
  ensureGeocodeNeeded: ensureGeocodeNeeded,
  buildMapsLinks: buildMapsLinks,
  encodeShare: encodeShare,
  decodeShare: decodeShare,
  expandStreetSuffix: expandStreetSuffix,
  arcgisGeocodeUrl: arcgisGeocodeUrl,
  parseArcGisCandidates: parseArcGisCandidates,
  routeMinutesForOrder: routeMinutesForOrder,
  estimateMinutesHaversine: estimateMinutesHaversine,
  formatMins: formatMins,
  parseClockToMin: parseClockToMin,
  formatClock: formatClock,
  remainingServiceMin: remainingServiceMin,
  minutesMatrix: minutesMatrix,
  matrixCacheKey: matrixCacheKey,
  matrixOrderKey: matrixOrderKey,
  remapMatrixToOrder: remapMatrixToOrder,
  simulateSchedule: simulateSchedule,
  schedCtx: schedCtx,
  scheduleCost: scheduleCost,
  costLess: costLess,
  findEarlyArrivalOpportunity: findEarlyArrivalOpportunity,
  trafficFactorAt: trafficFactorAt,
  trafficBucketKey: trafficBucketKey,
  learnedTrafficFactorAt: learnedTrafficFactorAt,
  recordTrafficSample: recordTrafficSample,
  rainFactorFor: rainFactorFor,
  driveAwayWindowFires: driveAwayWindowFires,
  geocodeSuffix: geocodeSuffix,
  photonBias: photonBias,
  classifyPrecision: classifyPrecision,
  PRECISE_ACCURACY_M: PRECISE_ACCURACY_M,
  savedLocationKey: savedLocationKey,
  isSavedLocation: isSavedLocation,
  toggleSavedLocation: toggleSavedLocation,
  renameSavedLocation: renameSavedLocation,
  filterSavedLocations: filterSavedLocations,
  normalizeEndpoint: normalizeEndpoint,
  collectAllJobTypes: collectAllJobTypes,
  addCustomJobType: addCustomJobType
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RouteCore;
}
if (typeof window !== 'undefined') {
  window.RouteCore = RouteCore;
}
