# Bounded product specifications

Status: canonical | Owner: product | Last verified: 2026-08-09

## Events and access

- `PRD-EVT-001` One organization owns many events. Every event command names its organization or event scope, repositories constrain reads to the actor's organization memberships or event assignments, and event settings and records never leak across events. Organizers may create and switch among events in organizations they belong to.
- `PRD-IAM-001` Roles are organizer, reviewer, speaker, and public. The current-session query returns the authenticated identity, organization memberships, event roles, and capabilities used by the application shell. Development-only demo switching changes to a signed, expiring seeded identity; it does not bypass application authorization.
- `PRD-IAM-002` Unauthenticated and unauthorized requests remain distinct, use the correlation-aware standard error contract, and reveal no inaccessible object details. The UI provides explicit loading, empty, denied, and recoverable error states, with navigation derived from the active event role.

## CFP, abstracts, and review

- `PRD-CFP-001` Organizers compose ordered typed fields, required rules, guidance, open/close state, preview, and publication.
- `PRD-CFP-002` Submission is server validated and idempotent; applicants get a durable confirmation identifier.
- `PRD-ABS-001` Organizers filter, assign, bulk-transition, and audit submissions through configured statuses.
- `PRD-REV-001` An evaluation plan defines criteria and scales. Reviewers see assignments, conflicts, completion, and no aggregate bias before submission.

`PRD-ABS-001` organizers configure an ordered event-scoped status set, filter proposals by those statuses, and transition a selected set atomically; each successful transition displays its transaction-current prior status, next status, proposal, actor, and occurrence time. `PRD-REV-001` organizers configure at least one uniquely identified, explicitly bounded scoring criterion and may assign a proposal once to a user who holds the reviewer role for that event. The rubric is locked once assignments exist. Reviewers can access only their own event assignments, declare a conflict, save a validated draft, and complete it. A conflicted assignment cannot be evaluated; completion is terminal and atomically persists the evaluation, aggregate outcome, and one idempotent completion event. Reviewer responses never contain aggregate outcomes; organizers receive an outcome only after at least one completed evaluation. Completion publishes version 1 of `EVT-REVIEW-COMPLETED` with organization/event/proposal/assignment scope and correlation/causation metadata.

## Speakers, content, and CRM

- `PRD-SPK-001` A person has one event-scoped speaker profile linked to sessions, tasks, assets, messages, and optional CRM origin.
- `PRD-CNT-001` A session owns title, abstract, format, speakers, tags/tracks, publication state, and schedule reference.
- `PRD-SPK-002` The portal is task-first and exposes completion, due state, profile preview, uploads, and calendar download.
- `PRD-CRM-001` Prospects have stage, contacts, notes, activities, owner, next action, and conversion preserving provenance.

## Agenda, communications, integrations, public

- `PRD-AGD-001` The agenda manages event-scoped rooms, tracks, timeslots, and placements over sessions supplied by the content application query. A placement may be added, moved, or removed in a private draft. Overlapping placements explicitly identify every shared room, speaker, or session and give a resolution; a conflicted draft cannot be published. Publication is an organizer-only, auditable action that creates a numbered immutable snapshot. Only the latest snapshot—not subsequent draft edits—is available through the public schedule projection.
- `PRD-COM-001` Templates and triggers enqueue immutable delivery attempts with retry and terminal state; sent history is auditable.
- `PRD-INT-001` SQL is canonical. Airtable and Accelevents receive versioned outbound projections through typed ports.
- `PRD-PUB-001` Only published projections are public. Event hub, schedule, sessions, speakers, and CFP have direct and embeddable views.
- `PRD-AI-001` AI may draft or summarize but never silently changes canonical state; manual fallback is required.

Detailed wire and event contracts belong in [interfaces](../interfaces/README.md); data ownership belongs in [domain boundaries](../architecture/domain-boundaries.md).
