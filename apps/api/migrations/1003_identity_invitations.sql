-- Invitations: how somebody who is not yet in an organization is asked into it.
-- Identity block `1000`-`1099`.
--
-- Before this table there was no route anywhere in the repository that wrote
-- `organization_memberships` or `event_roles`. The only writers were `grantOrganizer`, called by
-- signup and by event creation, and `provisionSpeaker`, called by CRM speaker conversion. A
-- self-serve organizer could not add a reviewer, a co-organizer, or anybody else.
--
-- **Acceptance is by the accepting session's own identity, never by matching this row's address.**
-- That is rule 1 in docs/architecture/authorization.md and it is the whole reason this table
-- stores a `token_hash` rather than trusting `email`. The deployed demo runs `DEMO_MODE=true`
-- against one database and `seed/reset.sql` gives the seeded personas real addresses, so an
-- invitation accepted by address lookup would let a real organizer invite
-- `organizer@greenroom.test` and turn the demo landing page's "Continue as organizer" button into
-- a door onto a real organization. `email` is here to address the invitation and to show the
-- organizer who they invited; it authorizes nothing.
--
-- `token_hash` rather than the token: the invitation link carries 32 random bytes, and only their
-- SHA-256 digest is stored, so a read of this table cannot mint an acceptance. Same reasoning as
-- `state_proof` in `identity_oauth_attempts` (`1000`).
--
-- Single use is the conditional `UPDATE` on `accepted_at IS NULL`, not a delete: an accepted
-- invitation is the durable answer to "who let this person in", which is a question the audit log
-- and the members list both have to be able to answer afterwards.
CREATE TABLE identity_invitations (
  id                   TEXT PRIMARY KEY NOT NULL,
  organization_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Set when this invitation grants a role on one event rather than membership of the
  -- organization. The two are different offers: organization membership is what lets somebody
  -- see across events, and an event role is what staffs them on exactly one.
  event_id             TEXT REFERENCES events(id) ON DELETE CASCADE,
  email                TEXT NOT NULL,
  -- `organizer` with no event is organization membership. Any role with an event is that role on
  -- that event. `public` is not invitable: it is what everybody already has.
  role                 TEXT NOT NULL CHECK (role IN ('organizer', 'reviewer', 'speaker')),
  token_hash           TEXT NOT NULL UNIQUE,
  invited_by_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  accepted_at          INTEGER,
  accepted_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- An organizer may withdraw an invitation before it is accepted. Recorded rather than deleted,
  -- for the same reason as `revoked_at` on a session.
  revoked_at           INTEGER,
  -- An organization-level invitation must carry no event, and an event-level one must carry a
  -- role that means something on an event. Stated here because the route is not the only writer
  -- this table will ever have.
  CHECK (event_id IS NOT NULL OR role = 'organizer')
);
-- The organizer's pending list reads by organization; acceptance reads by token hash, which the
-- UNIQUE constraint above already indexes.
CREATE INDEX identity_invitations_org_idx   ON identity_invitations(organization_id, created_at);
CREATE INDEX identity_invitations_email_idx ON identity_invitations(email);
