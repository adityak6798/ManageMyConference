CREATE TABLE identity_emails (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE CONSTRAINT identity_emails_lowercase CHECK (email = lower(email))
);
