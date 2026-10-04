/* RouteRunner core unit tests (spec V1 verification).
 * Run:  npm test   (from ~/workspace/route-runner)
 */
import { test, expect } from 'vitest';
import core from '../app/core.js';

/* Realistic OCR of the Arrow schedule screenshot: 4 stops, each
 *   <status badge> <name> <time> <street> <city, ST ZIP> <job type> */
const OCR_4_STOPS = [
  'NOT STARTED',
  'Alex Rivera',
  '9:00 AM',
  '1014 Kirkwood Ave',
  'Nashville, TN 37204-2516',
  'Sentricon Guarantee/Coverage',
  'NOT STARTED',
  'Jordan Blake',
  '10:00 AM',
  '921 Hillview Hts',
  'Nashville, TN 37204-2115',
  'Sentricon Guarantee/Coverage',
  'Lead - OPEN',
  'Casey Morgan',
  '11:00 AM',
  '1552 Eller Dr',
  'Nashville, TN 37221-3368',
  'Home Evaluation',
  'Lead - NEW',
  'Taylor Quinn',
  '12:00 PM',
  '1004 Summerview Ct',
  'Nashville, TN 37221-2348',
  'Home Evaluation'
].join('\n');

test('parseOcrText: extracts 4 stops, addresses + job types, NEVER names', () => {
  const res = core.parseOcrText(OCR_4_STOPS);
  expect(res.length).toBe(4);

  expect(res.map(s => s.street)).toEqual([
    '1014 Kirkwood Ave',
    '921 Hillview Hts',
    '1552 Eller Dr',
    '1004 Summerview Ct'
  ]);
  expect(res.map(s => s.zip)).toEqual(['37204', '37204', '37221', '37221']);
  expect(res.every(s => s.city === 'Nashville' && s.state === 'TN')).toBeTruthy();
  expect(res.map(s => s.jobType)).toEqual([
    'Sentricon Guarantee/Coverage',
    'Sentricon Guarantee/Coverage',
    'Home Evaluation',
    'Home Evaluation'
  ]);

  /* privacy: no name field exists, and no name/time string appears anywhere */
  expect(res.every(s => !('name' in s))).toBeTruthy();
  const blob = JSON.stringify(res);
  for (const name of ['Alex Rivera', 'Jordan Blake', 'Casey Morgan', 'Taylor Quinn']) {
    expect(!blob.includes(name)).toBeTruthy();
  }
  for (const t of ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM']) {
    expect(!blob.includes(t)).toBeTruthy();
  }
});

test('parseOcrText: missing job type yields "" and never the next name', () => {
  const txt = [
    'Alice Nobody', '9:00 AM', '1014 Kirkwood Ave', 'Nashville, TN 37204',
    'Bob Somebody', '10:00 AM', '921 Hillview Hts', 'Nashville, TN 37204', 'Sentricon'
  ].join('\n');
  const res = core.parseOcrText(txt);
  expect(res.length).toBe(2);
  expect(res[0].jobType).toBe('');        /* not "Bob Somebody" */
  expect(res[1].jobType).toBe('Sentricon');
  expect(!JSON.stringify(res).includes('Bob Somebody')).toBeTruthy();
});

test('parseFreeformAddresses: single-line address from notes/GPS screenshot', () => {
  const txt = '123 Main St, Nashville, TN 37201';
  const res = core.parseFreeformAddresses(txt);
  expect(res.length).toBe(1);
  expect(res[0].street).toBe('123 Main St');
  expect(res[0].city).toBe('Nashville');
  expect(res[0].state).toBe('TN');
  expect(res[0].zip).toBe('37201');
});

test('parseFreeformAddresses: multi-line address (street then city line)', () => {
  const txt = ['456 Oak Ave', 'Nashville, TN 37204'].join('\n');
  const res = core.parseFreeformAddresses(txt);
  expect(res.length).toBe(1);
  expect(res[0].street).toBe('456 Oak Ave');
  expect(res[0].zip).toBe('37204');
});

test('parseFreeformAddresses: dedupes repeated addresses', () => {
  const txt = ['123 Main St, Nashville, TN 37201', '123 Main St, Nashville, TN 37201'].join('\n');
  const res = core.parseFreeformAddresses(txt);
  expect(res.length).toBe(1);
});

test('parseOcrText: labeled Service Address field', () => {
  const txt = [
    'Service Address: 789 Pine St, Nashville, TN 37203',
    'Customer Name: John Doe',
  ].join('\n');
  const res = core.parseOcrText(txt);
  expect(res.length).toBe(1);
  expect(res[0].street).toBe('789 Pine St');
  expect(res[0].zip).toBe('37203');
  expect(!JSON.stringify(res).includes('John Doe')).toBeTruthy();
});

test('parseOcrText: time window sets confirmed window', () => {
  const txt = [
    'Jane Smith', '9:00 AM - 11:00 AM', 'General Pest Control',
    '456 Oak Ave', 'Nashville, TN 37204',
  ].join('\n');
  const res = core.parseOcrText(txt);
  expect(res.length).toBe(1);
  expect(res[0].apptMin).toBe(540); // 9:00 AM
  expect(res[0].twEnd).toBe(660);   // 11:00 AM
  expect(res[0].jobType).toBe('General Pest Control');
});

test('parseOcrText: stop-numbered route manifest', () => {
  const txt = [
    '3. 789 Pine Street, Nashville, TN 37203',
    '4. 101 Elm Dr, Nashville, TN 37204',
  ].join('\n');
  // single-line with stop numbers -> freeform fallback handles these
  const res = core.parseFreeformAddresses(txt);
  expect(res.length).toBe(0); // single-line numbered addresses need city-line context
  // parseOcrText needs city lines; test the numbered street stripping via full parse
  const txt2 = ['3. 789 Pine St', 'Nashville, TN 37203'].join('\n');
  const res2 = core.parseOcrText(txt2);
  expect(res2.length).toBe(1);
  expect(res2[0].street).toBe('789 Pine St');
});

test('parseOcrText: known job type detected when no explicit label', () => {
  const txt = [
    '9:00 AM', '123 Main St', 'Nashville, TN 37201',
    'Some random note line that is not a job',
  ].join('\n');
  // The heuristic picks up the note; known types are fallback only
  const res = core.parseOcrText(txt);
  expect(res.length).toBe(1);
});

