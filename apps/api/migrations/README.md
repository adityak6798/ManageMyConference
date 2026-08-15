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

`1705_delivery_proposal_submitted_trigger.sql` is the worked example of that last rule, and it is
recorded here because the number is in a block its author's lane does not own. It widens
`communication_deliveries.trigger_type` by one value so the CFP domain can queue a submission
confirmation (issue #190); the table is communications', the reason is CFP's, and the number
therefore comes from the communications block. It is announced in
[the wave ledger](../../../docs/exec-plans/competition-waves.md#issue-190-rulings) so a concurrent
communications lane meets the number rather than the conflict.

`1706_delivery_reviewer_reminder_trigger.sql` is the second instance of that rule, from the review
lane, adding `reviewer.reminder` so an organizer can nudge reviewers who still owe evaluations
(issue #191). The alternative — labelling a reminder `reviewer.assigned` — was ruled out in
writing under `ACC-REVIEW` before this lane existed, and it is announced in
[the wave ledger](../../../docs/exec-plans/competition-waves.md#issue-191-rulings) for the same
reason `1705` is.

## Rebuilding a review table

`review_assignments` is the parent with the longest child chain in this schema, and each migration
that has touched it left the next one more to do. Counted against the migrations rather than from
memory — `grep "REFERENCES review_assignments" apps/api/migrations/` and
`grep "^CREATE TRIGGER"` are what these numbers are:

**Three children**, copied and dropped in order: `review_conflicts` and `review_evaluations`
(`0006`), and `review_suggestions` (`1310`) — with `review_evaluations.suggestion_id` citing
suggestions in turn, so the two are a pair rather than two independent copies.

**Ten triggers to restate**, where `1301` restates five:

| Trigger | Added by | On |
|---|---|---|
| `review_completion_rejects_conflict` | `0007` | `review_evaluations` |
| `review_conflict_rejects_completion` | `0008` | `review_conflicts` |
| `review_assignment_requires_plan` | `0009` | `review_assignments` |
| `review_plan_lock` | `0010` | `review_plans` |
| `review_assignment_cap` | `1300` | `review_assignments` |
| `review_evaluation_source_insert` | `1310` | `review_evaluations` |
| `review_evaluation_source_update` | `1310` | `review_evaluations` |
| `review_assignment_requires_round` | `1312` | `review_assignments` |
| `review_assignment_requires_open_round` | `1312` | `review_assignments` |
| `review_assignment_requires_pool_membership` | `1312` | `review_assignments` |

SQLite drops a table's triggers with the table, so forgetting any of them leaves its rule holding
in the service and no longer holding in the schema — the half that was the point. The two
`review_evaluation_source_*` guards are the pair most easily missed: they are the AI-provenance
rules, they sit on a *child* rather than on the parent being rebuilt, and `1301` predates them.

**What actually catches a forgotten one** is `tools/check-schema-drift.mjs`, which fails when an
entry in `UNMODELLED_OBJECTS` names a trigger no migration creates. That is the net; it is not the
D1 replay, which re-runs `1301` and therefore only ever describes the world `1301` was written in.

`1312` itself deliberately rebuilds nothing, and its header explains why the surrogate-key shape
that would have required one was the more dangerous design over a deployed database.
