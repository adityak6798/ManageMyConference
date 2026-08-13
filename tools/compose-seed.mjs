// @spec ARC-DOM-001 ENG-CI-001
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("apps/api/seed/reset.sql", root);

export const seedFragments = [
  "publishing/cleanup.sql",
  "communications-integrations/cleanup.sql",
  "agenda/cleanup.sql",
  "crm/cleanup.sql",
  "content/cleanup.sql",
  "review/cleanup.sql",
  "cfp/cleanup.sql",
  "identity-access/roles-cleanup.sql",
  "events/templates-cleanup.sql",
  "events/events-cleanup.sql",
  "identity-access/users-cleanup.sql",
  "events/organizations-cleanup.sql",
  "events/organizations.sql",
  "identity-access/users.sql",
  "events/events.sql",
  "events/templates.sql",
  "identity-access/roles.sql",
  "communications-integrations/data.sql",
  "agenda/data.sql",
  "content/data.sql",
  "cfp/submissions.sql",
  "review/data.sql",
  "cfp/forms.sql",
  "crm/data.sql",
  "publishing/data.sql",
];

/**
 * What the composed file says about itself, before any SQL.
 *
 * Every other generated artifact in this repository names its generator in its first line, and
 * "do not edit generated files" is only enforceable against a reader who can tell that this is
 * one. `--` is SQLite's line comment, so this survives `wrangler d1 execute --file` and the
 * statement splitter in `apps/api/test/support/seeded-d1.ts` alike.
 */
export const SEED_HEADER = [
  "-- GENERATED: do not edit; run `npm run seed:generate`.",
  "-- Composed by tools/compose-seed.mjs from the fragments under apps/api/seed/domains/.",
  "-- Edit the owning domain's fragment instead; the order of the list in the composer is the",
  "-- order the statements run in, and it is a foreign-key ordering rather than an alphabetical one.",
  "",
  "",
].join("\n");

/**
 * One fragment, ending in exactly one newline and starting with its own first line.
 *
 * A fragment saved without a trailing newline used to run into the next fragment's first line:
 * the CFP forms cleanup came out with the identity fragment's opening `--` comment welded onto
 * the end of its own statement. SQLite and the splitter in `apps/api/test/support/seeded-d1.ts`
 * both cope — the statement is terminated and the comment runs to the newline — but the file is
 * read by people when a reset misbehaves, and a comment that has swallowed the statement above it
 * is exactly the wrong thing to be reading at that moment.
 *
 * Leading blank lines go too, and the boundary is then supplied here by joining with one. Several
 * fragments open with a newline to compensate for a neighbour that lacks one, which is a
 * separator maintained by hand in the wrong file and in the wrong direction: it stops working the
 * moment the list is reordered. Composing the separation makes every boundary look the same
 * whatever a fragment happens to end with, and it costs the domains nothing to keep true.
 */
const normalize = (fragment) => `${fragment.replace(/^\s+/, "").replace(/\s+$/, "")}\n`;

export async function composeSeed() {
  const fragments = await Promise.all(
    seedFragments.map((fragment) =>
      readFile(new URL(`apps/api/seed/domains/${fragment}`, root), "utf8"),
    ),
  );
  return SEED_HEADER + fragments.map(normalize).join("\n");
}

async function main() {
  const composed = await composeSeed();
  if (process.argv.includes("--check")) {
    const current = await readFile(output, "utf8");
    if (current !== composed) {
      process.stderr.write("Seed aggregate drift; run `npm run seed:generate`.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Seed aggregate matches ${seedFragments.length} domain fragments.\n`);
    return;
  }
  await writeFile(output, composed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
