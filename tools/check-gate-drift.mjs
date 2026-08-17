// @spec ENG-CI-001 TST-005
//
// Keeps the documented handoff gate (`npm run check`) and the merge gate
// (`.github/workflows/ci.yml`) from describing two different definitions of "green".
//
// The problem this exists to make impossible
//   Before this check, `check` chained one list of commands and CI ran another. Nothing
//   compared them, so a contributor could be green locally and red on the pull request
//   (a step CI ran that `check` did not) or, worse, green on the pull request and red
//   locally — which teaches people to stop trusting the local gate.
//
// The shape that fixes it
//   Root `package.json` holds one `gate:<name>` script per CI job. That script *is* the
//   gate: it is the only place a check is named.
//     * every merge-gate job in ci.yml runs exactly `npm run gate:<its own job name>`, plus
//       allowlisted environment setup (installing npm/uv/browsers);
//     * the one `deploy` release job runs `npm run deploy` only after every merge gate;
//     * `check` is nothing but a `&&` chain of `npm run gate:*` invocations;
//     * a gate `check` does not run must be listed, with a reason, under the
//       "Gates the local check deliberately skips" heading of
//       docs/engineering/ci-and-release.md — and a gate `check` *does* run must not be.
//
//   So adding a check to CI without adding it to `check` is a build failure, adding one
//   to `check` without adding it to CI is a build failure, and deciding they may
//   legitimately differ costs one sentence in the canonical CI document.
//
// What it deliberately does NOT cover
//   * `.github/workflows/gardening.yml`. That workflow is scheduled and read-only; it is
//     not a merge gate, so it is not required to mirror `check`.
//   * Step *order* inside a job, and the order gates appear in `check`.
//   * What a gate script actually runs. A gate is free to chain whatever it likes; the
//     invariant is that both entry points reach the same script.
//   * `uses:` steps. Marketplace actions (checkout, setup-node, gitleaks, artifact
//     upload) are environment and reporting, not repository commands.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const SETUP_ACTION_PATH = ".github/actions/setup/action.yml";
export const DOC_PATH = "docs/engineering/ci-and-release.md";
export const EXCLUSION_HEADING = "## Gates the local check deliberately skips";
export const DEPLOY_JOB = "deploy";
export const DEPLOY_CONDITION = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
/* The indentation is the assertion — these keys have to be the deploy job's own, not another
   job's — so the run counts are written as quantifiers rather than as spaces nobody can count. */
export const DEPLOY_CONCURRENCY =
  / {2}deploy:\n(?:.|\n)*? {4}concurrency:\n {6}group: production-deploy\n {6}cancel-in-progress: false\n/;

/**
 * Commands a CI job may run that are not gates: they build the environment the gate
 * then runs in, and have no local equivalent (a contributor already has these).
 */
const SETUP_STEPS = new Set([
  "npm ci",
  "uv sync --locked",
  "npx playwright install --with-deps chromium",
]);

/** `npm install --global npm@X` — X must be the version `packageManager` pins. */
const PINNED_NPM = /^npm install --global npm@(\S+)$/;

/**
 * The same pin, wherever it sits inside the shared setup action. That file is an action's
 * own configuration rather than workflow YAML, so it is matched rather than parsed — but it
 * is matched, because moving the bootstrap into a composite action must not quietly take the
 * npm-version check out of service along with it.
 */
// Anchored to an actual `- run:` step. Unanchored, a comment — or `echo npm install --global
// npm@…` — would satisfy the check, and the gate would report a pinned npm the action never
// installs.
const PINNED_NPM_IN_ACTION = /^\s*-?\s*run:\s*npm install --global npm@(\S+)\s*$/m;

const GATE_INVOCATION = /^npm run (gate:[A-Za-z0-9:_-]+)$/;

/**
 * Minimal reader for the subset of workflow YAML this repository writes: jobs at two
 * spaces, `steps:` at four, steps at six, step attributes at eight. Anything deeper is
 * an action's own configuration and is ignored. A block scalar (`run: |`) is rejected
 * rather than guessed at, because a multi-line CI step is exactly the drift this file
 * exists to prevent — those commands belong in a gate script.
 */
