-- Emailed-code challenges are keyed by address, so they are scoped to the seeded personas'
-- addresses — the only ones `users.sql` below re-creates. `DEMO_MODE=true` turns this door off
-- entirely on the demo deployment, so in practice this deletes nothing; it is here because the
-- reset must be applicable on a deployment where the door *is* open, and there a real person's
-- in-flight code is not the demo's to cancel.
DELETE FROM identity_login_challenges
WHERE email IN (
  'organizer@greenroom.test',
  'reviewer@greenroom.test',
  'speaker@greenroom.test'
);

-- **`identity_oauth_attempts` is deliberately no longer cleared, and that is a scoping decision
-- rather than an omission.**
--
-- An attempt row has no owner: no organization, no event, no user — it is minted before anybody
-- is identified. There is therefore no way to scope it, and the unscoped delete that used to be
-- here aborts the Google sign-in of whoever happens to be mid-redirect when a demo restore runs,
-- on a deployment the demo now shares with a real conference. The reason it was cleared no longer
-- holds either: it was "a callback able to complete against a database whose users have just been
-- replaced", and a reset that replaces only the seeded users leaves such a callback completing
-- into an ordinary self-serve signup. Rows expire ten minutes after they are minted
-- (`ATTEMPT_LIFETIME_MS`) and `saveOauthAttempt` sweeps the expired ones on every start, so this
-- table cleans itself.

-- Sessions belong to a user, so they go with the seeded users and nobody else's. Before `users`
-- for the same reason as the rows below it. An unscoped delete here signed every real person on
-- the deployment out, which is exactly the collateral this pass removes.
DELETE FROM identity_sessions
WHERE user_id IN (
  'seed-organizer',
  'seed-reviewer',
  'seed-speaker',
  'speaker-jordan-bell',
  'seed-public'
);

-- The audit spine is append-only in the application and cleared only here, because a
-- deterministic reset that kept the previous run's rows would report actions against users that
-- no longer exist. It holds no foreign key; the position is for readability. Scoped by every
-- identifier it carries, so a record about a seeded actor, a seeded subject, a seeded
-- organization or a seeded event goes and a record about a real one stays.
DELETE FROM identity_audit_events
WHERE actor_user_id IN (
  'seed-organizer',
  'seed-reviewer',
  'seed-speaker',
  'speaker-jordan-bell',
  'seed-public'
)
  OR subject_user_id IN (
    'seed-organizer',
    'seed-reviewer',
    'seed-speaker',
    'speaker-jordan-bell',
    'seed-public'
  )
  OR organization_id IN (
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )
  OR event_id IN (
    SELECT id FROM events
    WHERE organization_id IN (
      '00000000-0000-4000-8000-000000000010',
      '00000000-0000-4000-8000-000000000020'
    )
  );

-- Before `users`: these reference it, and D1 does not honour `PRAGMA foreign_keys` between
-- statements, so relying on the cascade would leave rows that make the next reset fail.
DELETE FROM identity_provider_accounts
WHERE user_id IN (
  'seed-organizer',
  'seed-reviewer',
  'seed-speaker',
  'speaker-jordan-bell',
  'seed-public'
);
DELETE FROM identity_emails
WHERE user_id IN (
  'seed-organizer',
  'seed-reviewer',
  'seed-speaker',
  'speaker-jordan-bell',
  'seed-public'
);

-- **Only the five the seed names.**
--
-- The demo can also *produce* a user: converting a CRM prospect to a speaker writes one through
-- `provisionSpeaker`, with a generated id and the contact's own address. Those are deliberately
-- left alone. Deleting a row in `users` that the seed does not name is precisely what `#208`'s
-- guard refuses to let a restore do, and the identity is real — it holds an address somebody
-- reads. Nothing depends on their removal: every row that referenced them through a seeded event
-- has already gone above, and `provisionSpeaker` is `INSERT OR IGNORE`, so re-running the demo
-- conversion adopts the existing user rather than failing. The residual, stated: a deployment
-- that has run the speaker conversion accumulates one user row per converted contact across
-- resets.
DELETE FROM users
WHERE id IN (
  'seed-organizer',
  'seed-reviewer',
  'seed-speaker',
  'speaker-jordan-bell',
  'seed-public'
);