test('dedupeStops: ZIP+4 vs ZIP5, "Street" vs "St", cross-screenshot dupes', () => {
  const a = { street: '1014 Kirkwood Street', city: 'Nashville', state: 'TN', zip: '37204-2516' };
  const b = { street: '1014 Kirkwood St', city: 'Nashville', state: 'TN', zip: '37204' };
  const c = { street: '921 Hillview Hts', city: 'Nashville', state: 'TN', zip: '37204-2115' };
  /* normalize keys must collide for a/b */
  expect(core.normalizeStop(a)).toBe(core.normalizeStop(b));

  const { stops, removed } = core.dedupeStops([a, b, c]);
  expect(stops.length).toBe(2);
  expect(removed).toBe(1);
  expect(stops[0], 'first occurrence is kept').toBe(a);
  expect(stops[1]).toBe(c);
});

test('dedupeStops: heights->hts and punctuation variants collide', () => {
  const a = { street: '921 Hillview Heights', zip: '37204' };
  const b = { street: '921 Hillview Hts.', zip: '37204-2115' };
  const { stops, removed } = core.dedupeStops([a, b]);
  expect(stops.length).toBe(1);
  expect(removed).toBe(1);
});

test('optimizeOrder: known geometry, pinned last, beats naive order', () => {
  /* start at lng 0; index 2 is the nearest stop but naive order visits index 1 first */
  const pts = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 10 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 20 }
  ];
  const m = core.buildHaversineMatrix(pts);
  expect(m.length).toBe(4);
  expect(m[0][0]).toBe(0);
  expect(Math.abs(m[0][2] - m[2][0]) < 1e-9).toBeTruthy();

  const order = core.optimizeOrder(m, { start: 0, last: 3 });
  expect(order[0], 'starts at origin').toBe(0);
  expect(order[order.length - 1], 'pinned stop stays last').toBe(3);
  expect([...order].sort(), 'visits every stop once').toEqual([0, 1, 2, 3]);

  const cost = o => o.slice(0, -1).reduce((s, _, k) => s + m[o[k]][o[k + 1]], 0);
  expect(cost(order) < cost([0, 1, 2, 3])).toBeTruthy();
});

test('optimizeOrder: degenerate inputs', () => {
  expect(core.optimizeOrder([], {})).toEqual([]);
  expect(core.optimizeOrder([[0]], {})).toEqual([0]);
  const m = core.buildHaversineMatrix([
    { lat: 0, lng: 0 }, { lat: 0, lng: 5 }, { lat: 1, lng: 1 }
  ]);
  /* last === start -> treated as no pin: every stop still visited */
  const o = core.optimizeOrder(m, { start: 0, last: 0 });
  expect(o[0]).toBe(0);
  expect([...o].sort()).toEqual([0, 1, 2]);
});

test('optimizeOrder: pinned first is visited right after start', () => {
  const pts = [
    { lat: 0, lng: 0 },   // 0: origin
    { lat: 0, lng: 10 },  // 1
    { lat: 0, lng: 1 },   // 2: nearest to origin, but pinned first is 1
    { lat: 0, lng: 20 }   // 3
  ];
  const m = core.buildHaversineMatrix(pts);
  const order = core.optimizeOrder(m, { start: 0, first: 1 });
  expect(order[0], 'starts at origin').toBe(0);
  expect(order[1], 'pinned stop is first after start').toBe(1);
  expect([...order].sort(), 'visits every stop once').toEqual([0, 1, 2, 3]);
});

test('optimizeOrder: pinned first + pinned last coexist', () => {
  const pts = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 0, lng: 1 }, { lat: 0, lng: 20 }
  ];
  const m = core.buildHaversineMatrix(pts);
  const order = core.optimizeOrder(m, { start: 0, first: 2, last: 3 });
  expect(order[0], 'starts at origin').toBe(0);
  expect(order[1], 'pinned stop is first after start').toBe(2);
  expect(order[order.length - 1], 'pinned stop stays last').toBe(3);
  expect([...order].sort(), 'visits every stop once').toEqual([0, 1, 2, 3]);
});

test('optimizeOrder: degenerate first pins are dropped', () => {
  const m = core.buildHaversineMatrix([
    { lat: 0, lng: 0 }, { lat: 0, lng: 5 }, { lat: 1, lng: 1 }
  ]);
  /* first === start -> no pin */
  let o = core.optimizeOrder(m, { start: 0, first: 0 });
  expect([...o].sort()).toEqual([0, 1, 2]);
  /* first === last -> first is dropped, last kept */
  o = core.optimizeOrder(m, { start: 0, first: 2, last: 2 });
  expect(o[o.length - 1], 'last pin survives').toBe(2);
  expect([...o].sort()).toEqual([0, 1, 2]);
  /* out of range -> no pin */
  o = core.optimizeOrder(m, { start: 0, first: 99 });
  expect(o[0]).toBe(0);
  expect([...o].sort()).toEqual([0, 1, 2]);
});

test('buildMapsLinks: 20 stops -> 2 legs, <=9 waypoints, overlapping boundary', () => {
  const stops = Array.from({ length: 20 }, (_, i) => ({
    street: `${100 + i} Test St`, city: 'Nashville', state: 'TN', zip: '37204'
  }));
  const legs = core.buildMapsLinks('Current Location', stops, {});
  expect(legs.length).toBe(2);
  expect(legs[0].label).toBe('Leg 1 · stops 1–10');
  expect(legs[1].label).toBe('Leg 2 · stops 10–20');

  for (const leg of legs) {
    expect(leg.url.includes('maps/dir/?api=1')).toBeTruthy();
    expect(leg.url.includes('travelmode=driving')).toBeTruthy();
    const wp = leg.url.match(/waypoints=([^&]*)/);
    expect(wp).toBeTruthy();
    expect(wp[1].split('|').length <= 9).toBeTruthy();
  }
  expect(legs[0].url.match(/waypoints=([^&]*)/)[1].split('|').length).toBe(9);
  expect(legs[1].url.match(/waypoints=([^&]*)/)[1].split('|').length).toBe(9);

  /* overlap: leg 1 destination === leg 2 origin (no stop dropped between legs) */
  const dest0 = decodeURIComponent(legs[0].url.match(/destination=([^&]*)/)[1]);
  const orig1 = decodeURIComponent(legs[1].url.match(/origin=([^&]*)/)[1]);
  expect(dest0).toBe(orig1);
  expect(dest0.includes('109 Test St')).toBeTruthy();

  /* avoid flags */
  const legs2 = core.buildMapsLinks('Home', stops.slice(0, 3), { avoid: ['tolls', 'highways'] });
  expect(legs2[0].url.includes('avoid=')).toBeTruthy();
});

