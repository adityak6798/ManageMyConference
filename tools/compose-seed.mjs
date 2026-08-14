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

/**
 * Every `DELETE` in the composed seed has to carry a `WHERE`.
 *
 * The demo and a real conference share one deployment, so a bare `DELETE FROM <table>` in this
 * file is a loaded gun: it reads as "restore the demo" and means "empty the table". A fragment
 * that gains one fails `npm run schema:check` rather than being discovered by a restore that
 * destroyed somebody's work.
 *
 * **What this does not do, stated so nobody mistakes it for more.** It checks that a predicate is
 * *present*, not that the predicate *scopes* anything: a delete whose `WHERE` is `1=1` passes. No
 * regex can decide the second question, and a check whose name promises it would be worse than
 * one that does not. The real guarantee is behavioural and lives in
 * `apps/api/test/demo-reset-guard.integration.test.ts`, which applies the actual `reset.sql` to a
 * database holding a live self-serve signup and asserts the person, their provider link and their
 * event all survive — twice. This is the cheap check that catches the accident; that is the one
 * that catches the mistake.
 *
 * Parsing is deliberately conservative: comments are stripped and statements are split on `;`
 * before anything is matched, so a `WHERE` inside a trailing comment, a `WHERE` belonging to the
 * *next* statement on the same line, and a `DELETE` split across lines all read correctly. Quoted
 * identifiers (`"users"`, `` `users` ``, `[users]`) are recognized, because SQLite accepts them
 * and a check that does not is a check with a door in it.
 *
 * A table that genuinely is demo-only, where emptying it is right, says so with
 * `-- SEED-SCOPE-EXEMPT: <reason>` in the comment block immediately before the statement. There
 * are none today; the marker exists so the answer is written down rather than argued at review
 * time.
 */
export function unscopedDeletes(sql) {
  const found = [];
  // Split into statements first, keeping the comment text that precedes each one so an exemption
  // can be attached to the statement it was written for and to no other.
  let rest = sql;
  let pendingExemption = false;
  while (rest.length > 0) {
    const end = rest.indexOf(";");
    const statement = end === -1 ? rest : rest.slice(0, end + 1);
    rest = end === -1 ? "" : rest.slice(end + 1);
    const exempted = /--\s*SEED-SCOPE-EXEMPT:/i.test(statement) || pendingExemption;
    // Strip line comments before looking at the SQL, so nothing in prose can satisfy the check.
    const code = statement
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (code === "") {
      // A comment-only chunk carries its marker forward to the next real statement.
      pendingExemption = exempted;
      continue;
    }
    pendingExemption = false;
    const match =
      /^DELETE\s+FROM\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i.exec(code);
    if (!match) continue;
    if (exempted) continue;
    if (/\bWHERE\b/i.test(code)) continue;
    found.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return found;
}

async function main() {
  const composed = await composeSeed();
  const unscoped = unscopedDeletes(composed);
  if (unscoped.length) {
    process.stderr.write(
      `Seed cleanup is unscoped for ${unscoped.join(", ")}. The demo shares a deployment with ` +
        "real conferences, so every DELETE must name the ids the seed inserts — or carry " +
        "`-- SEED-SCOPE-EXEMPT: <reason>` on the line before it.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--check")) {
    const current = await readFile(output, "utf8");
    if (current !== composed) {
      process.stderr.write("Seed aggregate drift; run `npm run seed:generate`.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Seed aggregate matches ${seedFragments.length} domain fragments, and every cleanup is scoped.\n`,
    );
    return;
  }
  await writeFile(output, composed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
