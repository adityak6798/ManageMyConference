
DELETE FROM identity_login_challenges;
-- In-flight sign-in attempts hold no foreign key, but a reset that leaves them behind leaves a
-- callback able to complete against a database whose users have just been replaced.
DELETE FROM identity_oauth_attempts;
-- Issued sessions are demo state: a reset that left them behind would leave a cookie minted
-- against the previous fixture resolving against the new one. Before `users` for the same
-- reason as the rows below it.
DELETE FROM identity_sessions;
-- The audit spine is append-only in the application and cleared only here, because a
-- deterministic reset that kept the previous run's rows would report actions against users that
-- no longer exist. It holds no foreign key; the position is for readability.
DELETE FROM identity_audit_events;
-- Before `users`: this references it, and D1 does not honour `PRAGMA foreign_keys` between
-- statements, so relying on the cascade would leave rows that make the next reset fail.
DELETE FROM identity_provider_accounts;
DELETE FROM identity_emails;
DELETE FROM users;
