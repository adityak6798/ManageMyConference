# Quality scorecard

Status: canonical | Owner: quality | Last verified: 2026-08-11

Evidence below was produced on 2026-08-11 by `npm run check` (83 API tests, 12 web tests, lint,
typecheck, OpenAPI drift, context integrity, build), `npm run test:d1` (15 tests across 11 files),
`npm run test:e2e` (19 tests, run twice consecutively against the fixture the first run mutated),
and `npm run test:quality` (3 tests).

| Acceptance ID | Journey | Required evidence | State |
|---|---|---|---|
| `ACC-HARNESS` | reference slice | UI/API/storage/auth/log/reset/context checks | **passed 2026-08-09**: local functional evidence complete; Ralph pass 5 satisfied with zero blockers/majors. Gitleaks/branch protection remain externally unverified under `GAP-003` |
| `ACC-IDENTITY-EVENTS` | identity/event foundation | role shell + API/storage tenant and authorization negatives | passed locally 2026-08-11: unit, API, D1 integration, Playwright, build, and context evidence complete. Production authentication does not exist; demo-mode sessions are the only identity path (issue #60) |
| `ACC-REVIEW` | `JNY-003` | reviewer/organizer E2E + auth negatives | passed locally 2026-08-11: domain, API, D1 persistence, role-negative, aggregate-bias, Playwright, build, and context evidence complete. Multi-round review and AI-assisted scoring are not implemented (issue #57) |
| `ACC-CFP` | `JNY-001`, `JNY-002` | Playwright + API validation | passed locally 2026-08-11. **Correction:** this row previously claimed a pass while the seeded published snapshot carried no `fields`, so from a clean reset the public form rendered no inputs and every public submission returned 500. Fixed in the seed, guarded at the repository boundary, and covered by `apps/api/test/seed-state.integration.test.ts`, which was confirmed to fail against the defective seed. Conditional logic and category routing remain unimplemented (issue #49) |
| `ACC-SPEAKER` | `JNY-004`, `JNY-005` | portal/task/asset/calendar E2E | passed locally 2026-08-11: unit, API, D1 persistence, role-negative, deterministic upload-port/calendar, and Playwright journey evidence complete. Asset read paths were added this pass with an authorization matrix test; ICS still omits `DTSTAMP` (issue #75) |
| `ACC-CRM` | `JNY-008` | prospect-to-speaker E2E | passed locally 2026-08-11: domain/API authorization negatives, D1 migration/reset persistence, idempotent conversion, private-note isolation, Playwright, build, and context evidence complete. Owner validation and stage-change activities are outstanding (issue #67) |
| `ACC-AGENDA` | `JNY-006` | conflict and publish E2E | passed locally 2026-08-11: resource/placement management, conflict boundaries, authorization, immutable publication, typed API/D1 storage, deterministic reset, drag-and-drop plus keyboard placement, List/Day/Week/Room/Track/Conflicts views, public projection isolation, Playwright, full check, and production builds. Slot times render in UTC rather than the event timezone (issue #85); durable schedule-event outbox delivery remains follow-up |
| `ACC-PUBLIC` | `JNY-007` | public/embed projection E2E + a11y | passed locally 2026-08-11: immutable allowlisted snapshots, API/auth negatives, D1 persistence, responsive public UI with no horizontal overflow at 390px, Playwright, and accessibility evidence complete. **Caveat:** the seeded published projection is hand-written fixture data rather than a composition of the seeded workspace, so publishing replaces it with different content (issues #36, #63) |
| `ACC-INTEGRATION` | `JNY-009` (`communications-integrations`) | communication outbox + adapter contracts + retry/terminal E2E | passed locally 2026-08-11: deterministic provider, durable outbox, retry/terminal recovery, authorization negatives, D1 persistence, and Playwright evidence complete. **Caveat:** no lifecycle event enqueues a communication and the only provider is a fake, so the seeded history is placeholder data (issues #52, #66) |
| `ACC-DEMO-SMOKE` | evaluator orientation across `JNY-001`–`JNY-009` | clean reset + role-aware discovery + accessibility/performance smoke | passed locally 2026-08-11: deterministic runbook/reset, every navigation destination asserted to render rather than merely exist, cross-role boundaries, mobile no-overflow smoke, 19-test Playwright suite proven re-runnable, 15-test D1 integration suite, build, and full check complete. Single-artifact lifecycle acceptance and hosted CI remain pending under issue #10 |

"Done" requires behavior, negative authorization, visible error state, observability, automated
acceptance, documentation linkage, and clean CI. A screen or mocked happy path is insufficient.
Where a row carries a caveat, the caveat is part of the record: it names what is not yet true and
the issue that closes it.