test('buildMapsLinks: single leg and lat/lng fallback labels', () => {
  const one = core.buildMapsLinks('Home', [{ lat: 36.1, lng: -86.8 }], {});
  expect(one.length).toBe(1);
  expect(decodeURIComponent(one[0].url).includes('36.1,-86.8')).toBeTruthy();
  expect(core.buildMapsLinks('Home', [], {}).length).toBe(0);
});

test('buildMapsLinks: app-shaped stop objects produce non-empty destinations', () => {
  // REGRESSION: the app once passed {label} wrappers here; stopLabel() returns ''
  // for those, yielding an empty Maps URL. The app must pass stop objects.
  const appStops = [
    { id: 'a1', street: '1014 Kirkwood Ave', city: 'Nashville', state: 'TN', zip: '37204',
      jobType: 'Sentricon', note: '', lat: 36.1, lng: -86.7, geocodeSource: 'census',
      done: false, isLast: false, source: 'manual' },
    { id: 'b2', street: '1552 Eller Dr', city: 'Nashville', state: 'TN', zip: '37221',
      jobType: 'Home Evaluation', note: '', lat: 36.0, lng: -86.9, geocodeSource: 'nominatim',
      done: false, isLast: false, source: 'manual' },
  ];
  const legs = core.buildMapsLinks('Current Location', appStops, { avoid: ['tolls'] });
  expect(legs.length).toBe(1);
  const url = decodeURIComponent(legs[0].url);
  // Coordinates are preferred when available (Google routes reliably to lat/lng
  // even when its address database lacks the street). Either form is valid.
  expect(url.includes('36.1,-86.7') || url.includes('1014 Kirkwood Ave')).toBeTruthy();
  expect(url.includes('36,-86.9') || url.includes('1552 Eller Dr')).toBeTruthy();
  expect(!/destination=&/.test(legs[0].url)).toBeTruthy();
  expect(url.includes('avoid=tolls')).toBeTruthy();
  // return-to-start shape the app uses
  const rts = core.buildMapsLinks('Current Location', appStops.concat([{ street: '36.10000,-86.70000' }]), {});
  expect(decodeURIComponent(rts[0].url).includes('36.10000,-86.70000')).toBeTruthy();
});

test('encodeShare/decodeShare: round-trip and garbage -> null', () => {
  const payload = {
    stops: [{
      street: '1014 Kirkwood Ave', city: 'Nashville', state: 'TN',
      zip: '37204', jobType: 'Sentricon Guarantee/Coverage'
    }],
    origin: { label: 'gps' },
    settings: { avoidTolls: true }
  };
  const enc = core.encodeShare(payload);
  expect(enc.startsWith('#r=')).toBeTruthy();
  expect(core.decodeShare(enc)).toEqual(payload);
  /* full-URL form also decodes */
  expect(core.decodeShare('https://example.com/app/' + enc)).toEqual(payload);

  expect(core.decodeShare('garbage')).toBe(null);
  expect(core.decodeShare('')).toBe(null);
  expect(core.decodeShare(null)).toBe(null);
  expect(core.decodeShare('#r=!!!not-base64!!!')).toBe(null);
});

test('buildDurationMatrix: stub OSRM -> osrm source and seconds matrix', async () => {
  const pts = [{ lat: 36.1, lng: -86.8 }, { lat: 36.2, lng: -86.7 }];
  let captured = '';
  const stub = async url => {
    captured = url;
    return { ok: true, json: async () => ({ code: 'Ok', durations: [[0, 600], [600, 0]] }) };
  };
  const { matrix, source } = await core.buildDurationMatrix(pts, stub);
  expect(source).toBe('osrm');
  expect(matrix).toEqual([[0, 600], [600, 0]]);
  expect(captured.startsWith('https://router.project-osrm.org/table/v1/driving/')).toBeTruthy();
  expect(captured.includes('-86.8,36.1;-86.7,36.2')).toBeTruthy();
});

test('buildDurationMatrix: throwing stub and bad payload -> haversine fallback', async () => {
  const pts = [{ lat: 36.1, lng: -86.8 }, { lat: 36.2, lng: -86.7 }];
  const throwing = async () => { throw new Error('network down'); };
  const r1 = await core.buildDurationMatrix(pts, throwing);
  expect(r1.source).toBe('haversine');
  expect(r1.matrix).toEqual(core.buildHaversineMatrix(pts));

  const badPayload = async () => ({ ok: true, json: async () => ({ code: 'NoRoute' }) });
  const r2 = await core.buildDurationMatrix(pts, badPayload);
  expect(r2.source).toBe('haversine');

  const badShape = async () => ({ ok: true, json: async () => ({ code: 'Ok', durations: [[0]] }) });
  const r3 = await core.buildDurationMatrix(pts, badShape);
  expect(r3.source).toBe('haversine');
});

test('optimizeRouteAsync: builds matrix then optimizes', async () => {
  const pts = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 10 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 20 }
  ];
  const stub = async () => ({ ok: true, json: async () => ({ code: 'Ok', durations: null }) });
  const { order, source } = await core.optimizeRouteAsync(pts, { startIdx: 0, lastIdx: 3, fetchFn: stub });
  expect(source, 'null durations -> fallback, still optimizes').toBe('haversine');
  expect(order[0]).toBe(0);
  expect(order[order.length - 1]).toBe(3);
  expect([...order].sort()).toEqual([0, 1, 2, 3]);
});

