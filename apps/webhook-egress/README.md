# Trusted webhook egress service

Status: Cloudflare Container deployment path implemented; live evidence pending | Owner:
communications-integrations

This service is the separately operated network boundary required by `PRD-INT-001`. It:

- authenticates Greenroom before parsing a command;
- resolves every A and AAAA answer at validation and dispatch time;
- rejects empty or mixed global/non-global answer sets;
- injects one validated address into the HTTPS socket lookup while retaining the URL hostname for
  `Host`, TLS SNI, and certificate verification;
- refuses redirects, bounds DNS/target time and response headers, and destroys target bodies;
- forwards only the Greenroom-owned webhook-header allowlist, never its own bearer; and
- returns a normalized result without target response content.

The Node resolver and transport run in a Cloudflare Container. `src/worker.ts` is the small Worker
front door: `/egress` reaches one singleton container, `/health` reports the Worker, and
`/probe-target` is a bodyless staging receiver used to check target-facing headers and status. All
other paths return 404. The abandoned Vercel preview wrapper was removed because it was neither a
durable deployment nor a path CI exercised.

## Build and deployment

The image is built from `Dockerfile` for `linux/amd64`. `predeploy` compiles the TypeScript server
before Wrangler builds the image, so the runtime image contains only Node and emitted JavaScript.

There is intentionally no local container deployment command: this developer machine has no
Docker-compatible runtime. A push to `main` runs `tools/deploy.mjs` on GitHub's Ubuntu runner. It
validates every new secret before changing remote state, migrates D1, builds the web application,
then:

1. atomically reconciles the egress bearers, then builds, pushes, and immediately rolls out
   `greenroom-webhook-egress` with those bindings;
2. deploys `project-greenroom-api` with the matching bearer and wrapping key in the same Worker
   version as the endpoint and key-version vars.

Both secret sets are written to mode-`0600` temporary JSON files. Egress uses `wrangler secret
bulk` before the image deploy so an explicit `null` really deletes the previous bearer; deploy's
additive `--secrets-file` path would filter the null and preserve that bearer. The API file is
supplied with `--secrets-file`, which activates its secrets with the endpoint vars and code. The
files are removed when deployment succeeds or fails. The GitHub repository
must provide `WEBHOOK_EGRESS_TOKEN` and `WEBHOOK_WRAPPING_KEYS`, plus
`WEBHOOK_EGRESS_TOKEN_PREVIOUS` only during a rotation. If the CI Cloudflare token receives a 403
while pushing the image, stop: its account scope must be corrected by an operator. Do not introduce
another registry or deployment path to bypass that refusal.

## Local verification

```sh
npm test --workspace @greenroom/webhook-egress
npm run typecheck --workspace @greenroom/webhook-egress
npm run build --workspace @greenroom/webhook-egress
npx wrangler deploy --dry-run --containers-rollout=none \
  --config apps/webhook-egress/wrangler.jsonc
```

The last command validates and bundles the Worker without pretending to build the Container. A full
dry run still needs Docker and is expected to refuse on this machine.

After a durable deployment, set `WEBHOOK_EGRESS_ENDPOINT`, `WEBHOOK_EGRESS_TOKEN`, and
`WEBHOOK_EGRESS_PROBE_TARGET`, then run:

```sh
npm run probe:webhook-egress
```

That command must not be described as deployed verification unless it targets the durable service.
The hourly GitHub monitor uses `--monitor` for the non-destructive safe, delivery, redirect, SNI,
and token-isolation path. The full manual probe additionally checks private IPv4/IPv6, metadata,
timeout, bounded status, optional mixed answers, and DNS rebinding.

## Bearer rotation and revocation

The service accepts `WEBHOOK_EGRESS_TOKEN` and, only during rotation,
`WEBHOOK_EGRESS_TOKEN_PREVIOUS`.

1. Generate a new random bearer. Never write it to this repository or a non-secret deployment var.
2. Set repository secret `WEBHOOK_EGRESS_TOKEN` to the new bearer and
   `WEBHOOK_EGRESS_TOKEN_PREVIOUS` to the old bearer.
3. Merge a no-op release commit or dispatch the main CI workflow. It deploys the service accepting
   both and the API sending the new bearer.
4. Run the monitor and one signed end-to-end delivery through the API Worker.
5. Delete repository secret `WEBHOOK_EGRESS_TOKEN_PREVIOUS` and deploy main again. The pre-deploy
   bulk reconciliation sends an explicit secret deletion; omission or `deploy --secrets-file`
   alone would leave Cloudflare's previous value in place.

For emergency revocation, replace the compromised current token and leave the previous slot empty;
webhooks fail closed until both Workers have deployed the replacement. Unrelated Greenroom routes
remain available. Roll back `project-greenroom-api` first if the egress deployment is unhealthy,
which removes the endpoint/version pair and returns webhook routes to `503 WEBHOOK_UNAVAILABLE`.
Then roll back `greenroom-webhook-egress` to the recorded known-good deployment while keeping a
compromised bearer revoked. Do not delete container images that a rollback may still reference.

## Live evidence

Record the UTC date, main commit, API and egress deployment identifiers, probe output, signed
delivery identifier, and observed refusal scenarios here after they actually run. Until that record
exists, `GAP-026` and issue #194 remain open.
