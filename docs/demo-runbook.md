# Competition demo runbook

Status: canonical | Owner: quality | Governing IDs: `PRD-005`, `PLAN-002`, `ACC-DEMO-SMOKE` | Last verified: 2026-08-11 (working tree: commit `3630977`)

## What this demo is, and is not

It runs locally, from a deterministic seed, with development-only signed demo identities. There is
no production authentication (`GAP-007`) and nothing serves the built frontend against a
configurable API origin (`GAP-008`), so the product cannot yet be handed over as a URL. Local
delivery, uploads, and every provider are deterministic fakes: no message leaves the machine, and
the Accelevents integration the brief names does not exist (`GAP-012`). The honest
feature-by-feature picture is in [competition traceability](product/competition-traceability.md);
the per-journey verdicts and the commands that prove them are in the
[quality scorecard](quality/scorecard.md).

## Start from a clean checkout

Use Node from `.nvmrc`, npm 11.12.1, and a local Python supported by `uv`.

```bash
npm ci
uv sync --locked
npx playwright install chromium   # only needed to run the browser suite
npm run setup:local
npm run worktree:status
npm run reset
npm run dev
```

`npm run worktree:status` prints the two ports this checkout resolved to — they are derived from the
checkout's path, so every worktree gets its own pair and no two collide. Open the web port it names.
The reset is deterministic and safe to repeat. It restores the same event, CFP, proposals, review
assignments, speakers, CRM records, agenda, delivery history, and published projection. Local
delivery and uploads use deterministic adapters and require no live credentials.

You no longer have to find free ports by hand, and `npm run test:e2e` resolves the same pair as
`npm run dev`, so the suite tests the servers this checkout started. To pin specific ports anyway:

```bash
GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e
```

