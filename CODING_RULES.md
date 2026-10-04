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
- **Deduplication claims must be verified against live remote state.** Local inventory can be stale; remote is ground truth.
- **Audit state before repairing state.** Compare SHAs/hashes before assuming damage. A 409 or error might be a transient race, not corruption.
- **Memory writes get verified.** After saving, re-read the entry. A wrong memory corrupts future work.

## 2. Code Quality (Non-Negotiable)

- **Sanitize all external data** before injecting into HTML (XSS). No exceptions.
- **Every fetch/async path handles failure.** No unhandled promise rejections, no silent 500s.
- **No secrets, tokens, or API keys in code, files, or chat.** Ever. Environment files only, never committed.
- **No dead code or commented-out blocks.** Delete it. Git remembers.
- **Consistent naming.** Pick a convention and stick to it across the file.
- **Input validation on every endpoint.** Reject impossible values with 400, not 500. Validate types, ranges, required fields. Reject non-finite floats (NaN, Infinity).
- **No stack traces in external error responses.** Log them internally, return generic messages.
- **Request body size limits.** Default 5MB, explicit exceptions where needed.
- **Build tools, fix root causes.** When the same error repeats, stop retrying and fix the cause. If you do the same check three times, automate it.
- **Research before first use.** New tool, API, or service: read the docs, understand capabilities and limits, know the gotchas — before writing code against it.
- **Service startup must not fatally depend on dependencies.** If the DB is down at boot, log a warning and continue — don't crash. Retry on first request.

## 3. Deployment Discipline

- **Interview before any project.** Ask ALL clarifying questions upfront in one batch — requirements, scope, what "done" looks like, constraints. Then write a tech spec, then build. Never start on assumptions.
- **Tech spec for every project.** What it does, exact requirements, data sources, plan, how it will be verified. Think the whole job through before acting.
- **Never deploy with red tests.** CI must be green.
- **Never deploy with incomplete verification.** If you can't verify it, say so — don't ship it.
- **Pin versions, never `:latest`.** Every deploy tags exact versions. Rollback = point at previous tag.
- **Database migrations are reversible.** Every schema change has a down-migration. Dump before migrating.
- **The production server is never a debugging environment.** Debug locally, deploy verified code.
- **Blue-green for critical services.** New version runs alongside old, switch only after health checks pass.
- **Scrutinize and debug before server, verify before deploy.** Nothing touches the server without code review, local debugging, load testing, and security review first.

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

### Docker & Infrastructure
- **Docker bypasses ufw.** Use `-p 127.0.0.1:port:port` binding, not firewall rules.
- **Valhalla image has no entrypoint.** Must pass the command explicitly: `valhalla_service /custom_files/config.json 1`.
- **Use systemd for service persistence.** `nohup` and backgrounded SSH commands die on disconnect. Systemd auto-restarts on failure.
- **Backup scripts must reference correct names.** After any rename, grep all scripts for stale references.
- **5GB+ reclaimable in Docker.** Run `docker builder prune` and remove unused images periodically.

### Code Editing
- **Span-replacement can delete whole functions.** Diff function inventory (`grep -n "^function\|^def\|^class"`) before/after every automated edit.
- **Moving UI elements? Delete the original.** Duplicate IDs render dead.
- **iOS caches aggressively.** Use versioned filenames for every revision.
- **Python `with conn:` commits on exit.** If writes aren't persisting, check you're connected to the right database.

### Python Quirks
- **Banker's rounding:** `round(36.15, 1) == 36.1`, not 36.2. Use `Decimal` when exact rounding matters.
- **httpx picks up proxy env vars.** Use `trust_env=False` for localhost URLs in sandboxed environments.
- **`bool` is a subclass of `int`.** Validate `isinstance(x, bool)` first when distinguishing them.

### GitHub API
- **Secret scanning blocks pushes** containing contiguous `pk.*` tokens. Split tokens in build scripts.
- **Empty folders don't sync via git.** Seed with a placeholder file.
- **Contents API 409 on empty repo.** Seed the initial commit via PUT /contents, then use git-data API.
- **Branch existence check returns 409 (not 404)** on empty repos. Treat both as empty.

### Testing & Pentesting
- **Pentest only against scratch databases.** Never drop/create on the live DB. A sanctioned pentest that destroys data is still destruction.
- **`/health` is intentionally public.** Monitoring needs keyless access. Auth tests should target authenticated endpoints.
- **OR-Tools burns the full time budget** on every solve (GILS never terminates early). Set explicit short defaults (5s), not 30s.

---

## 11. Working with Aaron

- **He dictates the flow.** Never end responses with a follow-up question. Never steer without direct instruction.
- **Honest pushback, not default agreement.** If something is a bad idea, say so with reasons.
- **Concise, decisive, phone-friendly.** Outcome first, no walls of text.
- **Ask all questions upfront, in one batch.** Then spec, then build. Never start unclear and fix through corrections.
- **Hold finished work for his word.** Nothing posts, publishes, or deploys without his explicit go-ahead.
- **When blocked, build the workaround.** Don't report the problem — overcome it and verify the fix.

---

## 12. Multi-Agent Work

- **Use a coordinator with specialist workers and an auditor.** Standard for any significant task.
- **Supervisor = recurring cron, not a long-lived subagent.** Subagents die on runtime restart. A 5-minute cron with a state file checks worker liveness and restarts stalled workers.
- **Bound parallelism by the scarcest resource.** API quotas, memory, disk — check before launching parallel workers.
- **Audit labels must cross-check process liveness.** A task with no live process is STALE, not RUNNING.
- **Verify worker outputs independently.** A completion report is a claim, not evidence.

---

## Changelog

- 2026-10-03: Backfilled with all lessons from RouteRunner frontend, backend build, security audit, and testing setup. Added §§11-12, expanded §§1-3, 10.
