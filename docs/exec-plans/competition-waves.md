# Competition wave plan and coordination ledger

Status: working | Owner: delivery coordination | Last verified: 2026-08-13

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
It closed in one landing carrying all three parts: durable sessions and the audit spine,
invitation and membership administration, and credential rotation and recovery with a
[security-operations runbook](../engineering/security-operations.md). `GAP-007` is deleted with it.

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

### Issue #100 REST API rulings

Webhook schedule fan-out composes the existing schedule-mail consumer with an idempotent webhook consumer; it does not widen `OutboxWorker` or introduce a second event source. Each subscription has a separate delivery queue so one receiver's retry does not resend another receiver's success. Webhook secret rotation keeps the previous secret for 24 hours and signs with both during that overlap. Webhook management reuses the existing `communications:manage` capability vocabulary; it does not add a parallel scope system.

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
| D14 | **API clients reuse `Capability`; rotation overlaps for 24 hours** | A second scope vocabulary would drift from authorization, so machine clients declare the same closed capabilities and resolution intersects them with the creator's current event grants on every request. Rotation moves the current digest into a bounded previous slot for 24 hours, allowing integrations to deploy the new credential without downtime; revocation remains immediate on the next request. |
| D15 | **Version the API contract, not its URLs; `Idempotency-Key` is the default with one explicit credential exception** | Moving every existing route and web caller below `/api/v1` would turn one platform policy into a repository-wide migration. One constant instead drives OpenAPI and the `Greenroom-API-Version` response header; breaking replacements overlap for at least 180 days under `Deprecation` and `Sunset`. All five webhook mutations durably implement the header. API-client create/rotate deliberately do not: replay would require retaining recoverable plaintext, contradicting their hash-only, shown-once security contract. API-client revoke uses unkeyed natural convergence. No API-client call sends, accepts, or declares a decorative key, and existing domain body keys remain compatible. |

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

**A second crash on 2026-08-13, on a different run, corroborates the stdout-pipe mechanism.** The
platform lane's occurrence — hosted run `31747167652`, now written up in `GAP-017` itself — is the
one that names the cause: `workerd` died *writing to its own stdout*, the pipe Playwright's
`webServer` capture holds, after fourteen minutes of logging a `request.denied` line per
unauthenticated poll. This is a separate run with the same signature, and it is recorded because
two independent sightings hours apart are worth more than one.

`gate:browser` on PR #188 at `86662d3` failed 2 of 70 — both in `speaker-portal.spec.ts`, which is
simply what was running when the Worker exited. `workerd` raised
`kj/async-io-unix.c++:186: disconnected: ::write(...): Broken pipe` repeatedly, `wrangler dev exited
with status 1`, and every later request is `connect ECONNREFUSED`. The same suite had passed locally
at the same commit minutes earlier, and a re-run of the unchanged job passed.

Two things it adds to the write-up in `GAP-017`. **It reached a single-tenant GitHub runner**, one
checkout and one suite, so for the runtime dying mid-run concurrent worktrees are not a necessary
condition. And it says nothing about the ephemeral-port occurrence below, which measured something
different — `EADDRNAVAIL` inside `npm run reset`, before the suite started, under seven `workerd`
and ten `vite` processes. That is exhaustion rather than a crash, and nothing here shows it can
happen without the concurrency that produced it. Two symptoms, one entry; whoever fixes this should
not assume one cause.

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

### Issue #102 rulings

Five decisions this lane made that a later reader would otherwise have to re-derive from the diff.

**The composition root now calls `createHttpAppFrom`.** The wave's collision ruling tells every lane
to append its service as a named property on the dependency object "immediately above the existing
`createHttpAppFrom(` call". No such call existed in `apps/api/src/index.ts`: it called the positional
`createHttpApp`, whose fourth argument is sorted out at runtime by testing for a method on it and
which has no slot for a service added after it was written. `app.ts` already documents
`createHttpAppFrom` as the form new code should use, and this lane may not edit `app.ts` — so the
call site was converted, argument for argument, with no change in behaviour. Every later lane's
addition is now the one-line append the ruling assumed. On a merge conflict here the resolution is
one converted call plus both lanes' properties.

**One entry in `context/architecture.json` had its `reason` corrected, and nothing was added.** The
entry for `apps/api/src/application/events/public.ts` said "No cross-domain import reaches it today
— consumers still use event-service.ts". That sentence stopped being true the moment
`application/cfp/template-slice.ts` imported the slice port from it, which is precisely the "future
consumer targets it rather than deep-importing" the same sentence anticipated. The allowlist itself
is untouched: no path was added, no boundary widened. Events declares `EventConfigurationSlice`,
each domain implements its own slice, and `index.ts` binds them, which creates no crossing to
exempt.

**`ACC-EVENT-TEMPLATES` is a new row rather than an edit to `ACC-IDENTITY-EVENTS`,** per this
document's own override of the lane prompt, and it is the more honest claim besides: reusable event
configuration is a different journey from the identity and event foundation, and #12 owns that row.

**`created_by` and `applied_by` carry no foreign key.** `defineEventsSchema()` is constructed first
in `schema/registry.ts` because identity-access's tables reference `events` and `organizations`, so
a declared reference back to `users` is a cycle the registry cannot build. A migration-only foreign
key would be a constraint the Drizzle declaration does not describe, and `npm run schema:check`
compares foreign keys — so the columns record provenance without pretending to enforce it, and both
the migration and the schema fragment say so.

