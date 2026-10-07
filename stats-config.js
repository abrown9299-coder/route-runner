/* stats-config.js — build placeholders, LS keys, caps, enums, crumbs (split from stats.js 2026-10-06) */
'use strict';
/* exported INGEST_KEY, GATEWAY, KEY_PLACEHOLDER, GATEWAY_PLACEHOLDER, LS_DEVICE, LS_QUEUE, LS_PROBE_QUEUE, LS_ERRORS, LS_CRUMBS, LS_ERR_WINDOW, LS_DROPPED, QUEUE_CAP, ERR_QUEUE_CAP, BATCH_MAX, ERR_RATE_MAX, ERR_RATE_WINDOW_MS, FLUSH_MS, PROBE_FLUSH_MS, PROBE_BATCH_MAX, MSG_MAX, STACK_MAX, STACK_FRAMES, EVENTS_PATH, ERRORS_PATH, EVENT_TYPES, EVENT_META_KEYS, ENGINES, ERROR_KINDS */

/* RouteRunner stats.js — anonymous usage statistics + automatic error reporting.
 *
 * Privacy (non-negotiable):
 *  - Device identity is a 128-bit RANDOM hex id (crypto.getRandomValues),
 *    generated on first run and stored in localStorage. It is never derived
 *    from hardware, UA, IP, or anything else. Clearing site data rotates it.
 *  - Events carry only closed enums and counts (stop_count, had_windows,
 *    engine). No addresses, coords, names, times-of-day, or payload contents.
 *  - Breadcrumbs are FIXED allowlist names only (Stats.CRUMB_NAMES, frozen).
 *    Unknown names are silently ignored. Names only, never data.
 *  - Error messages/stacks are sanitized client-side (URLs -> coords ->
 *    addresses -> phones -> emails -> quoted strings -> names -> basenames,
 *    then truncated) AND the server re-sanitizes before storage. Nothing
 *    identifying ever leaves the device.
 *  - The ingest key is a low-privilege key stamped at build time by
 *    dev/deploy.py (placeholder rring_d36b7c0bb12a90a32c0aa5b740f40acfc8a1dd852a7e869b — never committed).
 *    Dev builds (APP_VERSION == 'dev' or unstamped) disable stats entirely.
 *
 * Loaded by index.html BEFORE app.js. Exposes a single global: window.Stats.
 * Vanilla JS, zero dependencies. Every public method is wrapped in try/catch —
 * stats must never break the app or throw.
 *
 * iOS AND Android: transport is fetch + keepalive (works on iOS Safari >= 11.1
 * and Android Chrome — no platform-specific paths). The 60 s interval,
 * `online` event, boot flush, and pagehide beacon cover both platforms'
 * background-suspension behavior. No service-worker involvement.
 */

  /* ---------- build-time placeholders (stamped by dev/deploy.py) ---------- */
  var INGEST_KEY = 'rring_d36b7c0bb12a90a32c0aa5b740f40acfc8a1dd852a7e869b'; // -> rring_… (600-perm file on the server, read at deploy time)
  var GATEWAY = 'https://stopflow.io:8443';       // -> e.g. https://40.160.37.237:8443
  // Split literals: these must NEVER contain the contiguous placeholder bytes,
  // or the deploy-time replacement would stamp them too and the enabled-check
  // below could never tell a stamped build from an unstamped one. (Same
  // split-token trick as the Mapbox key in build_site.py.)
  var KEY_PLACEHOLDER = '__STATS_' + 'INGEST_KEY__';
  var GATEWAY_PLACEHOLDER = '__STATS_' + 'GATEWAY__';

  /* ---------- constants ---------- */
  var LS_DEVICE = 'rr.stats.device_id';
  var LS_QUEUE = 'rr.stats.queue';       // pending events (JSON array)
  var LS_PROBE_QUEUE = 'rr.stats.probe_queue'; // pending traffic probes (JSON array, separate flush path)
  var LS_ERRORS = 'rr.stats.errors';     // pending error reports (JSON array)
  var LS_CRUMBS = 'rr.stats.crumbs';     // persisted breadcrumb trail
  var LS_ERR_WINDOW = 'rr.stats.err_window'; // sliding-window timestamps for the 10/hr error cap
  var LS_DROPPED = 'rr.stats.dropped_errors';

  var QUEUE_CAP = 500;      // max queued events (drop oldest on overflow)
  var ERR_QUEUE_CAP = 20;   // max queued error reports (drop oldest on overflow)
  var BATCH_MAX = 50;       // max events per POST
  var ERR_RATE_MAX = 10;    // max error reports per device per hour (client-side)
  var ERR_RATE_WINDOW_MS = 3600 * 1000;
  var FLUSH_MS = 60000;     // periodic flush interval
  var PROBE_FLUSH_MS = 180000; // traffic-probe flush interval (3 min)
  var PROBE_BATCH_MAX = 50;    // max probes per traffic_probes event
  var MSG_MAX = 500, STACK_MAX = 2000, STACK_FRAMES = 12;

  var EVENTS_PATH = '/v1/events';
  var ERRORS_PATH = '/v1/errors';

  /* Breadcrumb allowlist (STATS_SPEC.md §1.6) — FROZEN. Fixed action names only;
   * anything else passed to crumb() is silently ignored. Never free-form. */
  var CRUMB_NAMES = [
    'app_boot',
    'importing_screenshots',
    'ocr_started',
    'ocr_finished',
    'adding_appointment',
    'editing_appointment',
    'adding_stop',
    'editing_stop',
    'deleting_stop',
    'optimizing_route',
    'optimize_finished',
    'starting_navigation',
    'checking_in',
    'opening_settings',
    'changing_setting',
    'saving_location',
    'opening_route_list',
    'selecting_stop',
    'undoing_action',
    'clearing_route',
    'sharing_route',
    'checking_update',
    'predrive_osrm_fallback',  // added 2026-10-05: app.js pre-drive matrix path (was silently ignored)
    'optimize_osrm_fallback',  // added 2026-10-05: app.js optimize path (was silently ignored)
  ];
  Object.freeze(CRUMB_NAMES);
  var CRUMB_SET = {};
  CRUMB_NAMES.forEach(function (n) { CRUMB_SET[n] = true; });

  var EVENT_TYPES = ['app_boot', 'route_optimized', 'stop_completed', 'check_in', 'traffic_probes'];
  var EVENT_META_KEYS = {
    app_boot: [],
    route_optimized: ['stop_count', 'had_windows', 'engine'],
    stop_completed: [],
    check_in: [],
    traffic_probes: ['probes'],
  };
  var ENGINES = ['backend', 'local'];
  var ERROR_KINDS = ['onerror', 'unhandledrejection'];