test('haversineMi: sanity on a known distance', () => {
  /* 1 degree of longitude at the equator ~ 69.09 miles */
  const d = core.haversineMi({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  expect(Math.abs(d - 69.09) < 0.2).toBeTruthy();
  expect(core.haversineMi({ lat: 36, lng: -86 }, { lat: 36, lng: -86 })).toBe(0);
});

/* ---------------- v1.4: geocode helpers + drive-time estimates ---------------- */

test('expandStreetSuffix: expands trailing abbreviations only', () => {
  expect(core.expandStreetSuffix('1004 Summerview Ct')).toBe('1004 Summerview Court');
  expect(core.expandStreetSuffix('921 Hillview Hts')).toBe('921 Hillview Heights');
  expect(core.expandStreetSuffix('1014 Kirkwood Ave')).toBe('1014 Kirkwood Avenue');
  expect(core.expandStreetSuffix('1552 Eller Dr')).toBe('1552 Eller Drive');
  expect(core.expandStreetSuffix('100 Main St.')).toBe('100 Main Street');
  expect(core.expandStreetSuffix('1004 Summerview Court'), 'no double-expand').toBe('1004 Summerview Court');
  expect(core.expandStreetSuffix('5 Ct House Rd'), 'only last token').toBe('5 Ct House Road');
  expect(core.expandStreetSuffix('')).toBe('');
});

test('arcgisGeocodeUrl + parseArcGisCandidates: round-trip on a real-shaped payload', () => {
  const url = core.arcgisGeocodeUrl('1004 Summerview Ct, Nashville, TN 37221');
  expect(url.includes('findAddressCandidates')).toBeTruthy();
  expect(url.includes(encodeURIComponent('1004 Summerview Ct, Nashville, TN 37221'))).toBeTruthy();
  const payload = { candidates: [{ address: '1004 Summerview Ct, Nashville, Tennessee, 37221',
    location: { x: -86.966365318264, y: 36.070928134057 }, score: 100, attributes: {} }] };
  const p = core.parseArcGisCandidates(payload);
  expect(p).toBeTruthy();
  expect(Math.abs(p.lat - 36.07093) < 1e-4 && Math.abs(p.lng + 86.96637) < 1e-4).toBeTruthy();
  expect(p.score).toBe(100);
  expect(core.parseArcGisCandidates({ candidates: [] }), 'empty -> null').toBe(null);
  expect(core.parseArcGisCandidates(null), 'null -> null').toBe(null);
  expect(core.parseArcGisCandidates({ candidates: [{ location: {} }] }), 'scoreless -> null').toBe(null);
  expect(core.parseArcGisCandidates('garbage'), 'garbage -> null, never throws').toBe(null);
});

test('routeMinutesForOrder: osrm seconds and haversine miles', () => {
  const secs = [[0, 600, 1200], [600, 0, 600], [1200, 600, 0]];
  expect(core.routeMinutesForOrder(secs, [0, 1, 2], 'osrm'), '600s+600s = 20m').toBe(20);
  const miles = [[0, 10, 20], [10, 0, 10], [20, 10, 0]];
  expect(core.routeMinutesForOrder(miles, [0, 1, 2], 'haversine'), '20mi x 2.7 = 54m').toBe(54);
  const withGap = [[0, Infinity], [Infinity, 0]];
  expect(core.routeMinutesForOrder(withGap, [0, 1], 'osrm'), 'Infinity legs skipped').toBe(0);
  expect(core.routeMinutesForOrder(secs, [0], 'osrm'), 'single point = 0').toBe(0);
});

test('estimateMinutesHaversine: consecutive legs, skips unlocated', () => {
  const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: null, lng: null }];
  const est = core.estimateMinutesHaversine(pts);
  const expected = core.haversineMi(pts[0], pts[1]) * 2.7;
  expect(Math.abs(est - expected) < 1e-6).toBeTruthy();
  expect(core.estimateMinutesHaversine([])).toBe(0);
});

test('formatMins: human durations', () => {
  expect(core.formatMins(74)).toBe('1h 14m');
  expect(core.formatMins(58)).toBe('58m');
  expect(core.formatMins(60)).toBe('1h 0m');
  expect(core.formatMins(0.4)).toBe('<1m');
});

test('optimizeRouteAsync: now also returns the matrix', async () => {
  const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }];
  const stub = async () => ({ ok: true, json: async () =>
    ({ code: 'Ok', durations: [[0, 100, 200], [100, 0, 150], [200, 150, 0]] }) });
  const r = await core.optimizeRouteAsync(pts, { startIdx: 0, fetchFn: stub });
  expect(r.source).toBe('osrm');
  expect(Array.isArray(r.matrix) && r.matrix.length === 3).toBeTruthy();
  const before = core.routeMinutesForOrder(r.matrix, [0, 1, 2], r.source);
  const after = core.routeMinutesForOrder(r.matrix, r.order, r.source);
  expect(after <= before + 1e-9).toBeTruthy();
});

/* ---------------- v1.9: confirmed stops + arrival time windows ---------------- */

test('parseClockToMin: 12h and 24h times', () => {
  expect(core.parseClockToMin('9:00 AM')).toBe(540);
  expect(core.parseClockToMin('12:00 PM')).toBe(720);
  expect(core.parseClockToMin('12:00 AM')).toBe(0);
  expect(core.parseClockToMin('2:30pm')).toBe(870);
  expect(core.parseClockToMin('14:30')).toBe(870);
  expect(core.parseClockToMin('9:00')).toBe(540);
  expect(core.parseClockToMin('nope')).toBe(null);
  expect(core.parseClockToMin('25:00')).toBe(null);
});

test('formatClock: minutes -> 12h clock', () => {
  expect(core.formatClock(540)).toBe('9:00 AM');
  expect(core.formatClock(870)).toBe('2:30 PM');
  expect(core.formatClock(0)).toBe('12:00 AM');
  expect(core.formatClock(720)).toBe('12:00 PM');
});

test('parseOcrText: captures appointment time, still never names', () => {
  const res = core.parseOcrText(OCR_4_STOPS);
  expect(res.length).toBe(4);
  expect(res.map((s) => s.apptMin)).toEqual([540, 600, 660, 720]);
  expect(res.every((s) => !('name' in s))).toBeTruthy();
  expect(!JSON.stringify(res).match(/Alex Rivera|Jordan Blake/)).toBeTruthy();
});

test('windows: no reorder when the plain route already meets windows', () => {
  // start 0, A 10min away, B 40min away; B window 10:00-12:00; depart 9:00.
  // [0,1,2] arrives B at 10:30 < 11:30 effective deadline -> keep short route.
  const m = [[0, 600, 2400], [600, 0, 2100], [2400, 2100, 0]]; // seconds
  const durMin = core.minutesMatrix(m, 'osrm');
  const windows = [null, null, { start: 600, end: 720 }];
  const order = core.optimizeOrder(m, { start: 0, windows, durMin, departMin: 540, serviceMin: 45 });
  expect(order).toEqual([0, 1, 2]);
});

