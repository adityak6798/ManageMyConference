-- The only thing the operational inbox stores.
--
-- Every item on that surface is derived from the owning domains' own reads on each request, so
-- completing a task or placing a session removes its item with no write here and no queue to
-- fall out of step with the world. A dismissal is the exception because it cannot be derived
-- from anything: it is one person saying they have seen an occurrence and are not acting on it.
--
-- `item_key` carries the *occurrence*, not the record — a task's key includes its deadline, a
-- delivery's includes its attempt count — so re-deriving the same condition finds the dismissal
-- and a genuinely new occurrence of it does not. That is why the key is opaque text here rather
-- than a foreign key: the rows it can refer to belong to five other domains, and platform must
-- not hold a reference into any of them.
--
-- Per actor, deliberately. Letting one organizer's dismissal hide an item from a colleague would
-- make it possible to silently remove work from somebody else's list.
--
-- **`ON DELETE CASCADE` on both references, and it is load-bearing rather than tidy.** The seed
-- reset is a full teardown of `events` and `users`, D1 enforces foreign keys, and it will not
-- honour `PRAGMA foreign_keys = OFF` between statements. Without the cascade, a single dismissed
-- inbox item makes every subsequent `npm run reset` fail with a bare `FOREIGN KEY constraint
-- failed` naming no table — and both Playwright configs bootstrap through `npm run reset`, so the
-- browser gate stops coming up before a spec runs.
--
-- A seed cleanup fragment would have been the other way to fix it, and is the wrong one here: the
-- seed has to stay applicable at migration `1801`, because `d1-publication-repository.integration
-- .test.ts` applies it there to prove `1802`'s guard refuses a pre-existing collision. A `DELETE`
-- against a table two hundred migrations later cannot run at that point. The cascade needs no
-- fragment, so the reset stays applicable at every migration boundary.
--
-- Cascading is also the right *meaning*: a dismissal is one person's decision about one occurrence
-- on one event, and it has nothing left to say once either the event or the person is gone.
CREATE TABLE platform_inbox_dismissals (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (event_id, item_key, actor_id)
);

CREATE INDEX platform_inbox_dismissals_event_actor_idx
  ON platform_inbox_dismissals(event_id, actor_id);
