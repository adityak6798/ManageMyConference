# Skeptical review loop

Use this reference for the Ralph stage and for invocation-specific review opinions.

## Review input

Give the reviewer:

- the actual base-to-head diff and repository state;
- governing specs, interfaces, plans, and architecture boundaries;
- commands actually run and their results;
- user-supplied review opinions, quoted as criteria;
- known gaps and prior-pass findings when verifying repairs.

Do not give the reviewer an intended verdict. Require inspection of actual files and behavior.

## Review dimensions

Prioritize:

1. User-visible functional behavior and failure states.
2. Authorization, privacy, secret handling, and tenant boundaries.
3. Persistence, migration compatibility, idempotency, and data loss.
4. Public interfaces, client/server contract agreement, and compatibility.
5. Tests that would fail for realistic regressions, including negative paths.
6. Documentation claims versus implementation and executed evidence.
7. Configuration that is declared but inert, inconsistent, or fail-open.
8. Harness bypasses only where they undermine a claimed guarantee.

Sample seams as well as the happy path: reloads, missing/misspelled environment values, custom configuration, malformed and semantically invalid input, unknown routes, later migrations, alternate import forms, and error redaction.

Do not demand coverage percentages, broad snapshots, duplicated gates, speculative abstractions, or exhaustive harness machinery without a concrete risk.

## Severity

- `blocker`: unsafe to publish or cannot satisfy core acceptance.
- `major`: credible functional, security, data, contract, or claimed-enforcement regression can pass.
- `minor`: worthwhile hardening or maintainability issue that does not invalidate review readiness.
- `note`: observation without requested action.

The exit condition is zero blockers and zero majors. Minors require an explicit fix or deferral rationale.

## Custom review opinions

Accept free-form opinions in the invocation, for example:

```text
Review opinions:
- Prefer functional tests over harness expansion.
- Treat API compatibility as a blocker.
- Do not add a dependency for this change.
```

Pass each opinion to the reviewer. If an opinion conflicts with repository policy, safety, or another opinion, surface the conflict instead of silently choosing.

## Findings ledger

Track one row per stable finding across passes:

| ID | Source | Severity | Area | Finding | Disposition | Evidence |
|---|---|---|---|---|---|---|
| `R1-M1` | Ralph pass 1 | major | authorization | Mutation bypasses capability check | fixed | test name, commit, or path |
| `BOT-C1` | Copilot | minor | configuration | Override is ignored | deferred | rationale and owner |

Use `fixed`, `rejected`, `duplicate`, `outdated`, or `deferred` as dispositions. Preserve the original severity and concise finding even after repair.

Record elapsed minutes on every pass. A pass without duration cannot be published by
`publicationProblems`, because finding yield without review cost cannot tune a risk-driven policy.
The ledger renderer emits both shipped marker names, `<!-- greenroom:findings -->` and
`<!-- ship-it-findings -->`, on the same stable comment so either historical updater finds it.
