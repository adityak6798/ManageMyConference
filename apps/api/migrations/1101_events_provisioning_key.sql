-- @spec PRD-EVT-001
--
-- Idempotency for a provisioned event, so a second concurrent writer loses (issue #164).
--
-- Self-serve signup gives a brand-new organization one first event. `SignupService` decides that
-- by reading the organization's events and creating one when it finds none, and two callbacks
-- that both read an empty organization both create one — measured against Miniflare D1 at 25 of
-- 45 tested stagger offsets, a window of roughly 40ms locally that widens with D1 latency. What
-- the person then holds is two identically named "Your first event" entries in the switcher, and
-- no route in this repository deletes an event.
--
-- A read cannot close that, whatever it is followed by; the second writer has to be refused by
-- storage. The key is supplied by the events domain (`firstEventProvisioningKey`) rather than by
-- the caller, and names the *person and the intent* — "the first event provisioned here for this
-- user" — so the loser can read the winner's row back and adopt it instead of creating another.
--
-- The subject is part of the key so that the idempotence is the caller's own: two concurrent
-- callbacks are the same person and share a key, which is what makes them converge, while two
-- *different* people provisioning in one organization would not silently collide.
--
-- It is not what stops a member adopting somebody else's event — `completeWorkspace` does that, by
-- provisioning only into an organization with no events and no other member, and never adopting an
-- event that already exists. The subject here is defence in depth for a caller that does not exist
-- yet, and no current code path can observe the difference.
--
-- Nullable, and the index is partial for the same reason `agenda_publications.command_key` is:
-- every event an organizer creates deliberately carries no key, many such rows exist per
-- organization, and NULLs must not collide with each other.
ALTER TABLE events ADD COLUMN provisioning_key TEXT;

CREATE UNIQUE INDEX events_provisioning_key_idx
  ON events(organization_id, provisioning_key)
  WHERE provisioning_key IS NOT NULL;
