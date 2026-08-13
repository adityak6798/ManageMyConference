# Competition demo runbook

Status: canonical | Owner: quality | Governing IDs: `PRD-005`, `PLAN-002`, `ACC-DEMO-SMOKE` | Last verified: 2026-08-12

## Where it is deployed

**https://project-greenroom-api.adityak6798.workers.dev** — one Cloudflare Worker serving both the
API and the built frontend, against remote D1 (`manage-my-conf`) and R2 (`manage-my-conf`), seeded
from the same `seed/reset.sql` this runbook uses locally.

It runs in **demo mode** (`ENVIRONMENT=development`, `DEMO_MODE=true`). Production emailed-code
sign-in exists in the product — `GAP-007` is partially closed — but demo mode deliberately turns it
off: `/api/auth/code` answers 404 whenever `demoMode` is set, and it would additionally need the
`AUTH_EMAIL_ENDPOINT` and `AUTH_EMAIL_TOKEN` bindings this deployment does not carry. So demo
personas are the only way in *here*, which is a property of this deployment rather than a missing
feature.

State the consequence plainly rather than implying less: **anyone who opens that URL can sign in as
an organizer of the seeded event.** It holds seed data only. Issue #12 owns what would change
that — durable logout and revocation, rotation and recovery, membership administration, audit
events, and the provider ADR.

Verified live on 2026-08-12: `/health` reports database and session signing configured; the
organizer, reviewer and speaker personas sign in; the public event, schedule, speaker pages and both
embeds serve; the seeded headshot resolves from R2; `/openapi.json` and `/docs` serve. The
`* * * * *` cron drains the outbox every minute against `COMMUNICATIONS_PROVIDERS=fixture`, so
nothing leaves the Worker.

Deploying is `npm run deploy` from the repository root. It first applies pending migrations to the
remote D1 database and stops if one fails; only then does it build `apps/web` and upload the Worker.
That ordering prevents code expecting a new table from reaching an older schema. The build step is
still load-bearing: `[assets] directory = "../web/dist"` uploads whatever is there.

## Restore the deployed demo

Local and deployed data are deliberately separate. `npm run reset` resets only this checkout's
isolated D1 and R2 fixture, which the browser suite is allowed to mutate. It never reaches the
remote database. The console labels itself `Local instance`, `Deployed demo`, or `Hosted instance`
so the distinction is visible without inspecting the address bar.

After authenticating Wrangler to the Cloudflare account that owns the demo, restore migrations,
`seed/reset.sql`, and the seeded R2 headshot with one command from the repository root:

```bash
npm run reset:demo -- --confirm project-greenroom-api
```

The confirmation is intentional. Before authenticating, the command requires the checked-in
Wrangler configuration to match the exact demo Worker, database ID, D1 binding, R2 bucket,
`ENVIRONMENT=development`, and `DEMO_MODE=true`. A production-authenticated configuration, renamed
resource, or disabled demo mode fails closed. Do not weaken these checks to reuse the command for
production.

Reseeding is on demand, not scheduled: a timer could erase a visitor's work mid-demo. Run it before
a review or after a visitor degrades the shared seed; the weekly gardening workflow remains
read-only.

## What this demo is, and is not

