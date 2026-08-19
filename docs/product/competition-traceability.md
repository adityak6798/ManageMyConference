# Competition traceability

Status: canonical | Owner: product | Evidence: `EVD-001`, `EVD-002`, `EVD-003` | Last verified: 2026-08-18 (working tree, branch docs/sbek-harness-run-2026-08-18)

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
| 1 | "custom call-for-speakers submission forms **with conditional logic and category-based routing**" (issue #49) | **complete** — conditions and status routes persist with the published form, both applicant renderers react to answers, server validation rejects hidden answers while skipping hidden required fields, and the resolved route is snapshotted on submission for status-filtered triage. Issue #190 completed the *lifecycle* around that form: a scheduled window in the event's timezone whose precedence with the explicit close/reopen controls is one function, proposals owned by an authenticated submitter with drafts, resumption, revisions under an optimistic guard, a dashboard carrying the organizer's decision, and a submission confirmation whose recipient comes from the session rather than from a form answer. Guest submission is unchanged and stays anonymous by construction | [`apps/api/src/domain/cfp/cfp.ts`](../../apps/api/src/domain/cfp/cfp.ts) | `PRD-CFP-001`, `PRD-CFP-002`, `PRD-CFP-003`, `PRD-CFP-004`, `JNY-001`, `JNY-002`, `ACC-CFP` |
| 2 | self-service speaker portal for bios, headshots and slides (issues #34, #62) | **shipped** — task-first portal with speaker and organizer editing one optimistic-versioned canonical profile, including bio, job title, company, social links, and chosen headshot; private upload; a chosen headshot that reaches the public gallery only on publish, becomes private again on replacement or removal, and falls back to initials; organizer-controlled reversible publication; an anonymous read path gated on event publication; and a download control that hands an organizer the bytes of any uploaded file. Asserted at the shared application command and real-D1 revision boundary, in organizer and public component tests, and end to end in `apps/web/e2e/speaker-portal.spec.ts`, which reads the headshot off an anonymous browser context and reads the downloaded file's PNG magic bytes rather than only its filename | [`apps/web/src/ContentWorkspace.tsx`](../../apps/web/src/ContentWorkspace.tsx) | `PRD-SPK-001`, `PRD-SPK-002`, `JNY-005`, `ACC-SPEAKER` |
| 3 | templated speaker communications, and "calendar invites delivered directly to each speaker's own calendar (Gmail, Outlook, iCal)" (issues #52, #56) | **partial** — immutable templates, a durable outbox with retry/terminal/recovery, an organizer who can compose a template version and send it to the event's speakers, and lifecycle enqueue on its own: acceptance, task assignment, reviewer assignment, an accept/decline decision and a published schedule (issue #66). The calendar half now has all three routes the brief names — an iTIP `METHOD:REQUEST` invitation with `ORGANIZER` and `ATTENDEE` that an organizer sends per speaker per session through the outbox (idempotent while schedule and recipient are unchanged; every change gets a strictly higher `SEQUENCE`, including A→B→A), Google and Outlook links per session in the portal, and the `.ics` download for Apple Calendar (issues #56, #136). Still: the schedule confirmation carries a link to the `.ics` rather than the attached invitation, which is one call and one payload key away; **no mail client has ever rendered one of these invitations**, because the fixture provider sends no mail, so what is proven is that the invitation is built correctly and reaches the provider; and no live adapter has met a real API | [`apps/api/src/application/content/calendar-invite.ts`](../../apps/api/src/application/content/calendar-invite.ts) | `PRD-COM-001`, `PRD-SPK-002`, `JNY-004`, `JNY-009`, `ACC-INTEGRATION`, `GAP-010` |
| 4 | abstract review and scoring, with "optional AI-assisted review **across multiple rounds**" (issues #57, #80) | **shipped and live-verified** — blind queues, a locked rubric, drafts, terminal completion, conflicts and organizer aggregates, asserted in the browser. **Both named differentiators now exist.** Multiple rounds shipped with `1300_review_rounds.sql`: assignments, caps and outcomes are round-scoped, and advancing a round preserves the earlier round's assignments, evaluations and aggregates. The **optional** AI half shipped with issue #110: a provider-neutral suggestion port whose deterministic fake is the default everywhere — so `npm run check`, the D1 suite, Playwright and the demo need no credential — behind a credential-gated live adapter that refuses a half configuration rather than falling back. Every suggestion is stored with its model, prompt version, time and abstract revision, and rendered with all four beside the draft. **It is draft-only by construction**: suggestions live in their own table that no aggregate query joins, accepting one writes the reviewer's evaluation as a *draft*, and completing it remains a separate reviewer action; storage refuses a suggestion that changes state without a named responder and an evaluation that claims provenance it does not have. The [2026-08-13 staging smoke](../engineering/review-suggestions.md#staging-smoke--completed-2026-08-13) verified the deployed fail-safe, live `claude-opus-5` generation and provenance, D1 persistence, accept-as-draft, separate completion, forced failures, manual fallback, and identity-free outbound request (`GAP-011` closed). | [`apps/api/src/domain/review/suggestion.ts`](../../apps/api/src/domain/review/suggestion.ts) | `PRD-ABS-001`, `PRD-REV-001`, `PRD-AI-001`, `JNY-003`, `ACC-REVIEW` |
| 5 | "drag-and-drop schedule/agenda building … viewable by list, day, week, track, or room" (issue #50) | **shipped** — room × time board with pointer drag and full keyboard parity, conflict explanation that blocks publication, six views in a shareable URL, event-timezone rendering | [`apps/web/src/agenda/AgendaWorkspace.tsx`](../../apps/web/src/agenda/AgendaWorkspace.tsx) | `PRD-AGD-001`, `JNY-006`, `ACC-AGENDA` |
| 6 | "real-time dashboard showing **which speakers** still have outstanding onboarding tasks" (issues #33, #53) | **shipped** — the Overview page names each speaker, task, due date and days overdue from current workspace data, fetched per load; the t=0 quality gate asserts the seeded speaker, open task, and due date before any spec mutation | [`apps/web/src/OverviewPage.tsx`](../../apps/web/src/OverviewPage.tsx) | `PRD-SPK-001`, `PRD-CNT-001`, `JNY-004`, `ACC-SPEAKER` |
| 7 | "native, one-way integration with Accelevents (our existing registration platform) to eliminate manual data re-entry" (issue #58) | **partial** — the one-way direction the brief asks for is implemented and operable: registrations are read from Accelevents and become speaker profiles through content's own public import command, with a dry run that writes nothing, an apply that converges rather than duplicating, per-record provenance, and an organizer surface showing the run, its counts, its row-level failures and its last-run state. It runs credential-free on a deterministic roster by default, and the surface names which source answered. Still **partial for one reason**: it has never exchanged a request with the real API — no credential exists here, the client's tests stub `fetch`, and the staging smoke has not run | [`apps/api/src/application/communications/accelevents-sync.ts`](../../apps/api/src/application/communications/accelevents-sync.ts) | `PRD-INT-001`, `JNY-009`, `ACC-INTEGRATION`, `GAP-012` |
| 8 | "resource and wiki pages within the speaker portal, including HTML embed support for existing reference material" (issue #54) | **shipped** — organizers author, order, show and hide resource pages; visible pages render in the speaker portal after parser-backed allowlist sanitization, while reference iframes require an allowlisted HTTPS host and run in a scriptless sandbox | [`apps/web/src/content/ResourceEditor.tsx`](../../apps/web/src/content/ResourceEditor.tsx) | `PRD-SPK-002`, `PRD-CNT-001`, `JNY-005`, `ACC-SPEAKER` |
| 9 | "embeddable, mobile-friendly speaker gallery and schedule" (issues #46, #55) | **shipped** — `/events/:slug/*`, the JSON feed, and `/embed/events/:slug/{schedule,sessions,speakers,gallery,itinerary}` serve one versioned immutable projection, with multi-day grouping, session/speaker search, Track/Format/Location facets, attendee itineraries, configurable fields/track/accent/chrome, `frame-ancestors *`, and no horizontal overflow at 390px | [`apps/web/src/PublicEventApp.tsx`](../../apps/web/src/PublicEventApp.tsx) | `PRD-PUB-001`, `JNY-007`, `ACC-PUBLIC` |

**One complete, six shipped, two partial, none missing**, counted from the table above rather than
carried forward — the previous sentence read "four shipped … three partial, two missing", which had
not matched its own table for some time. Feature 2 still carries a named hole and features 3 and 7
remain partial for the same reason as each other: no live adapter in this repository has met a real
API. The wider reconciliation of this file and the [scorecard](../quality/scorecard.md) against what
shipped is issue #10's, and the last clause of this paragraph is part of it — hosted CI **has** run
green on `main` since it was written.

Nothing in this table is judged by the existence of a screen: a verdict of "shipped" means the
scorecard row that owns it names the automated tests that assert it, and that those tests ran in
the suites that document measures from a clean reset.

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
that every journey surface is discoverable. `zz-closure-surfaces.spec.ts` drives the newer role,
report, portal, embed, and webhook-console surfaces rather than only discovering them. Neither
replaces the remaining acceptance criteria of issue #10, which include hosted CI. The reproducible
external SessionBoard evaluator is pinned and described in the
[evaluator runbook](../engineering/external-evaluator.md); the credentialed API path remains
unavailable on this branch, and the 2026-08-18 harness-path run that scored 85.5% / 95.4% at commit
`b8ca2dc` used in-session judges rather than the pinned models, so it is not comparable with the
older 65.9% report and neither is a release claim.
The competition demo order remains in [the demo runbook](../demo-runbook.md); deferred items are in
[known gaps](../quality/known-gaps.md) and the [technical debt register](../exec-plans/tech-debt.md).