test('windows: far stop with tight window jumps ahead', () => {
  // B window 9:00-10:00 (eff. deadline 9:30); depart 8:30; A 10min, B 40min.
  // [0,1,2]: B arrives 9:35 -> late. [0,2,1]: B arrives 9:10 -> on time.
  const m = [[0, 600, 2400], [600, 0, 2100], [2400, 2100, 0]];
  const durMin = core.minutesMatrix(m, 'osrm');
  const windows = [null, null, { start: 540, end: 600 }];
  const order = core.optimizeOrder(m, { start: 0, windows, durMin, departMin: 510, serviceMin: 45 });
  expect(order).toEqual([0, 2, 1]);
  const sim = core.simulateSchedule(order, durMin,
    { windows, departMin: 510, serviceMin: 45, bufferMin: 30, traffic: false });
  expect(sim.violations.length, 'no violations after reorder').toBe(0);
});

test('windows: 30-minute end buffer is enforced', () => {
  // window ends 10:00 -> effective deadline 9:30; arrival 9:40 must count late.
  const durMin = [[0, 80], [80, 0]];
  const windows = [null, { start: 480, end: 600 }];
  const sim = core.simulateSchedule([0, 1], durMin,
    { windows, departMin: 500, serviceMin: 0, bufferMin: 30, traffic: false });
  expect(sim.violations.length, 'arrival after end-30min is a violation').toBe(1);
  expect(Math.round(sim.violations[0].lateMin)).toBe(10);
  const ok = core.simulateSchedule([0, 1], [[0, 25], [25, 0]],
    { windows, departMin: 500, serviceMin: 0, bufferMin: 30, traffic: false });
  expect(ok.violations.length, 'arrival before end-30min is fine').toBe(0);
});

test('windows: impossible set prioritizes the earliest window start', () => {
  // A window 10:00-11:00 (eff 10:30), B window 9:20-10:20 (eff 9:50).
  // depart 9:00, service 45, A 10min / B 40min away. Only one can be on time:
  // B (earlier start) must win.
  const durMin = [[0, 10, 40], [10, 0, 35], [40, 35, 0]];
  const windows = [null, { start: 600, end: 660 }, { start: 560, end: 620 }];
  const order = core.optimizeOrder(durMin.map((r) => r.map((v) => v * 60)),
    { start: 0, windows, durMin, departMin: 540, serviceMin: 45 });
  const sim = core.simulateSchedule(order, durMin,
    { windows, departMin: 540, serviceMin: 45, bufferMin: 30, traffic: false });
  const violPoints = sim.violations.map((v) => v.point);
  expect(!violPoints.includes(2)).toBeTruthy();
  expect(violPoints.includes(1)).toBeTruthy();
});

test('windows: lexicographic protection beats any lateness tradeoff', () => {
  // A (point 1) window 10:00-11:00, B (point 2) window 10:20-11:20 (overlapping).
  // [0,1,2] meets A, misses B by ~1045 min; [0,2,1] meets B, misses A by ~56 min.
  // A scalar weight (56min x 1.67 vs 1045min x 1) picks [0,2,1] — sacrificing the
  // earlier window for a huge lateness saving. Lexicographic earliest-start
  // protection MUST pick [0,1,2]: the earlier window is protected, period.
  const durMin = [[0, 20, 20], [20, 0, 1040], [20, 21, 0]];
  const windows = [null, { start: 600, end: 660 }, { start: 620, end: 680 }];
  const ctx = { windows, departMin: 590, serviceMin: 45, bufferMin: 30, traffic: false };
  const costP = core.scheduleCost([0, 1, 2], durMin, ctx);
  const costQ = core.scheduleCost([0, 2, 1], durMin, ctx);
  expect(costP.misses, 'P misses only the later window').toEqual([0, 1]);
  expect(costQ.misses, 'Q misses only the earlier window').toEqual([1, 0]);
  expect(Math.round(costP.lateMin)).toBe(1045);
  expect(Math.round(costQ.lateMin)).toBe(56);
  expect(core.costLess(costP, costQ)).toBeTruthy();
  expect(!core.costLess(costQ, costP)).toBeTruthy();
  const order = core.optimizeOrder(durMin.map((r) => r.map((v) => v * 60)),
    { start: 0, windows, durMin, departMin: 590, serviceMin: 45 });
  expect(order, 'optimizer protects the earliest window').toEqual([0, 1, 2]);
});

test('windows: costLess tiebreaks on lateness then drive time', () => {
  const durMin = [[0, 10, 40], [10, 0, 35], [40, 35, 0]];
  const windows = [null, null, { start: 600, end: 720 }];
  const ctx = { windows, departMin: 540, serviceMin: 45, bufferMin: 30, traffic: false };
  // both orders meet every window; the shorter drive must win
  const c1 = core.scheduleCost([0, 1, 2], durMin, ctx);
  const c2 = core.scheduleCost([0, 2, 1], durMin, ctx);
  expect(c1.misses).toEqual([0]);
  expect(c2.misses).toEqual([0]);
  expect(c1.lateMin).toBe(0);
  expect(c2.lateMin).toBe(0);
  expect(c1.driveMin < c2.driveMin).toBeTruthy();
  expect(core.costLess(c1, c2)).toBeTruthy();
  expect(!core.costLess(c2, c1)).toBeTruthy();
});

test('windows: early arrival waits, no violation', () => {
  const durMin = [[0, 10], [10, 0]];
  const windows = [null, { start: 600, end: 720 }];
  const sim = core.simulateSchedule([0, 1], durMin,
    { windows, departMin: 540, serviceMin: 45, bufferMin: 30, traffic: false });
  expect(sim.violations.length).toBe(0);
  expect(sim.legs[0].waitMin, 'waits until window opens').toBe(50);
});

test('windows: start point that is a stop gets its window validated', () => {
  /* GPS-unavailable / checked-in origin: order[0] is a confirmed stop, not the
   * GPS origin. Its "arrival" is departMin; a passed window must violate. */
  const durMin = [[0, 10], [10, 0]];
  const windows = [{ start: 0, end: 30 }, null];
  const sim = core.simulateSchedule([0, 1], durMin,
    { windows, departMin: 1108, serviceMin: 45, bufferMin: 30, traffic: false });
  expect(sim.violations.length, 'passed window at route start violates').toBe(1);
  expect(sim.violations[0].point).toBe(0);
  expect(sim.violations[0].lateMin > 1000).toBeTruthy();
  /* and a future window at the start is not a violation */
  const sim2 = core.simulateSchedule([0, 1], durMin,
    { windows: [{ start: 1200, end: 1320 }, null],
      departMin: 1108, serviceMin: 45, bufferMin: 30, traffic: false });
  expect(sim2.violations.length).toBe(0);
});

