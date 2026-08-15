-- Organization-owned Sites: a branded portal composing several programs (issue #196).
--
-- A Site is **not** a second public-event projection and deliberately shares none of its
-- machinery. The projection answers "what is this conference's programme, at which version"; a
-- Site answers "where does a person go to find this organization's open calls, forms and speaker
-- portals". They are addressed under different public prefixes, so their slugs cannot collide and
-- neither reserves against the other.
--
-- What a Site publishes is a **pointer to a program**, never a copy of it. `site_programs` holds
-- the kind and the id, and the composer resolves each through the owning domain's public
-- application interface at read time. Copying a CFP's title into publishing's tables would be a
-- second source of truth for somebody else's data, and the first edit on the other side would
-- make the portal quietly wrong.
CREATE TABLE sites (
  id               TEXT PRIMARY KEY NOT NULL,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The public address. Readable and stable, like every other public address in this product.
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  tagline          TEXT NOT NULL DEFAULT '',
  landing_heading  TEXT NOT NULL DEFAULT '',
  landing_body     TEXT NOT NULL DEFAULT '',
  login_heading    TEXT NOT NULL DEFAULT '',
  login_body       TEXT NOT NULL DEFAULT '',
  -- Bounded branding: a theme name and a primary colour, validated in the application. Not free
  -- CSS — a portal that could carry arbitrary style could carry an arbitrary background image
  -- URL, which is a request to a third party made from a page a visitor believes is ours.
  theme            TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'auto')),
  primary_color    TEXT NOT NULL DEFAULT '#2f5d50',
  state            TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'unpublished')),
  published_at     TEXT,
  -- Optimistic concurrency across the whole Site, its pages and its program order, so two
  -- organizers editing the portal cannot interleave into an arrangement neither of them chose.
  revision         INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (length(slug) BETWEEN 1 AND 120),
  CHECK (length(name) BETWEEN 1 AND 120),
  -- Six hex digits behind a `#`. Written as a length test, a prefix test and one negated
  -- character class rather than as six positional classes: SQLite refuses a GLOB pattern of that
  -- second shape with "pattern too complex", so the obvious spelling would have failed every
  -- insert rather than only the malformed ones. `isPrimaryColor` states the same rule in the
  -- application, where the regular expression can be read.
  CHECK (
    length(primary_color) = 7
    AND substr(primary_color, 1, 1) = '#'
    AND lower(primary_color) NOT GLOB '*[^#0-9a-f]*'
  ),
  CHECK (revision >= 1),
  -- A published Site has a publication instant, and an unpublished one keeps it: the history is
  -- what "unpublish" is the absence of, and losing the instant would lose when it was last live.
  CHECK (state <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX sites_organization_idx ON sites(organization_id, name);
CREATE INDEX sites_state_idx ON sites(state, slug);

-- One attached program. `program_ref` is another domain's identifier and deliberately carries no
-- foreign key: publishing does not own CFP forms, interest forms or speaker portals, and a
-- reference that enforced existence here would be publishing reaching into their tables. A
-- program whose source has gone is dropped at composition time and reported to the organizer.
CREATE TABLE site_programs (
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  program_kind TEXT NOT NULL CHECK (program_kind IN ('event-cfp', 'interest-form', 'speaker-portal')),
  program_ref TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  PRIMARY KEY (site_id, program_kind, program_ref),
  CHECK (position >= 0),
  CHECK (length(label) <= 120)
);
CREATE INDEX site_programs_order_idx ON site_programs(site_id, position);

-- An organizer-authored page. `body_html` is sanitized by a parser before it is stored, the same
-- boundary speaker resources use; storing raw markup and sanitizing on render would leave the
-- unsafe copy as the durable one.
CREATE TABLE site_pages (
  id         TEXT PRIMARY KEY NOT NULL,
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  position   INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden')),
  CHECK (length(slug) BETWEEN 1 AND 120),
  CHECK (length(title) BETWEEN 1 AND 160),
  CHECK (length(body_html) <= 40000),
  CHECK (position >= 0)
);
CREATE UNIQUE INDEX site_pages_slug_idx ON site_pages(site_id, slug);
CREATE INDEX site_pages_order_idx ON site_pages(site_id, position);

-- Privacy notices are **append-only by version**, which is the whole point of recording consent:
-- a stored consent names a version, and a version whose text could be rewritten afterwards would
-- make every consent record a claim about text nobody can produce. The trigger refuses an update
-- to the body outright rather than trusting the one service that writes here.
CREATE TABLE site_privacy_notices (
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  body_html    TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  PRIMARY KEY (site_id, version),
  CHECK (version >= 1),
  CHECK (length(body_html) BETWEEN 1 AND 40000)
);

CREATE TRIGGER site_privacy_notices_immutable
BEFORE UPDATE ON site_privacy_notices
BEGIN
  SELECT RAISE(ABORT, 'a privacy notice version is immutable; publish a new version');
END;

-- The registration form's bounded custom fields. The required identity fields are fixed in the
-- application and are deliberately not rows here: a portal that could remove the field it
-- identifies a registrant by is a portal that can collect anonymous rows nobody can act on.
CREATE TABLE site_registration_fields (
  site_id  TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label    TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('text', 'longtext', 'select', 'checkbox')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  options  TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL,
  PRIMARY KEY (site_id, field_key),
  CHECK (length(field_key) BETWEEN 1 AND 60),
  CHECK (length(label) BETWEEN 1 AND 120),
  CHECK (json_valid(options)),
  CHECK (position >= 0)
);
CREATE INDEX site_registration_fields_order_idx ON site_registration_fields(site_id, position);

-- What somebody accepted, exactly. The version, the actor and the instant, and none of them
-- derived at read time: "the current notice" is not an answer to "what did they agree to".
--
-- `actor_ref` is the registrant's address, normalized. This is personal data and it is here
-- deliberately rather than hashed, because a consent record nobody can connect to a person is
-- not a consent record — it is what a data-subject request has to be answered from.
CREATE TABLE site_consents (
  id             TEXT PRIMARY KEY NOT NULL,
  site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  notice_version INTEGER NOT NULL,
  actor_ref      TEXT NOT NULL,
  accepted_at    TEXT NOT NULL,
  -- The bounded custom answers, as JSON. Fixed identity fields are columns above this comment's
  -- reach; everything else the organizer configured lands here.
  answers_json   TEXT NOT NULL DEFAULT '{}',
  CHECK (json_valid(answers_json)),
  FOREIGN KEY (site_id, notice_version) REFERENCES site_privacy_notices(site_id, version)
);
CREATE INDEX site_consents_site_idx ON site_consents(site_id, accepted_at);
-- One live registration per address per Site: a second submission updates nothing and is
-- reported as already registered rather than growing a second consent row for one person.
CREATE UNIQUE INDEX site_consents_actor_idx ON site_consents(site_id, actor_ref);

CREATE TRIGGER site_consents_immutable
BEFORE UPDATE ON site_consents
BEGIN
  SELECT RAISE(ABORT, 'a consent record is immutable');
END;

-- Publish history. Immutable, append-only, and the snapshot is what was served at that version —
-- so "what did the portal say in March" has an answer that does not depend on the draft.
--
-- **Deliberately no foreign key**, the same choice `platform_audit_records` made and for the same
-- reason: a record has to outlive the thing it describes. It is also what keeps the append-only
-- triggers below coherent — a cascade would be a delete, and the trigger would abort it.
--
-- **There is no delete for a Site.** Unpublishing is the withdrawal: the public address stops
-- answering and the history stays. That is not squeamishness about `DROP` — a Site accumulates
-- consent records naming a privacy-notice version, and deleting the notice a person accepted
-- would leave a consent record that cannot say what was consented to. Retention is therefore a
-- question about `site_consents`, answered on its own terms, rather than a side effect of
-- removing a portal.
CREATE TABLE site_publications (
  site_id      TEXT NOT NULL,
  version      INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (site_id, version),
  CHECK (version >= 1),
  CHECK (json_valid(snapshot_json))
);
CREATE INDEX site_publications_time_idx ON site_publications(site_id, published_at);

CREATE TRIGGER site_publications_no_update
BEFORE UPDATE ON site_publications
BEGIN
  SELECT RAISE(ABORT, 'site_publications is append-only');
END;

CREATE TRIGGER site_publications_no_delete
BEFORE DELETE ON site_publications
BEGIN
  SELECT RAISE(ABORT, 'site_publications is append-only');
END;
