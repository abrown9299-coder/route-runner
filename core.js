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
 *     windows[i] = null | {start, end} arrival window in minutes-from-midnight;
 *     effective deadline is end - bufferMin (30). Early arrival waits.
 *   simulateSchedule(order, durMin, schedCtx) -> {legs, driveMin, violations}
 *   minutesMatrix(matrix, source) -> drive-minute matrix parallel to matrix
 *   parseClockToMin("9:00 AM") -> 540 ; formatClock(540) -> "9:00 AM"
 *   buildDurationMatrix(points, fetchFn) -> Promise<{matrix, source}>
 *   optimizeRouteAsync(points, {startIdx, firstIdx, lastIdx, fetchFn}) -> Promise<{order, source}>
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
var STREET_RE = /^\d+\s+[A-Za-z]/;

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
 * Returns {start, end} or null. The apptMin provides the AM/PM context. */
function parseShortWindow(s, apptMin) {
  var m = String(s).match(/^\s*(\d{1,2})\s*[-\u2013\u2014]\s*(\d{1,2})\s*$/);
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
function parseStopNumber(s) {
  var m = String(s).match(/^(?:Stop\s+)?(\d{1,2})(?:\s*[.)]|\s+of\s+\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

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
                     .replace(/\s*\b\d{1,2}\s*[APap]\.?\s*[Mm]\.?\b/, '').trim();
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
    var locked = false;
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
        if (sw) { twEnd = sw.end; locked = true; break; }
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
 * missing/OCR-mangled city still dedupes against the same street+ZIP. */
function normalizeStop(s) {
  var raw = (s && s.street) ? String(s.street) : '';
  var t = raw.toLowerCase().replace(/[''`]/g, '');
  t = t.replace(/[^\w\s]/g, ' ');          /* strip punctuation */
  t = t.split(/\s+/).filter(Boolean)
       .map(function (w) { return ABBR[w] || w; }) /* USPS-abbrev normalize */
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
  return {
    windows: windows,
    departMin: (o.departMin !== null && o.departMin !== undefined) ? o.departMin : 0,
    serviceMin: o.serviceMin,
    bufferMin: (o.bufferMin !== null && o.bufferMin !== undefined) ? o.bufferMin : WINDOW_BUFFER_MIN,
    maxStart: maxStart,
    anyWindow: anyWindow
  };
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
    var dm = (d === null || d === undefined || !isFinite(d)) ? 1e9 : d;
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

/* Total cost of an order, compared LEXICOGRAPHICALLY so confirmed stops are
 * protected in earliest-window-start order no matter what:
 *   1. miss vector — one slot per windowed stop, sorted by window start
 *      ascending; 1 = missed its buffered deadline, 0 = met. Compared slot
 *      by slot, earliest window first.
 *   2. total lateness minutes across all violations.
 *   3. drive minutes.
 * A scalar weight can never guarantee (1); this ordering does. */
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
  var misses = winIdx.map(function (i) { return missed[i] ? 1 : 0; });
  return { misses: misses, lateMin: lateMin, driveMin: sim.driveMin,
           violations: sim.violations, legs: sim.legs };
}
/* True if cost a is strictly better than cost b under the lexicographic order. */
function costLess(a, b) {
  var n = Math.max(a.misses.length, b.misses.length);
  for (var i = 0; i < n; i++) {
    var am = a.misses[i] || 0, bm = b.misses[i] || 0;
    if (am !== bm) return am < bm;
  }
  if (Math.abs(a.lateMin - b.lateMin) > 1e-9) return a.lateMin < b.lateMin;
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

  /* nearest-neighbor from `start`; the pinned-first stop is visited right
   * after start, the pinned-last stop is visited last */
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
  var curCost = costOf(order);
  var improved = true;
  while (improved) {
    improved = false;
    for (var i = lo; i < endExclusive - 1 && !improved; i++) {
      for (var j = i + 1; j < endExclusive; j++) {
        var cand = order.slice();
        for (var a = i, b = j; a < b; a++, b--) {
          var tmp = cand[a]; cand[a] = cand[b]; cand[b] = tmp;
        }
        var cc = costOf(cand);
        if (better(cc, curCost)) {
          for (var q = 0; q < cand.length; q++) order[q] = cand[q];
          curCost = cc;
          improved = true;
          break;
        }
      }
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
  return buildDurationMatrix(points, o.fetchFn).then(function (r) {
    var durMin = minutesMatrix(r.matrix, r.source);
    var order = optimizeOrder(r.matrix, {
      start: startIdx, first: firstIdx, last: lastIdx,
      windows: o.windows, durMin: durMin, source: r.source,
      departMin: o.departMin, serviceMin: o.serviceMin, bufferMin: o.bufferMin
    });
    var sctx = schedCtx({ windows: o.windows, departMin: o.departMin,
                          serviceMin: o.serviceMin, bufferMin: o.bufferMin },
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
  } catch (e) {
    return null;
  }
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
  if (s && s.street) {
    var city = s.city ? s.city + ', ' : '';
    var state = s.state ? s.state + ' ' : '';
    var zip = s.zip || '';
    return (s.street + ', ' + city + state + zip).replace(/\s+$/, '');
  }
  if (s && typeof s.lat === 'number' && typeof s.lng === 'number') {
    return s.lat + ',' + s.lng;
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
      '&origin=' + encodeURIComponent(origin) +
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
  } catch (e) {
    return null; /* any failure -> null, never throw */
  }
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
  optimizeRouteAsync: optimizeRouteAsync,
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
  simulateSchedule: simulateSchedule,
  scheduleCost: scheduleCost,
  costLess: costLess
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RouteCore;
}
if (typeof window !== 'undefined') {
  window.RouteCore = RouteCore;
}
