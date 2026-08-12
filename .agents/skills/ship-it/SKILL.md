---
name: ship-it
description: Take implementation-ready repository work to a review-ready pull request through scoped validation, documentation synchronization, adversarial Ralph review loops, intentional commit and push, hosted CI repair, a 15-minute automated-review observation window, review-thread triage, and transparent PR findings/outstanding-work comments. Use when the user says ship it, make this PR ready, prepare or finish a PR, run final review, or asks to take completed implementation through CI and review. Supports invocation-specific review opinions and durable repo review opinions.
---

# Ship It

Move completed implementation to a truthful, review-ready draft PR. Do not merge it or mark it ready for review unless the user explicitly asks.

## Start

1. Read the repository instructions and inspect the worktree, branch, diff, current PR, and governing plan/spec IDs.
2. Capture review opinions from the invocation. Also read `.agents/ship-it-review-opinions.md` when present. Treat these as explicit review criteria, not automatic implementation requirements.
3. Confirm the changed files belong to the requested scope. Stop for unrelated or ambiguous user changes.
4. State the intended PR scope and the high-risk behavior before mutating Git or GitHub.

Read [review-loop.md](references/review-loop.md) before starting adversarial review. Read [doc-sync.md](references/doc-sync.md) before the documentation stage. Read [pr-ci-and-comments.md](references/pr-ci-and-comments.md) before publishing or writing to GitHub.

## Workflow

### 1. Establish implementation readiness

- Identify user-visible behavior, authorization boundaries, persistence, failure states, contracts, and operational changes in the diff.
- Run the smallest meaningful local checks first, then the repository's aggregate gate.
- Prefer behavioral evidence over line-coverage targets or broad snapshots.
- If implementation is not actually ready, repair in-scope defects. Report a blocker if completion needs a product or design decision.

### 2. Synchronize documentation

- Compare code, tests, interfaces, migrations, configuration, generated artifacts, plans, scorecards, and known gaps.
- Update canonical sources and regenerate derived docs/artifacts.
- Reject claims that exceed executed evidence. Distinguish local proof, configured CI, and externally verified state.
- Run the documentation/context drift gates. Use [doc-sync.md](references/doc-sync.md).

### 3. Run the risk-scoped skeptical Ralph loop

- Derive the risk map first: `node tools/review-risk.mjs <base>`. It reports the dimensions this
  change touches, the files that raised each one, and the owning domains and governing specs.
  Give the reviewer **that**, plus the diff, the governing documents, the test evidence, and any
  invocation-specific review opinions. "Review this diff" is not a review input.
- These dimensions always get a deep pass when touched, and the tool marks them `DEEP`:
  authorization, persistence and migrations, concurrency and idempotency, provider effects,
  public contracts, cross-domain composition, and the harness and gates themselves. Each carries
  the reason it is on the list, because a dimension nobody can justify is the first one dropped
  when a review is rushed.
- A change in which **every** file is a generated artifact may take the abbreviated path: prove
  equivalence by re-running the generator and showing an empty diff. A change touching a
  generator *and* its output is not generated-only — the generator is source, and it gets the
  full pass.
- Ask for severity-ranked blocker, major, minor, and note findings with concrete file/behaviour
  evidence. The risk map says where to look hardest; it never says what the reviewer will find,
  and "nothing in this dimension" is a valid result worth recording.
- Fix all blockers and majors that are in scope. Triage minors; fix high-value ones and record
  justified deferrals.
- Re-run relevant tests and doc sync after repairs, then ask the reviewer to inspect the new
  state. Repeat until the reviewer reports zero blockers and zero majors. Never substitute
  self-attestation for the independent pass — `publicationProblems` in
  `tools/review-ledger.mjs` refuses a resolution with no evidence naming the test, commit, or
  pass that closed it.
- Carry the ledger across passes with `mergePass`; do not re-derive the table each round. A
  finding the reviewer does not raise again is **not** thereby fixed, so it stays open until a
  disposition closes it, and a finding first raised in a late pass still reaches the comment.
- Record each pass's duration and finding count. `passStatistics` reports them, and tuning the
  policy is supposed to rest on that rather than on taste.

### 4. Publish a draft PR

