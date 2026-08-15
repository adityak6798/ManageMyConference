# ADR-006: Per-field access resolved with the actor, and one capability-link primitive

Status: accepted | Owner: identity-access, platform | Date: 2026-08-14

## Context

Issue #196 asks for three things that look unrelated and share one failure mode. Custom event
roles need to decide what a staffed person may see *field by field*. Portals need to record who
consented to what. Reports need to be exported and shared with somebody who has no account.

Every one of those is a way for the same record to reach a reader through a different door. The
console renders a speaker; so does a CSV; so does an XLSX; so does a JSON export; so does a share
link somebody forwarded. The failure mode is that the doors disagree — a phone number blanked on
the screen and present in the file, which nobody notices until the file is somewhere it should
not be. The brief's own words for the requirement are that a role decides View, Lock or Hide per
field, and the lane prompt states the test plainly: **a field the client hides and the API returns
is not hidden.**

Separately, `DEBT-012` had already recorded one anonymous capability URL — the attendee itinerary
— with its costs written down and no revocation, expiry or view limit, because its payload was
deliberately limited to public session slugs. Issue #196's report shares are the second such URL,
issue #189's `GAP-028` residual will be the third and fourth (a speaker profile, a speaker asset),
and three independently-invented conventions is how a repository ends up unable to answer "what
can this link reach and when does it stop working" in one place.

## Decision

**Field access is resolved in the same D1 read that resolves roles, and is a pure function of the
actor.** `resolve()` joins the custom role, unions its capabilities and its field policies, merges
the event's portal locks onto every non-organizer grant at the stricter of the two, and hands a
`FieldAccess` back on the actor. Nothing downstream re-derives it. That is what makes the doors
agree: there is one decision, made at the application boundary, and a screen, an export and a
share link are all downstream of it rather than beside it.

**Hidden fields are absent from the payload, not blanked.** The contracts mark governed fields
optional and the redaction returns `Omit<T, K> & Partial<Pick<T, K>>`, so a consumer that forgot
to handle a hidden field fails to compile. A blanked field is indistinguishable from an empty one,
and "no phone number on file" is a different statement from "you may not see this phone number".

**Redaction happens at the read boundary only.** Internal write paths load the unredacted record,
because a service that cannot see the field it is about to write is a worse bug than the one this
prevents.

**Composition across grants is least-restrictive, and an absent policy set means unrestricted.**
Capabilities already union, and a model where one of two grants silently narrowed the other would
make a second grant a demotion. The one place that is inverted is the portal lock, which is
deliberately the *stricter* of the two: a lock is the event saying "this is closed now", and a
grant should not reopen it.

**A required field's Hide is clamped to Lock rather than refused.** A record with no identifying
field is unjoinable to whoever is reading it — a table of anonymous rows is not a narrower view,
it is a useless one — so the model answers the nearest useful thing and the editor does not offer
the refusal at all.

**Export is a format applied to a run, never a second path to the rows.** `ReportingService.run`
produces the rows; `export` renders them. The renderers take a `ReportResult` and not a query, so
there is no argument by which an export could reach the unmasked value the screen did not.

**One capability-link primitive, `capability_links`, for every anonymous share.** A link is an
opaque token stored **only as a hash**, addressing `(resource_kind, resource_ref)` with no foreign
key — the resources belong to other domains — with an optional password hash, an expiry capped at
30 days, an optional view limit, and revocation as a column rather than a delete. Spending one
checks every constraint in one place, and an unknown, revoked, expired, spent or wrongly-answered
link answers identically, because telling them apart says whether a guessed token named a real
resource. `report` resolves today. `speaker-profile` and `speaker-asset` are declared and resolved
by nothing, deliberately, so `GAP-028`'s lane consumes this rather than minting a third shape.

## Consequences

- A new governed field is one entry in `GOVERNED_FIELDS` and one optional field in the contract;
  every reader then meets it at compile time. A new *reader* gets the decision for free, which is
  the point, and gets no way to opt out of it, which is also the point.
- `event_roles` admits a fifth value, `custom`, paired with its role by a CHECK rather than by
  convention. The primary key is unchanged, so a person holds at most one custom role on an
  event — stated by the schema instead of by a service.
- The identity read grew: resolving an actor now unions capabilities and field policies from the
  custom role. That is one more statement on a path already several statements long, and it is on
  the request path for every authenticated call. It is accepted because the alternative — deciding
  field access later, where the data is — is precisely the design that lets two doors disagree.
- `capability_links` does **not** fix `DEBT-012`'s actual cost. A URL still leaks through history,
  referrers, screenshots and shared screens. What changes is that a leak is now *containable*, and
  that a link carrying personal data needs `reports:pii` on the run that minted it.
- Scheduled report delivery sends a **link rather than a rendered report**, and lives in platform
  rather than in the communications outbox. Both halves are trades: a link expires and can be
  revoked where a message in a mailbox cannot, and staying out of the outbox avoids widening
  `communication_deliveries.trigger_type` — a pinned CHECK, and therefore a table rebuild in
  another lane's migration block. The cost is that these sends are absent from the communications
  history and share none of its retry ladder; `GAP-031` and `DEBT-014` record it.

## Alternatives considered

**Decide field access at each read site.** Rejected as the failure mode itself. Every new export,
feed or share link would be a fresh opportunity to forget, and forgetting is silent.

**Filter hidden fields out of the query rather than out of the projection.** Rejected because a
filter must still evaluate against the unmasked value for a saved report to keep meaning one
thing: "speakers whose email is at example.test" cannot be answered from masked data. Masking on
the way out and filtering on the way in is the only ordering that satisfies both.

**Make `reports:pii` a role rather than a capability.** Rejected because it would have to be a
role somebody holds permanently, and the useful shape is a permission exercised deliberately and
recorded when it is. Holding a capability and using it are different facts.

**A separate share-link table per feature.** Rejected as the third convention problem: the cost of
one shared table is that each kind interprets its own `scope` blob, which is small; the cost of
three tables is that "what can this link reach and when does it expire" has three answers.

**Widen `communication_deliveries.trigger_type` for scheduled reports.** Rejected for this change
only, and on coordination grounds rather than design ones: the CHECK is pinned and its rebuild
belongs to whichever lane owns the communications block. Folding scheduled reports into the outbox
is the follow-up, recorded rather than done.
