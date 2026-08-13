-- The identity-access audit spine: an append-only record of who did what to whom.
--
-- Append-only is a property of the writers rather than of SQLite — there is no UPDATE or DELETE
-- against this table anywhere in apps/api, and the seed reset is the one statement that clears
-- it, because demo rows are fixture state. Nothing here carries a credential: no id_token, no
-- code_verifier, no state_proof, no session token, no cookie value. The detail column is for the
-- shape of an action, never for the secret that authorized it.
--
-- No foreign keys. actor_user_id and subject_user_id name users, but an audit row must
-- outlive the user it describes: a cascade from users would delete exactly the history an
-- operator needs after an account is removed, and a plain reference would refuse the delete.
-- The cost is that a stale id can appear here, which is the correct trade for a record of the
-- past.
--
-- Issue #99 — permission-aware global search, operational inbox, and a unified audit timeline —
-- owns the cross-domain timeline that reads this table. The columns are shaped so it can project
-- them: actor, source, action, subject, organization, event, time, correlation. This lane
-- deliberately builds no timeline and no UI beyond the organization-scoped membership audit read.
--
-- No quote character of any kind belongs in a comment in this file. The schema-drift tokenizer
-- treats an apostrophe, a double quote or a backtick as the start of a literal and skips every
-- CHECK constraint until it meets the next one, which makes the declared schema and the migrated
-- database disagree about a constraint that is present in both.
CREATE TABLE identity_audit_events (
  id             TEXT PRIMARY KEY NOT NULL,
  occurred_at    INTEGER NOT NULL,
  -- The closed vocabulary of this table, not of one pull request. Extending a CHECK in SQLite
  -- is a table rebuild, so the whole vocabulary of the identity lane is declared here: durable
  -- sessions write the three session actions, membership administration writes the rest.
  action         TEXT NOT NULL CHECK (action IN (
    'session.issued',
    'session.signed_out',
    'session.revoked_all',
    'membership.invited',
    'membership.invitation_revoked',
    'membership.accepted',
    'membership.removed',
    'membership.role_changed',
    'event_role.granted',
    'event_role.revoked'
  )),
  -- A refusal is recorded, not just a success. A demo persona refused as a grant target is the
  -- row an operator most wants to find, and it is the one an outcome-free table cannot hold.
  outcome        TEXT NOT NULL CHECK (outcome IN ('succeeded', 'refused')),
  -- What kind of caller acted. The vocabulary of issue #99 also carries an agent source;
  -- identity-access has no agent-initiated action today, and admitting a value nothing writes
  -- would be a claim this table cannot support, so the column is the three that occur. Widening
  -- it is a rebuild, and belongs to whichever lane first has an agent actor.
  source         TEXT NOT NULL CHECK (source IN ('human', 'api', 'system')),
  -- Null when nobody was authenticated — a refusal recorded before an actor resolved.
  actor_user_id  TEXT,
  -- Who the action was about, when that is somebody other than the actor.
  subject_user_id TEXT,
  organization_id TEXT,
  event_id       TEXT,
  -- Always present: this is what turns a report of a refusal at 14:03 into the row itself.
  correlation_id TEXT NOT NULL,
  -- Optional JSON. Shape of the action only.
  detail         TEXT
);
-- The organizer-visible log is read by organization and by time; an operator investigating an
-- account reads by actor and by time.
CREATE INDEX identity_audit_events_org_idx   ON identity_audit_events(organization_id, occurred_at);
CREATE INDEX identity_audit_events_actor_idx ON identity_audit_events(actor_user_id, occurred_at);
