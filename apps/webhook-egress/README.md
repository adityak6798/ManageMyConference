# Trusted webhook egress service

Status: implementation foundation, not durably deployed | Owner: communications-integrations

This Node service is the separately operated network boundary required by `PRD-INT-001`. It:

- authenticates Greenroom before parsing a command;
- resolves every A and AAAA answer at validation and dispatch time;
- rejects empty or mixed global/non-global answer sets;
- injects one validated address into the HTTPS socket lookup while retaining the URL hostname for
  `Host`, TLS SNI, and certificate verification;
- refuses redirects, bounds DNS/target time and response headers, and destroys target bodies;
- forwards only the Greenroom-owned webhook-header allowlist, never its own bearer; and
- returns a normalized result without target response content.

`api/` is a deployment wrapper for a Node serverless host. It was exercised only through an
anonymous, expiring Vercel deployment while issue #194 was investigated. That was neither durable
deployment nor closure evidence. Cloudflare Containers can host the same Node implementation once
the account has a Containers-capable Workers plan; a plain Worker cannot independently select the
destination IP and preserve the original TLS hostname.

## Local verification

```sh
npm test --workspace @greenroom/webhook-egress
npm run typecheck --workspace @greenroom/webhook-egress
```

After a durable deployment, configure `WEBHOOK_EGRESS_ENDPOINT`, `WEBHOOK_EGRESS_TOKEN`, and
`WEBHOOK_EGRESS_PROBE_TARGET`, then run:

```sh
npm run probe:webhook-egress
```

That command must not be described as a deployed verification unless it is run against the durable
non-production service. The hourly GitHub monitor uses `--monitor` for the non-destructive safe,
delivery, redirect, SNI, and token-isolation path.

## Bearer rotation and revocation

The service accepts `WEBHOOK_EGRESS_TOKEN` and, only during rotation,
`WEBHOOK_EGRESS_TOKEN_PREVIOUS`.

1. Generate a new random bearer. Never write it to this repository or a non-secret deployment var.
2. Deploy the service with the new bearer as current and the old bearer as previous.
3. Replace the API Worker's `WEBHOOK_EGRESS_TOKEN` secret with the new bearer and deploy it.
4. Run the monitor and one signed end-to-end delivery through the API Worker.
5. Remove `WEBHOOK_EGRESS_TOKEN_PREVIOUS` from the service and redeploy.

For emergency revocation, remove the compromised token from both accepted slots first. Webhooks
then fail closed while unrelated Greenroom routes continue to serve. Rotate the API Worker secret,
verify the service, and only then resume delivery. Rollback restores the last known-good service
deployment while keeping a compromised bearer revoked.
