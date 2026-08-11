# Competition demo runbook

Status: canonical | Owner: quality | Governing IDs: `PRD-005`, `PLAN-002`, `ACC-DEMO-SMOKE` | Last verified: 2026-08-11 (commit `c72b796`)

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
npm run reset
npm run dev
```

Open `http://127.0.0.1:5173`. The reset is deterministic and safe to repeat. It restores the same
event, CFP, proposals, review assignments, speakers, CRM records, agenda, delivery history, and
published projection. Local delivery and uploads use deterministic adapters and require no live
credentials.

If port 5173 or 8787 is already taken — another checkout, another agent, another project — start the
dev servers on free ports:

```bash
GREENROOM_WEB_PORT=5273 GREENROOM_API_PORT=8887 npm run dev
```

The API port matters beyond convenience. `npm run test:e2e` defaults to 4173 for the web server and
**8787 for the API**, and Playwright reuses any server already answering on the port it wants
(`reuseExistingServer` is on outside CI). A second checkout serving 8787 will therefore be tested in
place of this one, silently. Give the suite free ports of its own when anything else is running:

```bash
GREENROOM_WEB_PORT=4373 GREENROOM_API_PORT=9087 npm run test:e2e
```

## Evaluator path

Every workspace has its own URL, so each step below is directly linkable and survives a reload.
`?event=<uuid>` selects the event workspace.

1. Continue as **organizer**. You land on **Overview** (`/`): the counts that matter, the alert
   strip, and the table of speakers with outstanding onboarding tasks.
2. **Abstracts** (`/abstracts`) — triage submissions by status tab, search, assign reviewers,
   record decisions, inspect a proposal's submitted answers.
3. **Sessions & speakers** (`/sessions`) — accepted content, speaker records, tasks, and assets.
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
   - `http://127.0.0.1:5173/embed/events/greenroom-demo-summit/schedule`
   - `http://127.0.0.1:5173/embed/events/greenroom-demo-summit/speakers`

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
   private asset, download the calendar file.
10. Switch to **public**, then open `http://127.0.0.1:5173/events/greenroom-demo-summit` and follow
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

To reproduce one acceptance row rather than the whole suite, name its spec — the `webServer` step
still resets the database first, so this is a clean-reset reproduction:

```bash
npm run test:e2e --workspace @greenroom/web -- e2e/agenda.spec.ts
```

`npm run test:e2e` starts its own API and web server and resets the database first — but only when
nothing is already answering on the ports it wants. Point it at **free** ports whenever other
servers are running, as above; pointing it at ports something else already holds makes it reuse that
process and skip the reset.

The suite is re-runnable. Measured on 2026-08-11 at commit `c72b796`: 30 tests passed three times
consecutively — once immediately after `npm run reset`, then twice more against the same
already-running servers with no reset in between. Every spec either restores what it mutated or
scopes its assertions to rows the run itself created. Two exceptions are inherent and documented in
the specs that carry them (`GAP-005`): a completed evaluation and a declared conflict are terminal by
design, and no affordance returns a communication delivery to a failed state.

Re-runnable is not the same as leaving no trace. Each run adds rows it does not remove — the event
`publishing.spec.ts` creates, the abstracts `review-workflow.spec.ts` files, the prospect
`crm.spec.ts` adds (`DEBT-007`). Run `npm run reset` before demoing to anyone.

`test:quality` checks role-aware journey discovery, that every navigation destination renders,
public semantics and labels, heading structure, mobile layout with no horizontal overflow, and
conservative loading/resource budgets. Those budgets are measured against the Vite dev server, so
they bound nothing about a built artifact (`GAP-014`).

If a step fails, preserve the displayed correlation reference and the Playwright artifacts under
`apps/web/test-results/`. Reset before retrying; never repair demo state with manual database edits.
