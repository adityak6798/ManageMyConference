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

export async function composeSeed() {
  return (
    await Promise.all(
      seedFragments.map((fragment) =>
        readFile(new URL(`apps/api/seed/domains/${fragment}`, root), "utf8"),
      ),
    )
  ).join("");
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