export function parseWorkflowJobs(text) {
  const jobs = new Map();
  let insideJobs = false;
  let job = null;
  let insideSteps = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      insideJobs = line === "jobs:";
      job = null;
      insideSteps = false;
      continue;
    }
    if (!insideJobs) continue;
    if (indent === 2) {
      const heading = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
      if (!heading) throw new Error(`Unreadable job heading in ${WORKFLOW_PATH}: ${line}`);
      job = { name: heading[1], steps: [] };
      jobs.set(job.name, job);
      insideSteps = false;
      continue;
    }
    if (!job) continue;
    if (indent === 4) {
      const property = /^ {4}([A-Za-z-]+):[ ]?(.*)$/.exec(line);
      if (property && property[1] !== "steps") job[property[1]] = property[2];
      insideSteps = line.trim() === "steps:";
      continue;
    }
    if (!insideSteps) continue;
    const started = /^ {6}- ([A-Za-z-]+):[ ]?(.*)$/.exec(line);
    const continued = /^ {8}([A-Za-z-]+):[ ]?(.*)$/.exec(line);
    const attribute = started ?? continued;
    if (!attribute) continue;
    if (started) job.steps.push({});
    const step = job.steps.at(-1);
    if (!step) throw new Error(`Step attribute before any step in ${WORKFLOW_PATH}: ${line}`);
    if (attribute[1] === "run" && (attribute[2] === "|" || attribute[2] === ">"))
      throw new Error(
        `Multi-line \`run:\` step in ${WORKFLOW_PATH} job "${job.name}". ` +
          "Put those commands in the job's gate script instead, so `npm run check` runs them too.",
      );
    step[attribute[1]] = attribute[2];
  }
  return jobs;
}

/** The `gate:*` scripts declared in root package.json, by gate name. */
export function gateScripts(packageJson) {
  return new Map(
    Object.entries(packageJson.scripts ?? {}).filter(([name]) => /^gate:[^:]/.test(name)),
  );
}

/** The gates `check` invokes, in order, or a problem describing why it could not be read. */
export function checkComposition(packageJson) {
  const script = packageJson.scripts?.check;
  if (typeof script !== "string") return { gates: [], problems: ["No `check` script exists."] };
  const gates = [];
  const problems = [];
  for (const command of script.split("&&").map((part) => part.trim())) {
    const invocation = GATE_INVOCATION.exec(command);
    if (invocation) gates.push(invocation[1]);
    else
      problems.push(
        `The \`check\` script runs \`${command}\`, which is not \`npm run gate:<name>\`. ` +
          "Every check belongs to a gate so CI and `check` cannot disagree about it.",
      );
  }
  return { gates, problems };
}

/**
 * Gate -> reason, read from the exclusion section of the canonical CI document. The
 * document is the record of the divergence, so the list of skipped gates has exactly
 * one home rather than one in code and one in prose.
 */
export function documentedExclusions(doc) {
  const section = doc.split(EXCLUSION_HEADING)[1];
  if (section === undefined) return null;
  const exclusions = new Map();
  for (const line of section.split("\n")) {
    if (line.startsWith("#")) break;
    const entry = /^- `(gate:[A-Za-z0-9:_-]+)`\s*[—-]\s*(.+)$/.exec(line.trim());
    if (entry) exclusions.set(entry[1], entry[2].trim());
  }
  return exclusions;
}

