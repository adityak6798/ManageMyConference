# API compatibility

Status: canonical | Owner: platform | Last verified: 2026-08-13

Greenroom versions the HTTP contract, not its URLs. Existing resources remain below `/api`
rather than moving behind a `/api/v1` prefix. Every response carries
`Greenroom-API-Version: 0.1.0`, and the same declared constant supplies the generated OpenAPI
document's `info.version`. The header identifies the contract implemented by the responding
deployment; it is not content negotiation and a request cannot select another version.

## Compatible changes

The following changes may ship without a new major contract version:

- a new endpoint;
- a new optional request field or header;
- a new response field;
- a new member of a response-only enum; clients must ignore response fields they do not use and
  handle response enum members they do not recognize;
- wider accepted input or a less restrictive documented limit, when existing requests keep their
  meaning.

A change is breaking when an existing conforming request is refused or changes meaning, or an
existing conforming response can no longer be consumed as documented. Removing or renaming a
field or endpoint, making request input required, narrowing accepted input, changing a field's
type, changing authorization scope, and repurposing a status or error code are breaking changes.

## Deprecation and breaking changes

A breaking replacement first ships additively. Responses from the old endpoint or representation
then carry all of the following:

- `Deprecation: @<unix-seconds>`, the Structured Field date on which use becomes deprecated;
- `Sunset: <HTTP-date>`, no earlier than 180 days after the deprecation date;
- `Link: </docs>; rel="deprecation"` or a more specific stable migration document.

The old and replacement contracts remain available together for at least 180 days. Removing the
old behavior requires a new major `Greenroom-API-Version`, an updated OpenAPI document, and a
migration note linked from deprecated responses. The `Deprecation` syntax follows
[RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html) and `Sunset` follows
[RFC 8594](https://www.rfc-editor.org/rfc/rfc8594.html). No Greenroom endpoint has completed this
procedure yet; the policy and the always-on version header are implemented, but an actual
deprecation is not claimed.

## Cursor pagination

Cursor-paged collections accept `limit` and an opaque `cursor`, and return their collection plus
`nextCursor`, which is `null` when no later page exists. Callers must not parse, synthesize, or
reuse a cursor with different filters. Each endpoint documents its own maximum and default page
size. The platform-owned `cursorPageParams({ max, default })` and `cursorPage(itemSchema)` Zod
helpers keep those mechanics consistent while allowing an established collection field name.

`GET /api/communications/history` is the existing adopter. Its `history` field, default of
25, maximum of 50, opaque-cursor bound, and `nextCursor` behavior are unchanged. No additional
list route is paginated by this change; in particular, the organization-wide CRM contacts route
remains unbounded and needs a CRM-owned behavior change.

## Idempotency keys

`Idempotency-Key` is the API-facing default for a caller's mutation retry key. A mutation that
declares it in OpenAPI must implement key-scoped semantics: the server scopes the key to the
authenticated tenant and operation, rejects reuse with different input, and retains the original
response for the documented period. A request-body field named `idempotencyKey` is a domain
command's deterministic key; existing routes retain those fields for compatibility, but new
public retry contracts do not introduce another body key.

Every webhook mutation introduced with this policy — subscription create, update and disable,
secret rotation, and manual delivery replay — requires `Idempotency-Key` and durably replays its
original response. That includes the same one-time webhook secret: webhook signing already needs
recoverable key material, so retaining the mutation result does not weaken its storage model.

API-client credentials are the conscious security exception. Creating or rotating one returns a
plaintext credential once and stores only its SHA-256 digest. Greenroom does not retain recoverable
plaintext merely to replay a response, so those two operations neither accept nor declare
`Idempotency-Key`; retrying them is a new credential operation. API-client revocation also declares
no key: it is naturally convergent, and an unkeyed retry answers `204` when the client is already
revoked. No API-client route advertises key-scoped semantics it does not implement. This is the
public contract decision for issue #100, not an accidental unfinished idempotency path.