If a server from another checkout is holding one of your ports, the suite now stops before its first
spec and names the foreign path rather than testing that checkout's code and reporting the result as
yours. `/health` carries the checkout root and commit it was started from for exactly that purpose;
see [local development](engineering/local-development.md#a-test-run-proves-whose-server-it-is-talking-to).

Two instances of **this** worktree are also safe now: local D1 and R2 state lives under
`apps/api/.wrangler/instances/<api-port>/`, so a demo server on one port and the suite on another own
separate databases. That was the sharp edge `GAP-004` recorded — both processes used to open the same
`apps/api/.wrangler/state/v3/d1` file whatever port they listened on, and the suite then failed
intermittently, a different single spec each time, looking exactly like a flaky assertion rather than
a shared-database problem.

## Evaluator path

Every workspace has its own URL, so each step below is directly linkable and survives a reload.
`?event=<uuid>` selects the event workspace.

1. Continue as **organizer**. You land on **Overview** (`/`): the counts that matter, the alert
   strip, and the table of speakers with outstanding onboarding tasks.
2. **Abstracts** (`/abstracts`) — triage submissions by status tab, search, assign reviewers,
   record decisions, inspect a proposal's submitted answers.
3. **Sessions & speakers** (`/sessions`) — accepted content, speaker records, tasks, and assets. Any
   upload can be marked publishable and made private again, and any image can be named — or
   un-named — as that speaker's profile photo; both decisions are reversible. Download hands you
   the file itself, whatever its visibility.
4. **Agenda** (`/agenda`) — place sessions on the room × time board by drag-and-drop or by
   keyboard (Enter to pick up, arrows to move, Enter to drop, Escape to cancel). Switch between
   List, Day, Week, Room, Track, and Conflicts; the chosen view is in the URL. Publish the schedule.
5. **Call for proposals** (`/cfp`) — compose the public form, watch the draft diverge from the live
   published form, publish, and copy the public link.
6. **Publishing** (`/publishing`) — the public projection, end to end and without touching the seed.
   **Preview** composes the payload from the current draft and publishes nothing; **Publish** freezes
   that payload as an immutable snapshot and reveals the public link; **Unpublish** takes it down and
   the public routes — the event page, `/api/public/events/greenroom-demo-summit/schedule`, and the
   speaker headshots that snapshot exposed — go back to the standard not-published response. On a
   clean reset the seeded snapshot is exactly what Publish composes, so pressing Publish before
   changing anything is a visible no-op rather than a collapse of the page — asserted by
   `apps/api/test/d1-publication-repository.integration.test.ts` ("seeds a published projection
   identical to what the publish command recomposes"), which applies the seed in Miniflare, compares
   the composed preview with the seeded snapshot field for field, and republishes to prove the page
   is unchanged. The panel names which parts of
   the draft have moved ahead of the snapshot, so "why is my edit not on the site" is answered on
   screen. Both embed views are here with their addresses, a paste-ready `<iframe>` snippet behind a
   copy button, and a live frame of the real embed:
   - `/embed/events/greenroom-demo-summit/schedule`
   - `/embed/events/greenroom-demo-summit/speakers`

   Addresses in this runbook are paths, because the host and port belong to your checkout —
   `npm run worktree:status` names them.

   To prove this does not depend on the seed, create an event under `/settings`, select it in the
   event switcher, and publish it from `/publishing`: the slug is server-assigned and the panel
   shows the reserved address before the first publish.
7. **Speaker CRM** (`/speakers`) and **Communications** (`/communications`) — the outreach pipeline
   and the delivery outbox. From a clean reset the outbox carries one delivery in each of the
   queued, retrying, succeeded, and terminal states, with attempt history and an explicit retry on
   the terminal one; recovering it consumes that state until the next reset. Nothing here was sent:
   the seeded history is placeholder data, no lifecycle event enqueues a delivery, and the only
   provider is a deterministic fake (`GAP-010`).
8. Switch to **reviewer** — only `/reviews` is reachable. Score the seeded assignment against the
   evaluation plan; unscored criteria are refused rather than silently scored at the minimum.
9. Switch to **speaker** — only `/portal` is reachable. Complete a task, edit the profile, upload a
   private asset, name one of your own images as your profile photo, and download the calendar file.
   Choosing a headshot is not publishing it: the file keeps the visibility it had, the portal says so
   in a sentence beside the preview, and the public gallery keeps showing initials until an organizer
   marks that file publishable.
10. Switch to **public**, then open `/events/greenroom-demo-summit` and follow
    schedule, sessions, speakers, and CFP. Submit a proposal through the live public form. The two
    `/embed/...` addresses above serve the same published projection with the marketing chrome
    stripped; paste the copied snippet into any local HTML file to see it render in a real host page.

`/embed/*` is served with `Content-Security-Policy: frame-ancestors *` so embedding is pinned rather
than inherited from a browser default. Under `npm run dev` and `vite preview` the header comes from
the `greenroom-embed-framing` plugin in `apps/web/vite.config.ts`; in the built output it comes from
`apps/web/public/_headers`, which Vite copies into `dist/` and which Cloudflare Pages and Netlify
apply. A static file server that does not read `_headers` needs the same rule configured by hand.

The role switcher establishes signed development-only sessions and does not bypass application
authorization. The API refuses demo mode outside the exact development environment.

## Reproduce the evidence

```bash
npm run check          # gate:integrity + gate:test-build + gate:d1 — the same three gates CI runs
npm run test:d1        # the D1 suite on its own (already included in npm run check)
npm run test:e2e       # full browser acceptance suite — 30 tests (needs `npx playwright install chromium`)
npm run test:quality   # the fast evaluator gate — 3 tests
```

`npm run check` is a `&&` chain of gate scripts, so what it runs is what CI's `integrity`,
`test-build`, and `d1` jobs run: gate-drift, Biome/Ruff formatting, context integrity, the Python
CLI tests, lint plus the AST error policy, typecheck, generated-OpenAPI drift, declared-schema drift
against the migrations, the tool/API/component test suites with coverage, both production builds,
and the Miniflare D1 integration suite. It does **not** run Playwright or `npm audit`; those are
`npm run gate:browser` and `npm run gate:security`.

`npm run test:e2e` starts its own API and web server and resets the database first — but only when
nothing is already answering on the ports it wants, because `apps/web/playwright.config.ts` sets
`reuseExistingServer` outside CI. Point it at **free** ports whenever other servers are running, as
above; pointing it at ports something else already holds makes it reuse that process, skip the reset,
and test whatever that process is serving.

Naming one spec runs that spec and nothing else:

```bash
GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e --workspace @greenroom/web -- e2e/agenda.spec.ts
```

That is a debugging tool, **not** a clean-reset reproduction of an acceptance row, for two reasons.
First, the reset is conditional, as above: against servers that are already up it does not happen at
all — measured on 2026-08-11, that exact command passed 6 tests in 5.4s against running servers and a
fixture two full suite runs had already mutated. Second, the specs are not independent: they share
one mutable local D1 fixture at `workers: 1`, and their order is deliberate —
`00-seed-state.spec.ts` is named to sort first precisely so that the CFP republish in `cfp.spec.ts`
cannot repair a seed defect before it is asserted. One spec alone therefore proves less than the same
spec proves inside the suite. The evidence the [scorecard](quality/scorecard.md) rests on is the
whole suite, run from a reset — which is why that document names no per-row command.

The suite is re-runnable. Measured on 2026-08-11 against the current working tree: 30 tests passed
immediately after `npm run reset`, and 30 passed again against the same already-running servers with
no reset in between. Every spec either restores what it mutated or scopes its assertions to rows the
run itself created. Two exceptions are inherent and documented in the specs that carry them
(`GAP-005`): a completed evaluation and a declared conflict are terminal by design, and no affordance
returns a communication delivery to a failed state. The second of those has a consequence worth
stating plainly: recovering the seeded terminal delivery consumes its own precondition, so
`communications.spec.ts` exercises recovery only on the run that follows a reset. On the second run
it asserted the complement instead — the delivery is already queued, offers no retry control, and the
route refuses one.

Re-runnable is not the same as leaving no trace. Each run adds rows it does not remove — the event
`publishing.spec.ts` creates, the abstracts `review-workflow.spec.ts` files, the prospect
`crm.spec.ts` adds (`DEBT-007`). Run `npm run reset` before demoing to anyone.

`test:quality` checks role-aware journey discovery, that every navigation destination renders,
public semantics and labels, heading structure, mobile layout with no horizontal overflow, and two
numbers on `/events/greenroom-demo-summit`: DOMContentLoaded under 10 seconds, and fewer than 100
resource requests. Those are smoke ceilings, not a performance budget — they would catch a page that
never finished loading or an accidental hundred-request waterfall, and nothing subtler — and they are
measured against the Vite dev server, so they bound nothing about a built artifact (`GAP-014`).

If a step fails, preserve the displayed correlation reference and the Playwright artifacts under
`apps/web/test-results/`. Reset before retrying; never repair demo state with manual database edits.
