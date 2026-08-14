-- Saved reports, their share links and their schedules (issue #196).
--
-- **Nothing here stores report *results*.** A definition is a question — a dataset, some filters,
-- a grouping — and it is answered by re-running it through the owning domains' declared read
-- interfaces every time. That is the same argument `PlatformSearchService` makes about not
-- building an index: a stored result set would be a second copy of private CRM notes, unpublished
-- speaker material and reviewer-hidden scores, sitting outside every rule that protects the
-- originals and needing to be kept honest by hand on every write in the repository.
--
-- The consequence, stated rather than discovered: a share link resolves *live* data under a
-- deliberate share policy, so revoking the link is the whole of revoking access.
CREATE TABLE report_definitions (
  id              TEXT PRIMARY KEY NOT NULL,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  -- Which allowlisted dataset this question is asked of. The catalogue lives in the application
  -- (`report-catalogue.ts`); this CHECK is what stops a row naming a dataset nothing can answer.
  dataset         TEXT NOT NULL CHECK (dataset IN (
    'sessions', 'speakers', 'submissions', 'reviews', 'deliverables',
    'contacts', 'agenda', 'communications'
  )),
  -- Field selection, filters, grouping, sorting and page size, as one validated JSON document.
  -- Stored as JSON rather than as five child tables because it is *one* value that is only ever
  -- read and written whole, and because every part of it is re-validated against the catalogue on
  -- the way in and on the way out — a filter naming a field the catalogue does not have is
  -- refused, so nothing here is a query fragment that could reach storage.
  query_json      TEXT NOT NULL CHECK (json_valid(query_json)),
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (length(name) BETWEEN 1 AND 120),
  CHECK (length(description) <= 400)
);
CREATE UNIQUE INDEX report_definitions_event_name_idx
  ON report_definitions(event_id, lower(name));
CREATE INDEX report_definitions_event_idx ON report_definitions(event_id, updated_at);

-- The capability-URL convention, as one table every anonymous share link in this product uses.
--
-- `DEBT-012` records this product's existing capability URL — the attendee itinerary — and the
-- condition it states for the next one: *identity plus revocation and rotation must ship before
-- the payload crosses the named public-data boundary.* Every later link does cross it, so rather
-- than each domain growing its own token table, this is the shape they share, and it ships what
-- that entry withholds from the itinerary: an expiry, a view limit, an optional password, and
-- revocation. Only the token's digest is stored, exactly as the itinerary stores only its hash.
--
-- **A link names a resource, not a session.** `resource_kind` says which domain resolves it and
-- `resource_ref` is that domain's own identifier, carried with **no foreign key** — platform owns
-- neither reports' rows nor content's, and a reference that enforced existence here would be
-- platform reaching into their tables. A resolver that finds nothing refuses exactly as an
-- unknown token does.
--
-- `speaker-profile` and `speaker-asset` are declared and resolved by nothing yet, deliberately:
-- issue #189's `GAP-028` residual needs precisely this shape, and a kind declared in advance is
-- a lane adding a resolver rather than inventing a second convention.
--
-- `scope_json` is the per-kind policy fixed when the link was minted. A report's link carries
-- `allowPii`, and it lives on the link rather than on the request because the person opening it
-- is anonymous and cannot be asked to hold a capability.
CREATE TABLE capability_links (
  id              TEXT PRIMARY KEY NOT NULL,
  resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('report', 'speaker-profile', 'speaker-asset')),
  resource_ref    TEXT NOT NULL,
  -- Recorded as the values they were, like an audit row: a link has to keep saying what it was
  -- for once the thing it addressed has moved on.
  organization_id TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  -- SHA-256 of the password, or null. Null means the link alone is the credential, which is what
  -- makes the expiry and the view limit load-bearing rather than decorative.
  password_hash   TEXT CHECK (password_hash IS NULL OR length(password_hash) = 64),
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  -- Null means unlimited views. A number is spent by the resolve, in the same statement that
  -- checks liveness, so two concurrent resolves of a one-view link cannot both succeed.
  view_limit      INTEGER CHECK (view_limit IS NULL OR view_limit >= 1),
  views           INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  revoked_at      TEXT,
  scope_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json))
);
CREATE INDEX capability_links_resource_idx
  ON capability_links(resource_kind, resource_ref, created_at);
-- The resolve's only lookup, and the sweep's: an expired link is a secret that has outlived its
-- use, and something will eventually want to find them all.
CREATE INDEX capability_links_expiry_idx ON capability_links(expires_at) WHERE revoked_at IS NULL;

-- Scheduled delivery, in the event's own timezone.
--
-- **Delivery is a link, not a message.** The recipient is sent an expiring share URL rather than
-- a rendered report, which is what keeps this inside publishing/platform rather than requiring a
-- new `communication_deliveries.trigger_type` — that column is a pinned CHECK whose widening is a
-- table rebuild in the communications block, and lane R1 is working there. `last_fired_key` is
-- the occurrence this schedule has already produced, so a cron tick that runs twice in one
-- minute, or a Worker that retries, fires once per occurrence rather than once per tick.
CREATE TABLE report_schedules (
  id             TEXT PRIMARY KEY NOT NULL,
  report_id      TEXT NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  cadence        TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  -- Minutes past midnight in `timezone`, and the day-of-week or day-of-month the cadence needs.
  minute_of_day  INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
  day_of_week    INTEGER CHECK (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6),
  day_of_month   INTEGER CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
  timezone       TEXT NOT NULL,
  recipients     TEXT NOT NULL CHECK (json_valid(recipients)),
  link_lifetime_hours INTEGER NOT NULL DEFAULT 72
    CHECK (link_lifetime_hours BETWEEN 1 AND 720),
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  paused_at      TEXT,
  last_fired_key TEXT,
  -- A weekly schedule names a weekday and a monthly one names a day; a daily one names neither.
  -- Stated here so a row cannot describe an occurrence the scheduler has no rule for.
  CHECK (
    (cadence = 'daily' AND day_of_week IS NULL AND day_of_month IS NULL) OR
    (cadence = 'weekly' AND day_of_week IS NOT NULL AND day_of_month IS NULL) OR
    (cadence = 'monthly' AND day_of_week IS NULL AND day_of_month IS NOT NULL)
  )
);
CREATE INDEX report_schedules_report_idx ON report_schedules(report_id);
CREATE INDEX report_schedules_active_idx ON report_schedules(paused_at, cadence);

-- What a schedule actually did, which is the row an operator reads when somebody says the report
-- never arrived. Append-only, and unique on the occurrence key so a retried tick converges on the
-- record already written rather than claiming a second delivery.
CREATE TABLE report_runs (
  id           TEXT PRIMARY KEY NOT NULL,
  schedule_id  TEXT NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  ran_at       TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed')),
  detail       TEXT NOT NULL DEFAULT '',
  UNIQUE (schedule_id, occurrence_key)
);
CREATE INDEX report_runs_time_idx ON report_runs(schedule_id, ran_at);

CREATE TRIGGER report_runs_no_update
BEFORE UPDATE ON report_runs
BEGIN
  SELECT RAISE(ABORT, 'report_runs is append-only');
END;
