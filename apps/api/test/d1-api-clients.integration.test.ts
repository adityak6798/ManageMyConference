// @acceptance ACC-HARNESS
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApiClientDatabasePort,
  D1ApiClientRepository,
} from "../src/adapters/persistence/d1-api-clients";
import { hashApiClientSecret } from "../src/application/identity/api-clients";
import type { AuditContext } from "../src/application/identity/audit";
import { applyMigrationFile, createMigratedDatabase } from "./support/seeded-d1";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const EVENT = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000100";
const NOW = 1_760_000_000_000;
const context: AuditContext = {
  correlationId: "correlation-test",
  actorUserId: "seed-organizer",
  source: "human",
};

describe("API clients against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "api-clients" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as ApiClientDatabasePort;
    return { database, repository: new D1ApiClientRepository(database) };
  }

  it("preserves populated identity audit history while widening its action vocabulary", async () => {
    const migrated = await createMigratedDatabase({
      label: "api-client-audit-rebuild",
      through: "1003_identity_invitations.sql",
    });
    runtime = migrated.runtime;
    await migrated.database
      .prepare(
        "INSERT INTO identity_audit_events (id, occurred_at, action, outcome, source, actor_user_id, subject_user_id, organization_id, event_id, correlation_id, detail) VALUES ('before-api-clients', 1, 'session.issued', 'succeeded', 'human', 'person', 'person', NULL, NULL, 'correlation-before', NULL)",
      )
      .run();

    await applyMigrationFile(migrated.database, "1004_api_clients.sql");

    const preserved = await migrated.database
      .prepare("SELECT action, correlation_id FROM identity_audit_events WHERE id = ?")
      .bind("before-api-clients")
      .all<{ action: string; correlation_id: string }>();
    expect(preserved.results).toEqual([
      { action: "session.issued", correlation_id: "correlation-before" },
    ]);
    const widened = await migrated.database
      .prepare(
        "INSERT INTO identity_audit_events (id, occurred_at, action, outcome, source, actor_user_id, subject_user_id, organization_id, event_id, correlation_id, detail) VALUES ('new-api-client-action', 2, 'api_client.created', 'succeeded', 'human', 'person', NULL, NULL, NULL, 'correlation-after', NULL)",
      )
      .run();
    expect(widened.success).toBe(true);
  });

  it("persists scopes/events without exposing hashes from organization listings", async () => {
    const { repository } = await stack();
    await repository.create(
      {
        id: CLIENT,
        organizationId: ORGANIZATION,
        name: "Automation",
        keyPrefix: "0123456789abcdef", // gitleaks:allow — public deterministic prefix fixture.
        secretHash: await hashApiClientSecret("secret"),
        previousSecretHash: null,
        previousSecretExpiresAt: null,
        createdBy: "seed-organizer",
        createdAt: NOW,
        expiresAt: null,
        revokedAt: null,
        scopes: ["events:read"],
        eventIds: [EVENT],
      },
      context,
    );

    const listed = await repository.list(ORGANIZATION);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.scopes).toEqual(["events:read"]);
    expect(listed[0]?.eventIds).toEqual([EVENT]);
  });

  it("reports exactly one changed row for a concurrent double revoke", async () => {
    const { database, repository } = await stack();
    await repository.create(
      {
        id: CLIENT,
        organizationId: ORGANIZATION,
        name: "Automation",
        keyPrefix: "0123456789abcdef", // gitleaks:allow — public deterministic prefix fixture.
        secretHash: await hashApiClientSecret("secret"),
        previousSecretHash: null,
        previousSecretExpiresAt: null,
        createdBy: "seed-organizer",
        createdAt: NOW,
        expiresAt: null,
        revokedAt: null,
        scopes: ["events:read"],
        eventIds: [EVENT],
      },
      context,
    );

    const changes = await Promise.all([
      repository.revoke({ organizationId: ORGANIZATION, clientId: CLIENT, now: NOW + 1, context }),
      repository.revoke({ organizationId: ORGANIZATION, clientId: CLIENT, now: NOW + 1, context }),
    ]);
    expect(changes.sort()).toEqual([0, 1]);
    const audits = await database
      .prepare("SELECT action FROM identity_audit_events WHERE action = 'api_client.revoked'")
      .all();
    expect(audits.results).toHaveLength(1);
  });
});
