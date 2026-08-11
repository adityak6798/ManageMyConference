// @acceptance ACC-HARNESS
// @spec ENG-CI-001 TST-005
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyse, readInputs, scorecardVerdicts } from "../check-evidence.mjs";
import { parseCounts } from "../record-run.mjs";

const COMMIT = "a".repeat(40);

const declaration = {
  rows: {
    "ACC-EXAMPLE": { suites: ["d1", "e2e"], specs: ["apps/web/e2e/example.spec.ts"] },
  },
};
const verdicts = new Map([["ACC-EXAMPLE", "shipped"]]);

const context = (overrides = {}) => ({
  commit: COMMIT,
  exists: () => true,
  readRecord: (suite) => ({ suite, exitCode: 0, commit: COMMIT }),
  ...overrides,
});

test("a row whose suites all passed at this commit is accepted", () => {
  assert.deepEqual(analyse(declaration, verdicts, context()), []);
});

test("a row citing a suite with no artifact fails", () => {
  const problems = analyse(
    declaration,
    verdicts,
    context({ readRecord: (suite) => (suite === "e2e" ? null : { exitCode: 0, commit: COMMIT }) }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'e2e' suite, which has no run record/);
  assert.match(problems[0], /npm run evidence:e2e/);
});

test("a row citing an artifact from a different commit fails", () => {
  const problems = analyse(
    declaration,
    verdicts,
    context({ readRecord: (suite) => ({ suite, exitCode: 0, commit: "b".repeat(40) }) }),
  );
  // Both suites are stale, and each says so with the two commits named.
  assert.equal(problems.length, 2);
  assert.match(problems[0], /produced at bbbbbbbbbbbb and this is aaaaaaaaaaaa/);
});

test("a row whose artifact records a failure fails", () => {
  const problems = analyse(
    declaration,
    verdicts,
    context({ readRecord: (suite) => ({ suite, exitCode: 1, commit: COMMIT }) }),
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /exited 1\. A failing run is not evidence of a passing row/);
});

test("deleting a spec a row depends on fails rather than leaving the row true", () => {
  // The `ACC-AGENDA` case from #87: the change that deleted the row's only browser coverage
  // left the row asserting complete Playwright evidence, and nothing connected the two.
  const problems = analyse(declaration, verdicts, context({ exists: () => false }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/web\/e2e\/example\.spec\.ts, which does not exist/);
});

test("a row with no declared evidence at all fails", () => {
  const problems = analyse({ rows: {} }, verdicts, context());
  assert.match(problems[0], /does not say what that rests on/);
});

test("declared evidence for a row the scorecard does not have fails", () => {
  const problems = analyse(declaration, new Map(), context());
  assert.match(problems[0], /declares evidence for ACC-EXAMPLE, which has no row/);
});

test("scorecard verdicts are read from the row table, not from prose about it", () => {
  const verdictsRead = scorecardVerdicts(
    [
      "Prose mentioning `ACC-GHOST` and the word shipped, which is not a row.",
      "| Acceptance ID | Journey | Verdict (local) | Automated evidence |",
      "|---|---|---|---|",
      "| `ACC-ONE` | `JNY-001` | shipped | a.spec.ts |",
      "| `ACC-TWO` | `JNY-002` | partial | b.spec.ts |",
    ].join("\n"),
  );
  assert.deepEqual(
    [...verdictsRead],
    [
      ["ACC-ONE", "shipped"],
      ["ACC-TWO", "partial"],
    ],
  );
});

test("counts are parsed from each runner this repository uses", () => {
  assert.deepEqual(parseCounts("  Tests  149 passed (149)\n"), {
    passed: 149,
    failed: 0,
    total: 149,
  });
  assert.deepEqual(parseCounts("  Tests  2 failed | 26 passed (28)\n"), {
    passed: 26,
    failed: 2,
    total: 28,
  });
  assert.deepEqual(parseCounts("  30 passed (31.7s)\n"), { passed: 30, failed: 0, total: 30 });
  // An unrecognised format weakens nothing: the exit status is what the gate enforces.
  assert.deepEqual(parseCounts("no counts here"), {});
});

test("every scorecard row has a declared evidence entry, and no entry is orphaned", () => {
  // Deliberately *not* asserting that the records are current. This suite runs inside
  // `gate:test-build`, which writes the `test-build` record only after the suite finishes — so
  // a test asserting that record could never see anything but the previous run's, and would
  // fail on the first run after every commit for a reason that says nothing about the code.
  // `gate:evidence` is where currency is judged, once, after the suites have run.
  const { declaration, verdicts } = readInputs();
  const structural = analyse(declaration, verdicts, {
    commit: "ignored",
    exists: () => true,
    readRecord: () => ({ exitCode: 0, commit: "ignored" }),
  });
  assert.deepEqual(structural, []);
});

test("every spec file a row names actually exists", () => {
  const { declaration, verdicts, context } = readInputs();
  const missing = analyse(declaration, verdicts, {
    ...context,
    readRecord: () => ({ exitCode: 0, commit: context.commit }),
  });
  assert.deepEqual(missing, []);
});
