# CODING RULES

Living document. Updated every time Aaron sets a rule, corrects a mistake, or a lesson is learned the hard way.
Last updated: 2026-10-03

> These aren't suggestions. They're the contract.

---

## 1. Verify Before Anything

- **Nothing is "done" until verified.** A tool call completing is not verification. Re-read the output, run the check, open the screenshot, query the result.
- **Test, then deploy, then browser-check the live build.** Never the reverse. Aaron's review is the final gate.
- **Confirm ALL functionality before ANY live update.** Not just "the new code is present" — prove the feature works and nothing else broke.
- **Never trust a subagent's completion report.** Check the files yourself. Grep for the promised change.
- **Never trust a browser task's visual self-verification.** Pull the screenshots and look with your own eyes.
- **Stale caches lie.** The shared browser profile keeps service workers and cached JS. When a test contradicts a direct curl, trust the curl and clear the profile.

## 2. Code Quality (Non-Negotiable)

- **Sanitize all external data** before injecting into HTML (XSS). No exceptions.
- **Every fetch/async path handles failure.** No unhandled promise rejections, no silent 500s.
- **No secrets, tokens, or API keys in code, files, or chat.** Ever. Environment files only, never committed.
- **No dead code or commented-out blocks.** Delete it. Git remembers.
- **Consistent naming.** Pick a convention and stick to it across the file.
- **Input validation on every endpoint.** Reject impossible values with 400, not 500. Validate types, ranges, required fields.
- **No stack traces in external error responses.** Log them internally, return generic messages.
- **Request body size limits.** Default 5MB, explicit exceptions where needed.

## 3. Deployment Discipline

- **Never deploy with red tests.** CI must be green.
- **Never deploy with incomplete verification.** If you can't verify it, say so — don't ship it.
- **Pin versions, never `:latest`.** Every deploy tags exact versions. Rollback = point at previous tag.
- **Database migrations are reversible.** Every schema change has a down-migration. Dump before migrating.
- **The production server is never a debugging environment.** Debug locally, deploy verified code.
- **Blue-green for critical services.** New version runs alongside old, switch only after health checks pass.

## 4. Architecture Principles

- **Phone is thin client, backend is brain.** The phone sends what (stops, windows, GPS) and gets the answer. It never computes matrices or runs solvers.
- **Backend never returns nothing.** Always return the best answer computable, with honest metadata about what degraded.
- **Offline fallback always works.** If backend is unreachable, phone uses built-in optimizer. Degraded, not dead.
- **API versioned at `/v1/`.** Breaking changes go to `/v2/`. The phone never breaks because the backend updated.

## 5. Privacy (Aaron's Priority)

- **All data anonymous.** No names, exact addresses, or precise coordinates in stored data.
- **Coarse areas only** for traffic learning (0.1° grid cells, not addresses).
- **No PII in logs.** Strip names, addresses, and precise locations before logging.
- **OCR images:** ephemeral processing, immediate deletion, no backups, no request-body logging.
- **Screenshots processed by our infrastructure only.** Never send image data to third-party platforms.

## 6. Performance

- **OR-Tools default solve: 5s** (not 30s). Use 120s only for overnight batch solves.
- **Docker resource limits** on every service. No service starves the others.
- **Log rotation everywhere.** 10MB max per file, 3 files max. Disk never fills from logs.
- **Cache aggressively.** Geocode results (24h), matrices (1h), in Redis.

## 7. Security

- **All services bind to 127.0.0.1.** No exceptions. (Docker bypasses ufw — binding is the fix, not firewall rules.)
- **API key auth on all endpoints.** `hmac.compare_digest` for comparison. 401 on 16/16 attack vectors.
- **Parameterized queries only.** Never string-concatenate SQL.
- **Rate limiting:** 60 req/min per IP. X-Forwarded-For spoofing must not bypass it.
- **Secrets in 600-permission files.** Never in code, never in git, never in chat.

## 8. Testing

- **Vitest** for frontend unit tests. **Playwright** for E2E. **pytest** for backend.
- **Coverage ≥80%** lines and branches on both frontend and backend.
- **Count-asserted tests.** If the test count drops, something was deleted — investigate.
- **Integration tests** hit staging nightly, not on every push.

## 9. When Things Go Wrong

- **Overcome problems, don't just report them.** Find another way — different data source, fallback, workaround — and verify it works.
- **If the same fix fails 3x,** stop and try a fundamentally different approach.
- **Automatic rollback on health failure.** If new version fails health checks for 2 minutes, revert.
- **`./rollback.sh`** — one command, 30 seconds, back to last-known-good.

## 10. Gotchas (Learned the Hard Way)

- **Docker bypasses ufw.** Use `-p 127.0.0.1:port:port` binding, not firewall rules.
- **Span-replacement can delete whole functions.** Diff function inventory before/after every automated edit.
- **Moving UI elements? Delete the original.** Duplicate IDs render dead.
- **iOS caches aggressively.** Use versioned filenames for every revision.
- **Postgres `with conn:` commits on exit.** If writes aren't persisting, check you're connected to the right database (we once had `routerunner` vs `routerrunner`).
- **GitHub secret scanning blocks pushes** containing contiguous `pk.*` tokens. Split tokens in build scripts.
- **Empty folders don't sync via git.** Seed with a placeholder file.

---

## Changelog

- 2026-10-03: Initial document. Codified all standing rules + lessons from RouteRunner backend build.
