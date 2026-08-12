CREATE TABLE identity_login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  code_proof TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at INTEGER
);
CREATE INDEX identity_login_challenges_expiry_idx ON identity_login_challenges(expires_at);