- Create or reuse an intentional branch, stage only scoped files, commit tersely, push, and create or update a draft PR.
- Write a PR body covering what changed, why, impact, validation, and known limitations.
- **Close every issue this PR resolves, with one `Closes #N` per issue, in the PR body.** GitHub's
  closing keywords are per-reference and are read from the PR body and default-branch commit
  messages — not from a citation. Two failure modes have each cost this repository a manual triage
  pass over nine issues:
  - `Closes #28, #90, #29` closes **only #28**. The keyword does not distribute across a list.
    Write `Closes #28. Closes #90. Closes #29.`
  - `feat(agenda): place a subset (#96)` in a commit subject closes **nothing**. A bare `(#N)` is a
    cross-reference; it links the commit to the issue and leaves it open.
- If a PR only partly satisfies an issue, do not use a closing keyword for it. Say what it did and
  what remains, and leave the issue open — a wrongly closed issue is harder to notice than an open one.
- Do not claim hosted checks passed before they finish.

### 5. Reach green hosted CI

- Wait for every required check to finish. Inspect job logs for failures.
- Fix actionable failures, run the relevant local reproduction, commit, push, and wait again.
- Before pushing a repair, repeat the affected readiness and documentation stages. Any functional code, contract, migration, authorization, or runtime-configuration repair must return through Ralph; a mechanical CI-service correction need not repeat unrelated review.
- Rerun an unchanged job only when evidence supports an infrastructure or flaky failure; record that judgment.
- Continue until required CI is green or a genuine external blocker is documented.

### 6. Observe automated review for 15 minutes

- Once the latest pushed commit has green CI, observe the PR for a full 15-minute quiet window for automated review bots.
- Poll reviews, conversation comments, and thread-aware inline comments at intervals no longer than 60 seconds while keeping the user updated.
- If a bot review is still pending at 15 minutes, report that explicitly; do not pretend it completed.
- Triage every new actionable thread. Fix valid in-scope findings, explain rejected suggestions, and surface design decisions.
- After any pushed repair, repeat affected local checks, doc sync, Ralph review, and hosted CI. Start a new 15-minute quiet window only after required CI is green on the repaired head SHA.

### 7. Post transparent PR comments

- Render the findings comment from the ledger rather than writing it by hand, so the two cannot
  drift. Before publishing, run `publicationProblems(ledger, head)`: it refuses a ledger whose
  last pass ran against a commit that is no longer the head. A repair after the review moves the
  head, and a comment naming the old one describes a review of code that is no longer there.
- Add or update one PR comment containing the triaged findings table. Include Ralph and automated-review findings, their disposition, and evidence.
- Before calling the PR review-ready, give every actionable item that will survive merge a durable issue tracker. Link an appropriate open issue and update its scope when needed; create a new issue only when no existing issue cleanly owns the work. Avoid duplicates. Record the owner, deferral rationale or current state, and a concrete closure condition in the issue.
- Add or update a separate PR comment titled `Remaining work` listing unresolved blockers, deferred items, external verification, ownership, and the linked issue for every actionable follow-on. If nothing remains, say so explicitly.
- Use stable HTML markers so reruns update the two comments instead of creating duplicates. Follow [pr-ci-and-comments.md](references/pr-ci-and-comments.md).
- Resolve a review thread only after its fix is pushed and validated, or after a clear documented rejection makes resolution appropriate.

## Decision boundary

Pause and surface choices that change public interfaces, product behavior, authorization, data ownership, migration compatibility, dependencies/runtime, privacy/security posture, or acceptance scope. Present the evidence, viable options, recommendation, and consequence of waiting.

Do not pause for reversible implementation details already governed by repository standards.

## Completion

Call the PR review-ready only when:

- scoped local validation passes;
- canonical docs and generated artifacts agree with code;
- Ralph reports zero blockers and zero majors;
- required hosted CI is green;
- the final 15-minute bot-review window is complete or honestly reported as externally pending;
- actionable review threads are triaged;
- every actionable item that survives merge is tracked in a linked open issue with ownership and a closure condition;
- findings and remaining-work comments reflect the final commit;
- the worktree is clean and the branch is pushed.

Return the PR link, final commit, checks, review verdict, thread counts, deferred work, and any decision still required from the user.
