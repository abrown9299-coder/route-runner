# RouteRunner

A self-sufficient, installable iPhone web app that replaces RoadWarrior for pest-control workdays: pull addresses off screenshots of a work-schedule app, dedupe, route-optimize up to 20 stops, hand off to Google Maps, and check stops off through the day.

**Live:** https://abrown9299-coder.github.io/route-runner/
**No AI, no backend, no account, no build step.** All logic runs client-side in vanilla JS.

## How it works

1. **Add appointments** — type an address in the search bar, pick it from the dropdown (saved locations first, then live results), and an appointment dialog opens with the address pre-filled. Set time (or Anytime), pick a job type, hit **Add Appointment**. Or import screenshots of a schedule — OCR extracts addresses and job types (never customer names).
2. **Start defaults to your current GPS location** unless you explicitly set a different start. Clearing the route resets Start back to current location.
3. **Optimize** — tap ⚡ Optimize to order stops by real drive time (OSRM). Pin a first/last stop, drag to reorder manually.
4. **Work the route** — check in to start a service timer, check off stops, get ETAs. Hand off to Google Maps for turn-by-turn.

Work and Personal profiles: work mode adds job types, appointment windows, check-in timers, and notes; personal mode is a clean stop list.

## Project layout

```
app/                 — the app (deployed as-is to GitHub Pages)
  index.html         — UI shell
  styles.css         — mobile-first dark theme, big touch targets
  core.js            — pure algorithms, zero DOM, zero deps (node-testable)
  app.js             — UI wiring, storage, maps links, PWA glue
  ocr.js             — Tesseract.js screenshot pipeline
  sw.js              — service worker (offline shell)
  manifest.json      — PWA manifest + icons
dev/                 — specs, docs, deploy tooling
  SPEC.md            — tech spec (requirements, architecture)
  LOCATION_UX.md     — address/location UX flows
  TESTING.md         — testing architecture
  functional-tracks.md — verification checklist
  deploy.py          — deploy to GitHub Pages via git-data API
  build-obfuscated.py — white-label obfuscated build → build/ (gitignored)
e2e/                 — Playwright end-to-end tests
```

## Development

```bash
npm install          # once
npx vitest run       # unit tests (98)
npx eslint .         # must be clean
npx playwright test  # end-to-end
```

## Deploy

```bash
python3 dev/deploy.py "commit message"
```

Pushes `app/` to the `route-runner` repo's `main` branch via the GitHub API; Pages serves it live. **Verify the live JS after every deploy** — `deploy.py` has skipped `app.js`/`styles.css` before; force-push via the Contents API and `curl` the live file to confirm.

## Docs

- `dev/SPEC.md` — what it does, requirements, architecture
- `dev/LOCATION_UX.md` — address search, dropdowns, GPS behavior
- `dev/TESTING.md` — how verification works
- `CODING_RULES.md` — the living contract: verify everything, no dead code, no secrets, iOS Safari needs ≥16px form controls (no auto-zoom)