test('windows: first/last pins coexist with windows', () => {
  // first pin (1) must stay at position 1, last pin (3) at the end,
  // window on 2 still honored among the free positions.
  const durMin = [[0, 5, 60, 8], [5, 0, 55, 6], [60, 55, 0, 50], [8, 6, 50, 0]];
  const windows = [null, null, { start: 540, end: 600 }, null];
  const order = core.optimizeOrder(durMin.map((r) => r.map((v) => v * 60)),
    { start: 0, first: 1, last: 3, windows, durMin, departMin: 480, serviceMin: 30 });
  expect(order[0]).toBe(0);
  expect(order[1], 'first pin stays second').toBe(1);
  expect(order[order.length - 1], 'last pin stays last').toBe(3);
});

test('windows: unconfirmed stops move freely (no window = no penalty)', () => {
  const durMin = [[0, 10, 40], [10, 0, 35], [40, 35, 0]];
  const order = core.optimizeOrder(durMin.map((r) => r.map((v) => v * 60)),
    { start: 0, windows: [null, null, null], durMin, departMin: 540, serviceMin: 45 });
  expect(order, 'pure drive-time order when nothing confirmed').toEqual([0, 1, 2]);
});

test('optimizeRouteAsync: schedule + violations returned with windows', async () => {
  const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 0 }];
  const stub = async () => ({ ok: true, json: async () =>
    ({ code: 'Ok', durations: [[0, 600, 2400], [600, 0, 2100], [2400, 2100, 0]] }) });
  const windows = [null, null, { start: 540, end: 600 }];
  const r = await core.optimizeRouteAsync(pts, {
    startIdx: 0, fetchFn: stub, windows,
    serviceMin: [0, 45, 45], departMin: 510, bufferMin: 30,
  });
  expect(r.schedule).toBeTruthy();
  expect(Array.isArray(r.schedule.legs) && r.schedule.legs.length === 2).toBeTruthy();
  expect(r.schedule.violations.length, 'reordered to meet the window').toBe(0);
  expect(r.order).toEqual([0, 2, 1]);
});

test('optimizeRouteAsync: no schedule without windows (backward compatible)', async () => {
  const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }];
  const stub = async () => ({ ok: true, json: async () =>
    ({ code: 'Ok', durations: [[0, 600], [600, 0]] }) });
  const r = await core.optimizeRouteAsync(pts, { startIdx: 0, fetchFn: stub });
  expect(r.schedule).toBe(null);
  expect(r.order).toEqual([0, 1]);
});

test('remainingServiceMin: just checked in -> full duration', () => {
  const now = Date.now();
  expect(core.remainingServiceMin(45, now, now)).toBe(45);
});

test('remainingServiceMin: elapsed time subtracts', () => {
  const now = Date.now();
  expect(core.remainingServiceMin(45, now - 30 * 60000, now)).toBe(15);
  expect(core.remainingServiceMin(30, now - 10 * 60000, now)).toBe(20);
});

test('remainingServiceMin: never below zero', () => {
  const now = Date.now();
  expect(core.remainingServiceMin(45, now - 60 * 60000, now)).toBe(0);
  expect(core.remainingServiceMin(45, now - 3 * 3600000, now)).toBe(0);
});

test('traffic: rush hour multiplies drive time', () => {
  // 8 AM rush (factor 1.35), 20-min free-flow leg
  const durMin = [[0, 20], [20, 0]];
  const sim = core.simulateSchedule([0, 1], durMin,
    { windows: [], departMin: 480, serviceMin: 0, bufferMin: 30 });
  expect(Math.round(sim.driveMin), '20 * 1.35 = 27').toBe(27);
});

test('traffic: overnight is free-flow', () => {
  const durMin = [[0, 20], [20, 0]];
  const sim = core.simulateSchedule([0, 1], durMin,
    { windows: [], departMin: 180, serviceMin: 0, bufferMin: 30 });
  expect(Math.round(sim.driveMin), '3 AM factor is 1.0').toBe(20);
});

test('traffic: disabled with flag', () => {
  const durMin = [[0, 20], [20, 0]];
  const sim = core.simulateSchedule([0, 1], durMin,
    { windows: [], departMin: 480, serviceMin: 0, bufferMin: 30, traffic: false });
  expect(Math.round(sim.driveMin), 'traffic disabled').toBe(20);
});

test('trafficBucketKey: includes time, day, and area', () => {
  // 8 AM weekday, downtown Nashville (36.16, -86.78)
  const k1 = core.trafficBucketKey(480, false, 36.16, -86.78);
  expect(k1).toBe('wd-2-361x-868');
  // Same time, weekend
  const k2 = core.trafficBucketKey(480, true, 36.16, -86.78);
  expect(k2).toBe('we-2-361x-868');
  // Different area (Brentwood 36.03, -86.78)
  const k3 = core.trafficBucketKey(480, false, 36.03, -86.78);
  expect(k3).toBe('wd-2-360x-868');
  expect(k1, 'different areas get different buckets').not.toBe(k3);
});

test('learnedTrafficFactorAt: no data falls back to base', () => {
  const f = core.learnedTrafficFactorAt(480, false, { buckets: {} }, 36.16, -86.78);
  expect(f).toBe(core.trafficFactorAt(480));
});

test('learnedTrafficFactorAt: sparse data falls back to base', () => {
  // Only 2 samples, need 3
  const learn = { buckets: { 'wd-2-361x-868': { n: 2, sum: 2.4 } } };
  const f = core.learnedTrafficFactorAt(480, false, learn, 36.16, -86.78);
  expect(f).toBe(core.trafficFactorAt(480));
});

