// @spec ENG-CI-001 TST-005
/**
 * Refuse a quality claim that no run supports.
 *
 * `docs/quality/scorecard.md` states a verdict per acceptance row.
 * `docs/quality/acceptance-evidence.json` says, per row, which suites that verdict rests on and
 * which test files carry its `@acceptance` marker. This compares both against the run records
 * `tools/record-run.mjs` writes.
 *
 * Four ways a row fails: a suite it names has no record, has a record from a different commit,
 * has a record of a failing run, or names a spec file that no longer exists. The last is the
 * `ACC-AGENDA` case from #87 — a change deleted the row's only browser coverage and the row
 * stayed true, because nothing connected the two.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EVIDENCE_DIR, recordPath } from "./record-run.mjs";
import { headCommit, worktreeRoot } from "./worktree-env.mjs";

const ROOT = worktreeRoot();
export const EVIDENCE_DECLARATION = "docs/quality/acceptance-evidence.json";
export const SCORECARD = "docs/quality/scorecard.md";
const ROW_PATTERN = /^\| `(ACC-[A-Z0-9-]+)` \| [^|]*\| ([^|]*)\|/gm;

/** Acceptance ID -> stated verdict, read from the scorecard's one table of rows. */
export function scorecardVerdicts(markdown) {
  const verdicts = new Map();
  for (const [, identifier, verdict] of markdown.matchAll(ROW_PATTERN))
    verdicts.set(identifier, verdict.trim());
  return verdicts;
}

export function readRecord(suite, directory = EVIDENCE_DIR) {
  const file =
    directory === EVIDENCE_DIR ? recordPath(suite) : path.join(directory, `${suite}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // ERROR-INTENT: a truncated record proves nothing, and is treated exactly as a missing one
    // — the row it supports fails either way, with the same remedy: run the suite again.
    return null;
  }
}

/**
 * @param declaration parsed acceptance-evidence.json
 * @param verdicts    acceptance ID -> verdict from the scorecard
 * @param context     { commit, readRecord, exists } — injected so fixtures need no filesystem
 */
export function analyse(declaration, verdicts, context) {
  const problems = [];
  const { commit, readRecord: read, exists } = context;
  for (const [identifier, verdict] of verdicts) {
    const row = declaration.rows[identifier];
    if (!row) {
      problems.push(
        `${SCORECARD} states '${verdict}' for ${identifier}, but ${EVIDENCE_DECLARATION} does ` +
          "not say what that rests on. Every row names its suites and its spec files.",
      );
      continue;
    }
    // An empty declaration is the same uncheckable state as a missing one: both loops below
    // would simply do nothing and the row would pass on the strength of saying nothing.
    if ((row.suites ?? []).length === 0 || (row.specs ?? []).length === 0) {
      problems.push(
        `${identifier} declares an empty \`suites\` or \`specs\` list in ${EVIDENCE_DECLARATION}. ` +
          "A row rests on at least one suite and at least one spec file, or its verdict is not " +
          "checkable at all.",
      );
      continue;
    }
    for (const specification of row.specs ?? []) {
      if (!exists(specification))
        problems.push(
          `${identifier} rests on ${specification}, which does not exist. Deleting a row's ` +
            "coverage has to fail here rather than leave the row quietly true — restore the " +
            `file, or change the row and its entry in ${EVIDENCE_DECLARATION}.`,
        );
    }
    for (const suite of row.suites ?? []) {
      const record = read(suite);
      if (!record) {
        problems.push(
          `${identifier} claims '${verdict}' on the '${suite}' suite, which has no run record. ` +
            `Produce one with \`npm run evidence:${suite}\`.`,
        );
        continue;
      }
      if (record.exitCode !== 0)
        problems.push(
          `${identifier} claims '${verdict}' on the '${suite}' suite, whose last recorded run ` +
            `exited ${record.exitCode}. A failing run is not evidence of a passing row.`,
        );
      if (record.commit !== commit)
        problems.push(
          `${identifier} claims '${verdict}' on the '${suite}' suite, but its record was ` +
            `produced at ${String(record.commit).slice(0, 12)} and this is ` +
            `${String(commit).slice(0, 12)}. A suite that passed on other code is not evidence ` +
            `about this one — re-run \`npm run evidence:${suite}\`.`,
        );
    }
  }
  for (const identifier of Object.keys(declaration.rows))
    if (!verdicts.has(identifier))
      problems.push(
        `${EVIDENCE_DECLARATION} declares evidence for ${identifier}, which has no row in ` +
          `${SCORECARD}.`,
      );
  return problems;
}

export function readInputs() {
  return {
    declaration: JSON.parse(readFileSync(path.join(ROOT, EVIDENCE_DECLARATION), "utf8")),
    verdicts: scorecardVerdicts(readFileSync(path.join(ROOT, SCORECARD), "utf8")),
    context: {
      commit: headCommit(ROOT),
      readRecord: (suite) => readRecord(suite),
      exists: (relative) => existsSync(path.join(ROOT, relative)),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { declaration, verdicts, context } = readInputs();
  const problems = analyse(declaration, verdicts, context);
  if (problems.length > 0) {
    process.stderr.write(
      `Quality claims without evidence:\n  ${problems.join("\n  ")}\n` +
        `See ${EVIDENCE_DECLARATION} and docs/quality/scorecard.md.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Evidence checks passed (${verdicts.size} rows, all suites recorded at ` +
        `${context.commit.slice(0, 12)}).\n`,
    );
  }
}