Locally it runs from a deterministic seed, with development-only signed demo identities. The built
frontend is served by the Worker with a configurable API origin. Production emailed-code
authentication exists; the remaining lifecycle work is tracked by `GAP-007`. Local
delivery, uploads, and every provider are deterministic fakes: no message leaves the machine. The
Accelevents integration the brief names is now real and operable — you can preview and apply a
registration sync, and see its last run — but it reads a built-in sample roster here rather than a
registration platform, and it has never exchanged a request with the real API (`GAP-012`). The
panel says so on screen for exactly that reason. The honest
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

   Two integration surfaces live here. **Accelevents registrations** reads the registration
   platform and turns registrants into speaker profiles. Press **Preview registrations** first:
   nothing is written, and the panel lists exactly what an import would create, what is already
   present, and the one deliberately malformed address the sample roster carries so the failure
   path is reachable without editing code. Then **Import registrants**, and press it a second
   time — the counts move to "already present" rather than importing anybody twice. The panel
   says **Fixture mode** throughout, because a demo has no Accelevents credential and a surface
   that let you read those numbers as live ones would be lying to you.

   **Send calendar invitations** (beside *Accepted sessions*, once the agenda is published) sends
   each speaker the iTIP invitation for their own session through the outbox. Pressing it twice
   on an unchanged agenda reports that everyone already has the current invitation rather than
   sending again. Note the honest limit: the demo runs on the deterministic provider, so the
   invitations reach the delivery history, not a mailbox.
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
   and the delivery outbox.

   The **Send to speakers** card at the top of `/communications` is the part to demonstrate. It
   reports "1 of 2 speakers can be reached by email" — the count comes from the server resolving
   the event's speakers, and it names Jordan Bell, who has no address on their identity, rather
   than quietly sending to fewer people than you asked for. Press **New template**, write one
   using `{{speakerName}}`, save it, then send: the confirmation names the version and the count
   before anything is written, and the delivery appears in the history below within a second.
   Expand its attempt row and you can read the message that was rendered for that speaker,
   substituted, not the template it came from. Send the same version again and it says nothing
   new was queued, because it was not.

   Below it, from a clean reset, the outbox carries one delivery in each of the queued, retrying,
   succeeded, and terminal states, with attempt history and an explicit retry on the terminal one;
   recovering it consumes that state until the next reset. Those rows are still seeded, but they
   are now shaped exactly as the product writes them — a real seeded speaker's address, the
   idempotency key the enqueueing code generates, the message that template version renders — and
   the two failures are genuine fixture outcomes rather than states typed into SQL.

   What is no longer true of them: the product does enqueue on its own. Accept a proposal in
   `/content` and the speaker is welcomed and told about each onboarding task; assign review work
   and the reviewer hears once; decide a proposal and its submitter is told. Publishing an agenda
   commits an `EVT-SCHEDULE-PUBLISHED` record in the same transaction as the publication, and
   draining it queues one confirmation per speaker. Be straight about the last one: that message
   carries a **link** to the `.ics`, not an attached invitation — nothing yet lands in a calendar
   client (`GAP-010`, issue #56). The provider behind every send here is a deterministic fake;
   live adapters exist but are credential-gated off and unverified.
8. Switch to **reviewer** — only `/reviews` is reachable. Score the seeded assignment against the
   evaluation plan; unscored criteria are refused rather than silently scored at the minimum.
9. Switch to **speaker** — only `/portal` is reachable. Complete a task, edit the profile, upload a
   private asset, name one of your own images as your profile photo, and download the calendar file.
   Each scheduled session also offers **Google** and **Outlook** links that open a pre-filled
   event in those calendars — the two clients the brief names that take a URL rather than a file.
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

## Built artifact and deployment

`npm run build` creates `apps/web/dist` and performs a Wrangler dry-run of the Worker that serves
those files. In that deployed shape, `/api/*` runs through Hono while unknown non-API paths fall back
to the SPA entry point, so direct navigation to the public and embed URLs above works without Vite.
The domain API clients default to that same origin. `VITE_API_BASE_URL=https://api.example.com`
compiles an alternate origin into those clients, but the separate host must provide its own
compatible browser CORS and credential policy. The documented Worker deployment avoids that
boundary and needs no override.

Once the D1 and R2 bindings in `apps/api/wrangler.toml` point at provisioned Cloudflare resources,
set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, configure a unique SESSION_SECRET plus
AUTH_EMAIL_ENDPOINT and AUTH_EMAIL_TOKEN, then run `npm run deploy`. Wrangler prints the resulting
Worker URL. Enabling demo mode in production is explicitly refused by the runtime.

On either the local or deployed Worker, open `/docs` for the browsable API reference or
`/openapi.json` for the generated source document. Both are public discovery routes; they expose the
already-checked contract and introduce no authentication mechanism.

## Reproduce the evidence

```bash
npm run check          # gate:integrity + gate:test-build + gate:d1 — the same three gates CI runs
npm run test:d1        # the D1 suite on its own (already included in npm run check)
npm run test:e2e       # full browser acceptance suite — 30 tests (needs `npx playwright install chromium`)
npm run test:quality   # the fast built-artifact evaluator gate — 5 tests
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

`test:quality` builds the web app, resets the shared fixture, and asks the Worker to serve that
artifact. It runs axe WCAG A/AA checks over every organizer destination, the reviewer and speaker
shells, all seven public routes, and all four embeds. It also proves skip links and landmarks, focus
after client navigation, live navigation destinations, and 390px layout across every organizer and
public route. On `/events/greenroom-demo-summit`, DOMContentLoaded must stay under 1.5 seconds,
transferred bytes under 300 KiB, and resource requests under 12. Those ceilings were set after a
local built-artifact measurement of 55 ms, 166 KiB, and 5 requests.

If a step fails, preserve the displayed correlation reference and the Playwright artifacts under
`apps/web/test-results/`. Reset before retrying; never repair demo state with manual database edits.
