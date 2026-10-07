/* stats-sanitize.js — NAME_RE + sanitizer functions (split from stats.js 2026-10-06) */
/* global MSG_MAX, NAMES, STACK_FRAMES, STACK_MAX: readonly */
'use strict';
/* exported sanitizeMessage, sanitizeStack */


  /* Rule 7 — personal names -> [NAME] (Aaron's decision: NO names in error
   * reports, period). Runs after quoted strings, so "Robert O'Neil" is
   * already [STR]; this catches unquoted bare names like
   * "for customer John Smith". Case-insensitive standalone-word match
   * (\b boundaries); ONE regex built once at module load (alternation of
   * the escaped blocklist, longest-first). The shared instance is only
   * ever used with String.replace, which resets lastIndex, so reuse is
   * safe. EXCLUSIONS (month names + ultra-common words like "will",
   * "mark", "long") are removed at generation time — see
   * route-runner-traffic/scripts/gen_names_blocklist.py. */
  var NAME_RE = new RegExp('\\b(?:' + NAMES.slice().sort(function (a, b) {
    return b.length - a.length;
  }).map(function (n) {
    return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|') + ')\\b', 'gi');
  function reNames() { return NAME_RE; }

  function reUrl() { return /(?:https?|file):\/\/[^\s"'<>]+/gi; }
  function reCoords() { return /-?\d{1,3}\.\d{3,}\s*,?\s*-?\d{1,3}\.\d{3,}/g; }
  /* The separator between label and number may be ':'/'=', or plain
   * whitespace (e.g. debug strings like "lat 36.123456, lng -86.789012"). */
  function reCoordLabeled() { return /(lat|lng|lon|latitude|longitude)\s*[:=]?\s*-?\d+\.\d+/gi; }
  function reAddress() {
    return /\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Pl|Place|Way|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle)\b\.?/gi;
  }
  function rePhone() { return /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g; }
  function reEmail() { return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g; }
  /* Rule 6 matches double- and single-quoted spans independently, so an
   * apostrophe inside double quotes (e.g. "Robert O'Neil") cannot break the
   * match and leak the name. */
  function reQuoted() { return /"[^"]{2,}"|'[^']{2,}'/g; }
  function rePathToken() { return /[^\s"'()[\]]+[\\/][^\s"'()[\]]*/g; }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function basename(p) {
    var s = String(p == null ? '' : p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /* Rules 1–7, in order: URLs -> coords -> addresses -> phones -> emails ->
   * quoted strings -> names. (Rule 8, path reduction, applies to stack
   * lines only.) */
  function sanitizeText(s) {
    var out = String(s == null ? '' : s);
    out = out.replace(reUrl(), '[URL]');
    out = out.replace(reCoords(), '[COORDS]');
    out = out.replace(reCoordLabeled(), '$1=[COORD]');
    out = out.replace(reAddress(), '[ADDRESS]');
    out = out.replace(rePhone(), '[PHONE]');
    out = out.replace(reEmail(), '[EMAIL]');
    out = out.replace(reQuoted(), '[STR]');
    out = out.replace(reNames(), '[NAME]');
    return out;
  }

  function sanitizeMessage(s) {
    return truncate(sanitizeText(s), MSG_MAX);
  }

  function sanitizeStack(s) {
    if (s == null) return '';
    var lines = String(s).split('\n');
    var out = [];
    for (var i = 0; i < lines.length && i < STACK_FRAMES; i++) {
      var line = sanitizeText(lines[i]);
      line = line.replace(rePathToken(), function (m) { return basename(m); });
      out.push(line);
    }
    return truncate(out.join('\n'), STACK_MAX);
  }
