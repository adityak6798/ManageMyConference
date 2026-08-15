-- Generated agenda drafts, the criteria that shape them, and speaker availability
-- (issue #192's residual Private-set agenda-generation epic).
--
-- **What already existed, and what was missing.** `assistedPlacement` seats every unscheduled
-- session by first fit and writes the result straight onto the live board. That is useful and it
-- is not what the epic asks for: it has one rule nobody chose, it cannot be compared with the
-- board it replaced, it cannot be re-run without having already changed things, and a session it
-- could not seat is reported once and then forgotten. Three tables close that.
--
-- **A generated draft is a candidate, never the board.** `agenda_generated_drafts` holds a whole
-- proposed placement set as JSON, alongside the board revision it was generated against. Nothing
-- about it is live: the organizer compares it with the board, accepts the changes they want, and
-- the board's own optimistic concurrency refuses the accept if the board moved underneath. That
-- is why `board_revision` is stored rather than derived — a draft generated against a board two
-- edits ago is a diff against something that no longer exists, and saying so is the whole point.
--
-- **Placements are JSON rather than rows.** A draft is only ever read and written whole: it is
-- generated in one pass, compared in one read, and either accepted or thrown away. Child rows
-- would buy per-placement addressing that nothing needs and cost a join on every comparison.
-- Every placement in it is re-validated against the live board on accept, so nothing here is
-- trusted as it stands.
CREATE TABLE agenda_generated_drafts (
  id             TEXT PRIMARY KEY NOT NULL,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- The board revision this was generated against. A draft older than the board is stale, and
  -- the comparison says so rather than quietly proposing placements against vanished slots.
  board_revision INTEGER NOT NULL,
  -- The ordered criteria that produced it, copied at generation time. Copied rather than
  -- referenced because the library is editable: a draft that named the library would change its
  -- own explanation the next time somebody reordered a rule.
  criteria_json  TEXT NOT NULL CHECK (json_valid(criteria_json)),
  placements_json TEXT NOT NULL CHECK (json_valid(placements_json)),
  -- Why each session the pass could not seat was left out, in the organizer's terms and naming
  -- the criterion that refused it. The epic asks for explanations, and an explanation produced
  -- at generation time is the only one that can name the cells that were actually tried.
  unplaced_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unplaced_json)),
  generated_by   TEXT NOT NULL REFERENCES users(id),
  generated_at   TEXT NOT NULL,
  -- `accepted` records that the organizer took changes from it. It stays visible afterwards so
  -- "where did this arrangement come from" has an answer — the provenance the epic asks for.
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'discarded')),
  accepted_at    TEXT,
  CHECK (length(name) BETWEEN 1 AND 120),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE INDEX agenda_generated_drafts_event_idx ON agenda_generated_drafts(event_id, generated_at);

-- The criteria library, in priority order.
--
-- One row per criterion per event, and `position` is the priority: earlier is stronger. The keys
-- are a closed list because each one is a rule the generator implements — a row naming a key
-- nothing implements would be a priority nobody applies, which is worse than not offering it.
--
-- A criterion is either a hard constraint (a cell it refuses is never used) or a soft preference
-- (a cell it dislikes is used only when nothing better exists). Which of the two each key is
-- belongs to the generator rather than to this table: making it a column would let an organizer
-- turn "do not double-book a speaker" into a preference.
CREATE TABLE agenda_generation_criteria (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  criterion   TEXT NOT NULL CHECK (criterion IN (
    'avoid-speaker-clash',
    'respect-speaker-availability',
    'keep-track-together',
    'spread-tracks-across-rooms',
    'prefer-earlier-slots',
    'balance-room-load'
  )),
  position    INTEGER NOT NULL CHECK (position >= 0),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (event_id, criterion)
);
CREATE INDEX agenda_generation_criteria_order_idx ON agenda_generation_criteria(event_id, position);

-- When a speaker cannot be scheduled.
--
-- A *window* rather than a flag, because "not on Tuesday morning" is the shape of the real
-- constraint and a boolean cannot carry it. `kind` says whether the window is the only time they
-- are available or the one time they are not; both occur, and collapsing them into one would make
-- an organizer express "only Tuesday" as every other day.
--
-- `speaker_id` names an identity this domain does not own and carries no foreign key, the same
-- choice `agenda_session_schedules` makes about session ids: the agenda is handed speaker ids by
-- the content domain and reads none of its tables.
CREATE TABLE agenda_speaker_availability (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  speaker_id TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('available', 'unavailable')),
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (event_id, speaker_id, starts_at, ends_at, kind),
  -- A window that ends before it starts is not a window, and a generator given one would silently
  -- refuse every cell for that speaker.
  CHECK (ends_at > starts_at),
  CHECK (length(note) <= 200)
);
CREATE INDEX agenda_speaker_availability_event_idx
  ON agenda_speaker_availability(event_id, speaker_id);
