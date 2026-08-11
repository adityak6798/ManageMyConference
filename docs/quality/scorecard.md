# Quality scorecard

Status: canonical | Owner: quality | Last verified: 2026-08-10

| Acceptance ID | Journey | Required evidence | State |
|---|---|---|---|
| `ACC-HARNESS` | reference slice | UI/API/storage/auth/log/reset/context checks | **passed 2026-08-09**: local functional evidence complete; Ralph pass 5 satisfied with zero blockers/majors. Gitleaks/branch protection remain externally unverified under `GAP-003` |
| `ACC-IDENTITY-EVENTS` | identity/event foundation | role shell + API/storage tenant and authorization negatives | passed locally 2026-08-10: unit, API, D1 integration, Playwright, build, and context evidence complete |
| `ACC-REVIEW` | `JNY-003` | reviewer/organizer E2E + auth negatives | **passed locally 2026-08-10**: domain, API, D1 persistence, role-negative, aggregate-bias, Playwright, build, and context evidence complete |
| `ACC-CFP` | `JNY-001`, `JNY-002` | Playwright + API validation | passed locally 2026-08-10: organizer/applicant Playwright journey, API validation and authorization negatives, real-D1 snapshot/idempotency integration, migration/reset, build, and context evidence complete |
| `ACC-SPEAKER` | `JNY-004`, `JNY-005` | portal/task/asset/calendar E2E | passed locally 2026-08-10: unit, API, D1 persistence, role-negative, deterministic upload-port/calendar, and Playwright journey evidence complete |
| `ACC-CRM` | `JNY-008` | prospect-to-speaker E2E | passed locally 2026-08-10: domain/API authorization negatives, D1 migration/reset persistence, idempotent conversion, private-note isolation, Playwright, build, and context evidence complete |
| `ACC-AGENDA` | `JNY-006` | conflict and publish E2E | passed locally 2026-08-10 for resource/placement management, conflict boundaries, authorization, immutable publication, typed API/D1 storage, deterministic reset, organizer UI, public projection isolation, Playwright, full check, and production builds; durable schedule-event outbox delivery remains follow-up |
| `ACC-PUBLIC` | `JNY-007` | public/embed projection E2E + a11y | passed locally 2026-08-10: immutable allowlisted snapshots, upstream CFP/content/agenda composition, API/auth negatives, D1 persistence, responsive public UI, Playwright, and accessibility evidence complete |
| `ACC-INTEGRATION` | `JNY-009` (`communications-integrations`) | communication outbox + adapter contracts + retry/terminal E2E | passed locally 2026-08-10: deterministic provider, durable outbox, retry/terminal recovery, authorization negatives, D1 persistence, and Playwright evidence complete |
| `ACC-LIFECYCLE` | `JNY-001`–`JNY-009` | clean reset + role-aware discovery + aggregate `ACC-*` suite + evaluator smoke | passed locally 2026-08-10: deterministic runbook/reset, cross-role browser path, 12-test aggregate Playwright suite, standalone accessibility/performance smoke, 12-test D1 integration suite, build, and full check complete; hosted CI remains pending |

“Done” requires behavior, negative authorization, visible error state, observability, automated acceptance, documentation linkage, and clean CI. A screen or mocked happy path is insufficient.
