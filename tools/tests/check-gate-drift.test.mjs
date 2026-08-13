// @acceptance ACC-HARNESS
// @spec ENG-CI-001 TST-005
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyse,
  checkComposition,
  DOC_PATH,
  documentedExclusions,
  EXCLUSION_HEADING,
  parseWorkflowJobs,
  readInputs,
  selfTest,
} from "../check-gate-drift.mjs";

const workflow = `name: CI

on:
  pull_request:

permissions:
  contents: read

jobs:
  integrity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm install --global npm@9.9.9
      - run: npm ci
      - run: npm run gate:integrity

  browser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run gate:browser
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-failure-artifacts
          path: |
            apps/web/playwright-report
          if-no-files-found: ignore
`;

const packageJson = {
  packageManager: "npm@9.9.9",
  scripts: {
    check: "npm run gate:integrity",
    lint: "biome lint .",
    "gate:integrity": "npm run lint",
    "gate:browser": "npm run test:e2e",
    "gates:check": "node tools/check-gate-drift.mjs",
  },
};

const doc = `# CI\n\n${EXCLUSION_HEADING}\n\n- \`gate:browser\` — needs a downloaded browser.\n\n## Next\n`;

// The shared bootstrap. It is where the pinned npm lives once jobs stop installing it
// themselves, so the drift check has to follow it there.
const setupAction = `name: Set up
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
    - run: npm install --global npm@9.9.9
      shell: bash
    - run: npm ci
      shell: bash
`;

const inputs = () => ({
  workflow,
  setupAction,
  packageJson: structuredClone(packageJson),
  doc,
});

test("a workflow whose jobs each run their own gate agrees with check", () => {
  assert.deepEqual(analyse(inputs()), []);
});

test("a release job is allowed only after every gate on a main push", () => {
  const withDeploy = {
    ...inputs(),
    workflow: `${workflow}
  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: [integrity, browser]
    concurrency:
      group: production-deploy
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run deploy:assert-current
      - run: npm run deploy
`,
  };
  assert.deepEqual(analyse(withDeploy), []);
  assert.match(
    analyse({
      ...withDeploy,
      workflow: withDeploy.workflow.replace("needs: [integrity, browser]", "needs: [integrity]"),
    }).join("\n"),
    /must need every gate/,
  );
  assert.match(
    analyse({
      ...withDeploy,
      workflow: withDeploy.workflow.replace("refs/heads/main", "refs/heads/demo"),
    }).join("\n"),
    /only for main-branch pushes/,
  );
  assert.match(
    analyse({
      ...withDeploy,
      workflow: withDeploy.workflow.replace("      group: production-deploy\n", ""),
    }).join("\n"),
    /must serialize production deploys/,
  );
  assert.match(
    analyse({
      ...withDeploy,
      workflow: withDeploy.workflow.replace("      - run: npm run deploy:assert-current\n", ""),
    }).join("\n"),
    /must refuse stale main/,
  );
});

test("the reader keeps step attributes with their step and ignores action configuration", () => {
  const jobs = parseWorkflowJobs(workflow);
  assert.deepEqual([...jobs.keys()], ["integrity", "browser"]);
  assert.deepEqual(
    jobs.get("browser").steps.map((step) => step.run ?? step.uses),
    [
      "actions/checkout@v4",
      "npm ci",
      "npx playwright install --with-deps chromium",
      "npm run gate:browser",
      "actions/upload-artifact@v4",
    ],
  );
  // `name:`/`path:` under `with:` belong to the action, not to the gate definition.
  assert.equal(jobs.get("browser").steps.at(-1).name, undefined);
});

test("a multi-line run step is refused rather than half-read", () => {
  const blocked = workflow.replace(
    "      - run: npm run gate:browser",
    "      - run: |\n          npm run reset\n          npm run test:e2e",
  );
  assert.throws(() => parseWorkflowJobs(blocked), /Multi-line/);
});

test("`gates:check` is a tool, not a gate", () => {
  assert.deepEqual(checkComposition(packageJson).gates, ["gate:integrity"]);
  assert.deepEqual(analyse(inputs()), []);
});

test("an exclusion needs both a gate name and a reason", () => {
  assert.deepEqual(
    [...documentedExclusions(doc)],
    [["gate:browser", "needs a downloaded browser."]],
  );
  assert.equal(documentedExclusions("# CI\n"), null);
  assert.deepEqual([...documentedExclusions(`${EXCLUSION_HEADING}\n\n- \`gate:browser\`\n`)], []);
});

