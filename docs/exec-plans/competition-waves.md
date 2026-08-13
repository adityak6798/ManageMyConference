# Competition wave plan and coordination ledger

Status: working | Owner: delivery coordination | Last verified: 2026-08-12

This is the durable record of how the remaining backlog is being worked: which lanes exist, what
blocks what, and every cross-lane ruling that has been made. It exists because the coordination
happens across many sessions — some Claude, some Codex — and none of them retains the others'
context. **A ruling that is only in a chat transcript does not survive.**

Scope: every open issue except **#103** (production SaaS graduation), which is deliberately out.

## How to use this

- Before launching a lane, read its row plus "Standing rulings".
- When a ruling is made, add it here in the same turn. A ruling not written down will be
  re-litigated.
- When a wave completes, move its lanes to the completed table with the PR numbers.
- This file is not `active.md`. That register holds product execution plans with `PLAN-*` ids and
  a lifecycle the integrity gate checks; this is delivery coordination and has no `PLAN-*` id.

## State at a glance

| | |
|---|---|
| Waves complete | 0, 1, 2, 3 |
| Wave in flight | platform (#134 #131) — no PR open yet |
| Next wave | 4 — **#10**, recommended as two lanes; see "Wave 4 scope grew" |
| Open issues | **16**, of which #103 is out of scope — triaged 2026-08-12, eight closed |
| Merged so far | #105 #106 #107 #108 #109 #111 #112 #113 #114 #117 #118 #125 #126 #127 #128 #129 #130 #135 #137 (and #98) |

## Completed waves

| Wave | Lanes | Issues closed | PRs |
|---|---|---|---|
| 0 | workspace decomposition; contracts/schema/seed split; deployable frontend | #70 #104 #59 | #107 #105 #106 |
| 1 | event-scoped authorization + real auth; diagnosable failures + round trips | #27 #60 #68 #69 | #109 #108 |
| 2 | cfp; review; content; comms; agenda; public; crm | #49 #20 #93 #57(partial) #54 #94 #37 #95 #97 | #112 #114 #117 #118 #113 #111 #125 |
| 3 | comms; integrations; quality; content; agenda; crm; publishing | #119 #120 #121 #122 #123 #124 #116 #84 — and the work of #22 #23 #48 #52 #56 #58 #66 #82 #96, **none of which auto-closed** | #126 #127 #128 #129 #130 #135 #137 |

**Wave 2 did not close everything assigned to it**, deliberately in each case:

- **#22** — atomic versions, the transaction and retry idempotency shipped. The
  `EVT-SCHEDULE-PUBLISHED` outbox record did not: the communications outbox models *a delivery to
  a provider*, and `0019`'s `CHECK` pins four trigger types, none a schedule publication. Routing
  a domain event through it would have queued a fabricated external effect. Closing it needs a
  channel-neutral trigger and a migration widening that `CHECK`, both communications-owned. The
  seam (`PublicationEventWriter`) is built and tested; activation is one line in `index.ts`.
- **#96** — shipped; the `sessionIds` subset is API-only because the board has no selection
  affordance. Tracked as #119.
- **#52** — editor and send shipped; reminder rules deferred because they need content's task data.
- **#23** — live adapters shipped; one major deferred (an overtaken projection can leave the
  external system stale).
- **#57** — narrowed to multi-round only. The AI half is #110, scheduled last.

## Wave 3 — complete

All seven lanes merged. The merge order below held. Measured at `c739ec6` on 2026-08-12: hosted CI
green on **all six jobs** (`integrity`, `test-build`, `d1`, `browser`, `evidence`, `security`), and
locally `gate:browser` is 52 passed / 1 skipped plus 5 quality tests.

| Lane | Runtime | Issues | Notes |
|---|---|---|---|
| W3-comms | Claude | #66 #82 #22 #52 | Owns `index.ts` this wave. Writes the ACC-INTEGRATION row, last. |
| W3-integrations | Claude | #56 #58 #23 | `complete()` change landed as isolated commit `725166f`. |
| W3-quality | Codex | #48 #84 | Audits every domain, owns none. Most likely to generate cross-lane findings. |
| W3-content | Claude | #116 | **Implemented and green**, heading into ship-it. |
| W3-agenda | Claude | #119 | Confined to `apps/web/src/agenda/*`. No migration, no `index.ts`. |
| W3-crm | Codex | #120 #121 | |
| W3-publishing | Codex | #124 #123 #122 | #122 is the events domain — no lane has ever owned it. |

