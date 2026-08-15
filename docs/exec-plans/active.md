# Active execution plans

Status: canonical | Owner: delivery | Last verified: 2026-08-14

## `PLAN-002` Product lifecycle

Status: active; review-ready locally after lifecycle and closure-surface acceptance, hosted branch
CI pending

The bounded vertical slices for `JNY-001` through `JNY-009` are available through public application
entrypoints. `ACC-DEMO-SMOKE` provides the deterministic reset/runbook, role-aware evaluator path,
accessibility/performance smoke, and scheduled quality gate.

Issue #10's first acceptance criterion is met and measured:
[`apps/web/e2e/lifecycle.spec.ts`](../../apps/web/e2e/lifecycle.spec.ts) carries one newly submitted
proposal across review, acceptance, speaker provisioning, scheduling, and public publication in a
single run and hands the fixture back. `apps/web/e2e/closure-surfaces.spec.ts` adds the adjacent
closure journeys: custom-role field projection and locked writes, report exports/share/scheduled
execution, public portal registration, persisted embeds, and the webhooks console's real
unconfigured state. What remains before this plan can close:

- hosted CI on this branch, and branch protection that makes those jobs required (`GAP-003`);
- the still-open deferred item of issue #10 — `DEBT-004`; `DEBT-005` closed through issues #48
  and #84;
- the missing brief features that no lifecycle test can substitute for: `GAP-010`
  (lifecycle-triggered communications and calendar delivery) and `GAP-012` (Accelevents).
  Multi-round and AI-assisted review shipped and closed `GAP-011`; portal resource and wiki pages
  shipped with issue #54.
Issue #12 is closed: durable session records and revocation
([`ADR-005`](../decisions/adr-005-durable-sessions-and-revocation.md)), organization invitation and
membership administration, and credential rotation and recovery with a
[security-operations runbook](../engineering/security-operations.md). `GAP-007` is deleted with it.

## `PLAN-003` Evaluation artifact

Status: active; `prototype.html` retained as a **historical** artifact, no longer maintained as a
product view

[`prototype.html`](../../prototype.html) is the pre-implementation planning sketch. The shipped
organizer console replaced it: the routed console, agenda board, and public site look and behave
differently, and several capabilities the sketch depicts — lifecycle communication automations, a
four-column CRM board, review rounds — are not implemented. It is kept, not deleted, because it is
the record of the intent the product was built against and because deleting it would remove evidence
rather than a claim; it now says on every screen that it is historical and where the real product
is. The live equivalent of what it once illustrated is the
[competition traceability](../product/competition-traceability.md) table and the
[demo runbook](../demo-runbook.md). Do not update the sketch to match the product: if it ever needs
to be current, replace it with a screenshot tour of the shipped console instead.
