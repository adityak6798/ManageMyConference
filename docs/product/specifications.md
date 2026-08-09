# Bounded product specifications

Status: canonical | Owner: product | Last verified: 2026-08-09

## Events and access

- `PRD-EVT-001` One organization owns many events; event settings and records never leak across events.
- `PRD-IAM-001` Roles are organizer, reviewer, speaker, and public. Demo switching changes an authenticated seeded identity; it does not bypass authorization.
- `PRD-IAM-002` Denial returns the standard error contract and the UI presents a safe, actionable state.

## CFP, abstracts, and review

- `PRD-CFP-001` Organizers compose ordered typed fields, required rules, guidance, open/close state, preview, and publication.
- `PRD-CFP-002` Submission is server validated and idempotent; applicants get a durable confirmation identifier.
- `PRD-ABS-001` Organizers filter, assign, bulk-transition, and audit submissions through configured statuses.
- `PRD-REV-001` An evaluation plan defines criteria and scales. Reviewers see assignments, conflicts, completion, and no aggregate bias before submission.

## Speakers, content, and CRM

- `PRD-SPK-001` A person has one event-scoped speaker profile linked to sessions, tasks, assets, messages, and optional CRM origin.
- `PRD-CNT-001` A session owns title, abstract, format, speakers, tags/tracks, publication state, and schedule reference.
- `PRD-SPK-002` The portal is task-first and exposes completion, due state, profile preview, uploads, and calendar download.
- `PRD-CRM-001` Prospects have stage, contacts, notes, activities, owner, next action, and conversion preserving provenance.

## Agenda, communications, integrations, public

- `PRD-AGD-001` The agenda manages rooms, tracks, timeslots, and sessions; speaker, room, and overlap conflicts are explicit.
- `PRD-COM-001` Templates and triggers enqueue immutable delivery attempts with retry and terminal state; sent history is auditable.
- `PRD-INT-001` SQL is canonical. Airtable and Accelevents receive versioned outbound projections through typed ports.
- `PRD-PUB-001` Only published projections are public. Event hub, schedule, sessions, speakers, and CFP have direct and embeddable views.
- `PRD-AI-001` AI may draft or summarize but never silently changes canonical state; manual fallback is required.

Detailed wire and event contracts belong in [interfaces](../interfaces/README.md); data ownership belongs in [domain boundaries](../architecture/domain-boundaries.md).