/** Everything wrong with the relationship between the two gates. Empty means they agree. */
export function analyse({ workflow, packageJson, doc, setupAction }) {
  const problems = [];
  const jobs = parseWorkflowJobs(workflow);
  const gates = gateScripts(packageJson);
  const pinnedNpm = String(packageJson.packageManager ?? "").replace(/^npm@/, "");

  const actionNpm = PINNED_NPM_IN_ACTION.exec(setupAction ?? "");
  if (!actionNpm)
    problems.push(
      `${SETUP_ACTION_PATH} does not install a pinned npm. Every job bootstraps through it, ` +
        "so that is where the version package.json pins has to be installed.",
    );
  else if (actionNpm[1] !== pinnedNpm)
    problems.push(
      `${SETUP_ACTION_PATH} installs npm@${actionNpm[1]} but package.json pins npm@${pinnedNpm}.`,
    );

  for (const [name, job] of jobs) {
    if (name === DEPLOY_JOB) {
      const gateNames = [...jobs.keys()].filter((candidate) => candidate !== DEPLOY_JOB);
      const expectedNeeds = `[${gateNames.join(", ")}]`;
      if (job.if !== DEPLOY_CONDITION)
        problems.push(`${WORKFLOW_PATH} job "${DEPLOY_JOB}" must run only for main-branch pushes.`);
      if (job.needs !== expectedNeeds)
        problems.push(
          `${WORKFLOW_PATH} job "${DEPLOY_JOB}" must need every gate: ${expectedNeeds}.`,
        );
      if (!DEPLOY_CONCURRENCY.test(workflow))
        problems.push(
          `${WORKFLOW_PATH} job "${DEPLOY_JOB}" must serialize production deploys without cancelling one in progress.`,
        );
      const commands = job.steps.map((step) => step.run).filter((run) => run !== undefined);
      if (
        commands.length !== 2 ||
        commands[0] !== "npm run deploy:assert-current" ||
        commands[1] !== "npm run deploy"
      )
        problems.push(
          `${WORKFLOW_PATH} job "${DEPLOY_JOB}" must refuse stale main before running \`npm run deploy\` once.`,
        );
      continue;
    }
    const gate = `gate:${name}`;
    if (!gates.has(gate))
      problems.push(
        `${WORKFLOW_PATH} job "${name}" has no \`${gate}\` script in package.json, so ` +
          "`npm run check` can never run it.",
      );
    const commands = job.steps.map((step) => step.run).filter((run) => run !== undefined);
    const invoked = commands.filter((run) => run === `npm run ${gate}`);
    if (invoked.length !== 1)
      problems.push(
        `${WORKFLOW_PATH} job "${name}" runs \`npm run ${gate}\` ${invoked.length} times; ` +
          "it must run its own gate exactly once.",
      );
    for (const command of commands) {
      if (command === `npm run ${gate}` || SETUP_STEPS.has(command)) continue;
      const npm = PINNED_NPM.exec(command);
      if (npm) {
        if (npm[1] !== pinnedNpm)
          problems.push(
            `${WORKFLOW_PATH} job "${name}" installs npm@${npm[1]} but package.json pins ` +
              `npm@${pinnedNpm}.`,
          );
        continue;
      }
      problems.push(
        `${WORKFLOW_PATH} job "${name}" runs \`${command}\` directly. Move it into the ` +
          `\`${gate}\` script so \`npm run check\` runs it too, or add it to SETUP_STEPS in ` +
          "tools/check-gate-drift.mjs if it only builds the runner's environment.",
      );
    }
  }

  for (const gate of gates.keys())
    if (!jobs.has(gate.slice("gate:".length)))
      problems.push(
        `package.json declares \`${gate}\` but ${WORKFLOW_PATH} has no matching job, so the ` +
          "merge gate would not run it.",
      );

  const composition = checkComposition(packageJson);
  problems.push(...composition.problems);
  const ran = new Set(composition.gates);
  if (ran.size !== composition.gates.length)
    problems.push("The `check` script invokes the same gate more than once.");
  for (const gate of ran)
    if (!gates.has(gate))
      problems.push(`The \`check\` script runs \`${gate}\`, which does not exist.`);

  const exclusions = documentedExclusions(doc);
  if (exclusions === null) {
    problems.push(`${DOC_PATH} has no "${EXCLUSION_HEADING}" section.`);
    return problems;
  }
  for (const gate of gates.keys()) {
    const skipped = !ran.has(gate);
    if (skipped && !exclusions.has(gate))
      problems.push(
        `\`${gate}\` runs in CI but not in \`npm run check\`. Add it to \`check\`, or record ` +
          `why it is skipped under "${EXCLUSION_HEADING}" in ${DOC_PATH}.`,
      );
    if (!skipped && exclusions.has(gate))
      problems.push(
        `${DOC_PATH} says \`${gate}\` is skipped locally, but \`check\` runs it. Delete the entry.`,
      );
  }
  for (const gate of exclusions.keys())
    if (!gates.has(gate))
      problems.push(`${DOC_PATH} records \`${gate}\` as skipped, but no such gate exists.`);

  return problems;
}

