// @acceptance ACC-HARNESS
// @spec ENG-AGENT-001 TST-005
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyLedger,
  mergePass,
  passStatistics,
  publicationProblems,
  renderFindings,
  unresolved,
} from "../review-ledger.mjs";
import { isGenerated, render, riskMap } from "../review-risk.mjs";

const manifest = {
  domains: [
    { id: "review", specs: ["PRD-REV-001"], paths: ["apps/api/src/application/review"] },
    { id: "platform", specs: ["ARC-001"], paths: ["tools", "apps/api/src/transport/http/app.ts"] },
  ],
};

test("a change touching authorization is a deep dimension", () => {
  const map = riskMap(["apps/api/src/application/identity/actor.ts"], manifest);
  assert.ok(map.deep.includes("authorization"));
  assert.equal(map.path, "full");
});

test("a migration is a deep dimension and names why", () => {
  const map = riskMap(["apps/api/migrations/0023_example.sql"], manifest);
  assert.ok(map.deep.includes("persistence-and-migrations"));
  const dimension = map.dimensions.find((entry) => entry.id === "persistence-and-migrations");
  assert.match(dimension.why, /immutable once merged/);
});

test("the review input names the actual risks, not a generic request", () => {
  const map = riskMap(
    ["apps/api/src/application/review/review-service.ts", "apps/api/migrations/0023_x.sql"],
    manifest,
  );
  const input = render(map);
  assert.match(input, /\[DEEP\] persistence-and-migrations/);
  assert.match(input, /PRD-REV-001/);
  assert.match(input, /0023_x\.sql/);
  // The reviewer's judgement is preserved: the input says where to look, never what is wrong.
  assert.match(input, /not a claim that something is wrong there/);
});

test("a generated-only change gets the abbreviated path", () => {
  const map = riskMap(
    ["packages/contracts/openapi.json", "docs/generated/context-index.md"],
    manifest,
  );
  assert.equal(map.path, "abbreviated");
  assert.match(render(map), /re-running its generator/);
  assert.match(render(map), /does not weaken source validation/);
});

test("touching a generator alongside its output is not generated-only", () => {
  const map = riskMap(
    ["packages/contracts/openapi.json", "packages/contracts/scripts/generate-openapi.ts"],
    manifest,
  );
  assert.equal(map.path, "full");
  assert.ok(isGenerated("packages/contracts/openapi.json"));
  assert.ok(!isGenerated("packages/contracts/scripts/generate-openapi.ts"));
});

test("harness and gate changes are reviewed deeply", () => {
  const map = riskMap(
    [".github/workflows/ci.yml", "tools/check-evidence.mjs", "apps/web/e2e/fixtures.ts"],
    manifest,
  );
  assert.ok(map.deep.includes("harness-and-gates"));
  assert.ok(
    map.dimensions
      .find((dimension) => dimension.id === "harness-and-gates")
      .files.includes("apps/web/e2e/fixtures.ts"),
  );
});

test("deployed egress code is a deep provider effect", () => {
  const map = riskMap(["apps/webhook-egress/src/ip.ts"], manifest);
  assert.ok(map.deep.includes("provider-effects"));
});

const finding = (overrides = {}) => ({
  severity: "major",
  dimension: "authorization",
  file: "apps/api/src/routes/review.ts",
  summary: "Bulk transition does not re-check the event capability",
  ...overrides,
});

test("a finding raised in an early pass survives later passes", () => {
  let ledger = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 4,
    findings: [finding()],
  });
  // Pass 2 does not raise it again. Not raising a finding is not the same as fixing it.
  ledger = mergePass(ledger, { pass: 2, head: "bbb", durationMinutes: 2, findings: [] });
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].firstSeenPass, 1);
  assert.equal(ledger.findings[0].status, "open");
});

test("findings are ordered by severity", () => {
  const ledger = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 3,
    findings: [
      finding({ severity: "note", summary: "n" }),
      finding({ severity: "blocker", summary: "b" }),
      finding({ severity: "minor", summary: "m" }),
    ],
  });
  assert.deepEqual(
    ledger.findings.map((entry) => entry.severity),
    ["blocker", "minor", "note"],
  );
});

test("a ledger whose last pass predates the head cannot be published", () => {
  const ledger = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 2,
    findings: [],
  });
  const problems = publicationProblems(ledger, "bbb");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /last review pass ran against aaa/);
  assert.match(problems[0], /needs another pass/);
  // Re-reviewing the new head clears it.
  const reviewed = mergePass(ledger, {
    pass: 2,
    head: "bbb",
    durationMinutes: 1,
    findings: [],
  });
  assert.deepEqual(publicationProblems(reviewed, "bbb"), []);
});

test("an open blocker or major cannot be published", () => {
  const ledger = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 2,
    findings: [finding()],
  });
  const problems = publicationProblems(ledger, "aaa");
  assert.match(problems[0], /major still open/);
  assert.match(problems[0], /never on self-attestation/);
  assert.equal(unresolved(ledger).length, 1);
});

test("closing a finding requires evidence", () => {
  const withoutEvidence = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 2,
    findings: [finding({ status: "fixed" })],
  });
  assert.match(publicationProblems(withoutEvidence, "aaa")[0], /marked fixed with no evidence/);

  const withEvidence = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 2,
    findings: [finding({ status: "fixed", evidence: "review-http.test.ts, pass 2" })],
  });
  assert.deepEqual(publicationProblems(withEvidence, "aaa"), []);
});

test("late-pass findings appear in the rendered comment against the final head", () => {
  let ledger = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 2,
    findings: [],
  });
  ledger = mergePass(ledger, {
    pass: 2,
    head: "bbb",
    durationMinutes: 3,
    findings: [finding({ severity: "minor", summary: "Late finding from the repair pass" })],
  });
  const comment = renderFindings(ledger, "bbb");
  assert.match(comment, /Reviewed head: `bbb`/);
  assert.match(comment, /Late finding from the repair pass/);
  assert.match(comment, /ship-it-findings/);
  assert.match(comment, /5 review minute/);
});

test("publication requires review duration for every pass", () => {
  const ledger = mergePass(emptyLedger(), { pass: 1, head: "aaa", findings: [] });
  assert.match(publicationProblems(ledger, "aaa")[0], /pass 1 has no duration/);
});

test("pass duration and yield are recorded so the policy can be tuned", () => {
  let ledger = mergePass(emptyLedger(), {
    pass: 1,
    head: "aaa",
    durationMinutes: 12,
    findings: [finding(), finding({ severity: "minor", summary: "m" })],
  });
  ledger = mergePass(ledger, { pass: 2, head: "bbb", durationMinutes: 5, findings: [] });
  assert.deepEqual(passStatistics(ledger), {
    passes: 2,
    findings: 2,
    blockersAndMajors: 1,
    totalMinutes: 17,
    findingsPerPass: [2, 0],
  });
});
