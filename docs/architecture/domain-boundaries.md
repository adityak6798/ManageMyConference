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
| CRM | prospects, contacts, activity | speaker conversion command |
| agenda | rooms, tracks, slots, placements | published schedule projection |
| communications-integrations | templates, outbox, attempts, provider projections | delivery status and typed provider ports |
| publishing | public projections/embed config | public queries |

Rules:

- Each table has one owner; another domain uses an exported application query/command or declared event, never direct table reads.
- Domain packages import no UI, HTTP, database, Cloudflare, or provider SDK.
- Infrastructure implements typed ports; providers do not appear in domain types.
- Cross-domain transactions are explicit application workflows; asynchronous work uses an outbox.
- `shared` is restricted to identifiers, time/result primitives, and contract-neutral utilities. Business nouns belong to a domain.
- The context manifest declares public application entrypoints, composition roots, and allowed external packages per layer. CI rejects undeclared cross-domain source imports and layer packages; an allowlist is an explicit reviewed boundary, not a general escape hatch.
- UI source is an explicit `ui` layer, not an unclassified edge. It may import UI-local modules and declared browser-safe packages/contracts, but never API domain, application, adapter, or transport implementation files.
- Every owned production file under an `apps/*/src` or `packages/*/src` tree maps to exactly one manifest layer. Unmatched or multiply matched files fail CI. Only named composition roots may be exempt; shared runtime contracts use the constrained `contracts` layer.
