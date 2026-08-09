# Errors and observability

Status: canonical | Owner: platform | IDs: `ARC-ERR-001`, `ARC-OBS-001` | Last verified: 2026-08-09

Errors are expected domain results or unexpected faults. Neither may disappear.

- Expected failures use stable codes, safe messages, optional field errors, and actionable UI states. Logging severity reflects operational impact.
- Unexpected failures are logged once at the ownership boundary with correlation ID and safe context, then mapped to the standard error envelope.
- Background/provider work records queued, retrying, succeeded, or terminal state. Retry is bounded and idempotent.
- PII, tokens, raw submissions, message bodies, and provider secrets are redacted.

```json
{"error":{"code":"FORBIDDEN","message":"Your account cannot perform this action.","correlationId":"...","fieldErrors":{}}}
```

Structured request events include severity, operation, correlation ID, method, path, status, duration, and safe actor/event identifiers where available. Background/provider events additionally include error code, retry count, and outcome. Deployment adapters may add timestamps and service metadata. No bare console output, empty catch, ignored promise, or undocumented discarded result is allowed.

An intentional discard requires an adjacent `ERROR-INTENT:` comment explaining why no user, retry, telemetry, or state consequence remains. Natural propagation, typed conversion, explicit terminal handling, and test assertions are not suppressions.

For `catch` blocks and Promise rejection callbacks, explicit handling means rethrowing or calling the approved ownership boundary (`logger.error`, `logger.warn`, `reportError`, or UI `setError`). Returning a fallback or calling an arbitrary recovery function is not evidence of handling; add the actual reporting/state transition or an adjacent `ERROR-INTENT:` rationale.
