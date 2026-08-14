-- Every event in a seeded organization, not only the three the seed inserts by id.
--
-- The narrower rule was tried first and it breaks the reset. The demo *creates* events — the
-- browser journey does, the event-template journey does — and an event created inside "Greenroom
-- Labs" is demo state with no seeded id. Leaving it behind makes the organizations cleanup below
-- fail on a foreign key, so the second `npm run reset` refuses and the demo can never be restored
-- again.
--
-- Scoping by owning organization is also the honest line. A real conference does not live in the
-- demo's organization: a self-serve signup provisions an organization of its own and puts its
-- first event there, which is what makes this rule safe and what
-- `demo-reset-guard.integration.test.ts` asserts by running a restore against a live signup. Every
-- event-scoped cleanup above resolves its ids through this same subquery, so nothing can be
-- deleted here that a child cleanup did not already clear.
DELETE FROM events
WHERE organization_id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
