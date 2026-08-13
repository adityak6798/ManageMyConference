# Domain boundaries

Status: canonical | Owner: architecture | ID: `ARC-DOM-001` | Last verified: 2026-08-09

Dependency direction is `domain → application → adapter/transport` when read as “is used by”: adapters and transports depend inward; domain depends on nothing external.

| Domain | Owns | May expose |
|---|---|---|
| identity-access | users, memberships, roles | authorization decisions |
| events | organizations, events, settings | event identity/configuration |
| CFP | forms, fields, submissions | submitted proposal reference |
| review | plans, assignments, scores | review outcome |
| content | sessions, speaker profiles, tasks/assets | publishable content |
| CRM | prospects, contacts, activity; the organization-wide contact directory, its enrichment, deduplication, segments and sourcing history | speaker conversion command |
| agenda | rooms, tracks, slots, placements | published schedule projection |
| communications-integrations | templates, outbox, attempts, provider projections | delivery status and typed provider ports |
| publishing | public projections/embed config | public queries |
| platform | inbox dismissals (`platform_inbox_dismissals`), the append-only audit timeline (`platform_audit_records`) | cross-domain operational reads — search and the inbox — composed from other domains' public application interfaces |

Rules:

- Each table has one owner; another domain uses an exported application query/command or declared event, never direct table reads.
- Domain packages import no UI, HTTP, database, Cloudflare, or provider SDK.
- Infrastructure implements typed ports; providers do not appear in domain types.
- Cross-domain transactions are explicit application workflows; asynchronous work uses an outbox.
- `shared` is restricted to identifiers, time/result primitives, and contract-neutral utilities. Business nouns belong to a domain.
- The context manifest declares public application entrypoints, composition roots, and allowed external packages per layer. CI rejects undeclared cross-domain source imports and layer packages; an allowlist is an explicit reviewed boundary, not a general escape hatch. See [widening a boundary](#widening-a-boundary) for what an entry has to say.
- UI source is an explicit `ui` layer, not an unclassified edge. It may import UI-local modules and declared browser-safe packages/contracts, but never API domain, application, adapter, or transport implementation files.
- Every owned production file under an `apps/*/src` or `packages/*/src` tree maps to exactly one manifest layer. Unmatched or multiply matched files fail CI. Only named composition roots may be exempt; shared runtime contracts use the constrained `contracts` layer.
- A domain registers itself on each surface — HTTP routes, console workspace, OpenAPI paths, context metadata — through its own module plus one line in that surface's registry. Two domains claiming one route, workspace, symbol, or owned path fails the check with both named. See [registering a domain](../engineering/registering-a-domain.md).

## Widening a boundary

Both architecture allowlists live in `context/architecture.json` and are arrays of objects, not
of paths:

```json
{
  "path": "apps/web/src/ui/primitives.tsx",
  "governing": "ARC-DOM-001",
  "reason": "The design system. Eight domains' workspaces render through the same Card, Notice, EmptyState and PageHeader, which is what makes the console read as one product."
}
```

`greenroom-context check` fails an entry with no `reason`, a `reason` short enough to be a
placeholder, no `governing` spec or ADR id, a duplicated path, or a path that does not exist.

**Why the format changed.** The lists used to be bare strings, and the cheapest way to make the
gate stop complaining was to append one path. That made a laundered violation look exactly like
a declared shared interface in the diff, and both happened one line apart in the same change:
`ui/primitives.tsx` and `ui/icons.tsx` were added because the design system genuinely is a
shared interface, while `CrmWorkspace` importing `api/review.ts` to populate an owner selector
was a real coupling of CRM to `review:manage`. The second was removed rather than allowlisted —
issue #67 tracks the identity-access query that does it properly — but nothing in the tooling
made that the obvious path. Now the entry has to say which of the two it is, and a reviewer
reads the sentence rather than inferring intent from a path.

**When widening is the right answer.** When the target is genuinely a surface its domain
publishes for others — a `public.ts`, a design system, a transport-wide contract that holds no
domain logic — or when the source is a composition root whose entire job is to assemble
domains. Both are declarations that a boundary *exists*, expressed as a permitted crossing.

**When it is not.** When a domain needs one field from another and the quickest route is to
import its module. Then the answer is a query on the owning domain's public interface, or an
event. The failure message names the allowlist and the reason format on purpose: it should be
easier to read what the exemption is *for* than to add one.

Entries are audited rather than accumulated. Every entry shipped today was checked by removing
it and recording which imports the gate then blocked; five that blocked nothing were deleted
instead of being given invented justifications. One entry —
`apps/api/src/application/events/public.ts` — is deliberately kept while blocking nothing,
because it is the events domain's declared export surface and its reason says so; a future
consumer should target it rather than deep-import `event-service.ts`.

New entries should name an export surface — a `public.ts`, an index, or a contract module —
rather than an arbitrary file, so a deep import cannot be blessed path by path. Several existing
entries name a service or component directly; each records why in its `reason`, and narrowing
them is follow-up work rather than a silent exception.
