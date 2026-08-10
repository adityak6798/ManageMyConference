# Quality scorecard

Status: canonical | Owner: quality | Last verified: 2026-08-09

| Acceptance ID | Journey | Required evidence | State |
|---|---|---|---|
| `ACC-HARNESS` | reference slice | UI/API/storage/auth/log/reset/context checks | **passed 2026-08-09**: local functional evidence complete; Ralph pass 5 satisfied with zero blockers/majors. Gitleaks/branch protection remain externally unverified under `GAP-003` |
| `ACC-IDENTITY-EVENTS` | identity/event foundation | role shell + API/storage tenant and authorization negatives | passed locally 2026-08-10: unit, API, D1 integration, Playwright, build, and context evidence complete |
| `ACC-CFP` | `JNY-001`, `JNY-002` | Playwright + API validation | planned |
| `ACC-REVIEW` | `JNY-003` | reviewer/organizer E2E + auth negatives | planned |
| `ACC-SPEAKER` | `JNY-004`, `JNY-005` | portal/task/asset/calendar E2E | planned |
| `ACC-CRM` | `JNY-008` | prospect-to-speaker E2E | planned |
| `ACC-AGENDA` | `JNY-006` | conflict and publish E2E | planned |
| `ACC-PUBLIC` | `JNY-007` | public/embed projection E2E + a11y | passed locally 2026-08-10: allowlisted snapshot tests and semantic, keyboard-navigable responsive direct/embed Playwright coverage |
| `ACC-INTEGRATION` | `JNY-009` (`communications-integrations`) | communication outbox + adapter contracts + retry/terminal E2E | planned |

“Done” requires behavior, negative authorization, visible error state, observability, automated acceptance, documentation linkage, and clean CI. A screen or mocked happy path is insufficient.
