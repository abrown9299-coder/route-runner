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
 *   optimizeOrder(matrix, {start, last}) -> index order (NN + 2-opt, `last` pinned)
 *   buildDurationMatrix(points, fetchFn) -> Promise<{matrix, source}>
 *   optimizeRouteAsync(points, {startIdx, lastIdx, fetchFn}) -> Promise<{order, source}>
 *   buildMapsLinks(originLabel, orderedStops, {avoid}) -> [{label, url}]
 *   encodeShare(payload) / decodeShare(str) -> shareable '#r=...' links
 */

'use strict';

/* ------------------------------------------------------------------ */
/* 6.1 OCR parse                                                       */
/* ------------------------------------------------------------------ */

/* Arrow schedule cards repeat this block per stop:
 *   <customer name>   <- DISCARDED, never stored
 *   <time e.g. 9:00 AM> <- DISCARDED
 *   <street e.g. "1014 Kirkwood Ave">
 *   <city, ST ZIP e.g. "Nashville, TN 37204-2516">
 *   <job type e.g. "Sentricon Guarantee/Coverage">
 * Output objects NEVER carry a `name` field.
 */
var CITY_ZIP_RE = /^(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;
var STREET_RE = /^\d+\s+[A-Za-z]/;
var TIME_RE = /^\d{1,2}:\d{2}/;

function parseOcrText(text) {
  var lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });

  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(CITY_ZIP_RE);
    if (!m) continue;

    /* street = nearest PRECEDING line that starts with a house number */
    var street = '';
    for (var k = i - 1; k >= 0; k--) {
      if (STREET_RE.test(lines[k])) { street = lines[k]; break; }
      if (CITY_ZIP_RE.test(lines[k])) break; /* previous stop's block */
    }
    if (!street) continue; /* city line without a street is not a stop */

    /* jobType = first FOLLOWING line that is not a time and < 60 chars.
     * Stop at the next stop's block (street/city line). If the candidate is
     * immediately followed by a time line it is the NEXT stop's name
     * (name -> time pattern) -> treat as missing jobType so no name leaks. */
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

    out.push({
      street: street,
      city: m[1].trim(),
      state: m[2],
      zip: m[3],
      jobType: jobType
    });
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

function optimizeOrder(matrix, opts) {
  var o = opts || {};
  var start = (o.start === undefined || o.start === null) ? 0 : o.start;
  var last = (o.last === undefined) ? null : o.last;

  var n = matrix ? matrix.length : 0;
  if (n === 0) return [];
  if (n === 1) return [0];

  var pinned = last;
  if (pinned === start) pinned = null;              /* degenerate -> no pin */
  if (pinned !== null && (pinned < 0 || pinned >= n)) pinned = null;

  /* nearest-neighbor from `start`; pinned stop is visited last */
  var order = [start];
  var used = {};
  used[start] = true;
  if (pinned !== null) used[pinned] = true;

  var target = (pinned === null) ? n : n - 1;
  var cur = start;
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

  /* 2-opt improvement; keep start fixed at 0 and the pinned stop at the end */
  var endExclusive = (pinned !== null) ? order.length - 1 : order.length;
  var curCost = pathCost(order, matrix);
  var improved = true;
  while (improved) {
    improved = false;
    for (var i = 1; i < endExclusive - 1 && !improved; i++) {
      for (var j = i + 1; j < endExclusive; j++) {
        var cand = order.slice();
        for (var a = i, b = j; a < b; a++, b--) {
          var tmp = cand[a]; cand[a] = cand[b]; cand[b] = tmp;
        }
        var cc = pathCost(cand, matrix);
        if (cc < curCost - 1e-9) {
          for (var q = 0; q < cand.length; q++) order[q] = cand[q];
          curCost = cc;
          improved = true;
          break;
        }
      }
    }
  }
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
  var lastIdx = (o.lastIdx === undefined) ? null : o.lastIdx;
  return buildDurationMatrix(points, o.fetchFn).then(function (r) {
    return {
      order: optimizeOrder(r.matrix, { start: startIdx, last: lastIdx }),
      source: r.source
    };
  });
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
  normalizeStop: normalizeStop,
  dedupeStops: dedupeStops,
  haversineMi: haversineMi,
  buildHaversineMatrix: buildHaversineMatrix,
  optimizeOrder: optimizeOrder,
  buildDurationMatrix: buildDurationMatrix,
  optimizeRouteAsync: optimizeRouteAsync,
  buildMapsLinks: buildMapsLinks,
  encodeShare: encodeShare,
  decodeShare: decodeShare
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RouteCore;
}
if (typeof window !== 'undefined') {
  window.RouteCore = RouteCore;
}