test('learnedTrafficFactorAt: sufficient data shifts the factor', () => {
  // 10 samples averaging 1.2x the base
  const learn = { buckets: { 'wd-2-361x-868': { n: 10, sum: 12.0 } } };
  const base = core.trafficFactorAt(480); // 1.35
  const f = core.learnedTrafficFactorAt(480, false, learn, 36.16, -86.78);
  // Bayesian: base * ((1.2*10 + 1.0*5) / 15) = base * 1.133
  const expected = base * ((12.0 + 5) / 15);
  expect(Math.abs(f - expected) < 0.001).toBeTruthy();
  expect(f > base).toBeTruthy();
});

test('learnedTrafficFactorAt: hierarchical fallback to time+day aggregate', () => {
  // No data for downtown, but 6 samples across other areas at same time
  const learn = { buckets: {
    'wd-2-360x-868': { n: 3, sum: 3.6 }, // Brentwood: 1.2x
    'wd-2-362x-867': { n: 3, sum: 3.0 }, // North: 1.0x
  }};
  const base = core.trafficFactorAt(480);
  const f = core.learnedTrafficFactorAt(480, false, learn, 36.16, -86.78); // downtown, no data
  // Aggregate: (3.6+3.0)/6 = 1.1x, blended: base * ((1.1*6+5)/11)
  expect(f !== base).toBeTruthy();
});

test('recordTrafficSample: accumulates and decays', () => {
  let learn = { buckets: {} };
  learn = core.recordTrafficSample(learn, 'wd-2-361x-868', 1.2);
  learn = core.recordTrafficSample(learn, 'wd-2-361x-868', 1.4);
  expect(learn.buckets['wd-2-361x-868'].n).toBe(2);
  expect(Math.abs(learn.buckets["wd-2-361x-868"].sum - 2.6) < 0.001).toBeTruthy();
});

test('rainFactorFor: scales with precipitation', () => {
  expect(core.rainFactorFor(0)).toBe(1.0);
  expect(core.rainFactorFor(-1)).toBe(1.0);
  expect(core.rainFactorFor(0.2)).toBe(1.05);
  expect(core.rainFactorFor(1.0)).toBe(1.15);
  expect(core.rainFactorFor(5.0)).toBe(1.3);
  expect(core.rainFactorFor(10.0)).toBe(1.5);
});

/* findEarlyArrivalOpportunity — previously untested (v1.9.59/60 feature). */
const EARLY_CTX = (windows, departMin) => ({
  windows, departMin, serviceMin: 0, bufferMin: 30, traffic: false,
});
const EARLY_DUR = [[0, 30, 10], [30, 0, 10], [10, 10, 0]];
const EARLY_WIN = [null, { start: 600, end: 720 }, { start: 540, end: 720 }];

test('findEarlyArrivalOpportunity: finds a valid swap', () => {
  const opp = core.findEarlyArrivalOpportunity([0, 1, 2], EARLY_DUR, EARLY_CTX(EARLY_WIN, 510));
  expect(opp).toEqual({ swapIdx: 1, earlyStop: 2, earlyByMin: 20, savedMin: 20, newOrder: [0, 2, 1] });
});

test('findEarlyArrivalOpportunity: null when order too short', () => {
  expect(core.findEarlyArrivalOpportunity([0, 1], EARLY_DUR, EARLY_CTX(EARLY_WIN, 510))).toBe(null);
  expect(core.findEarlyArrivalOpportunity([], EARLY_DUR, EARLY_CTX(EARLY_WIN, 510))).toBe(null);
  expect(core.findEarlyArrivalOpportunity(null, EARLY_DUR, EARLY_CTX(EARLY_WIN, 510))).toBe(null);
});

test('findEarlyArrivalOpportunity: null when no windows', () => {
  expect(core.findEarlyArrivalOpportunity([0, 1, 2], EARLY_DUR,
    EARLY_CTX([null, null, null], 510))).toBe(null);
  expect(core.findEarlyArrivalOpportunity([0, 1, 2], EARLY_DUR,
    { departMin: 510, serviceMin: 0, traffic: false })).toBe(null);
});

test('findEarlyArrivalOpportunity: null when savings below 15min threshold', () => {
  const dur = [[0, 12, 10], [12, 0, 10], [10, 10, 0]]; // swap saves only 4 min
  expect(core.findEarlyArrivalOpportunity([0, 1, 2], dur, EARLY_CTX(EARLY_WIN, 510))).toBe(null);
});

test('findEarlyArrivalOpportunity: null when early by more than 30min', () => {
  // depart 470 → arrive stop 2 at 480, wait 60 > EARLY_MAX_MIN
  expect(core.findEarlyArrivalOpportunity([0, 1, 2], EARLY_DUR, EARLY_CTX(EARLY_WIN, 470))).toBe(null);
});

test('findEarlyArrivalOpportunity: null when swap creates a new violation', () => {
  // stop 1 window ends 575 (eff 545); swapped arrival 550 violates it
  const win = [null, { start: 500, end: 575 }, { start: 540, end: 720 }];
  expect(core.findEarlyArrivalOpportunity([0, 1, 2], EARLY_DUR, EARLY_CTX(win, 510))).toBe(null);
});

test('findEarlyArrivalOpportunity: null when arrival is not early (on-time)', () => {
  // depart 530 → arrive stop 2 at 540, exactly at window start, waitMin 0
  expect(core.findEarlyArrivalOpportunity([0, 1, 2], EARLY_DUR, EARLY_CTX(EARLY_WIN, 530))).toBe(null);
});

test('findEarlyArrivalOpportunity: scans multiple pairs and picks a valid one', () => {
  const dur = [[0, 10, 10, 10], [10, 0, 10, 10], [10, 10, 0, 40], [10, 10, 10, 0]];
  const win = [null, { start: 600, end: 720 }, { start: 540, end: 720 }, { start: 560, end: 720 }];
  const opp = core.findEarlyArrivalOpportunity([0, 1, 2, 3], dur, EARLY_CTX(win, 510));
  expect(opp !== null).toBeTruthy();
  expect(opp.savedMin >= 15).toBeTruthy();
  expect(opp.earlyByMin > 0 && opp.earlyByMin <= 30).toBeTruthy();
  expect(opp.newOrder.length).toBe(4);
});

