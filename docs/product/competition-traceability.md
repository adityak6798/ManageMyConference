# Competition traceability

Status: canonical | Owner: product | Evidence: `EVD-001`, `EVD-002`, `EVD-003` | Last verified: 2026-08-11 (working tree: commit `3630977`)

## Where the nine features come from

**The competition brief is not committed to this repository.** `EVD-001` records it as an external
document with no hash and an uncommitted local copy, so nothing here can be quoted as authoritative
feature text. The nine rows below are therefore *derived*, not transcribed: each one is reconstructed
from the issue bodies that cite it by number, and each row names the issue whose wording it is
reconstructed from. Where an issue quotes the brief directly, the quotation is reproduced inside
quotation marks; everything outside quotation marks is this repository's paraphrase. If the brief
itself becomes available, re-derive this table against it before relying on it (`GAP-002`).

## The nine features

Verdicts are **shipped** (behaviour exists and an automated test asserts it), **partial** (the
feature's named differentiator is missing), or **missing** (no implementation). A qualifier after a
verdict names a hole too small to make the feature partial and too real to leave out. This column
judges the *feature*; the scorecard's `Verdict (local)` column judges this repository's *journey*,
which is why a shipped journey can serve a partial feature.

| # | Feature as cited by the issues | Verdict | Deciding file | Governing IDs |
|---|---|---|---|---|
| 1 | "custom call-for-speakers submission forms **with conditional logic and category-based routing**" (issue #49) | **complete** — conditions and status routes persist with the published form, both applicant renderers react to answers, server validation rejects hidden answers while skipping hidden required fields, and the resolved route is snapshotted on submission for status-filtered triage | [`apps/api/src/domain/cfp/cfp.ts`](../../apps/api/src/domain/cfp/cfp.ts) | `PRD-CFP-001`, `PRD-CFP-002`, `JNY-001`, `JNY-002`, `ACC-CFP` |
| 2 | self-service speaker portal for bios, headshots and slides (issues #34, #62) | **shipped** — task-first portal with profile edit, private upload, a speaker-chosen headshot that reaches the public gallery on publish and falls back to initials when that file is unpublished, organizer-controlled reversible publication, an anonymous read path gated on event publication, and a download control that hands an organizer the bytes of any uploaded file. Asserted end to end in `apps/web/e2e/speaker-portal.spec.ts`, which reads the headshot off an anonymous browser context and reads the downloaded file's PNG magic bytes rather than only its filename | [`apps/web/src/ContentWorkspace.tsx`](../../apps/web/src/ContentWorkspace.tsx) | `PRD-SPK-001`, `PRD-SPK-002`, `JNY-005`, `ACC-SPEAKER` |
| 3 | templated speaker communications, and "calendar invites delivered directly to each speaker's own calendar (Gmail, Outlook, iCal)" (issues #52, #56) | **partial** — immutable templates, a durable outbox with retry/terminal/recovery, and a conformant `.ics` **download** exist; nothing is triggered by a lifecycle event, the only provider is a deterministic fake, and no invite reaches a calendar | [`apps/api/src/index.ts`](../../apps/api/src/index.ts) (one fake wired to `email`, `airtable` and `accelevents`) | `PRD-COM-001`, `PRD-SPK-002`, `JNY-004`, `JNY-009`, `ACC-INTEGRATION`, `GAP-010` |
| 4 | abstract review and scoring, with "optional AI-assisted review **across multiple rounds**" (issues #57, #80) | **partial** — blind queues, a locked rubric, drafts, terminal completion, conflicts and organizer aggregates are shipped and asserted in the browser; there is one round and no AI | [`apps/api/src/domain/review/review.ts`](../../apps/api/src/domain/review/review.ts) | `PRD-ABS-001`, `PRD-REV-001`, `PRD-AI-001`, `JNY-003`, `ACC-REVIEW`, `GAP-011` |
| 5 | "drag-and-drop schedule/agenda building … viewable by list, day, week, track, or room" (issue #50) | **shipped** — room × time board with pointer drag and full keyboard parity, conflict explanation that blocks publication, six views in a shareable URL, event-timezone rendering | [`apps/web/src/AgendaWorkspace.tsx`](../../apps/web/src/AgendaWorkspace.tsx) | `PRD-AGD-001`, `JNY-006`, `ACC-AGENDA` |
| 6 | "real-time dashboard showing **which speakers** still have outstanding onboarding tasks" (issues #33, #53) | **shipped, thinly covered** — the Overview page names each speaker, task, due date and days overdue from live workspace data, but it is fetched per load, not pushed, and no test asserts a single row of it | [`apps/web/src/OverviewPage.tsx`](../../apps/web/src/OverviewPage.tsx) | `PRD-SPK-001`, `PRD-CNT-001`, `JNY-004`, `ACC-SPEAKER`, `GAP-015` |
| 7 | "native, one-way integration with Accelevents (our existing registration platform) to eliminate manual data re-entry" (issue #58) | **missing** — `accelevents` is a delivery channel enum with the deterministic fake behind it; there is no client, no fixture, no field mapping and no organizer surface | [`apps/api/src/domain/communications/delivery.ts`](../../apps/api/src/domain/communications/delivery.ts) | `PRD-INT-001`, `JNY-009`, `ACC-INTEGRATION`, `GAP-012` |
| 8 | "resource and wiki pages within the speaker portal, including HTML embed support for existing reference material" (issue #54) | **missing** — the portal has tasks, profile, uploads and a calendar download; there is no page model, no authoring surface and no sanitizer | [`apps/web/src/ContentWorkspace.tsx`](../../apps/web/src/ContentWorkspace.tsx) | `PRD-SPK-002`, `PRD-CNT-001`, `JNY-005`, `ACC-SPEAKER`, `GAP-013` |
| 9 | "embeddable, mobile-friendly speaker gallery and schedule" (issues #46, #55) | **shipped** — `/events/:slug/*` and `/embed/events/:slug/{schedule,speakers}` serve one composed immutable snapshot, with headshots, day grouping, event-timezone times, copy-ready `<iframe>` snippets, `frame-ancestors *`, and no horizontal overflow at 390px | [`apps/web/src/PublicEventApp.tsx`](../../apps/web/src/PublicEventApp.tsx) | `PRD-PUB-001`, `JNY-007`, `ACC-PUBLIC` |

Four shipped — feature 2 with a named hole in it, feature 6 with no test on its rows — three partial,
two missing. Nothing in this table is judged by the existence of a screen: a verdict of "shipped"
means the [scorecard](../quality/scorecard.md) row that owns it names the automated tests that assert
it, and that those tests ran in the suites that document measures from a clean reset. No row here is
evidence of anything on hosted CI, which has never run this branch.

## Internal areas behind those features

This repository's own journeys and acceptance IDs do not map one-to-one onto the nine features; the
speaker CRM in particular is product work the brief does not name. The mapping is:

| Internal area | Governing rules | Journey | Acceptance | Serves feature |
|---|---|---|---|---|
| CFP | `PRD-CFP-*` | `JNY-001`, `JNY-002` | `ACC-CFP` | 1 |
| abstract management | `PRD-ABS-001` | `JNY-003` | `ACC-REVIEW` | 4 |
| reviewing | `PRD-REV-001` | `JNY-003` | `ACC-REVIEW` | 4 |
| speaker/content | `PRD-SPK-*`, `PRD-CNT-001` | `JNY-004`, `JNY-005` | `ACC-SPEAKER` | 2, 6, 8 |
| agenda | `PRD-AGD-001` | `JNY-006` | `ACC-AGENDA` | 5 |
| public views and embeds | `PRD-PUB-001` | `JNY-007` | `ACC-PUBLIC` | 9 |
| communications and integrations | `PRD-COM-001`, `PRD-INT-001` | `JNY-009` | `ACC-INTEGRATION` | 3, 7 |
| speaker CRM | `PRD-CRM-001` | `JNY-008` | `ACC-CRM` | none — additional product work |
| identity and events | `PRD-EVT-001`, `PRD-IAM-*` | all | `ACC-IDENTITY-EVENTS` | foundation for all nine |

The lifecycle chain is the integration acceptance target, and it is now executable:
[`apps/web/e2e/lifecycle.spec.ts`](../../apps/web/e2e/lifecycle.spec.ts) carries one newly filed
proposal from the public form to the published site and back. `ACC-DEMO-SMOKE` separately verifies
that every journey surface is discoverable. Neither replaces the remaining acceptance criteria of
issue #10, which include hosted CI. The reproducible evaluator order and clean-reset commands are in
the [competition demo runbook](../demo-runbook.md); the deferred items are in
[known gaps](../quality/known-gaps.md) and the [technical debt register](../exec-plans/tech-debt.md).