### Merge order — this one matters

```
W3-content  ──►  W3-comms  ──►  W3-integrations
```

- content first: it restructures `content-service.ts`, and comms adds #66 call sites into those
  files. Landing content first means comms writes against the final shape.
- comms before integrations: integrations' `complete()` change is an isolated first commit that
  comms rebases onto. Free if integrations lands second, mid-flight rework if it lands first.
- **comms must carry integrations' one-line `index.ts` patch** (the `EMAIL_SENDER` ORGANIZER
  wiring) *in its own PR*. If comms merges without it, the calendar feature lands unwired and
  integrations cannot add it without taking a file the ruling gave to comms.

W3-agenda, W3-crm, W3-publishing, W3-quality are independent and can land whenever.

## Wave 4 scope grew — read this before launching #10

Three findings from the post-wave-3 sweep at `9a6b840`. Each enlarges #10, whose job is to describe
the finished state.

1. ~~Nine issues are landed-but-unclosed.~~ **Done 2026-08-12.** Each was validated against its own
   acceptance criteria at `9a6b840`, not bulk-closed. **Closed: #22 #48 #52 #56 #58 #66 #82 #96**,
   each with the deciding tests named in its closing comment. **Left open: #23** (adapters and
   contract suite are done; the closure condition requires a *staging-verified* smoke, and
   `docs/engineering/README.md:11` still describes it as not yet run) and **#61** (Worker serves the
   built frontend and Cloudflare D1/R2 are now provisioned, but nothing is deployed and no URL is
   recorded). None auto-closed because the PRs cited them as `(#N)` in commit subjects rather than
   `Closes #N` in PR bodies — the same defect that left wave 0's issues open. **This keeps
   recurring; wave 4 should fix the habit, not just the symptom.**
2. **The canonical product docs are materially stale.** `competition-traceability.md` is stamped
   `Last verified: 2026-08-11 (commit 3630977)`, eight merged PRs behind, and its summary sentence
   contradicts its own table: it says "Four shipped … three partial, two missing" where the table
   now reads 1 complete, 5 shipped, 3 partial, 0 missing.
3. **The scorecard asserts something now false.** It states "**No hosted CI run exists for any commit
   on this branch**" and describes a divergence from run `31471037575` at head `10eab436`. Hosted CI
   has since run green on all six jobs on `main` at `c739ec6`. Every row's "no row says done"
   reasoning rests on that clause, so correcting it is a re-judgement of the whole table, not a
   one-line edit. This is the single largest piece of #10's reconciliation half.

**Recommendation: split #10 into two lanes.** They share no files. Lane A (integration) does the
cross-domain wiring and the lifecycle chain; Lane B (reconciliation) does items 2 and 3 above plus
the evaluator artifacts, and closes #30. One lane doing both serialises a large doc rewrite behind
integration work that has nothing to do with it.

## Remaining waves

| Wave | Lanes | Issues |
|---|---|---|
| 4 | integration | **#10** alone — connects cross-domain events, reconciles prototype/docs/traceability/scorecard/known-gaps against what shipped, produces evaluator artifacts. Must be last: its job is describing the finished state. **Close #30 here** — by then ~16 PRs will have run the risk-scoped Ralph loop, which is the multi-PR trial it is waiting on. |
| 5 | productization | #99; #100 then #101 as one lane (MCP rides on the API's auth surface); #102; ~~#110 (AI suggestion port)~~ — **in flight, see below** |

**#12** (production authentication) is lane work and is in flight, not externally blocked. The
provider ADR it once owed is [`ADR-004`](../decisions/adr-004-google-oauth-provider.md); durable
sessions and revocation landed with [`ADR-005`](../decisions/adr-005-durable-sessions-and-revocation.md).
It closes in three landings — durable sessions and the audit spine, then invitation and membership
administration, then credential rotation and recovery with a security-operations runbook — and
`GAP-007` names what each one leaves open.

Also open and externally blocked, not lane work: **#61** (stays open until Cloudflare credentials
exist and a deployed URL is recorded).

## Wave 5 — #110 in flight (AI suggestion port)

Closes the last gap in brief feature 4. Read this before touching the review domain or the
`1300` migration block.

- **Migration numbers inside `1300`.** The #134 lane took `1301` for its corrective rebuild of
  `1300`. This lane starts at **`1310`** and takes nothing below it. `1310` is `CREATE`/`ADD
  COLUMN` only — no table rebuild — so it does not depend on `PRAGMA foreign_keys` holding
  between statements, and it applies to the table `1301` rebuilt.
