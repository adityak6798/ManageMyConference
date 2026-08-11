// @spec ENG-CI-001 TST-005
/**
 * Run a test suite and write down what happened.
 *
 * A quality document that says a suite passed is a claim about an event. Until this existed
 * nothing recorded the event, so the claim could only be believed. The cost is on record: the
 * `ACC-CFP` row read "passed locally 2026-08-10 … complete" while every public proposal
 * submission returned 500 from a clean reset, and the row is *why* the defect survived — the
 * documentation said the journey worked.
 *
 * Each record names the suite, the exact command, the exit status, the counts the runner
 * printed, the commit it ran against, and when. `greenroom-context check` reads them and
 * refuses a scorecard row whose evidence is missing, failed, or was produced against a
 * different commit.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headCommit, worktreeRoot } from "./worktree-env.mjs";

const ROOT = worktreeRoot();
/** Generated, gitignored, and never committed: a record is evidence of a run, not source. */
export const EVIDENCE_DIR = path.join(ROOT, ".evidence");

/**
 * Pull the pass/fail tallies out of a runner's output.
 *
 * Vitest prints "Tests  149 passed (149)", Playwright "30 passed (31.7s)", and node --test
 * "# pass 38". Counts are reported when they are found and omitted when they are not; a record
 * is not weakened by a runner whose format is not recognised, because the exit status is the
 * part the gate actually enforces.
 */
export function parseCounts(output) {
  let passed = 0;
  let failed = 0;
  let found = false;
  const add = (passedCount, failedCount) => {
    passed += passedCount;
    failed += failedCount;
    found = true;
  };
  // Summed, not taken from the first match: `npm test` runs the tool suite and both
  // workspaces, and reporting only whichever printed first understates it by hundreds.
  for (const match of output.matchAll(/Tests\s+(?:(\d+) failed \| )?(\d+) passed\s+\(\d+\)/g))
    add(Number(match[2]), Number(match[1] ?? 0));
  // `node --test` prints "ℹ pass 38" with its default reporter and "# pass 38" under TAP.
  for (const match of output.matchAll(/^[#ℹ] pass (\d+)$/gm)) add(Number(match[1]), 0);
  for (const match of output.matchAll(/^[#ℹ] fail (\d+)$/gm)) add(0, Number(match[1]));
  if (!found)
    for (const match of output.matchAll(/^\s*(?:(\d+) failed\s+)?(\d+) passed \(/gm))
      add(Number(match[2]), Number(match[1] ?? 0));
  return found ? { passed, failed, total: passed + failed } : {};
}

export function recordPath(suite) {
  return path.join(EVIDENCE_DIR, `${suite}.json`);
}

export function writeRecord(record) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(recordPath(record.suite), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath(record.suite);
}

function main(argv) {
  const suite = argv[0];
  const command = argv.slice(1);
  if (!suite || command.length === 0)
    throw new Error("usage: node tools/record-run.mjs <suite> <command> [args…]");

  const startedAt = new Date().toISOString();
  const started = Date.now();
  // Sampled *before* the suite runs. A D1 or Playwright run takes minutes, and another process
  // committing during it would otherwise attribute results from the old checkout state to the
  // new HEAD — evidence for code that was never tested.
  const commit = headCommit(ROOT);
  // Piped so the output can be parsed, and echoed so a developer still watches it live.
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  const record = {
    suite,
    command: command.join(" "),
    // `status` is null when the child was killed by a signal, and an interrupted suite must
    // never be recorded as a pass. Any of a signal, a spawn error, or a null status without
    // either is a failure.
    exitCode: result.signal ? 1 : (result.status ?? 1),
    ...(result.signal ? { signal: result.signal } : {}),
    startedAt,
    durationMs: Date.now() - started,
    commit,
    counts: parseCounts(output),
  };
  const written = writeRecord(record);
  process.stderr.write(
    `\nrecorded ${suite}: exit ${record.exitCode} at ${record.commit.slice(0, 12)} -> ` +
      `${path.relative(ROOT, written)}\n`,
  );
  // The suite's own outcome is this process's outcome. Recording never masks a failure.
  process.exitCode = record.exitCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // ERROR-INTENT: CLI ownership boundary. The message is the product; a stack trace above a
    // usage error helps nobody. Reported in full and turned into a non-zero exit.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
