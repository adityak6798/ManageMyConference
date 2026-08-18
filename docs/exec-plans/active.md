# Active execution plans

Status: canonical | Owner: delivery | Last verified: 2026-08-16

## `PLAN-006` Console modernization

Status: active; the rebuild merged as #243 and the suite migration and capture regeneration as #244,
and the browser suites (`e2e`, `quality`) were last recorded against those branch tips rather than
the merge commit, so the eleven scorecard rows naming them stay refused until `npm run gate:browser`
runs here — `npm run gate:evidence` is the current answer for the checkout in front of you

`PLAN-005` rolled the design language across the portal. This is the change that finished the job
on the console itself: the whole organizer console, the public event pages and the signed-out
landing page were rebuilt on the same foundation, across seven implementation lanes and a polish
pass. It moves presentation and interaction only — product behavior stays in the owning `PRD-*`
specification, no HTTP shape moved, and no migration was written. The result is stated in
[the design language](../product/design-language.md), which is the document to read before
touching any of it.

Four things changed at the foundation:

1. one cool neutral ramp replaced the console/public split, so no component is authored against two
   grounds it cannot see, and public surfaces differentiate by measure, rhythm and scale instead;
2. a control tier — `Field`, `Select`, `Combobox`, `Menu`, `Checkbox`, `Radio`, `DateTimeField`,
   `SegmentedControl`, `CopyableSecret` — took over the pickers the reader's operating system used
   to draw. Counted in `apps/web/src`, the console held 72 native `<select>`s and 20 native date and
   time inputs before this change and holds 41 and 21 after it: the tier is how a converted surface
   asks for a value, the remainder is real, and the date count rose because the agenda split four
   `datetime-local` fields into ten date and time inputs while five call sites moved to the tier.
   `GAP-032` records the remainder rather than leaving it to be found by clicking;
3. `Section` replaced `Card` as the default page region, and a bordered thing may no longer contain
   another one;
4. the cue gutter — a 56px monospace measure column behind a continuous hairline spine — became the
   shared row grammar for queues, lists and boards, which is what let uppercase eyebrows, ornaments
   and card titlebars be deleted without pages losing structure.

**A redesign of this size is a reading of the product, and it found defects rather than only
restyling them.** Recorded here because each one was reachable by a user before this change:

- the bare `button` selector painted every button in the application solid green, and
  `:focus-visible` mutated corner radius, so an input's corners visibly snapped from 8px to 5px on
  keyboard focus;
- `.stack`, `.inline` and `.form-stack` were written into roughly 26 forms before the rules that
  space them existed, so those rows had no spacing at all, and six custom properties were
  referenced with no declaration anywhere. `tools/check-css-tokens.mjs` fails `gate:integrity` on
  the undeclared `var()` — in a stylesheet or in a component's inline style — and on the mirror of
  the class defect, a rule no component names. The direction that actually shipped those 26 forms,
  a component naming a class no stylesheet declares, is **not** gated: it needs an oracle for
  runtime-composed class names that the file has only in a loose form, and `GAP-033` records it;
- `/invitations/accept` was unreachable for the invitee it exists for, and dead-ended for a demo
  persona with the standard 401 sentence — "Sign in to continue." — shown to somebody who had just
  signed in;
- Settings → Event shipped two implementations of the same surface, with the better one unreachable;
- seven destructive actions committed on the press, with no confirmation of any kind;
- the agenda board froze neither axis, and renamed rooms through `window.prompt()`;
- a CFP preview mounted inside the console repainted every page behind it, because the token layer
  swapped the whole ramp on `:root:has(…)`;
- `/search` and `/events/new` were addressable but unreachable — the first redirected because the
  route guard read the *sidebar* list as the reachability rule, the second because `main.tsx`
  matched `/events/` for the public site and served "This event page is unavailable" to the
  console's own create form on any document load;
- every `Select` overflowed its column, because a grid item's automatic minimum size is its
  untruncated content: at 390px the topbar's event chip covered the Search button, and
  `document.elementFromPoint` at that button returned the chip;
