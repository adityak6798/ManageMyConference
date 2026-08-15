-- The two organizations the seed inserts, by id. Last, because everything above references them.
--
-- If a real conference has been created inside one of these — an event of its own, an API client,
-- a webhook subscription — this statement fails on the foreign key rather than removing it, and
-- that failure is the correct outcome: it says the demo organization is no longer only the
-- demo's. `tools/remote-demo-reset.mjs` refuses before reaching here in that case (`#208`), and
-- this is the second line of the same defence.
DELETE FROM organizations
WHERE id IN (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020'
);
