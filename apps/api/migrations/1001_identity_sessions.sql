-- Issued sessions, so that signing out can be revocation rather than cookie clearing.
-- Identity block 1000-1099; 1000 is Google sign-in.
--
-- Before this table the session cookie was a signed bearer carrying its own expiry and nothing
-- else: a copy taken from another device kept working for the rest of the eight hours no matter
-- what the browser that minted it did afterwards. The row is what a sign-out can act on. The
-- cookie now carries the id of its row, the resolver reads the row on every authenticated
-- request, and a row that is missing, revoked or expired refuses the credential.
--
-- revoked_at rather than a delete: an expired row and a revoked one are the same refusal to a
-- caller, but they are not the same fact to an operator reading identity_audit_events beside
-- this table, and a row that is gone cannot tell them apart.
--
-- No quote character of any kind belongs in a comment in this file; see the note in
-- 1002_identity_audit_events.sql for what the schema-drift tokenizer does with one.
CREATE TABLE identity_sessions (
  id          TEXT PRIMARY KEY NOT NULL,
  -- Whose session this is, and the only thing this column is for: it scopes revocation, meaning
  -- end every session of this user, and nothing else. Actor resolution stays with findByPersona
  -- and findByUserId; see docs/architecture/authorization.md.
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
-- Revoke-all reads by user; expiry is what a future prune would sweep on.
CREATE INDEX identity_sessions_user_idx   ON identity_sessions(user_id);
CREATE INDEX identity_sessions_expiry_idx ON identity_sessions(expires_at);
