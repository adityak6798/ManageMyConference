// @acceptance ACC-INTEGRATION
// @spec PRD-COM-001
/**
 * Issue #217: a second organization can send.
 *
 * Every lifecycle message resolves a `message_templates` row scoped to the **organization**, and
 * no migration had ever written one. The only rows anywhere were the demo seed's, all for
 * organization `…010`. Every other organization — every self-serve Google signup — got
 * `Template version not found`, which `notifyLifecycle` swallows by design, so the lifecycle
 * action succeeded and **no delivery row was ever created**.
 *
 * These run against real D1 rather than the memory repository because two of the three
 * provisioning routes are storage: the backfill is a migration, and the uniqueness that makes a
 * concurrent provision converge is an index.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1CommunicationsRepository } from "../src/adapters/persistence/d1-communications-repository";
import { CommunicationsService } from "../src/application/communications/communications-service";
import { DEFAULT_TEMPLATES } from "../src/domain/communications/default-templates";
import { applyMigrations, createMigratedDatabase } from "./support/seeded-d1";

const SEEDED_ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SECOND_ORGANIZATION = "20000000-0000-4000-8000-0000000000aa";
const SECOND_EVENT = "20000000-0000-4000-8000-0000000000bb";

/** A self-serve organization and its first event, exactly as signup writes them. */
const createSecondOrganization = async (database: D1Database) => {
  await database
    .prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
    .bind(SECOND_ORGANIZATION, "Second conference", "2026-08-14T09:00:00.000Z")
    .run();
  await database
    .prepare(
      "INSERT INTO events (id, organization_id, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(SECOND_EVENT, SECOND_ORGANIZATION, "Your first event", "UTC", "2026-08-14T09:00:00.000Z")
    .run();
};

const serviceFor = (database: D1Database) => {
  let id = 0;
  return new CommunicationsService({
    repository: new D1CommunicationsRepository(database),
    eventDirectory: { belongsToOrganization: async () => true },
    newId: () => `provisioned-${++id}`,
    now: () => new Date("2026-08-14T10:00:00.000Z"),
  });
};

describe("lifecycle templates for every organization", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("creates a delivery for an organization nobody seeded", async () => {
    /*
     * The acceptance the issue asks for, and the test that fails against `origin/main`: a second
     * organization, one lifecycle action, and a delivery row that exists.
     */
    const migrated = await createMigratedDatabase({ label: "templates-second-org", seed: true });
    runtime = migrated.runtime;
    await createSecondOrganization(migrated.database);
    const service = serviceFor(migrated.database);

    const enqueued = await service.enqueue({
      organizationId: SECOND_ORGANIZATION,
      eventId: SECOND_EVENT,
      idempotencyKey: `speaker-invite:${SECOND_EVENT}:profile-1`,
      triggerType: "speaker.invited",
      channel: "email",
      recipientRef: "newcomer@example.test",
      payload: { speakerName: "Newcomer", sessionTitle: "A first talk" },
      templateKey: "speaker-invite",
    });

    expect(enqueued.created).toBe(true);
    const stored = await new D1CommunicationsRepository(migrated.database).get(enqueued.id);
    // The row exists *and* carries the message. A delivery with no rendered body would satisfy
    // "a row exists" while still sending nothing.
    expect(stored?.renderedSubject).toBe("Welcome to Greenroom");
    expect(stored?.renderedBody).toContain("Hello Newcomer");
    // Pinned to a real template row of its own, not to the demo organization's copy.
    expect(stored?.templateId).not.toBeNull();
    const template = await new D1CommunicationsRepository(migrated.database).findTemplate(
      SECOND_ORGANIZATION,
      "speaker-invite",
    );
    expect(template?.id).toBe(stored?.templateId);
    expect(template?.version).toBe(1);
  });

  it("backfills an organization that existed before the migration ran", async () => {
    /*
     * The deployed database already holds a self-serve organization from the first real Google
     * sign-in (issue #216), created long before this catalogue existed. It must not have to send
     * a message before it has templates, so migration `1706` writes them.
     *
     * Built by migrating up to the migration *before* `1706`, inserting the organization there,
     * and then applying the rest — which is the real sequence rather than a simulation of it.
     */
    const migrated = await createMigratedDatabase({
      label: "templates-backfill",
      through: "1705_delivery_proposal_submitted_trigger.sql",
    });
    runtime = migrated.runtime;
    await createSecondOrganization(migrated.database);
    const before = await migrated.database
      .prepare("SELECT COUNT(*) AS tally FROM message_templates WHERE organization_id = ?")
      .bind(SECOND_ORGANIZATION)
      .first<{ tally: number }>();
    expect(before?.tally).toBe(0);

    await applyMigrations(migrated.database as never, {
      from: "1706_default_lifecycle_templates.sql",
    });

    const after = await migrated.database
      .prepare(
        "SELECT template_key, version, subject, body FROM message_templates WHERE organization_id = ? ORDER BY template_key",
      )
      .bind(SECOND_ORGANIZATION)
      .all<{ template_key: string; version: number; subject: string; body: string }>();
    expect(after.results.map(({ template_key }) => template_key).sort()).toEqual(
      DEFAULT_TEMPLATES.map(({ key }) => key).sort(),
    );
    // The migration's words and the catalogue's are two copies of the same nine messages, so they
    // are asserted equal rather than trusted to stay so.
    for (const row of after.results) {
      const catalogued = DEFAULT_TEMPLATES.find(({ key }) => key === row.template_key);
      expect(row.version).toBe(1);
      expect(row.subject).toBe(catalogued?.subject);
      expect(row.body).toBe(catalogued?.body);
    }
  });

  it("leaves the demo organization's own templates exactly as the seed wrote them", async () => {
    // The backfill guard is on `(organization, key)`, not on `(organization, key, version)`: an
    // organization that already has a message keeps it, whoever wrote it and whatever it says.
    const migrated = await createMigratedDatabase({ label: "templates-seeded", seed: true });
    runtime = migrated.runtime;

    const seeded = await migrated.database
      .prepare(
        "SELECT id, version FROM message_templates WHERE organization_id = ? AND template_key = 'speaker-invite'",
      )
      .bind(SEEDED_ORGANIZATION)
      .all<{ id: string; version: number }>();

    expect(seeded.results).toEqual([{ id: "template-speaker-v1", version: 1 }]);
  });

  it("never overwrites a version the organization published for itself", async () => {
    /*
     * "Editable afterwards" is the half of this that a provisioning fix can quietly break. An
     * organization that rewrites a default publishes version 2, and every later resolution —
     * including one that runs provisioning again — must return their words, not ours.
     */
    const migrated = await createMigratedDatabase({ label: "templates-customized", seed: true });
    runtime = migrated.runtime;
    await createSecondOrganization(migrated.database);
    const service = serviceFor(migrated.database);
    await service.provisionDefaultTemplates(SECOND_ORGANIZATION);
    const repository = new D1CommunicationsRepository(migrated.database);
    await repository.createTemplate({
      id: "their-own-welcome",
      organizationId: SECOND_ORGANIZATION,
      key: "speaker-invite",
      version: 2,
      channel: "email",
      subject: "Ours, not yours",
      body: "Hello {{speakerName}}, this is our own wording.",
      createdAt: "2026-08-14T11:00:00.000Z",
    });

    await service.provisionDefaultTemplates(SECOND_ORGANIZATION);
    const enqueued = await service.enqueue({
      organizationId: SECOND_ORGANIZATION,
      eventId: SECOND_EVENT,
      idempotencyKey: `speaker-invite:${SECOND_EVENT}:profile-2`,
      triggerType: "speaker.invited",
      channel: "email",
      recipientRef: "newcomer@example.test",
      payload: { speakerName: "Newcomer" },
      templateKey: "speaker-invite",
    });

    const stored = await repository.get(enqueued.id);
    expect(stored?.renderedSubject).toBe("Ours, not yours");
    expect(stored?.templateVersion).toBe(2);
  });

  it("is idempotent, so provisioning twice writes one set", async () => {
    const migrated = await createMigratedDatabase({ label: "templates-idempotent", seed: true });
    runtime = migrated.runtime;
    await createSecondOrganization(migrated.database);
    const service = serviceFor(migrated.database);

    await service.provisionDefaultTemplates(SECOND_ORGANIZATION);
    await service.provisionDefaultTemplates(SECOND_ORGANIZATION);

    const tally = await migrated.database
      .prepare("SELECT COUNT(*) AS tally FROM message_templates WHERE organization_id = ?")
      .bind(SECOND_ORGANIZATION)
      .first<{ tally: number }>();
    expect(tally?.tally).toBe(DEFAULT_TEMPLATES.length);
  });
});
