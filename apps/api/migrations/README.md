# Migration number allocation

Migration filenames remain globally ordered, but each domain owns a non-overlapping block. Choose
the next unused four-digit number in the owning domain's block; do not reuse a gap or renumber an
existing migration.

| Domain | Block |
|---|---:|
| identity-access | `1000`–`1099` |
| events | `1100`–`1199` |
| cfp | `1200`–`1299` |
| review | `1300`–`1399` |
| content | `1400`–`1499` |
| crm | `1500`–`1599` |
| agenda | `1600`–`1699` |
| communications-integrations | `1700`–`1799` |
| publishing | `1800`–`1899` |
| platform | `1900`–`1999` |

Within the `review` block, `1301`–`1309` are reserved for issue #134's corrective rebuild of
`1300`; the AI suggestion port starts at `1310`. That split is recorded in
[the wave ledger](../../../docs/exec-plans/competition-waves.md#wave-5--110-in-flight-ai-suggestion-port)
so the two lanes cannot collide.

Migrations `0001`–`0022` predate this allocation and keep their current names. A cross-domain
migration uses the block of the domain that owns the table being changed; split changes across
blocks when more than one domain owns the affected tables.
