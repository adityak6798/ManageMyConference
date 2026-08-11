// @acceptance ACC-CFP ACC-PUBLIC
import { readdir, readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type D1CfpDatabasePort,
  D1CfpRepository,
} from "../src/adapters/persistence/d1-cfp-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import { D1PublicationRepository } from "../src/adapters/persistence/d1-publication-repository";

/**
 * The deterministic seed is the demo. A defect in it cannot be caught by any suite
 * that builds its own fixtures, and one shipped for real: the published CFP snapshot
 * was written without its `fields`, so the public form rendered no inputs and every
 * public submission failed with a 500 from a clean reset.
 *
 * This suite applies every migration in order and then the seed exactly as
 * `npm run reset` does, and asserts the resulting state is actually demonstrable.
 */

/**
 * Split SQL on statement boundaries. A plain `split(";")` corrupts the trigger
 * migrations, whose bodies contain their own semicolons between BEGIN and END.
 */
function statements(sql: string): string[] {
  const found: string[] = [];
  let current = "";
  let inString = false;
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] as string;

    if (inString) {
      current += character;
      // '' is an escaped quote inside a SQL string, not the end of one.
      if (character === "'") {
        if (sql[index + 1] === "'") {
          current += "'";
          index += 1;
        } else inString = false;
      }
      continue;
    }

    if (character === "'") {
      inString = true;
      current += character;
      continue;
    }

    const upcoming = sql.slice(index);
    const beginMatch = /^BEGIN\b/i.exec(upcoming);
    if (beginMatch) {
      blockDepth += 1;
      current += beginMatch[0];
      index += beginMatch[0].length - 1;
      continue;
    }
    const endMatch = /^END\b/i.exec(upcoming);
    if (endMatch && blockDepth > 0) {
      blockDepth -= 1;
      current += endMatch[0];
      index += endMatch[0].length - 1;
      continue;
    }

    if (character === ";" && blockDepth === 0) {
      if (current.trim()) found.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) found.push(current.trim());
  return found;
}

const demoEventId = "00000000-0000-4000-8000-000000000001";
const demoSlug = "greenroom-demo-summit";

async function seededDatabase(runtime: Miniflare) {
  const database = await runtime.getD1Database("DB");
  const migrationsDirectory = new URL("../migrations/", import.meta.url);
  // Read the directory rather than a hand-maintained list so a new migration is
  // covered the moment it lands.
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(migrations.length).toBeGreaterThan(0);
  for (const migration of migrations) {
    const sql = await readFile(new URL(migration, migrationsDirectory), "utf8");
    for (const statement of statements(sql)) await database.prepare(statement).run();
  }
  const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
  for (const statement of statements(reset)) await database.prepare(statement).run();
  return database;
}

describe("deterministic seed", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("publishes a CFP an applicant can actually complete", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "seed-state-cfp" },
    });
    const database = await seededDatabase(runtime);
    const repository = new D1CfpRepository(database as D1CfpDatabasePort);

    const published = await repository.findPublished(demoEventId);
    if (!published) throw new Error("the seed must publish a CFP for the demo event");
    expect(published.status).toBe("open");

    // The regression: a snapshot with no fields renders an empty public form.
    expect(Array.isArray(published.fields)).toBe(true);
    expect(published.fields.length).toBeGreaterThan(0);
    for (const field of published.fields) {
      expect(field.id, "every published field needs an id to key an answer").toBeTruthy();
      expect(field.label, `field ${field.id} needs a human label`).toBeTruthy();
      expect(field.type, `field ${field.id} needs a type`).toBeTruthy();
    }

    // The public form must show what the organizer configured, not a stale subset.
    const draft = await repository.findForm(demoEventId);
    expect(published.fields.map((field) => field.id)).toEqual(
      draft?.fields.map((field: { id: string }) => field.id),
    );
  });

  it("seeds a published public projection with browsable content", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "seed-state-projection" },
    });
    const database = await seededDatabase(runtime);
    // Read through the owning domain's repository rather than its table, so this suite
    // exercises the same path the public site uses.
    const publications = new D1PublicationRepository(database as never);

    const publication = await publications.findPublicBySlug(demoSlug);
    if (!publication) throw new Error(`the seed must publish the ${demoSlug} projection`);
    expect(publication.state).toBe("published");

    const snapshot = publication.published;
    expect(snapshot?.event?.name, "the published event needs a name to render").toBeTruthy();
    expect(
      snapshot?.sessions.length,
      "an empty schedule is not a demonstrable event",
    ).toBeGreaterThan(0);
    expect(
      snapshot?.speakers.length,
      "a speaker gallery with nobody in it is not a demo",
    ).toBeGreaterThan(0);
  });

  it("seeds every role in the evaluator path with an event to work in", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "seed-state-roles" },
    });
    const database = await seededDatabase(runtime);
    // Resolve identities the way the app does, through the identity directory.
    const directory = new D1IdentityDirectory(database as never);

    for (const persona of ["organizer", "reviewer", "speaker"] as const) {
      const actor = await directory.findByPersona(persona);
      expect(actor, `the runbook demos ${persona}; the seed must provide one`).not.toBeNull();
      expect(
        actor?.eventAccess.some((access) => access.eventId === demoEventId),
        `the seeded ${persona} must have access to the demo event`,
      ).toBe(true);
    }
  });
});
