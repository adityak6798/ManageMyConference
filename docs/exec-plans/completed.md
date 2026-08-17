# Completed execution plans

Status: canonical | Owner: delivery | Last verified: 2026-08-16 (`PLAN-001` unchanged since commit `3630977`)

## `PLAN-005` Portal design-language rollout

Status: completed 2026-08-16 | merged as PR #242 (`design/portal-integration-237`), closing issue #237

Issue #237 coordinated the portal-wide redesign after the shared design language and responsive
shell merged in PR #241. The implementation was split across three independently owned lanes:

1. #238 rebuilt organizer overview, program, review, sessions, and schedule surfaces;
2. #239 rebuilt people, communications, publishing, and settings surfaces;
3. #240 rebuilt the landing page and the reviewer, speaker, attendee, and public-event surfaces.

The final cutover composed those contributions into six job-shaped organizer hubs—Program, People,
Schedule, Communications, Publish, and Settings—while preserving event query state and redirecting
legacy workspace URLs to stable hub tabs. Integrations deliberately composes API-client and webhook
controls into one tab because the user job is shared even though the bounded-context ownership is
not. Existing reviewer and speaker routes remain direct, role-specific workspaces.

This row closes because everything it set out to sequence merged; it does not close because the
console was finished. The rebuild of the console itself, the public event pages and the signed-out
landing page followed as [`PLAN-006`](active.md), which is where the remaining design work and its
outstanding list live.

## `PLAN-001` Harness and reference slice

Status: completed 2026-08-09 | Acceptance: `ACC-HARNESS` passed | Ralph: pass 5 satisfied, zero blockers/majors

Delivered the canonical documentation/context graph; canonical domain, journey, acceptance, plan, path, symbol, trust-labeled backlink, and generated-index routing; cross-domain/dependency enforcement; AST error-policy checks; npm/uv tooling; CI; and the executable event reference slice. The slice proves harness-only production-gated signed demo sessions, application authorization and 401/403 behavior, shared Zod/OpenAPI contracts, UI/API/application/repository layers, Drizzle/D1 persistence, idempotent reset, structured once-owned errors, and safe correlation feedback.

Verified commands:

- `npm run check`
- `npm run reset`
- `npm run test:d1 --workspace @greenroom/api`
- `npm run test:e2e`
- `npm audit --audit-level=high`
- `npm run context -- check`

Evidence includes passing unit/API/component/Python/AST-checker tests, Miniflare persistence and reset-idempotency tests, Playwright reference-slice coverage, production builds, generated OpenAPI drift, and the final skeptical review. The implementation is present in the current worktree; attach the eventual commit/merge reference when published.

Gitleaks has since been observed succeeding on hosted CI: the `security` job of run `31471037575`, at head `10eab436`, ran `gitleaks/gitleaks-action@v2` and `npm audit --audit-level=high` to a successful conclusion. GitHub branch protection, however, is **not enabled** — the protection API answered 404 on 2026-08-11 — so none of the five jobs is a required check. That remainder is `GAP-003`; it does not invalidate locally reproducible `ACC-HARNESS` completion, but no claim of "clean CI" may rest on it.
