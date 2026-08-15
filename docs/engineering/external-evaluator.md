# External SessionBoard evaluator

Status: canonical | Owner: quality | Last verified: 2026-08-15

`npm run eval:sbek` is the one entrypoint for issue #193's external evaluation. It pins the
SessionBoard Eval Kit to commit `d8fafa41cdc484309e3fda953c5567cc2d462734`, records the target
commit and tree cleanliness before setup, chooses a fresh worktree-specific local D1 instance,
builds the public artifact, resets that empty fixture, and starts the Worker. The evaluator config
selects all six required areas and therefore all 18 required scenarios. Its checkout, browser
storage, local D1/R2 state and reports stay below ignored `.evidence/sbek/`.

With `ANTHROPIC_API_KEY`, the command runs and scores the full API path. Without it, the command
uses the evaluator's no-key plan command, archives the exact 18-scenario checklist and exits 2 with
`status: blocked`. That exit is deliberate: it is not a zero score, and it is not a successful
evaluation. Continue the generated run through the evaluator's MCP harness, using a fresh judge
session for each area, or rerun with the credential. The manual GitHub workflow uploads whatever
the run produced even when it is blocked or fails.

Every run directory contains:

- `metadata.json`: target/evaluator commits, dirty paths, sanitized configuration and its hash,
  isolated fixture directory, timestamps, status and failures;
- `evalconfig.json`, with no credentials or recipient data;
- `evaluator.log` and `worker.log`;
- `artifacts/`, containing the evaluator run directory when it produced files. A completed run
  includes `report.html`, `report.json`, judgments, scenario evidence/screenshots and the manual
  checklist because those are the evaluator's native run artifacts.

Do not copy `.auth`, `.dev.vars`, live recipient addresses, provider tokens or `.wrangler` state
into an artifact. A second invocation receives a different isolated D1 instance and begins with a
reset; it cannot observe submissions left by the first invocation.

## Score status

The declared 2026-08-13 baseline is **60.5% overall / 92.4% coverage**, with 21 manual checks.
The latest completed report available during this lane, started 2026-08-14 18:32 UTC, reads
**65.9% / 97.6%**, with 16 manual checks. Its area scores are CFP 85.1%, Abstract Management
36.5%, Speaker Management 57.8%, Content Management 62.9%, AI Agenda 100%, and Public Widgets
67.6%. That older workflow did not record its target commit, so it is useful directional evidence
and is not a release claim for this branch.

The latest wrapper run recorded its clean target commit, the pinned evaluator and the validated
18-scenario plan. It stopped blocked because this environment has no
`ANTHROPIC_API_KEY`; consequently **there is no current model-scored number for this branch**.
Issue #193 remains open. The 65.9% report's non-pass items also predate several landed fixes and
must not be presented as the result of this tree.

The known owners of score that cannot reach 100% remain #230 (XLSX and track-filtered abstract
selection), `GAP-028` (private-set content hardening), `GAP-029` (interest forms/campaigns/directory
analytics), #132 (recipient-scoped communication cap), #190 (its residual list), and `GAP-030`
(fixture-independent 390px min-content coverage). Pending manual items remain findings until a
completed run's `manual-results.json` resolves them; no scorecard claim is weakened to hide them.
