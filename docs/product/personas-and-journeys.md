# Personas and journeys

Status: canonical | Owner: product | Last verified: 2026-08-09

## Personas

- Organizer: configures events, operates the content pipeline, communicates, schedules, and publishes.
- Reviewer: evaluates assigned submissions without access to unrelated private material.
- Applicant/speaker: submits proposals, completes requested work, and controls profile information.
- Attendee: browses published event information without authentication.

## P0 journeys

- `JNY-001` Organizer creates an event, configures CFP fields, previews, and publishes the form.
- `JNY-002` Applicant submits a proposal and receives field-level success or failure feedback.
- `JNY-003` Organizer triages submissions and assigns reviewers; reviewer scores against an evaluation plan.
- `JNY-004` Organizer accepts content, creates/links speaker records, requests tasks/assets, and records communication.
- `JNY-005` Speaker completes profile, task, asset, and calendar-download work in the portal.
- `JNY-006` Organizer schedules sessions across rooms/tracks with conflicts explained before publishing.
- `JNY-007` Attendee browses published event, schedule, sessions, speakers, and CFP; embeds show the same published projection.
- `JNY-008` Organizer manages a CRM prospect through outreach and converts the prospect into a speaker without losing history, and works the organization-wide speaker directory across events: searching and filtering it, saving a view, importing a spreadsheet, merging a duplicate, sending bulk outreach, and sourcing a contact into a chosen event.
- `JNY-009` Organizer uses communications/integration delivery and observes queued, retry, terminal failure, and audit state. This journey belongs to the `communications-integrations` domain.

Authorization negatives and visible failures are part of every journey, not separate polish.
