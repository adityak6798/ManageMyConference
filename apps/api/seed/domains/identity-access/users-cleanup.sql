
DELETE FROM identity_login_challenges;
-- In-flight sign-in attempts hold no foreign key, but a reset that leaves them behind leaves a
-- callback able to complete against a database whose users have just been replaced.
DELETE FROM identity_oauth_attempts;
-- Before `users`: this references it, and D1 does not honour `PRAGMA foreign_keys` between
-- statements, so relying on the cascade would leave rows that make the next reset fail.
DELETE FROM identity_provider_accounts;
DELETE FROM identity_emails;
DELETE FROM users;
