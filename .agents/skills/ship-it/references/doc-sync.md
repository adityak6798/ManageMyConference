# Documentation synchronization

Use this stage after implementation and after any review repair that changes behavior, interfaces, architecture, operations, or evidence.

## Trace the diff

For each changed behavior, verify the corresponding sources:

- Product behavior: canonical specification and journey.
- HTTP/event shape: shared schema and generated API artifact.
- Authorization: capability policy and negative tests.
- Persistence: schema, ordered migrations, ownership, reset/seed behavior.
- Architecture: public entrypoints, dependency rules, and ADR when durable tradeoffs change.
- Delivery state: active/completed plan, acceptance scorecard, and known gaps.
- Operations: setup, environment variables, CI/release docs, and failure artifacts.

## Check direction both ways

- Code to docs: every material behavior or boundary change is represented.
- Docs to code: every implemented/passed claim has executable evidence.
- Generated to source: regenerate artifacts and run drift checks; never hand-edit generated output.
- Plans to reality: completed means acceptance evidence exists; configured external controls are not reported as executed.

## Useful questions

- Did a public response, event, cookie, environment variable, port, or error code change?
- Can reload, failure, authorization, or migration behavior contradict the prose?
- Is a shared policy actually extended/imported and enforced?
- Does the context index route agents to new tests and source files?
- Are external or hosted checks distinguished from local results?

Record an intentional no-doc-change decision in the findings ledger when the diff is internal and the canonical docs remain accurate.
