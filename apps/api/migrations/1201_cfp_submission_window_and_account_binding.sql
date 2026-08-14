-- @spec PRD-CFP-001 PRD-CFP-002
--
-- A scheduled submission window, and proposals that belong to an account.
--
-- ## The window lives in columns, not in the published snapshot
--
-- `published_json` is the form applicants are served, and republishing it is how an organizer
-- changes what the form asks. A deadline is not part of what the form asks: extending it must not
-- also publish whatever unrelated draft edits are sitting in the composer, and closing a call
-- early must not require a republish. So `opens_at` and `closes_at` are live state on the row,
-- exactly like `status`, and `savePublished` deliberately omits them from the snapshot it writes.
-- `D1CfpRepository` overlays the columns onto every form it reads, which is why a snapshot
-- written before this migration needs no backfill.
--
-- Both hold a UTC instant in the canonical `Date.prototype.toISOString()` shape
-- (`YYYY-MM-DDTHH:MM:SS.sssZ`) and nothing else. That is load-bearing rather than tidy:
-- `createSubmission` and the two proposal writes below compare these columns against a bound
-- instant as **text**, and lexicographic order equals chronological order only while every value
-- is the same fixed-width UTC format. `CfpService` normalises through `Date` before writing, and
-- `d1-cfp-repository.integration.test.ts` pins the comparison.
--
-- An instant rather than a wall-clock time in the event's zone, and the difference is visible: a
-- deadline announced to applicants must not move because somebody corrected the event's timezone
-- afterwards. Both applicant and organizer surfaces render the instant *in* the event timezone,
-- which is where "interpreted in the event timezone" belongs — presentation and entry, not
-- storage.
--
-- ## Proposals gain an owner, a lifecycle and a revision
--
-- `submitter_user_id` is NULL for every anonymous submission, including the ones already stored.
-- That is the whole ownership rule: an anonymous proposal has no owner, appears on nobody's
-- dashboard, and cannot be claimed by asserting an address (`#132`). Nullable also satisfies
-- SQLite's requirement that a column added with a `REFERENCES` clause default to NULL while
-- foreign keys are enforced.
--
-- `lifecycle` is the authoritative draft/submitted marker and every reader of `cfp_submissions`
-- outside this domain filters on it — `D1SubmittedProposalAdapter` does so in all four of its
-- read paths, which `cfp-draft-isolation.integration.test.ts` enumerates. A draft additionally
-- carries `status = 'draft'`, which is defence in depth rather than a second source of truth:
-- no event configures a triage status keyed `draft`, so a status-filtered triage read cannot
-- reach a draft even if a future reader forgets the lifecycle predicate, and a draft cannot pin
-- a configured status against deletion through `cfp_status_delete_rejects_in_use`. The two are
-- held in agreement by the guard triggers below rather than by convention.
--
-- `revision` is the optimistic-concurrency token for a proposal, in the same shape
-- `cfp_forms.version` already uses for the composer: every write names the revision it read,
-- exactly one competing write advances it, and the loser is refused without replacing the winner.
--
-- `updated_at` is nullable because SQLite cannot add a NOT NULL column without a default and no
-- default here would be true. The backfill sets it for every row that already exists and
-- `D1CfpRepository` writes it on every insert and update, so a NULL means only "written by
-- something older than this migration" — which every reader resolves with
-- `COALESCE(updated_at, submitted_at)` rather than by pretending the row has no history. It is
-- deliberately *not* enforced by the guards below: a NOT NULL-by-trigger column would refuse
-- every fixture and seed insert that predates it for no invariant worth the churn.
-- `submitted_at` keeps its meaning — when this proposal was submitted — and for a draft it holds
-- the creation instant, which no surface displays.

ALTER TABLE cfp_forms ADD COLUMN opens_at TEXT;
ALTER TABLE cfp_forms ADD COLUMN closes_at TEXT;

ALTER TABLE cfp_submissions ADD COLUMN submitter_user_id TEXT REFERENCES users(id);
ALTER TABLE cfp_submissions ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'submitted'
  CHECK (lifecycle IN ('draft', 'submitted'));
ALTER TABLE cfp_submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE cfp_submissions ADD COLUMN updated_at TEXT;

UPDATE cfp_submissions SET updated_at = submitted_at WHERE updated_at IS NULL;

-- The submitter dashboard reads one account's proposals for one event; the lifecycle index serves
-- every organizer projection, all of which now filter drafts out.
CREATE INDEX cfp_submissions_submitter_idx ON cfp_submissions(submitter_user_id, event_id);
CREATE INDEX cfp_submissions_event_lifecycle_idx ON cfp_submissions(event_id, lifecycle);

-- A draft is owned and marked `draft` in both columns. A submitted proposal is the mirror image:
-- never marked `draft` in either. Stated as one trigger per write path because SQLite evaluates a
-- `BEFORE INSERT` trigger and a `BEFORE UPDATE` trigger separately, and a guard that covered only
-- the insert is exactly the sibling `GAP-025` was filed about.
CREATE TRIGGER cfp_submission_lifecycle_insert_guard
BEFORE INSERT ON cfp_submissions
WHEN (NEW.lifecycle = 'draft') <> (NEW.status = 'draft')
  OR (NEW.lifecycle = 'draft' AND NEW.submitter_user_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'CFP_PROPOSAL_LIFECYCLE_INVALID');
END;

CREATE TRIGGER cfp_submission_lifecycle_update_guard
BEFORE UPDATE ON cfp_submissions
WHEN (NEW.lifecycle = 'draft') <> (NEW.status = 'draft')
  OR (NEW.lifecycle = 'draft' AND NEW.submitter_user_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'CFP_PROPOSAL_LIFECYCLE_INVALID');
END;

-- Submitting is one-way. A submitted proposal that could revert to a draft would vanish from the
-- reviewer queue and the organizer's triage after it had been read there, and no downstream
-- reader would see anything but an absence.
CREATE TRIGGER cfp_submission_lifecycle_no_regression
BEFORE UPDATE OF lifecycle ON cfp_submissions
WHEN OLD.lifecycle = 'submitted' AND NEW.lifecycle = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'CFP_PROPOSAL_LIFECYCLE_REGRESSION');
END;

-- A proposal's owner is fixed at creation. Reassigning one would move somebody else's submission
-- onto this account's dashboard, which is the isolation property the dashboard exists to keep.
CREATE TRIGGER cfp_submission_owner_is_immutable
BEFORE UPDATE OF submitter_user_id ON cfp_submissions
WHEN COALESCE(OLD.submitter_user_id, '') <> COALESCE(NEW.submitter_user_id, '')
BEGIN
  SELECT RAISE(ABORT, 'CFP_PROPOSAL_OWNER_IMMUTABLE');
END;
