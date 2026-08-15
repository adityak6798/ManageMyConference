-- Named, revocable embeds (issue #192's residual embed-lifecycle epic).
--
-- **What was missing was the lifecycle, not the embed.** PR #214 shipped embed *views* — a
-- schedule, a speaker directory, a gallery — configured by query string and copied as a snippet.
-- Nothing was stored, which means an organizer could not come back to an embed they had issued,
-- could not change it, and above all **could not withdraw it**: a URL pasted into somebody else's
-- site kept answering for ever, and the only way to stop it was to unpublish the whole event.
-- This table is that missing half.
--
-- **The token is the address, and revoking it is the whole of withdrawal.** Only the digest is
-- stored, exactly as `attendee_itineraries` and `capability_links` store theirs. An embed is not a
-- `capability_link`, deliberately: those are one-off shares that expire and count views, while an
-- embed is a *standing* publication with no expiry and unbounded reads. Sharing the table would
-- have meant giving every embed an expiry nobody wants or giving every share link an immortality
-- nobody should have.
--
-- **`output` is immutable after creation, and that is a product rule rather than a limitation.**
-- A host page parsing JSON cannot survive being handed HTML, and an organizer editing an embed
-- has no way to know who is parsing it. Changing the output is therefore `duplicate`, which mints
-- a new token — so the old integration keeps working until its owner takes it down, and the
-- trigger below makes that true of any writer rather than only of the service.
CREATE TABLE publication_embeds (
  id           TEXT PRIMARY KEY NOT NULL,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- Which view this embed renders. The same four PR #214 shipped.
  view         TEXT NOT NULL CHECK (view IN ('schedule', 'speakers', 'gallery', 'itinerary')),
  -- What a host page receives. Immutable; see the trigger.
  output       TEXT NOT NULL CHECK (output IN ('styled-html', 'basic-html', 'json', 'xml', 'ical')),
  -- Bounded presentation. A six-digit accent and a theme name, never free CSS: an embed that
  -- could carry arbitrary style could carry an arbitrary background-image URL, which is a request
  -- to a third party made from a frame the visitor believes is the conference's.
  accent       TEXT NOT NULL DEFAULT '#2f5d50',
  theme        TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'auto')),
  -- Track/format/day narrowing, and which optional fields a card prints. Both validated against
  -- the composer's own vocabulary before they are stored.
  filters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters_json)),
  fields_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields_json)),
  token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- Withdrawal. The row stays so the organizer can see what they issued and when they stopped it;
  -- the URL answers exactly as an unknown one from that moment.
  revoked_at   TEXT,
  CHECK (length(name) BETWEEN 1 AND 120),
  CHECK (
    length(accent) = 7
    AND substr(accent, 1, 1) = '#'
    AND lower(accent) NOT GLOB '*[^#0-9a-f]*'
  )
);
CREATE INDEX publication_embeds_event_idx ON publication_embeds(event_id, created_at);
-- The resolve's only lookup, and it skips withdrawn rows outright.
CREATE INDEX publication_embeds_live_idx ON publication_embeds(token_hash) WHERE revoked_at IS NULL;

-- The output an embed was issued with is what its consumers parse. A host page reading JSON does
-- not survive being handed HTML, and nobody editing the embed can know who is parsing it — so
-- this is refused at the table rather than only in the service that happens to write here.
CREATE TRIGGER publication_embeds_output_is_immutable
BEFORE UPDATE OF output ON publication_embeds
WHEN NEW.output <> OLD.output
BEGIN
  SELECT RAISE(ABORT, 'an embed output type is immutable; duplicate the embed instead');
END;

-- And the token with it: rotating an address in place would break every host page silently
-- rather than visibly. A new address is a new embed.
CREATE TRIGGER publication_embeds_token_is_immutable
BEFORE UPDATE OF token_hash ON publication_embeds
WHEN NEW.token_hash <> OLD.token_hash
BEGIN
  SELECT RAISE(ABORT, 'an embed address is immutable; duplicate the embed instead');
END;
