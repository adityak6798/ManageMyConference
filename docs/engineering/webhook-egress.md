# Webhook egress operations

Status: canonical | Owner: communications-integrations | Last verified: 2026-08-13

The application Worker cannot resolve DNS and pin the resulting address to an ordinary `fetch`.
It therefore never connects to a subscriber URL. Webhooks are enabled only when all four bindings
exist:

- `WEBHOOK_EGRESS_ENDPOINT`: HTTPS endpoint of a separately deployed enforcement service.
- `WEBHOOK_EGRESS_TOKEN`: Worker secret authenticating Greenroom to that service only.
- `WEBHOOK_WRAPPING_KEY_VERSION`: non-secret current key version.
- `WEBHOOK_WRAPPING_KEYS`: Worker secret JSON object from version to base64 32-byte AES key.

No bindings means the feature is locally unavailable: declared webhook routes return
`503 WEBHOOK_UNAVAILABLE` and the cron does not fan out webhook rows. A partial or malformed
configuration fails composition by naming the missing/invalid binding. Unrelated routes remain
available when no webhook binding is present.

The separately operated enforcement service is the DNS and network trust boundary. Its Node
implementation, Cloudflare Container image, singleton Container Worker front door, deployment
orchestrator, staging receiver, and probes live in `apps/webhook-egress/`, `tools/deploy.mjs`, and
`tools/probe-webhook-egress.mjs`. Deployment and live verification remain tracked in
[issue #194](https://github.com/adityak6798/ManageMyConference/issues/194), so this repository does
not claim the boundary is deployed until the live-evidence section in the application README is
filled from a main deployment. For both `validate` and `dispatch`
it must resolve every A and AAAA answer, reject the entire set when any answer is loopback,
link-local, private, reserved, multicast or otherwise non-global, and reject an empty set. Dispatch
must resolve again, choose only from that validated set, and pin that address to the outbound TLS
connection while preserving the original hostname for SNI/certificate verification. It must never
follow a target redirect. DNS rebinding between validation and dispatch therefore refuses rather
than reaching the rebound address.

Greenroom sends its egress bearer only to `WEBHOOK_EGRESS_ENDPOINT`; it is not part of the target
headers. The enforcement service sends the supplied webhook headers/body, applies the supplied
timeout, discards the target body, and returns JSON only: `{result:"delivered",targetStatus:2xx}` or
`{result:"retryable|terminal",code:"NORMALIZED_CODE",targetStatus?:3xx-5xx}`. Greenroom rejects
redirects or malformed/incoherent responses from the service, and normalizes service network
failures into its bounded webhook retry policy.

The main-only CI release reconciles the egress bearers, builds and pushes the Container, then
deploys the API Worker. Egress uses `wrangler secret bulk` because only that path interprets a JSON
`null` as deletion; the API uploads its bearer/wrapping key alongside its Worker version from a
mode-`0600` temporary file, avoiding the partial four-binding configuration that it correctly
refuses. The CI token must have Container image-push permission; a 403 is an operator scope failure,
not a reason to add a second registry or weaken the boundary. Local development writes blank
overrides for all four webhook bindings and retains the explicit unavailable/503 behavior.

The checked-in implementation accepts a current egress bearer and, only during rotation, one
previous bearer. The complete deployment, probe, rotation, emergency-revocation and rollback
procedure is in `apps/webhook-egress/README.md`. The hourly monitor is inert until a durable
endpoint, repository secret and probe-target variable are configured; an anonymous or expiring
serverless preview is not acceptable evidence.

Wrapping-key rotation adds a new version/key, deploys it alongside every old version still present
in stored envelopes, changes `WEBHOOK_WRAPPING_KEY_VERSION`, and only removes an old key after all
rows using it have been rewrapped. The missing bulk rewrap command and its explicit closure are
tracked as `GAP-025`; old versions must remain configured until that gap closes or a reviewed
one-off migration completes.
