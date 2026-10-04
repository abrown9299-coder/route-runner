# RouteRunner Testing Spec v1.0 (2026-10-03)

Adapting React-ecosystem testing standards to RouteRunner (vanilla JS frontend + Python backend).

## Philosophy

Aaron's standing rule: "Verify before delivery, every time." This spec makes that automatic.
Tests run on every push. Nothing merges with red tests. Coverage is tracked, not just pass/fail.

## Frontend (vanilla JS)

### Vitest (replaces node:test)
- **Why:** React ecosystem standard (Vite-native, 10-20x faster than node:test on large suites,
  watch mode, built-in coverage, same assertion style).
- **Migration:** `dev/core.test.js` → `dev/core.test.js` (Vitest-compatible, minimal changes —
  replace `node:test`/`node:assert` imports with `vitest`).
- **Config:** `vitest.config.js` at repo root. Coverage thresholds: 80% lines, 80% branches.
- **Run:** `npm test` (single run), `npm run test:watch` (dev mode).

### Playwright (E2E browser testing)
- **Why:** React ecosystem standard for E2E. Real Chromium, real user flows.
- **Tests** (`e2e/`):
  - App boots with no console errors
  - OCR import flow (upload test screenshot → stops appear)
  - Optimize flow (mock backend or local) → route renders
  - Geolocation permission denied → graceful fallback
- **Run:** `npm run test:e2e`. CI runs on every push.

### ESLint
- Catches bugs before tests run. Config: `eslint.config.js`, recommended rules + no-unused-vars as error.

## Backend (Python)

### pytest
- **Tests** (`tests/` in route-runner-traffic repo):
  - `test_validation.py` — traffic ratio bounds, /leg discard rules, input sanitization
  - `test_locked_stops.py` — position locks hold under adversarial matrices
  - `test_leg_buckets.py` — bucket key computation, Bayesian blending math
  - `test_auth.py` — API key rejection, rate limiting
- **Run:** `pytest` with `--cov` (80% threshold).
- **Integration tests** (`tests/integration/`, marked with `@pytest.mark.integration`):
  Hit the live staging services. Run nightly, not on every push.

## CI (GitHub Actions)

`.github/workflows/test.yml` in both repos:
1. Frontend: `npm ci && npm run lint && npm test -- --coverage && npm run test:e2e`
2. Backend: `pip install -r requirements.txt && pytest --cov`
3. Block merge on failure.

## What This Replaces

- `dev/core.test.js` (node:test) → Vitest (same tests, faster runner)
- `dev/harness-*.js` (manual) → Playwright E2E (automated)
- Ad-hoc backend verification → pytest suite

## Verification

- All existing tests pass under the new runners (no test left behind)
- Coverage report shows ≥80% on both frontend and backend
- CI workflow runs green on a test push
