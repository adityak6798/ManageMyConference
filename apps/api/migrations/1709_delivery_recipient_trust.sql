-- @spec PRD-COM-001 PRD-CFP-002
--
-- Record how much a delivery's recipient address was worth trusting (issue #132).
--
-- ## Why a column, when the cap already counted rows
--
-- The unverified-recipient cap counts what an event has already written to one address. Without
-- this column it could only count *every* delivery to that address, whatever its provenance — and
-- an accepted guest proposal generates the product's own follow-up mail to the same address: the
-- decision, then the speaker welcome the acceptance provisions, then the first onboarding task.
-- Three, which is the cap. The organizer then reverses the decision and the decline is refused:
-- the applicant is never told, and nothing abusive happened at any step.
--
-- So the count has to be scoped to the deliveries the cap is *about*. `recipient_trust` is that
-- scope, written by `CommunicationsService.prepare` from what the caller declared, and read by
-- `countDeliveriesTo`.
--
-- ## Why `ADD COLUMN` rather than a rebuild
--
-- Nothing is being narrowed: the column is new, `NOT NULL` with a default that is legal for every
-- existing row, and carries a `CHECK` — which SQLite permits on an added column. Migration `1708`,
-- immediately before this one, rebuilt this table already, and there is no reason to do it again
-- for an additive column.
--
-- The default is `account`, which is the safe direction for rows that predate this: they are not
-- counted against the cap. A pre-existing delivery to an address a guest later types is somebody
-- else's mail, and spending a stranger's budget on it would refuse a message nobody abused.

ALTER TABLE communication_deliveries
  ADD COLUMN recipient_trust TEXT NOT NULL DEFAULT 'account'
  CHECK (recipient_trust IN ('account', 'declared'));

-- The cap's read is `(organization_id, event_id, recipient_trust, <normalized address>)`, and the
-- normalization happens in the statement rather than in a stored column — see
-- `d1-communications-repository.ts`. This index covers everything the statement can use before
-- that expression, which is the whole of the row set it then scans.
CREATE INDEX communication_deliveries_recipient_cap_idx
  ON communication_deliveries(organization_id, event_id, recipient_trust);