export function readInputs() {
  return {
    workflow: readFileSync(new URL(WORKFLOW_PATH, root), "utf8"),
    setupAction: readFileSync(new URL(SETUP_ACTION_PATH, root), "utf8"),
    packageJson: JSON.parse(readFileSync(new URL("package.json", root), "utf8")),
    doc: readFileSync(new URL(DOC_PATH, root), "utf8"),
  };
}

const clone = (inputs) => ({ ...inputs, packageJson: structuredClone(inputs.packageJson) });

/**
 * Every way the two gates can drift apart, and the mutation that produces it. A green
 * run is only worth something if these are all still caught.
 */
export const MUTATIONS = [
  [
    "a CI job that never invokes its gate",
    (inputs) => ({
      ...inputs,
      workflow: inputs.workflow.replace("      - run: npm run gate:d1\n", ""),
    }),
  ],
  [
    "a CI step that bypasses the gate scripts",
    (inputs) => ({
      ...inputs,
      workflow: inputs.workflow.replace(
        "      - run: npm run gate:d1",
        "      - run: npm run lint\n      - run: npm run gate:d1",
      ),
    }),
  ],
  [
    "a CI job with no gate script",
    (inputs) => ({
      ...inputs,
      workflow: inputs.workflow.replace("  d1:\n", "  d1-extra:\n"),
    }),
  ],
  [
    "a gate script with no CI job",
    (inputs) => {
      const mutated = clone(inputs);
      mutated.packageJson.scripts["gate:orphan"] = "npm run lint";
      return mutated;
    },
  ],
  [
    "a check step that belongs to no gate",
    (inputs) => {
      const mutated = clone(inputs);
      mutated.packageJson.scripts.check = `${mutated.packageJson.scripts.check} && npm run lint`;
      return mutated;
    },
  ],
  [
    "a gate silently dropped from check",
    (inputs) => {
      const mutated = clone(inputs);
      mutated.packageJson.scripts.check = mutated.packageJson.scripts.check
        .split("&&")
        .map((part) => part.trim())
        .filter((part) => part !== "npm run gate:d1")
        .join(" && ");
      return mutated;
    },
  ],
  [
    "an undocumented gate exclusion",
    (inputs) => ({ ...inputs, doc: inputs.doc.split(EXCLUSION_HEADING)[0] ?? "" }),
  ],
  [
    "a stale npm pin in CI",
    (inputs) => {
      const mutated = clone(inputs);
      mutated.packageJson.packageManager = "npm@0.0.1";
      return mutated;
    },
  ],
  [
    "a shared setup action that installs no pinned npm",
    (inputs) => ({
      ...inputs,
      setupAction: inputs.setupAction.replace(/npm install --global npm@\S+/, "npm --version"),
    }),
  ],
];

/** Mutations the analysis failed to notice. Must be empty. */
export function selfTest(inputs) {
  return MUTATIONS.filter(([, mutate]) => analyse(mutate(inputs)).length === 0).map(
    ([label]) => label,
  );
}

function main() {
  const inputs = readInputs();
  const problems = analyse(inputs);
  if (problems.length > 0) {
    process.stderr.write(
      `The local gate and the merge gate disagree:\n  ${problems.join("\n  ")}\n` +
        `Both are defined by the \`gate:*\` scripts in package.json; see ${DOC_PATH}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const undetected = selfTest(inputs);
  if (undetected.length > 0) {
    process.stderr.write(
      `Gate drift check is not trustworthy: it failed to notice ${undetected.join("; ")}.\n` +
        "Update MUTATIONS in tools/check-gate-drift.mjs so the self-test keeps biting.\n",
    );
    process.exitCode = 1;
    return;
  }
  const gates = [...gateScripts(inputs.packageJson).keys()];
  const local = new Set(checkComposition(inputs.packageJson).gates);
  process.stdout.write(
    `Gate drift checks passed (${gates.length} gates, ${local.size} run by \`npm run check\`, ` +
      `${gates.length - local.size} documented as skipped, ${MUTATIONS.length} self-test mutations detected).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
