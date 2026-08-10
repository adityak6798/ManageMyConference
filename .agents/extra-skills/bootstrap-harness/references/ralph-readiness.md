# Ralph harness-readiness loop

## Independent review

Use a skeptical reviewer in a separate agent/thread from the primary implementer. Give it raw repository artifacts, requirements, diff/state, and executed evidence. Do not pass a desired verdict; ask it to inspect rather than trust the summary.

Classify findings:

- `blocker`: unsafe, unusable, or core acceptance cannot be demonstrated.
- `major`: a credible product/security/data/contract regression or claimed harness bypass can pass.
- `minor`: useful hardening that does not invalidate readiness.

Exit only at zero blockers and zero majors. Record minors with disposition and owner.

## Review passes

Review the system first, then mutate its assumptions:

- Can generated or external text falsely satisfy normative context?
- Can an owned file, UI, shared package, dynamic import, or composition root evade boundaries?
- Is a declared compiler/linter/base config actually wired into every workspace?
- Can a missing or misspelled environment value enable unsafe behavior?
- Do public contracts describe required bodies, statuses, and errors accurately?
- Can invalid or unauthorized mutations reach persistence?
- Do unexpected errors leak through responses or logs?
- Does reload restore authenticated/product state?
- Does a later `ALTER TABLE` migration pass the drift model?
- Do custom ports and other documented overrides work end to end?
- Are Python/MJS/other real file conventions included in routing and policy checks?

After the main passes, perform one file-by-file configuration audit. This complements architectural review and catches inert or inconsistent wiring.

## Repair loop

For each blocker/major:

1. Reproduce or prove the failure.
2. Make the smallest architectural repair.
3. Add a regression test that fails on the original bypass.
4. Synchronize canonical docs and generated artifacts.
5. Run the aggregate gate plus storage/browser/security checks as applicable.
6. Ask the reviewer to inspect the repaired state.

Do not lower severity merely because a defect is in harness code. Do not expand the harness for hypothetical concerns without a concrete failure mode.

## Completion record

Move the harness plan to completed only with commands, artifacts, acceptance IDs, reviewer verdict, and known external gaps. Be precise about local evidence versus configured or hosted controls. The next product plan becomes ready, not automatically complete.
