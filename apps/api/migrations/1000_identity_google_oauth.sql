-- Google sign-in: the durable half of the authorization-code flow, and the link between a
-- provider account and a Greenroom user. Identity block `1000`–`1099`; first migration in it.
--
-- `identity_oauth_attempts` exists because CSRF `state` and the PKCE `code_verifier` have to
-- outlive the redirect to Google without ever reaching the browser. The verifier in particular
-- is the whole point of PKCE: an attacker who intercepts the authorization code cannot exchange
-- it without the verifier, which is why it stays server-side rather than in a cookie.
--
-- Single use is enforced by deleting the row on the callback (`DELETE … RETURNING`), not by a
-- consumed flag: a row that is gone cannot be replayed by a second callback racing the first,
-- and a delete that returns nothing is the same refusal as an expired attempt, which is exactly
-- how a replay should read.
CREATE TABLE identity_oauth_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  -- HMAC of the `state` value this attempt issued. The value itself travels through Google and
  -- back in a query parameter; storing only its proof means a database read cannot forge a
  -- callback.
  state_proof TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX identity_oauth_attempts_expiry_idx ON identity_oauth_attempts(expires_at);

-- Which provider identity is this Greenroom user?
--
-- Keyed on (provider, subject) rather than on the address: Google's `sub` is stable and an
-- account's email is not, so a user who changes their Google address keeps this row and keeps
-- their workspace. `identity_emails` continues to own the address itself, which is what the
-- emailed-code route resolves and what account linking matches on the first sign-in only.
CREATE TABLE identity_provider_accounts (
  provider TEXT NOT NULL CHECK (provider = 'google'),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identity_provider_accounts_user_idx ON identity_provider_accounts(user_id);