test("the exclusion list stops at the next heading", () => {
  const later = `${EXCLUSION_HEADING}\n\n- \`gate:browser\` — reason.\n\n## Coverage\n\n- \`gate:security\` — prose, not an exclusion.\n`;
  assert.deepEqual([...documentedExclusions(later).keys()], ["gate:browser"]);
});

for (const [label, mutate, expected] of [
  [
    "a CI job with no gate script",
    (given) => ({ ...given, workflow: given.workflow.replace("  browser:", "  smoke:") }),
    /no `gate:smoke` script/,
  ],
  [
    "a gate script with no CI job",
    (given) => {
      given.packageJson.scripts["gate:load"] = "npm run load";
      return given;
    },
    /no matching job/,
  ],
  [
    "a raw command smuggled into a CI job",
    (given) => ({
      ...given,
      workflow: given.workflow.replace(
        "      - run: npm run gate:integrity",
        "      - run: npm run typecheck\n      - run: npm run gate:integrity",
      ),
    }),
    /runs `npm run typecheck` directly/,
  ],
  [
    "a job that never runs its gate",
    (given) => ({
      ...given,
      workflow: given.workflow.replace("      - run: npm run gate:integrity\n", ""),
    }),
    /runs `npm run gate:integrity` 0 times/,
  ],
  [
    "a job that runs its gate twice",
    (given) => ({
      ...given,
      workflow: given.workflow.replace(
        "      - run: npm run gate:integrity",
        "      - run: npm run gate:integrity\n      - run: npm run gate:integrity",
      ),
    }),
    /2 times/,
  ],
  [
    "a check step that belongs to no gate",
    (given) => {
      given.packageJson.scripts.check = "npm run gate:integrity && npm run lint";
      return given;
    },
    /which is not/,
  ],
  [
    "the same gate invoked twice by check",
    (given) => {
      given.packageJson.scripts.check = "npm run gate:integrity && npm run gate:integrity";
      return given;
    },
    /more than once/,
  ],
  [
    "check invoking a gate that does not exist",
    (given) => {
      given.packageJson.scripts.check = "npm run gate:integrity && npm run gate:ghost";
      return given;
    },
    /which does not exist/,
  ],
  [
    "a gate quietly dropped from check",
    (given) => {
      given.packageJson.scripts.check = "npm run gate:browser";
      return given;
    },
    /`gate:integrity` runs in CI but not in `npm run check`/,
  ],
  [
    "an exclusion recorded for a gate check actually runs",
    (given) => {
      given.packageJson.scripts.check = "npm run gate:integrity && npm run gate:browser";
      return given;
    },
    /Delete the entry/,
  ],
  [
    "an exclusion for a gate that no longer exists",
    (given) => ({
      ...given,
      doc: given.doc.replace(
        "- `gate:browser`",
        "- `gate:gone` — a stale record.\n- `gate:browser`",
      ),
    }),
    /but no such gate exists/,
  ],
  [
    "the exclusion section deleted outright",
    (given) => ({ ...given, doc: "# CI\n" }),
    new RegExp(`${DOC_PATH} has no`),
  ],
  [
    "a CI npm pin that drifted from packageManager",
    (given) => {
      given.packageJson.packageManager = "npm@11.12.1";
      return given;
    },
    /installs npm@9\.9\.9 but package\.json pins npm@11\.12\.1/,
  ],
  [
    "a shared setup action whose npm pin drifted from packageManager",
    (given) => ({ ...given, setupAction: given.setupAction.replace("9.9.9", "8.8.8") }),
    /actions\/setup\/action\.yml installs npm@8\.8\.8 but package\.json pins npm@9\.9\.9/,
  ],
  [
    "a shared setup action that stopped pinning npm at all",
    (given) => ({ ...given, setupAction: "name: Set up\nruns:\n  using: composite\n" }),
    /does not install a pinned npm/,
  ],
]) {
  test(`the analysis reports ${label}`, () => {
    const problems = analyse(mutate(inputs()));
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `expected ${label} to be reported, got: ${problems.join(" / ") || "nothing"}`,
    );
  });
}

test("this repository's own gates agree, and the analysis proves it would notice if they did not", () => {
  const real = readInputs();
  assert.deepEqual(analyse(real), []);
  assert.deepEqual(selfTest(real), []);
});