- the shared `Checkbox` took the visually-hidden recipe, so with no positioned ancestor the input's
  own box was laid out against the initial containing block and sat at y = −21, off the top of the
  document, hit-testable by nothing but its label;
- the two signed-out surfaces — the first screens a stranger sees — shipped a `contentinfo`
  landmark and no `banner`;
- the public call for proposals' placeholder measured 2.81:1, on the two required questions where
  that placeholder was the entire visible content.

The browser suite was migrated with it, because a spec that drove a native `<select>` through
`selectOption` against a converted picker reports success while writing nothing:
`apps/web/e2e/controls.ts` now holds the control-tier helpers and every spec drives the real
interface through them. Two journeys that had no coverage were added — the signed-out invitee at
`/invitations/accept`, and an event-settings save landing in the topbar chip. The four landing-page
product captures were regenerated against the rebuilt console; the CFP form-builder shot was
retired for the submissions queue, because the fixture's form has no routing rules and no public
address, so the picture proved a setup rather than a product.

What remains before this plan can close:

- **evidence at the landing commit.** The e2e migration lane measured 96 passed / 1 skipped and
  `test:quality` 7 passed from a clean reset, and re-ran the suite in place without a reset; every
  one of those runs names a commit this merge is not. A record names the commit it ran against and
  `gate:evidence` compares that name, so a merge invalidates a branch-tip run even where the merge
  is tree-identical to it — which is what happened here, and which is the gate working rather than
  a fault in it. `npm run gate:evidence` refuses every scorecard row until `npm run gate:browser`
  and `npm run check` are re-run at the commit this lands on;
- **`GAP-032`**, which records what this change deliberately did not build: five surfaces the API
  cannot yet fill, each blocked on contract work that does not belong in a design pull request,
  and four narrower things left undone. That register is what is verifiable from the tree and the
  lanes' reports; it is not a claim that the lanes deferred nothing else, and anything else they
  deferred is unrecorded rather than closed;
- `GAP-003` is unchanged, so nothing about hosted CI is a required check for any of this.

## `PLAN-004` SessionBoard defect closure

Status: active; implementation is complete in PRs #233 and #236, with the scored evaluator rerun blocked on its model credential

Issue #235 closes the six defects reproduced by the 2026-08-15 pinned SessionBoard evaluation and
the functional paths that were not judgeable from its deterministic fixture. The work remained
below 10,000 changed lines per pull request:

1. PR #233 delivered evaluator/closure infrastructure, speaker assets, task-bound deliverables,
   content history/approval/export, agenda demonstration, public detail/search/embed/download
   parity, and fixture coverage;
2. PR #236 delivers CFP classifications and structured participants, the server-side blind-review
   projection, and the idempotent acceptance-to-content handoff.

Each layer is based on the preceding PR head. Product behavior is recorded in the owning product
specification, HTTP shapes in the contracts/OpenAPI package, and storage history in additive
migrations. The final layer reran the credential-optional wrapper for evaluator commit
`d8fafa41cdc484309e3fda953c5567cc2d462734` from a clean fixture and archives its target commit,
configuration, timestamps, validated 18-scenario plan, and tree state through the #193 evidence
path. This environment has no `ANTHROPIC_API_KEY`, so the wrapper correctly records that run as
blocked and does not invent pass verdicts; #193 continues to own the credentialed scored rerun.

## `PLAN-002` Product lifecycle

Status: active; single-artifact lifecycle acceptance and closure surfaces are review-ready locally;
hosted branch CI pending

The bounded vertical slices for `JNY-001` through `JNY-009` are available through public application
entrypoints. `ACC-DEMO-SMOKE` provides the deterministic reset/runbook, role-aware evaluator path,
accessibility/performance smoke, and scheduled quality gate.

Issue #10's first acceptance criterion is met and measured:
[`apps/web/e2e/lifecycle.spec.ts`](../../apps/web/e2e/lifecycle.spec.ts) carries one newly submitted
proposal across review, acceptance, speaker provisioning, scheduling, and public publication in a
single run and hands the fixture back. `apps/web/e2e/zz-closure-surfaces.spec.ts` adds the adjacent
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