**The lane's four pull requests became one, at the requester's direction.** The prompt splits issue
#102 at the architecture's own seams and each split would have been independently green; the
argument against one large change was made and the decision went the other way, which is the
requester's to make. What that costs is real and worth naming: the template store and the CFP slice
cannot land while the console surface is still in review, and a reviewer reads six slices at once.
What it buys is that the seam and every implementation of it are reviewed together, which is where
a port's shape is actually judged.

**Speaker task checklists shipped rather than being deferred.** They are new product surface, not
export of existing state — every task in the system is bound to a `speaker_profile_id`, so nothing
checklist-shaped existed to clone. `speaker_task_templates` (migration `1405`, content-owned), the
commands that author and instantiate one, the routes, and the seed all landed, so the category is
genuinely populated rather than a preview line that always reports zero. It has **no console
authoring surface**: an organizer reaches it through the API only, and the scorecard row says so.

`GAP-023` records the limit that survives all of it: applying is not atomic across domains, and a
`partial` application is not surfaced anywhere after the response that reported it.
### Issue #141 rulings

**One shared file the wave plan did not assign: `tools/tests/check-schema-drift.test.mjs`.** It
asserts a literal census of domain-owned tables ("the registry and public aggregate expose all *N*
domain-owned tables", and the same `N` again in the body), so **any lane that adds a table must
bump it**, and this wave's migration assignments give several lanes a new table. That makes a
conflict likely, and no "take both sides" rule can resolve it, because the two sides are different
numbers and neither is right on its own. **Resolution: take neither; set the count to the number of
tables actually declared after the merge, and re-run `npm run schema:check`, which prints the true
count.** #141 raised it from 55 to 56. (Which other lanes actually add a table is a prediction from
the wave plan, not something #141 can observe — the branches do not exist yet. The resolution rule
holds regardless of how many of them land.)

**The backfill was written rather than deferred, so the fallback in the lane brief is unused.** The
CTE in `1601` is asserted equal to folding `nextSessionScheduleRevisions` over the same rows, both
on a hand-built history covering every branch (`d1-agenda-repository.integration.test.ts`) and on
2,000 generated histories per run — 1,000 seeds carrying two events each — in
`apps/api/test/agenda-backfill-parity.test.ts`, which is in the unit suite and therefore
re-runnable and CI-enforced rather than a one-off. That test also asserts its generator still
reaches the cases that *discriminate* the two implementations: empty boards, dangling slot
references, returns after absence, double placements whose copies resolve differently, and
sessions still in force whose room the final snapshot dropped. Counting shapes rather than
discriminating cases is what let two mutations of `1601` survive the suite in the first place.

The self-healing watermark read described as the honest second choice was therefore
not needed for the backfill; what replaced it as the residual risk was recorded as `GAP-024`, and
issue #169 has since closed it — with a watermark read that *is* self-healing, plus a trigger that
moves the watermark for writers the application never sees. See "Issue #169 rulings" below.

**`agenda/public.ts` is now edited as predicted.** `ContentAgendaInterface.publishedSessionSchedules`
is expressed as `ReadonlyMap<string, SessionScheduleRevision>`, which is structurally identical to
the `PlacedSessionTime & { revision; revisedAt }` it replaces — no file under
`application/content/` or `application/communications/` needed a change, which was the contract
test for this lane. A lane appending to this file should add its export below the interface and
edit nothing above.
### Issue #169 rulings

`GAP-024` is closed and its entry is deleted from [known gaps](../quality/known-gaps.md). The
register does both — `GAP-009` and `GAP-011` are kept in place and annotated as closed, while
`GAP-007`, `GAP-015` and `GAP-018` were removed — so deletion is a choice rather than the house
style, and the reason for it here is that nothing of the entry survives as a limitation: detection,
repair and a test that a desynchronised table is detected rather than served are all present, and
the residuals that remain (no console surface; a directly edited table is found only when somebody
asks; a repair cannot retract mail already sent) are carried in the `ACC-AGENDA` row where the rest
of this surface's limits already live. An earlier draft of this paragraph asserted a convention the
register does not follow, which is the kind of claim this ledger exists to keep honest.

**The detection had to be in the database, not in the application.** The invariant #141 relied on —
"every writer of `agenda_publications` also maintains `agenda_session_schedules`" — was convention,
and the two ways it breaks are precisely the ways application code cannot see: the *old* Worker
committing publications during the deploy window, after `migrate:remote` and before the upload, and
any future direct writer. A trigger belongs to the database the migration has already reached, so it
fires for both. It cannot make an unmaintained insert *impossible* — the derived rows are a fold
over the whole history that no `CHECK` can express, and a trigger cannot see statements that come
later in the same transaction — but it makes one impossible to go unnoticed, which is the strongest
thing available and is enough, because everything downstream now re-derives before believing.

**Repair runs on all three paths, and the reasoning differs for each.**

- *On every read.* Not because reads should write, but because of what this particular read decides:
  whether a speaker is mailed an invitation to a session the programme does not schedule, and
  whether the invitation that puts a returning talk back on their calendar is suppressed. Mail does
  not roll back. The check is one indexed row in the same `batch` as the rows themselves, so the
  steady state costs a round trip's share of nothing and the replay happens only when the history
  really has moved.
