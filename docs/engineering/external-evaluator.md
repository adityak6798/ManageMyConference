# External SessionBoard evaluator

Status: canonical | Owner: quality | Last verified: 2026-08-18

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

Two numbers exist for this repository and they were produced by **different judges**. Read the
provenance line before quoting either.

**API path (pinned models).** The declared 2026-08-13 baseline is **60.5% overall / 92.4%
coverage**, with 21 manual checks. The most recent completed API-path report, started 2026-08-14
18:32 UTC, reads **65.9% / 97.6%**, with 16 manual checks: CFP 85.1%, Abstract Management 36.5%,
Speaker Management 57.8%, Content Management 62.9%, AI Agenda 100%, Public Widgets 67.6%. That
workflow did not record its target commit, so it is directional evidence and not a release claim.
Its non-pass items also predate several landed fixes.

**Harness path (2026-08-18).** The remedy this runbook prescribes for a missing credential — carry
the generated run through the evaluator's MCP harness and judge each area in a fresh context — was
executed in full against target commit `b8ca2dc` with a clean tree, on the pinned evaluator
`d8fafa41`, over all six required areas and all 18 required scenarios. It scored **85.5% overall /
95.4% coverage**, with 19 manual checks outstanding: CFP 85.1%, Abstract Management 92.9%, Speaker
Management 82.8%, Content Management 81.5%, AI Agenda 100%, Public Widgets 76.5%. By probe type:
scoping 95.0%, roundtrip 90.9%, rule 86.8%, depth 86.4%, crud 83.3%, side-effect 83.3%, exists
80.4%, bulk 72.7%, handoff 66.7%. Archived at
`.evidence/sbek/runs/2026-08-18T19-36-40-531Z/` with 297 screenshots.

**That number does not supersede the API-path numbers and does not close issue #193.** The API path
pins `claude-sonnet-5` as the browsing agent and `claude-opus-5` as the judge; this run used
in-session Claude Code agents for both, which `report.json` records as
`models.agent = "harness (in-session agent)"` and `models.judge = "harness (in-session judge)"`. The
six judges each ran in a fresh context with no browsing history, as the kit requires, but the
evidence they read was authored by the same operator that dispatched them. Comparing 85.5% against
65.9% compares two judges as much as two trees. It also bypassed `npm run eval:sbek`, so the
archive's `metadata.json` was written by hand rather than by the wrapper; its `failures` array
records exactly that.

The judges recorded evaluation gaps that would move the number in **both** directions, and these are
the first thing to fix on a re-run rather than anything in the product:

- Several verdicts are `partial` only because a path was never opened. The browsing agent concluded
  no manual add-speaker control exists while the Speakers tab carries an unopened `Import speakers`
  panel and the CRM tab offers `New prospect` with a `Converted to speakers` metric (`SPK-02`,
  `SPK-03`); the speakers-directory search box, an agenda session block, and a gallery card were
  never clicked (`EMB-05`, `EMB-08`, `EMB-13`); `CNT-S3` exhausted its turns before organizer
  bio/headshot editing (`CNT-10`) or any public-surface approval check (`CNT-12`).
- `AIA-04` is `cannot_judge` for a speaker double-booking the agent believed impossible, but the
  final public schedule shows one speaker on two sessions — the clash was inducible and simply was
  not attempted.
- Judges overrode five browsing-agent claims that its own screenshots contradict, most consequentially
  that only three embed widget types exist when the publishing surface offers five. One `CFP-S4`
  observation was retracted by an appended correction in its `evidence.json` and excluded from
  scoring.
- Most screenshots are 1280x800 viewport captures even where full-page was requested, so a number of
  verdicts rest on recorded observations plus adjacent evidence rather than on pixels.

Findings this run surfaced that are **not** already owned below, and are worth triaging before the
next credentialed run:

- A published conditional form field never renders on the public CFP form. Configured, saved and
  published as v3, reproduced from two personas; the form serves 8 of its 9 questions.
- `POST /api/organizations/{id}/invitations` returns 403, so an organizer cannot add a reviewer who
  is not pre-seeded. The refusal is surfaced as a banner with a correlation id.
- Accepting an abstract creates a speaker record without the submitter's contact address, and the
  speaker profile editor has no email field, so Communications reports the just-accepted speaker
  among those it cannot reach.
- File comment threads are write-only for organizers: the deliverables row offers a comment box but
  never renders the existing thread the speaker can see in the portal.
- Bulk task assignment reports nothing and does not reset its form; two presses create two identical
  tasks.

The known owners of score that cannot reach 100% remain #230 (XLSX and track-filtered abstract
selection), `GAP-028` (private-set content hardening), `GAP-029` (interest forms/campaigns/directory
analytics), #132 (recipient-scoped communication cap), #190 (its residual list), and `GAP-030`
(fixture-independent 390px min-content coverage). Pending manual items remain findings until a
completed run's `manual-results.json` resolves them; no scorecard claim is weakened to hide them.
