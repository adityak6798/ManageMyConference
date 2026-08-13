-- Before `events` and `organizations`, which this references, and for the reason the users
-- fragment gives: D1 does not honour `PRAGMA foreign_keys` between statements, so a cascade
-- cannot be relied on and a row left behind is a live acceptance link pointing at an
-- organization the next reset has already replaced.
DELETE FROM identity_invitations;
DELETE FROM api_client_events;
DELETE FROM api_client_scopes;
DELETE FROM api_clients;
DELETE FROM event_roles;
DELETE FROM organization_memberships;
