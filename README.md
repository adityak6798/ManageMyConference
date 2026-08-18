# Project Greenroom

An open conference-operations platform for the Kill My SaaS competition. Greenroom follows the lifecycle from CFP and review through speakers, agenda, communications, CRM, and public publishing.

The repository is deliberately organized as an agent-readable context graph. Start with [AGENTS.md](AGENTS.md) or browse the [documentation system of record](docs/README.md). `prototype.html` is a historical pre-implementation sketch, not the product.

## What is shipped, and what is not

The product runs from a deterministic seed with development-only demo identities. The production
bundle is deployable as one Cloudflare Worker serving both the API and SPA, with emailed-code
authentication and event-scoped bearer tokens. Credential-gated live email, Airtable and
Accelevents adapters exist, but the deterministic fakes are the default everywhere and no live
adapter has ever exchanged a request with a real API. Of the
nine competition features, four are shipped — one of those with a named hole, one with no test on its
rows — four are partial, and one is missing. The per-feature verdict with a deciding file for each
is the [traceability table](docs/product/competition-traceability.md); the per-journey verdict, the
tests behind it, and exactly which commands were run to measure it are the
[quality scorecard](docs/quality/scorecard.md); everything deferred is in
[known gaps](docs/quality/known-gaps.md) and the
[technical debt register](docs/exec-plans/tech-debt.md). No hosted CI run exists for any commit on
this branch, so every result quoted anywhere in this repository is local.

## Run it

Follow the [competition demo runbook](docs/demo-runbook.md) for the deterministic evaluator path and its documented acceptance boundary.

```bash
npm ci
uv sync --locked
npm run setup:local
npm run context -- map
npm run reset
npm run dev
```

## Build and deploy

`npm run build` produces `apps/web/dist` and then verifies the Worker bundle that serves it. The
Worker asset configuration sends `/api/*` to Hono and falls back to `index.html` for client routes,
including `/events/*` and `/embed/*`. API clients use the same origin by default. A separately
hosted API may be selected with `VITE_API_BASE_URL` before the build, but that host must supply its
own browser CORS and credential policy; this repository's deploy command avoids that cross-origin
boundary by serving both artifacts from one Worker.

After provisioning the D1 and R2 bindings named in `apps/api/wrangler.toml`, replace the
`local-development` D1 ID and bucket name there with those resource identifiers, authenticate
Wrangler with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then deploy both artifacts in one
command:

```bash
npm exec wrangler d1 migrations apply DB --config apps/api/wrangler.toml --remote
npm run deploy
```

The production runtime deliberately does not enable DEMO_MODE. Configure a unique SESSION_SECRET,
AUTH_EMAIL_ENDPOINT, AUTH_EMAIL_TOKEN, INITIAL_ORGANIZER_USER_ID, and INITIAL_ORGANIZER_EMAIL.
The initial identity variables securely link an existing organizer row on first login; remove them
after the link is established. The endpoint receives a JSON object containing
to and code with the token as a Bearer credential. Missing/default signing configuration fails
startup, while demo mode remains development-only.

The running Worker serves its generated API contract at `/openapi.json` and a self-contained,
browsable reference at `/docs`. The docs page loads no third-party runtime assets. `/developers`
is the human entry point in front of both: what the contract guarantees, the three ways a request
is authenticated, how a webhook is signed, what may change under a client with how much notice, and
which operations the generated document does not yet describe. It is linked from the marketing
page's bar and footer, because an API nobody can find from the home page is one an evaluator
concludes does not exist.

Run `npm run check` before opening a pull request; it runs the same three gates CI's `integrity`, `test-build`, and `d1` jobs run, including the production builds. It deliberately does **not** run the `browser` and `security` gates — [AGENTS.md](AGENTS.md#the-handoff-gate-is-not-the-whole-merge-gate) says why, and `npm run gate:browser` / `npm run gate:security` run them by hand. Product behavior and the implementation roadmap live under `docs/`; this README is only an entrypoint.
