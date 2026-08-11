# Active execution plans

Status: canonical | Owner: delivery | Last verified: 2026-08-11 (commit `4a46216`)

## `PLAN-002` Product lifecycle

Status: active; single-artifact lifecycle acceptance shipped locally 2026-08-11, hosted CI pending

The bounded vertical slices for `JNY-001` through `JNY-009` are available through public application
entrypoints. `ACC-DEMO-SMOKE` provides the deterministic reset/runbook, role-aware evaluator path,
accessibility/performance smoke, and scheduled quality gate.

Issue #10's first acceptance criterion is met and measured:
[`apps/web/e2e/lifecycle.spec.ts`](../../apps/web/e2e/lifecycle.spec.ts) carries one newly submitted
proposal across review, acceptance, speaker provisioning, scheduling, and public publication in a
single run and hands the fixture back. What remains before this plan can close:

- hosted CI on this branch, and branch protection that makes those jobs required (`GAP-003`);
- the two still-open deferred items of issue #10 — `DEBT-004` and `DEBT-005`;
- the missing brief features that no lifecycle test can substitute for: `GAP-009` (CFP conditional
  logic and routing), `GAP-010` (lifecycle-triggered communications and calendar delivery),
  `GAP-011` (multi-round and AI-assisted review), `GAP-012` (Accelevents), `GAP-013` (portal
  resource and wiki pages).

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