- *On the existing cron.* For the events nobody reads, bounded at twenty a tick, because each
  repair replays one history and an unbounded sweep would reintroduce on a schedule exactly the
  cost #141 removed.
- *On demand, as two routes.* Because the watermark can only ever notice that the *history* moved.
  A derived table edited directly leaves it undisturbed, and only a full replay finds that. And
  because an operator must be able to ask "is this event sound" without the asking changing the
  answer, which is why the `GET` writes nothing, including the watermark.

**The masking objection is real and is answered by noise, not by inaction.** An automatic repair can
hide the write path producing the drift: a future importer writing publications directly would be
corrected forever and look correct. Leaving the damage in place is not the alternative it appears to
be, because nothing surfaces the condition — an organizer pressing Send is shown a count and no
error in either direction. So every repair logs `agenda.schedule.drift_repaired` with both
watermarks and the three divergence counts (not the session ids: that line reaches a shared sink).

**The observer belongs to the repository, not to the sweep, and review is what settled that.** The
first version wired it to `sweepDriftedSchedules`, which made the claim false for the path that runs
most: a read repairs the instant anybody opens the workspace or presses Send, so the tick only ever
reaches events *nobody read*. An importer corrupting an actively used event would have been repaired
silently forever and logged nothing — precisely the hypothetical the logging exists to answer.

**And "a healthy deployment logs nothing, ever" needed qualifying**, because this very migration
contradicts it: `1602` leaves every already-published event unclaimed, so each one is repaired once,
with all three drift counts zero. The counts are what separate the two, and the operator rule is
stated in those terms rather than in terms of the line's existence.

**`1602` marks every already-published event as *unverified*, not as current.** `1601` derived the
table from the whole history one migration earlier and it almost certainly still matches — but the
deploy window is open while the two migrations run, and a migration that asserted "already current"
would put the first false statement into the very table whose purpose is to be believed. The cost is
one replay per published event, taken by whichever path reaches it first — a read, or the sweep at
twenty events a tick, so ⌈N/20⌉ minutes for the events nobody reads rather than a single sweep. The seed, by contrast, *does* claim
the watermark, because the seed genuinely maintains the derived table; without that the demo fixture
would start life flagged as drifted.

**What review changed, and it was not the design.** Five adversarial passes ran in three rounds
against the risk map. The mechanism, the migration, the trigger pair and both `GAP-024` failure axes
survived every one. Nothing else about the repair path did, and the sequence is worth recording
because each round found the previous round's *fix* incomplete rather than finding new ground.

*Round one* found the repair's write ordering: `rebuildSessionSchedules` rewrote the
rows unconditionally and guarded only the watermark claim, and a D1 batch does not abort on a
zero-row `UPDATE` — so a repair that lost its race to a concurrent publication committed a stale
prefix of the history *underneath* a watermark that publication had already marked current. That is
verbatim the undetectable divergence this change exists to prevent, manufactured by the repair path
itself, and it was found with a reproduction rather than by reading. Every statement of a rebuild
now carries the guard, so a losing attempt writes nothing at all. Two test gaps went with it: no
history exceeded one replay page, so a one-character mutation of the paging terminator silently
truncated every long history and then claimed the watermark for it; and the lost-claim branch was
never driven, so `=== 1` could be mutated to `>= 0` with a green suite. Both are pinned now.

*Round two* verified those repairs and found two of them incomplete. The repair observer had moved
onto the repository class but had never been given to the repository the **request path** builds —
so read-path repairs, which are most of them, were still silent, and the four canonical statements
round one had corrected were false again. And when every attempt lost its race, `reconcile` served
the *stored* rows while the comment above it said it served the replayed ones; the value handed back
was the phantom row, with `drift.phantom` non-empty in the same object, delivered to the
calendar-invite read by the method that had just detected it. Round two found that by probing the
returned value rather than by reading the comment. It also found `publish`'s conditional claim — the
half the counter redesign added — unpinned, with two independent mutations surviving the whole
integration suite.

*Round three* verified those, found both closed, and found a false claim in a canonical document:
the scorecard and the adapter both called the watermark claim "the one affected-row count in this
adapter", when `updateDraft`'s optimistic revision check is another. It also found `contended`
counting an event that a read had healed between the sweep's listing and its repair — reporting
contention for an event that lost no race — and five more mutants that no test killed.

The two composition-root defects are the same defect twice, so the fix is structural rather than
another test: `agendaRepository(...)` in `index.ts` attaches the observer once, and both
compositions call it. `index.ts` is untested by construction here, and two independent argument
lists that must agree is exactly the shape that keeps not agreeing.

**Fifteen mutants of the shipped SQL and TypeScript are now killed by the suite**, each one named by
a review pass that found it surviving.

**The watermark counts writes rather than naming a version**, which is the same review's doing. A
version-valued token cannot distinguish a publication inserted out of order — issue #169's own
"nothing checks that a publication's version is the event's newest" — from no write at all, so the
next ordinary publication would fold past it and mark the event caught up. A counter cannot be
fooled that way, and `publish`'s claim is now conditional on it, so a write by anybody in that
window leaves the event flagged instead of silently sound.

