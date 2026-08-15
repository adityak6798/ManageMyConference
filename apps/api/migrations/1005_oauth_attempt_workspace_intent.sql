-- @spec PRD-IAM-001 PRD-EVT-001 PRD-CFP-002
--
-- Carry the *context* a Google sign-in was started from, per attempt.
--
-- ## The defect this exists for
--
-- `SignupService.signInWithGoogle` outcome 3 — a provider account nobody has seen, whose verified
-- address belongs to no Greenroom identity — provisions an organization and an event called "Your
-- first event". That is right for somebody who pressed "Continue with Google" on `/signin`
-- intending to run a conference. It is wrong for a CFP submitter who pressed the same button on a
-- public call page because they wanted to keep track of a talk proposal: they get a conference
-- workspace they did not ask for, named after themselves, with an empty event in it. Recorded as
-- a residual of `GAP-027` by issue #190, owned by nobody until this lane.
--
-- ## Why the attempt row rather than a cookie or the callback URL
--
-- The callback URL is fixed configuration registered with Google and must stay that way — deriving
-- it from a request is the open redirect this flow refuses by construction — so the context cannot
-- ride on it. A cookie could carry it, but the browser would then be choosing, at callback time,
-- which of its in-flight sign-ins meant what; the attempt row already holds the per-attempt state
-- that has to outlive the redirect (`state_proof`, `code_verifier`, `nonce`) and is already spent
-- exactly once by `DELETE … RETURNING`, so it is where a per-attempt fact belongs.
--
-- ## What it is not
--
-- Not an authorization decision. `submitter` **withholds** provisioning; it grants nothing, so a
-- forged one costs its own sender a workspace and gains them nothing. The default is `organizer`,
-- which is exactly today's behaviour, so an attempt minted by any path that does not set it
-- behaves as it always has.
--
-- `ADD COLUMN` with a default rather than a table rebuild: SQLite permits a `CHECK` on an added
-- column when it has a default satisfying it, and every existing row is an in-flight sign-in that
-- expires within ten minutes anyway.

ALTER TABLE identity_oauth_attempts
  ADD COLUMN workspace_intent TEXT NOT NULL DEFAULT 'organizer'
  CHECK (workspace_intent IN ('organizer', 'submitter'));