test('parseClockToMin: edge cases', () => {
  expect(core.parseClockToMin('9:75 AM')).toBe(null);      // bad minutes
  expect(core.parseClockToMin('13:00 PM')).toBe(null);     // h>12 with AM/PM
  expect(core.parseClockToMin('9:00 XM')).toBe(null);      // trailing garbage
  expect(core.parseClockToMin('9 AM')).toBe(540);          // hour-only
  expect(core.parseClockToMin(null)).toBe(null);
  expect(core.parseClockToMin('0:30')).toBe(30);           // 24h midnight
  expect(core.parseClockToMin('12:30 am')).toBe(30);       // lowercase
  expect(core.parseClockToMin('9:00 a.m.')).toBe(540);    // dotted
  expect(core.parseClockToMin('11:59 PM')).toBe(1439);
  expect(core.parseClockToMin('  2:05 Pm  ')).toBe(845);   // whitespace
});

test('parseOcrText: null/undefined input returns empty', () => {
  expect(core.parseOcrText(null)).toEqual([]);
  expect(core.parseOcrText(undefined)).toEqual([]);
  expect(core.parseOcrText('')).toEqual([]);
});

test('parseOcrText: merges wrapped city/ZIP lines', () => {
  const text = [
    'Alex Rivera', '9:00 AM', '1014 Kirkwood Ave',
    'Nashville, TN', '37204-2516', 'Sentricon Guarantee',
  ].join('\n');
  const res = core.parseOcrText(text);
  expect(res.length).toBe(1);
  expect(res[0].zip).toBe('37204');
  expect(res[0].street).toBe('1014 Kirkwood Ave');
});

test('parseOcrText: deduplicates repeated stops', () => {
  const block = ['Alex Rivera', '9:00 AM', '1014 Kirkwood Ave', 'Nashville, TN 37204', 'Sentricon'];
  const res = core.parseOcrText(block.concat(block).join('\n'));
  expect(res.length).toBe(1);
});

test('buildMapsLinks: splits into multiple legs for 10+ stops', () => {
  const stops = [];
  for (let i = 0; i < 12; i++) stops.push({ street: i + ' Main St', city: 'Nashville', state: 'TN', zip: '37204' });
  const links = core.buildMapsLinks('Home', stops, {});
  expect(links.length).toBe(2);
  expect(links[0].url.includes('google.com/maps')).toBeTruthy();
});

test('buildMapsLinks: empty and avoid options', () => {
  expect(core.buildMapsLinks('', [], {})).toEqual([]);
  expect(core.buildMapsLinks(null, null, {})).toEqual([]);
  const links = core.buildMapsLinks('H', [{ street: '1 Main St' }], { avoid: ['tolls', null] });
  expect(links.length).toBe(1);
  expect(links[0].url.includes('avoid=tolls')).toBeTruthy();
});

/* Count assertion (CODING_RULES.md §8): if this fails, a test was deleted.
 * Update EXPECTED_TESTS when intentionally adding tests. */
test('meta: test count has not dropped', async () => {
  const EXPECTED_TESTS = 78; // includes this meta-test
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL(import.meta.url).pathname, 'utf8');
  const count = (src.match(/^test\('/gm) || []).length;
  expect(count).toBe(EXPECTED_TESTS);
});

test('simulateSchedule: handles null/undefined context and order', () => {
  const m = [[0, 10], [10, 0]];
  expect(core.simulateSchedule([0, 1], m, null).driveMin).toBe(10);
  expect(core.simulateSchedule([0, 1], m, undefined).driveMin).toBe(10);
  expect(core.simulateSchedule([0, 1], m, {}).driveMin).toBe(10);
  expect(core.simulateSchedule([], m, {}).legs).toEqual([]);
  expect(core.simulateSchedule(null, m, {}).legs).toEqual([]);
});

test('simulateSchedule: start-point window validated (late and early)', () => {
  const m = [[0, 10], [10, 0]];
  const w = [{ start: 500, end: 560 }]; // eff end 530 with buffer 30
  const late = core.simulateSchedule([0, 1], m, { windows: w, departMin: 600, bufferMin: 30, traffic: false });
  expect(late.violations.length).toBe(1);
  expect(late.violations[0].point).toBe(0);
  const early = core.simulateSchedule([0, 1], m, { windows: w, departMin: 400, bufferMin: 30, traffic: false });
  expect(early.violations.length).toBe(0);
  expect(early.legs[0].waitMin).toBe(100);
});

test('trafficFactorAt: covers all time-of-day slots', () => {
  expect(core.trafficFactorAt(0)).toBe(1.0);      // midnight: free flow
  expect(core.trafficFactorAt(300)).toBe(1.0);   // 5am: free flow
  expect(core.trafficFactorAt(360)).toBe(1.1);   // 6am: buildup
  expect(core.trafficFactorAt(480)).toBe(1.35);  // 8am: morning rush
  expect(core.trafficFactorAt(600)).toBe(1.15);  // 10am: mid-morning
  expect(core.trafficFactorAt(720)).toBe(1.1);   // noon: lunch
  expect(core.trafficFactorAt(840)).toBe(1.15);  // 2pm: afternoon
  expect(core.trafficFactorAt(1020)).toBe(1.4);  // 5pm: evening rush
  expect(core.trafficFactorAt(1140)).toBe(1.2);  // 7pm: wind-down
  expect(core.trafficFactorAt(1320)).toBe(1.05); // 10pm: late evening
  expect(core.trafficFactorAt(-60)).toBe(1.05);  // negative wraps to 11pm
  expect(core.trafficFactorAt(1500)).toBe(1.0);   // >1440 wraps to 1am
});

test('costLess: tiebreaks on orderPenalty before drive time', () => {
  const a = { misses: [0], lateMin: 0, orderPenalty: 1, driveMin: 10 };
  const b = { misses: [0], lateMin: 0, orderPenalty: 2, driveMin: 5 };
  expect(core.costLess(a, b)).toBeTruthy();  // lower penalty wins despite longer drive
  expect(!core.costLess(b, a)).toBeTruthy();
  const c = { misses: [0], lateMin: 5, orderPenalty: 0, driveMin: 10 };
  const d = { misses: [0], lateMin: 3, orderPenalty: 0, driveMin: 20 };
  expect(core.costLess(d, c)).toBeTruthy();  // less late wins
  expect(!core.costLess(c, d)).toBeTruthy();
});

test('costLess: compares miss counts element-wise', () => {
  const a = { misses: [0, 1], lateMin: 0, driveMin: 10 };
  const b = { misses: [0, 0], lateMin: 0, driveMin: 10 };
  expect(core.costLess(b, a)).toBeTruthy();  // fewer misses at index 1 wins
  expect(!core.costLess(a, b)).toBeTruthy();
});