**Two agenda debts closed here rather than left for a later lane.** `DEBT-008` (an empty board read
the timezone abbreviation at `new Date()`, so a January conference announced itself as PDT in July)
and `DEBT-009` (the week board recomputed every slot's calendar day in every cell). Both are agenda's
own, both are in agenda's own files, and both now carry the regression test the register asked for —
`DEBT-008` closes differently from how its row anticipated, because rendering "the event's"
abbreviation needs event dates that `EventDto` does not carry, so the board names no abbreviation at
all. Also deleted: `apps/web/src/AgendaWorkspace.tsx`, a one-line re-export shim left over from
#70's decomposition that every consumer imported through.

**#131's NUL-byte gate is still worth having, and this lane proved it again.** A template literal
written into `AgendaWorkspace.tsx` during this work carried a literal NUL as its separator, turning
the file into a binary blob exactly as `D12` describes — `file` said `data`, and `grep` silently
matched nothing while `sed` printed the text. It was caught within minutes because the separator was
also read back wrongly, but nothing in `npm run check` would have caught it. The gate lives in
`tools/`, which is platform, so this lane did not add it.

### Issue #99 rulings

**The composition root now calls `createHttpAppFrom`, and it had to.** `apps/api/src/index.ts` was
still on the deprecated positional `createHttpApp(...)` — fourteen positional parameters, one of
which is sniffed by testing for a method on it. There is no fourteenth-and-a-half slot for a new
service, so a lane adding one has exactly two options: widen the positional signature in
`transport/http/app.ts`, which the collision ruling forbids #99 from touching, or move the call to
the named form `app.ts` already exports and documents as the replacement. This lane took the
second. The change is mechanical — the same services, by name — and it is what the coordination
document's own instruction ("add your services to the dependency object as new named properties
appended after `itineraries` and before `build`") presupposes. Later lanes should find the object
they were told to append to. `createHttpApp` itself is untouched and still exported; the API test
suites that use it still pass.

**One dependency field, not three.** The lane prompt for #99 asks for `search?: PlatformSearchService`
on `HttpDependencies`; the coordination document assigns #99 exactly one field, `platformOps?:
PlatformOperationsService`. The coordination document wins, because the reason for the rule is
cross-lane merge surface rather than this lane's convenience. `PlatformOperationsService` is
therefore the single service the transport takes, composing search now and the inbox and audit
timeline in the later phases, with each capability in its own module.

**Sources are declared as ports here, not imported as services.** `application/platform/` states the
narrowest shape it needs from each domain — `ContentSource`, `ReviewSource`, and so on —
and the real services satisfy them structurally where the composition root binds them. This is the
same inversion `ContentAgendaInterface` and `OutreachDispatchPort` already use. Two consequences
worth naming: platform holds no import of another domain's concrete projection types, so the
cross-domain import gate has nothing to allow beyond what already exists; and a domain that changes
one of those shapes breaks the build at the binding site in `index.ts`, which is where somebody can
see all six at once.

**`/search` sorts above `/abstracts` by grouping, not by number.** The coordination document assigns
#99 the `order` band 5–9 and also says "above abstracts", whose `order` is 1. Both are satisfiable
at once and the apparent conflict is not one: the sidebar groups by `NAV_GROUP_ORDER` first and
sorts within a group second, so `/search` at `order: 5` in the `home` group renders above the whole
`Program` group. The assigned band is used as written.

**What #99a does not claim.** Search opens the workspace that holds a record, not the record — the
console has no per-record routes at all, and `GAP-022` owns both that and the fact that the in-memory
filtering is proven bounded only against the seed. The inbox (`99b`) and the audit timeline (`99c`)
are separate phases with their own rows; `ACC-OPS` covers search alone until they land.

#### 99b — the inbox

**Items are derived; only a dismissal is stored.** There is no work queue and nothing marks an
item done, so completing a task or placing a session removes its item with no write and no
possibility of the surface disagreeing with the domains it reads. The one stored thing is a
dismissal, and its key carries the *occurrence* rather than the record — a task's key includes its
deadline, a delivery's its attempt count — so a re-derived identical item stays dismissed while a
moved deadline comes back. That is also why `item_key` is opaque text with no foreign key: the
conditions it names live in five other domains, and a reference into any of them would be platform
holding a pointer at another domain's row.

**Dismissals are per actor.** A dismissal that hid an item from every organizer would let one
person silently remove work from a colleague's list. The primary key is
`(event_id, item_key, actor_id)` for that reason, and the service suite asserts it.

**Four of five categories populate from the seed, and the fifth honestly cannot.** The seeded event
is published and its draft matches its snapshot, so nothing is awaiting publication — which is the
correct answer, not a missing fixture. #99 is not permitted to add a platform seed fragment, so
rather than assert a row into existence the browser spec creates an event and reads its inbox,
exactly as `publishing.spec.ts` creates its own event for the same reason. The scorecard says this
in as many words.

**`tools/tests/check-schema-drift.test.mjs` moved from 55 to 56 tables.** That count is hard-coded
in a platform-owned self-test, and the number is the point of the assertion, so adding a table
means updating it. Any lane adding a table this wave will hit the same line.

**`platform_inbox_dismissals` cascades, and the coordination rules stand.** The wave document
says #99 must not add a platform seed fragment and must not edit `tools/compose-seed.mjs`. It does
neither, and the first attempt at this fix did both before being backed out.

The defect was real: the table references `events(id)` and `users(id)`, `seed/reset.sql` is a full
teardown of both, and D1 enforces foreign keys. A single dismissed inbox item made **every
subsequent `npm run reset` fail** with a bare `FOREIGN KEY constraint failed` naming no table — and
both Playwright configs bootstrap through `npm run reset`, so `gate:browser` stopped coming up
before a spec ran. Reproduced against a real Miniflare D1.

A cleanup fragment fixes that and breaks something else, which is why it was withdrawn: the seed
has to stay applicable at migration `1801`, because `d1-publication-repository.integration.test.ts`
applies it there to prove `1802`'s guard refuses a pre-existing collision. A `DELETE` against a
table introduced at `1900` cannot run at that point, and the D1 suite says so. **Any lane adding a
cleanup fragment for a table created after `1801` will hit this**, and the cascade is the general
answer rather than a special case.

`apps/api/test/d1-platform-repository.integration.test.ts` carries the gate that was missing: it
seeds a database, dismisses an item, and re-applies `reset.sql`. Confirmed by removing the cascade
and watching it fail.

**The section-degradation rule now lives in one place.** `application/platform/section.ts` holds the
three-state classification and `transport/http/routes/platform.ts` holds one `wireSection` helper,
both shared by search and the inbox. Two copies of that rule is how one surface ends up refusing
where the other omits, or logging what the other does not.

#### 99c — the audit timeline

**Attribution needed a per-request holder, and here is why.** The lifecycle ports the composition
root binds — `speakerNotifications`, `reviewNotifications`, the agenda's publication batch — carry
no actor, because they report facts rather than commands. Recording every audit row as `system`
would have made "correct actor and source" false, so platform's own route module mounts one
`app.use("/api/*", …)` that hands the resolved actor and correlation id to `platformOps` before any
route runs, and the writers read it. That is safe because the Worker constructs every service
inside `fetch`: one holder per invocation, and two concurrent requests cannot see each other's. It
is also the one middleware this lane adds, mounted inside `routes/platform.ts`, which is the
pattern the coordination document already blesses for #100-PR3's version header.

**No foreign keys on `platform_audit_records`, deliberately.** An audit record has to outlive the
thing it describes; one that vanished when its event was deleted would be missing exactly when
somebody needs it. The consequence is that the seed reset — a full teardown of `users`,
`organizations` and `events` — neither removes audit rows nor is blocked by them, so records
accumulate across runs of the local fixture. That is what an append-only log does, and it is why
the browser spec creates its own event instead of asserting against the shared demo one. It is
also why the DELETE trigger cannot fight the reset: nothing cascades into this table.

**Four domains at 99c, five at 99d.** Review, content, agenda and communications are hooked
through ports that already existed, with no edit to any other domain's application code.
Publishing had no port on `PublicationService.publish` to record through, and adding one is an
edit to publishing — which this lane's own prompt assigns to PR 99d, where it lands. Each PR's
scorecard row states the count that is true of it.

**`tools/tests/check-schema-drift.test.mjs` moved from 64 to 65 tables**, and the two append-only
triggers are declared in `UNMODELLED_OBJECTS` in `tools/check-schema-drift.mjs`, because Drizzle
cannot express a trigger and the gate refuses one that is not acknowledged.

**A reinstated decision *is* recorded, and getting there took three attempts of which two were
wrong.**

The audit key for a decision wants an occurrence component: accept, decline, accept again is three
decisions, and the outcome carried in the action separates only the first two. The first attempt
used the recorder's own clock, which the spec forbids outright — `ReviewService.decide` documents
re-deciding as how a half-finished decision heals, so a retry would have written a second permanent
row for one decision. The second attempt added `decidedAt` to `ReviewNotificationPort` and took the
instant from the fact instead. That changed nothing: `decide` recomputes `decidedAt` on every call,
including the retry, so the "fact-derived" instant was the attempt's clock one layer down. The port
change was backed out rather than left in place looking like a fix.

Distinguishing a retry from a reinstatement needs something monotonic that a real decision advances
and a retry does not, and a stored `ProposalDecision` had no such field. The third attempt gives it
one: migration `1311` adds `revision`, advanced inside the upsert **only when the outcome changes**,
which is exactly the definition of a new decision. Storage allocates it and `RETURNING` hands it
back, so two organizers deciding at once cannot both read the old value and write the same new one.
`decisionRecorded` reports it and the audit key uses it as the occurrence, so a retry converges on
one record and accept → decline → accept produces three.

That is a review-domain change with its own migration, which is beyond what this lane was scoped to
touch, and it is deliberate rather than incidental: keying the log on anything the review domain
already had would have been wrong in one direction or the other, and shipping either would have put
a false statement on an append-only table. It is announced here for the same reason the publishing
port is, and it lands in its own commit so a lane rebasing around review can take or leave it
independently of the rest of #99.

#### 99d — the one edit that leaves platform's files

**Announced before starting, as the coordination rules require, and it is one domain rather than
three.** The lane prompt named three candidates; building 99a–99c settled each of them:

- **CFP — not needed.** The prompt guessed CFP might owe an organizer-wide proposal list. It does
  not: review's `organizerWorkspace` already carries the proposals that both search and the inbox
  read, so nothing was added to `cfp/public.ts`.
- **Communications — not taken, deliberately.** `history(actor, organizationId, eventId, {limit})`
  answers both the delivery search section and the failed-deliveries inbox category. The real
  limitation is that failures beyond the first page of history are invisible to the inbox, and
  that is a bounded-cost decision rather than a missing projection — the existing surface *can*
  answer it by paging. It is also the file `#100-PR2` owns this wave. Recorded in `GAP-022`
  instead of edited around.
- **Publishing — taken.** `PublicationService.publish` had no seam to observe, which is why the
  audit timeline covered four domains and not five. Publishing now declares its own
  `PublicationNotificationPort` — the same inversion `SpeakerNotificationPort` and
  `ReviewNotificationPort` already use — and the composition root binds it. Publishing gains no
  knowledge of auditing and no import of the platform domain; the port is optional, so every
  existing composition behaves exactly as it did.

`apps/api/src/application/publishing/public.ts` gains **one appended re-export line at the very end
of the file**, per the collision ruling, so a lane rebasing around it moves nothing above it.

### Issues #178 #179 #180 #173 rulings — the platform follow-up lane

Four issues #99 left behind, taken as one pull request. Five decisions a later reader would
otherwise re-derive from the diff.

**The two attribution issues were closed structurally rather than with a test guarding folklore.**
#178 offered either option; the structural one is available and cheap, so it was taken.
`RouteModule` gains an optional `registerRequestScope`, and `app.ts` runs every module's before it
registers any module's routes — so middleware a domain needs ahead of *other* domains' handlers no
longer depends on where its module sits in an array. Platform's attribution middleware moved into
it, the registry's comment now says the order decides route matching and nothing else, and
`createHttpAppFrom` takes an optional module list so the regression test can build an app with
platform registered **last**. Both mutations were verified to fail the new tests: swapping the two
loops in `app.ts`, and removing the holder's ambiguity guard.

**#179's answer is that the holder refuses to attribute rather than guessing.** `RequestIdentity`
became `begin`/`end` — a scope the transport ends in a `finally` — and a scope opened while another
is still open reports through a required `report` callback and answers `actor(): null` until the
last one closes. Failing the request outright was considered and rejected: hoisting service
construction is a mistake to report loudly, not one to turn into an outage, and `PRD-OPS-003`
already says a record with no request behind it names nobody. A second, unlooked-for fix came with
it: the holder is now empty *between* requests, where it used to keep the last actor indefinitely.
The concurrency test needed a barrier — the first version passed against the very design it was
written to refuse, because `AuditRecorder.prepare` reads the holder synchronously and a handler
that never yields cannot observe another request's actor.

**#180 took no migration, and deliberately.** The lane's assigned block is platform `1900–1999`, but
the fact #180 needs is agenda-owned — the issue says so — and an agenda table in platform's block
would break the per-domain rule in `apps/api/migrations/README.md`. The occurrences live in
`agenda_drafts.draft_json`, which is agenda's own opaque JSON, advanced by a pure domain fold
(`advanceBoardOccurrences`) inside the same optimistic `UPDATE` that changes the board. So: no
migration number taken in any block, no `table-ownership.json` edit, no schema-drift count to bump,
and a lost compare-and-set re-folds against the board that actually committed. This is the same
shape as `nextSessionScheduleRevisions` (#141) one level down.

**The occurrence is per session, not the board revision.** The closure condition allowed either. A
board revision in the key is correct and useless: every dismissal on the programme would evaporate
the moment anybody dragged a card. What is stored instead is, per session, the revision at which
that session's placements last changed, plus one **per slot** for when that hour was last
retimed; a conflict takes the later of its two placements' and its two slots'. That second number
was narrowed three times across three review passes, and every narrowing is one argument:
`conflictsFor` reads slot *times* and ids that already live on the placements, and reads neither
the room list nor the tracks. So the first version, which counted every resource edit, reopened
every dismissed conflict on the event when somebody added a room; the second, which compared the
whole slot list, did it when somebody added a slot nothing was placed in; and the third, one
number for all slots, did it when somebody retimed an hour three rooms away from the clash. Each
is the same promise failed one size smaller, which is worth naming as a pattern: a number that
advances for an edit no derived condition can read will always resurface decisions about
conditions that edit cannot affect. What is left is the case that is real — a slot that keeps its
id and moves in time, compared as an *instant* so that re-spelling `16:00:00.000Z` as `16:00:00Z`
is not a retiming. `MISSING_SESSION` excludes the slots for the same kind of reason.

**Nothing is backfilled, and that is the visible cost of taking no migration.** Every programme
dismissal recorded before this reads as occurrence zero, so its item returns open once on deploy
and the old row stays in `platform_inbox_dismissals`. It is the conservative direction — the
surface asks again rather than hiding something nobody has seen — and it is now stated in
`PRD-OPS-002`, the interface docs and `GAP-022` rather than left to be discovered. The same
absence is why `AgendaRepository.getDraft` now promises the field and both implementations
normalize **on read**: `savePlacements` answers with the board it read whenever a plan seats
nothing — every session already placed, or nothing left that fits — and that path served a draft
with no `occurrences` to a console whose response contract now requires one. Caught by the review
pass, not by a gate: `tsc` sees an optional field and `openapi:check` sees a schema, and neither
knows which producer skips normalization.

**`occurrences` is on the wire, and eight web fixtures were updated for it.** The console does not
read it, so hiding it from the response was the tempting alternative; it was rejected because the
route returns the draft projection as it is, and a contract that omitted a field the response
carries would be wrong in the direction that costs the most. The publication snapshot omits it
along with the conflicts — both describe the draft, and two publications of one board should be
identical bytes.

**#173 also normalizes each fragment's leading blank lines, which the issue did not ask for.**
Several fragments open with a newline to compensate for a neighbour that lacks a trailing one: a
separator maintained by hand, in the wrong file, that stops working the moment the composer's list
is reordered. The composer now trims both ends and joins with one blank line, so every boundary
looks the same. `apps/api/seed/reset.sql` was also added to `tools/review-risk.mjs`'s `GENERATED`
list, which it always belonged in and which its new header now makes checkable.

### Issues #177, #175 and #176 rulings

The three minors #102's own lane split out, worked as one pull request in that order. Five
decisions a later reader would otherwise re-derive from the diff.

**`createTemplate` is gone from the repository port, replaced by `createTemplateWithVersion`.**
The narrow fix for #177 was a batch inside `saveFromEvent`; the fix taken removes the shape
instead. A template with no versions is not a lesser template, it is a husk — listed with an
empty version select, refused for duplication, answering 404 for every apply, and holding its
name against the partial unique index — so the port now offers no way to write one. That forced
the capture to move *before* the first write, which is the real content of the fix: the six
cross-domain slice exports used to run between the two writes and were the widest window in the
file. The name-conflict mapping had to be re-established for the batch, both from a rejected
promise and from an unsuccessful result, which is why the issue called this not a mechanical
lift.

**The version number is allocated inside the insert, and `nextVersion` is gone with it.** Not
scope creep but the same defect: `nextVersion` then `createVersion` is a read-then-write race, so
two organizers capturing one template at once both read the same number and the loser tripped
`UNIQUE (template_id, version)` — a 500 describing a constraint for a request with nothing wrong
with it. `INSERT … SELECT … RETURNING version` decides it in one statement, exactly as `1311`
does for a decision's revision. Three test call sites lost an explicit `version: 2` that the
store now allocates.

**#175 is surfaced in the templates workspace and deliberately not in the platform inbox.** The
issue's closure condition is that a `partial` application is surfaced where the organizer will
see it with the repair one action away, and the workspace is where applying already lives. An
inbox category would reach an organizer who never opens that page, and it is the better home —
but it is a sixth category on **platform's** product surface, needing a new port in
`application/platform/sources.ts`, a key in `inbox-service.ts`, a binding, contracts and the
inbox web surface. That is a product decision about platform, not about events, so `GAP-023` was
narrowed to record it as the residual rather than filed as a new issue: the issue it belongs to
is closed by what shipped.

**The stored outcome gained a `selection` field.** A repair has to be the same act as the
application it repairs. `outcome_json` recorded the categories' results and the destination range
but not which categories the command *named*, so re-applying a two-category clone would have
written all six. Absent on rows written before this, where it reads as "no selection recorded",
which is the honest reading of a row that never stored one.

**#176 added three content commands rather than reusing `importTaskTemplates`.** The bulk
declaration writes at `(event_id, title)`, which is right for a clone — a checklist arriving in
another event has nothing else to converge on — and a trap for a person: an organizer who
mistyped a title cannot correct it that way, because the corrected title writes a second line and
nothing there removes the first. Authoring therefore addresses the row. A console surface where
a typo is permanent is not a console surface, so the delete and the rename are part of closing
the issue rather than an expansion of it.

**And one shared file: `apps/web/src/styles/content.css`.** The checklist editor shares the
resource editor's selectors rather than copying them, so the two panels cannot drift into looking
like different products. A lane editing that file should expect the roster rules to name both.

## Wave 5 publishing ruling — one live programme, versioned (#205, #192)

Publishing the site is the act that establishes public presence; publishing an agenda is not.
After a site is live, `EVT-SCHEDULE-PUBLISHED` carries the exact agenda snapshot into publishing's
own composer, and publishing contributes its own opaque statements to the agenda batch. The agenda
therefore neither imports publishing storage nor creates a site, while a successful schedule
publish and the public projection become visible together. A schedule publish for a never-published
or currently unpublished event remains private.

Each activated public composition has a per-event monotonic version and source provenance: agenda
version/time, CFP version/time, a digest of the allowlisted content projection, and the activation
cause. The active row is the serving pointer; `public_event_projection_versions` is immutable
history. CFP and content have no durable publication-event seam, so a public read reconciles those
narrow application projections before serving and appends a version only when public bytes or
provenance changed. Event/site-owned draft fields are deliberately preserved by source refresh and
still require an explicit site publish.

The public event response, schedule endpoint, pages, configured embeds, JSON feed, and itinerary
all consume that one active projection. The deterministic seed now demonstrates two scheduled days,
and session discovery combines text across sessions and speakers with Track, Format, and Location
facets. The itinerary embed reads a shared capability-token plan without introducing an attendee
account or copying private data.

### Issues #164, #166 and `GAP-019` rulings — the sign-in-before-Google lane

All three are one lane because they are one precondition: the deployed demo cannot offer Google
sign-in until a real account is safe on that database, and neither race can be left open once one
can exist.

**The demo reset's guard reads the data, and its SQL lives in the domains that own the tables.**
`tools/remote-demo-reset.mjs` belongs to `platform`; `organizations` and `events` belong to
`events` and `users` to `identity-access`, so the command composes its count query from
`events-fixture-statements.mjs` and `identity-fixture-statements.mjs` rather than writing it —
the pattern `identity-revocation-statements.mjs` set for `revoke-sessions`. A tool is not exempt
from the boundary, and `npm run context -- check` enforces it by text, including in tests: two
integration tests were rewritten to drive domain services instead of raw SQL for that reason.

**Fail closed, and prove it by attempting the destructive thing.** Every inconclusive answer —
unreachable database, non-zero wrangler exit, unparseable output, a missing or non-integer column —
refuses. `demo-reset-guard.integration.test.ts` runs the shipped query against a real seeded D1,
refuses on a database carrying a self-serve signup, and then applies `seed/reset.sql` to that same
database to show the rows really do disappear. A guard whose refusal is never demonstrated to be
about something real is a comment.

**The override names the counts.** `--destroy-real-data <organizations>/<events>/<users>` must
repeat exactly what the refusal reported, is separate from `--confirm`, and cannot be reached
without first being shown the numbers. `--confirm` was not widened to carry it: one flag says which
deployment, the other says that destroying real rows there is intended.

**Both first-sign-in races are closed by storage, not by ordering.** The events domain declares a
`provisioning_key` on `events` (migration `1101`, events block) with a partial unique index per
organization, so the second concurrent first-event writer loses and adopts the winner's row; the
identity batch's own uniqueness already decided the account, and the loser now discards the
organization it created and signs in as the winner. Reads cannot close either race, and this
product has no delete for an event or an organization — so the only repair is prevention.

**The organizer grant travels in the event's own batch.** `event_roles` is identity's table, so
`D1EventRepository` takes a statement writer (`preparedOrganizerGrant`) and never learns it, the
same shape the agenda uses for `EVT-SCHEDULE-PUBLISHED`. `EventService`'s `grantOrganizer`
dependency is gone: an event whose creator holds no role on it is not a state this path can leave.

**One browser, several sign-ins.** `greenroom_oauth` carries a capped set of attempt ids rather
than one, and a callback spends only the attempt its `state` proof identifies. The cookie remains
the browser-binding half of the CSRF defence, and it is no longer cleared before the attempt is
identified — that was what let an older tab's failed callback destroy a newer tab's live sign-in.

**One outcome is told apart from a refusal, deliberately.** A failure that is ours lands on
`/signin?auth=unavailable`. It names no check and so hands a forger nothing; what it buys is that
somebody whose sign-in broke on our side is not told to check an account that is fine.

**The review turned up one thing that was not a regression and was fixed anyway — and its first
fix was wrong, which is the part worth carrying forward.** `completeWorkspace` adopted "the
organization's first event" when a user held a membership and no event role, a state an
**organization-level invitation** produces (and so does revoking somebody's only event role), not
only a failed signup. A member reaching it and then signing in with Google was handed
`events:settings:update`, `agenda:manage` and `review:manage` on somebody else's event.

**Two repairs were tried and rejected before the third, and that sequence is the lesson.** The
first keyed the adoption to the organization; a review pass reproduced the escalation straight
through it, because **every** organization a self-serve signup created carries a provisioned first
event for ever, so an organization-scoped key answers "yes, provisioned" to whoever joins later.
The second adopted only what *this person* provisioned and otherwise provisioned into any
organization holding no events — which made a newcomer the organizer of somebody else's *empty*
organization, and stranded its owner, whose own next sign-in then found it non-empty.

What shipped is smaller than either: **completing a workspace provisions, and never adopts.** One
condition, both halves of it a permission — an organization with no events *and* no other member is
a workspace this person owns and has not been given an event in. Adoption still happens one layer
down, inside `provisionFirstEvent`, for a caller that is provisioning *now*, which is what makes
two tabs converge. The member count is identity's own read: `organization_memberships` is its
table, so the events domain cannot answer that half.

Two consequences are deliberate and worth stating rather than discovering. A **revoked** event role
is not restored by signing in again — "somebody revoked my only role" and "my signup stopped early"
are the same state seen from here, and the old rule silently reversed the revocation on the next
Google sign-in while the emailed-code door left it revoked. And a signup whose organization has
since gained an event or a second member is not resumed; that person's membership already lets them
create an event themselves.

Two smaller notes. The loop runs over *every* organization the actor belongs to rather than
`organizations[0]`, which is a sort order rather than a choice. And the subject inside the
provisioning key is now defence in depth rather than the guard: no caller can reach
`provisionFirstEvent` with another person's key in play, because the precondition above admits only
a sole member — the key's job is to make two callbacks *for one person* converge.

**Two more from the same pass, both about the guard's own honesty.** Migration `0002` plants an
`Imported organization` row that the seed never re-inserts, so the guard refused the *first* restore
against a freshly provisioned database and offered `--destroy-real-data` as the way through — the
exact habit the flag exists to prevent; migration-planted ids are now declared by the domain that
owns the table. And the command's own ordering had no test: `main` takes its two Wrangler seams as
parameters so a refusal can be shown to run nothing destructive, and so `--remote` on the count
query is asserted rather than assumed.
