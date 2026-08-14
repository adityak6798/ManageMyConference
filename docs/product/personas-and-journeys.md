# Personas and journeys

Status: canonical | Owner: product | Last verified: 2026-08-14

## Personas

- Organizer: configures events, operates the content pipeline, communicates, schedules, and publishes.
- Reviewer: evaluates assigned submissions without access to unrelated private material.
- Applicant/speaker: submits proposals, completes requested work, and controls profile information.
- Attendee: browses published event information without authentication.

## P0 journeys

- `JNY-001` Organizer creates an event, configures CFP fields, previews, publishes the form, and schedules the submission window that decides when applicants may answer it.
- `JNY-002` Applicant submits a proposal and receives field-level success or failure feedback. With an account they also keep it: a draft survives a closed browser and is resumed, a submitted proposal can be revised while the call is open, and the organizer's decision appears on the applicant's own proposals page. Guest submission stays available and stays anonymous — it produces a confirmation identifier and nothing an account could later claim.
- `JNY-003` Organizer triages submissions and assigns reviewers; reviewer scores against an evaluation plan.
- `JNY-004` Organizer accepts content, creates/links speaker records, requests tasks/assets, and records communication.
- `JNY-005` Speaker completes profile, task, asset, and calendar-download work in the portal.
- `JNY-006` Organizer schedules sessions across rooms/tracks with conflicts explained before publishing.
- `JNY-007` Attendee browses published event, schedule, sessions, speakers, and CFP; embeds show the same published projection.
- `JNY-008` Organizer manages a CRM prospect through outreach and converts the prospect into a speaker without losing history, and works the organization-wide speaker directory across events: searching and filtering it, saving a view, importing a spreadsheet, merging a duplicate, sending bulk outreach, and sourcing a contact into a chosen event.
- `JNY-009` Organizer uses communications/integration delivery and observes queued, retry, terminal failure, and audit state. This journey belongs to the `communications-integrations` domain.
- `JNY-010` A visitor with no account lands on `/`, chooses Get started, signs in with Google, and arrives in a workspace of their own: an organization named after them, a first event, the organizer role on it, and empty states that say what to do next rather than showing empty tables. The journey is the whole round trip — the redirect out, Google's consent screen, the callback back — and it ends on a surface, not on a JSON response. Its failure half is part of it: a refused sign-in returns the visitor to the sign-in surface with one recoverable message that names no check, and a deployment with no Google configuration offers no button at all rather than one that 404s. A returning visitor whose provider account is already linked lands in the workspace they already had; a person whose verified address already belongs to an identity keeps that identity and its access instead of being handed a second, empty one. This journey belongs to the `identity-access` domain.

Authorization negatives and visible failures are part of every journey, not separate polish.