- **Merge order — done.** #134 merged as PR #140; this lane rebased onto it rather than
  merge-resolving. Three conflicts, all trivial (a migration list, a test import, the generated
  manifest). Two things came *back* from that lane and were adopted rather than duplicated: the
  shared `d1-write-result.ts` row-count contract (#133), which replaced this lane's own copy of
  the same rule, and the lesson `1301` encodes — `1310`'s header now records that
  `review_suggestions` makes the review foreign-key chain one link longer for whoever rebuilds
  those tables next.
- **Files this lane did not touch**, by ruling: `apps/api/test/d1-migration-rebuild.integration.test.ts`
  and `apps/api/test/support/seeded-d1.ts` (both #134's). New storage coverage went into
  `d1-review-repository.integration.test.ts`, which review owns. `apps/api/src/index.ts` and
  `table-ownership.json` were appended to only.

### One decision worth carrying forward

**The Anthropic SDK was tried first and put back.** `@anthropic-ai/sdk` pulls `node:fs` and
`node:path` into the Worker bundle for its credential-chain support, which resolves only with the
`nodejs_compat` compatibility flag — a runtime change affecting *every* route in the deployment, to
serve one adapter that is off by default. That is the shape "fix, don't file" warns about: a small
diff carrying a repository-wide decision made from inside one domain's PR. The adapter speaks raw
`fetch` instead, like the three delivery adapters, and the reasoning is recorded in
[review suggestions](../engineering/review-suggestions.md#why-raw-fetch-rather-than-the-anthropic-sdk)
so the next person meets the answer rather than the question. Revisit if the Worker ever needs
`nodejs_compat` for its own reasons.

## Standing rulings

These bind every lane until changed here.

### Migration numbers

Per-domain blocks in [`apps/api/migrations/README.md`](../../apps/api/migrations/README.md) —
identity `1000`, events `1100`, cfp `1200`, review `1300`, content `1400`, crm `1500`, agenda
`1600`, communications `1700`, publishing `1800`, platform `1900`. Within the communications
block this wave: **W3-comms `1701–1749`, W3-integrations `1750–1799`.**

### Domain ownership

After #24 and #105 each domain owns its route module, workspace, OpenAPI fragment, context
fragment, contracts module, schema module and seed fragment. Still shared: `App.tsx`,
`ui/primitives.tsx`, `docs/quality/scorecard.md` and `docs/quality/acceptance-evidence.json` —
edit only your own `ACC-*` row, and insert a new one beside its domain's neighbours rather than at
the end of the table.

### Fix, don't file

Wave 2 filed seven follow-up issues; the backlog grew as fast as it shrank. Fix a defect in your
own domain if it is under roughly half a day. File only when it needs a product decision, belongs
to a domain you do not own, or would double the PR — and say in the PR body why. Never file for
something fixable in a file you already had open.

**Refinement, from wave 3 — time is the wrong axis on its own.** The rule as first written judged
cost in hours, and twice that gave the wrong answer:

- The `meta.changes` fix (#133) was **four lines**. Its cost was not the diff, it was four
  adapters disagreeing about what a missing row count means — a repository-wide convention set
  from inside one domain's PR.
- The CFP submission confirmation (D5) was nominally small and still had to be deferred, because
  the missing piece was a policy decision, not code.

The rule therefore has two axes: how long it takes, **and how far the decision reaches**. In the
#116 lane's formulation, which is the one to use:

> "Fix, don't file" is about not deferring work you own; it is not a licence to make a repo-wide
> decision from inside one domain's PR.

A short change can be a large decision. When it is, file — and name it as a divergence *you*
introduced rather than as someone else's problem, the way #130 links #133.

### Evidence gate ordering

`npm run check` includes `gate:evidence`, which binds run records to the commit. So: **commit
first, then `npm run gate:browser`, then `npm run check`.** Records produced before committing are
stale.

## Decisions log

| # | Decision | Reason |
|---|---|---|
| D1 | **#57 split**: multi-round in wave 2, AI port to #110 in wave 5 | The either/or was stale — #89 had already made the docs honest, so there was no overclaim to delete. The brief's own word is "*optional* AI-assisted review across multiple rounds", and the AI half is the only work needing a live credential. |
| D2 | **Communications gets `public.ts`** as its declared surface, created first | It was the only domain whose allowlist entry named a service directly; #92 recorded narrowing it. `trigger(actor,…)` assumes a request actor that lifecycle events do not have. Unblocked review and agenda on day one. |
| D3 | **#66/#82 moved from wave 2 to wave 3** | #66's call sites live in content, review and agenda services — files owned by three other lanes. Assigning it to comms in wave 2 created a dependency cycle. |
| D4 | **#123: keep no-expiry/no-revocation**, add bounded pruning, move `GAP-018` to tech-debt | Expiry breaks a saved plan mid-event; revocation protects nothing while the payload is starred public sessions. But pruning *empty* itineraries and those for *ended* events breaks neither, and closes the storage half. `known-gaps.md` sends accepted trade-offs to the debt register. |
| D5 | **CFP submission confirmation NOT shipped** | The submitter address is an unauthenticated form field that nothing verifies. A send there turns the public form into a mail-bombing primitive — `FixedWindowThrottle(10, 60_000)` on client address alone, ~14k/day at a recipient of the attacker's choosing. Needs a per-(event, recipient) cap or double opt-in: a product decision plus storage. |
| D6 | **Decision notifications DO ship**, with the property documented | Same unverified address, but behind an authenticated organizer action and one message per decision. Boundary: acceptable while the notification carries only the *fact* of a decision; not once it carries reviewer comments or scores. |
| D7 | **Four `export` keywords in `content-service.ts`** allowed against additive-only | The alternative was duplicating a 75-octet UTF-8-aware line folder that must stay byte-identical for calendar clients and whose divergence fails no test. Four one-token edits in a region no other session touches. |
| D8 | **iTIP `ORGANIZER` comes from `EMAIL_SENDER`**; unconfigured refuses, naming the binding | No honest source exists — `Actor`, `AssignableOwner` and `Event` all lack an address. Gmail and Outlook require ORGANIZER to match the sender or they will not render Accept/Decline, so a fabricated address produces an invite that looks delivered and does nothing. |
| D9 | **Enqueue fires *beside* the content batch, not inside it** | Not because a cross-domain write cannot join a batch — `prepareEnqueue`/`PreparedDeliveryWriter` exists precisely for that and agenda uses it for #22 — but because for a change that has already committed, retry plus idempotency converges on one delivery, which is cheaper than a shared batch. |
| D10 | **Lazy-load the two app roots in `main.tsx`** rather than raising a budget or merging files | `main.tsx` named both roots statically, so every public visitor downloaded the organizer console. The `resourceCount < 100` budget caught it only because #119's two files took the public page from 98 to 100. Fixing the cause took it to **40**; the ceiling was left untouched, so it still means what it meant and now has real headroom. Raising it would have deleted the signal; merging files would have moved the number by one and pushed against #70's decomposition. |
| D11 | **#133 filed** for the `meta.changes` divergence, rather than four lanes patching their own copy | #116 correctly changed content to treat a missing count as an error; three other adapters still read `?? 0`. #119 was offered the same one-line change and declined for a better reason than the one on offer — the pattern is the repository's, not agenda's, and fixing one of four is less legible than the uniform reading. Platform-owned, post-competition, no live defect claimed. |
| D12 | **#131 filed** for a NUL-byte gate | #116's own change put two literal NUL bytes into `memory-content-repository.ts`, turning it into a binary blob: `git diff` reported "Bin 11432 → 14150 bytes, 0 insertions, 0 deletions", 2.7 KB of change to a core adapter invisible to the PR view, to blame and to grep — while `npm run check` stayed green for two commits. Caught by a human reading the file in review pass 3. The gate belongs in `tools/`, which is platform, so it is an issue rather than another commit. |
| D13 | **AI suggestions are a sibling table, not columns on `review_evaluations`** | "AI may draft but never silently changes canonical state" is only as strong as the thing enforcing it. As a nullable column it is a convention one careless `UPDATE` breaks; as `review_suggestions`, which no aggregate query joins, it is a property of the schema. Accepting writes a *draft* and completing stays a separate act, so the two human actions are structural too. |

## Known stale facts

Things the repository asserts that are no longer true. Each cost time before it was caught.

- **`AGENTS.md` line 27** says `gate:browser` "cannot run concurrently with another agent or
  checkout on this machine". False since #28 made local D1/R2 state per-instance keyed on the
  derived API port. Two wave-3 agents had already agreed to serialise on it. **W3-quality is
  correcting it.**
- **Issues written before wave 2 cite paths that moved.** #70's decomposition and #105's splits
  relocated a great deal; #56 pointed at `ContentWorkspace.tsx` for a control now in
  `apps/web/src/content/SpeakerContent.tsx`. Trust the tree over the issue text, and note the
  discrepancy in the PR.

## Issues raised during wave 3

Filed deliberately, each against the "fix, don't file" exceptions rather than around them.

| # | Why it was filed rather than fixed |
|---|---|
| #131 | NUL-byte gate. Lives in `tools/`, which is platform — not the content lane's to add. |
| #133 | `meta.changes` divergence across four adapters. Shared port type, one owner, no current lane owns it. |
| #132 | CFP submitter's address is unverified (decision D5). A product policy decision plus storage, not a code fix. |
| #134 | Migration `1300` uses a table-rebuild recipe that D1 refuses, because `PRAGMA foreign_keys` is not honoured between statements. |
| #136 | Calendar invitations are not re-sent when a session returns to the schedule. Communications-owned. |

**Where these land:** #131 and #134 are the platform lane, in flight now. #133 is platform and
post-competition. #132 and #136 need a wave — #132 is a product decision worth taking before any
public demo; #136 is a correctness hole in a shipped feature and belongs in wave 4 or a comms lane.

**#134 is partly addressed already, and the platform lane should read this before starting.** PR
#137 added `apps/api/test/d1-migration-rebuild.integration.test.ts`, which replays a rebuild
migration over the *seeded* fixture — exactly the arrangement the harness could not produce, and its
header states the `PRAGMA foreign_keys` reasoning correctly. But it covers **`1703` only**.
`apps/api/migrations/1300_review_rounds.sql` still opens with `PRAGMA foreign_keys = OFF` and drops
two tables (lines 1, 19, 56, 83), and no test replays it over rows. So the pattern exists and the
original defect does not: #134 is still real work, and its remaining scope is 1300 plus the
generalised harness rule, not the test pattern.

**`GAP-017` has a third occurrence**, and it narrows the problem. The two recorded occurrences are
both in the **browser** suite; #119's is in the **D1** suite, on migrations that branch does not
touch (`1401_content_workflow_scale.sql` statement 5, `1300_review_rounds.sql` statement 4), ~20
unrelated tests red with `fetch failed` / `Server is not running.`, green on re-run at the same
commit. So the failure is not specific to `wrangler dev` under Playwright. Recorded in PR #126's
body rather than in the entry, since platform owns `GAP-017`. A plausible trigger, not a
conclusion: #25 made `createMigratedDatabase()` mint a Miniflare instance per call, so instance
count now scales with test count, and seven concurrent lanes is a load pattern that did not exist
before this month.

**A fourth occurrence, on 2026-08-12 at `c739ec6`, names the mechanism.** `gate:d1` failed 24 of 79
with `fetch failed`, and `gate:browser` died *before the suite started* — inside `npm run reset`,
with `connect EADDRNAVAIL 127.0.0.1:56532` from `wrangler d1 execute`. That is ephemeral-port
exhaustion, not a Worker crash, which explains why the symptom reaches both suites and why it can
strike setup rather than mid-run. Concurrent load at the time: 7 `workerd` and 10 `vite` processes
across worktrees, 1049 sockets in `TIME_WAIT`. Both gates were green on immediate re-run at the same
commit with no change. Two consequences for whoever fixes this: the failing D1 run is *not*
deterministic (a second `gate:d1` failed 24 again but on a partly different set), and a run that
dies during reset still leaves a record — my failing run overwrote `.evidence/d1.json` with
`exitCode 1`, which is harmless only because `.evidence/` is gitignored.

**`GAP-015` is closed.** W3-quality took the relay: #84's t=0 gate now proves the seeded Overview
table names Sam Speaker, their open task and its due date, before any spec mutation. The
traceability row for brief feature 6 was updated with it; the summary sentence beneath that table
still says feature 6 has "no test on its rows", which is one of the staleness items for #10.

## Open questions

- **Per-event contact address.** `EMAIL_SENDER` means invites arrive from the deployment's sender,
  not the conference. The natural home is the events domain, whose first update path is being
  built now under #122. Not chased across lanes; recorded for whoever picks up event settings.
- **`acceptance-evidence.json` conflicts.** Seven lanes each edit one row. Assessed as small and
  mechanical — rows sit 8–14 lines apart and git merges them cleanly. Revisit only if it actually
  hurts; the fix would be the same shape as #105.
