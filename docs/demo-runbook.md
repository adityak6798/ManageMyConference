# Competition demo runbook

Status: canonical | Owner: quality | Governing IDs: `PRD-005`, `PLAN-002`, `ACC-DEMO-SMOKE` | Last verified: 2026-08-11

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
   clean reset the seeded snapshot is already exactly what Publish composes, so pressing Publish
   before changing anything is a visible no-op rather than a collapse of the page. The panel names which parts of
   the draft have moved ahead of the snapshot, so "why is my edit not on the site" is answered on
   screen. Both embed views are here with their addresses, a paste-ready `<iframe>` snippet behind a
   copy button, and a live frame of the real embed:
   - `http://127.0.0.1:5173/embed/events/greenroom-demo-summit/schedule`
   - `http://127.0.0.1:5173/embed/events/greenroom-demo-summit/speakers`

   To prove this does not depend on the seed, create an event under `/settings`, select it in the
   event switcher, and publish it from `/publishing`: the slug is server-assigned and the panel
   shows the reserved address before the first publish.
7. **Speaker CRM** (`/speakers`) and **Communications** (`/communications`) — the outreach pipeline
   and the delivery outbox with queued, retrying, succeeded, and terminal states plus explicit retry.
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
npm run check          # format, context integrity, lint, typecheck, OpenAPI drift, unit tests, build
npm run test:d1        # D1 integration suite, including the deterministic seed-state regression
npm run test:e2e       # full browser acceptance suite (needs `npx playwright install chromium`)
npm run test:quality   # the fast evaluator gate
```

`npm run test:e2e` starts its own API and web server and resets the database first — but only when
nothing is already answering on the ports it wants. Point it at **free** ports whenever other
servers are running, as above; pointing it at ports something else already holds makes it reuse that
process and skip the reset.

`npm run test:e2e` is repeatable because its own `webServer` step resets the database before each
invocation. The specs are **not** idempotent against an already-mutated fixture: several assert
seeded counts, and review completion is terminal by design. If you point the suite at servers that
are already running — which skips that reset — expect failures. Run `npm run reset` first in that
case.

`test:quality` checks role-aware journey discovery, that every navigation destination renders,
public semantics and labels, heading structure, mobile layout with no horizontal overflow, and
conservative loading/resource budgets.

If a step fails, preserve the displayed correlation reference and the Playwright artifacts under
`apps/web/test-results/`. Reset before retrying; never repair demo state with manual database edits.
