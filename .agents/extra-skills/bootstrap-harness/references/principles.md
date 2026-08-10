# Harness principles

## Repository as context system

Treat the repository as structured prompt injection for coding agents. The root instruction file is a map, not a manual. Place durable knowledge in canonical, focused documents and make the current task route to only the relevant subset.

Good context is:

- discoverable without broad searches;
- bounded by task and ownership;
- explicit about authority and provenance;
- close enough to code to stay synchronized;
- backed by executable checks where correctness matters;
- cheap to update as the product changes.

## Progressive disclosure

Use three layers:

1. Root map: commands, non-negotiable rules, and links.
2. Domain indexes: product, architecture, interfaces, engineering, plans, and quality.
3. Task context: exact specs, boundaries, symbols, tests, and active plan returned by deterministic routing.

Do not make every agent ingest the full product. Do not hide critical rules in tribal knowledge or a giant `CLAUDE.md`/`AGENTS.md`.

## Docs and code

Docs own intent and boundaries; executable artifacts own exact machine contracts:

- specs own behavior and acceptance;
- schemas own wire validation and generate API artifacts;
- domain types own internal semantics;
- migrations own deployed database history;
- tests own executable evidence;
- plans own sequencing;
- generated indexes are disposable views.

Reference governing IDs in critical code comments. Comments explain why and invariants, not syntax.

## Hard feedback

Agents improve when the repo makes invalid states difficult:

- fail-closed architecture and ownership checks;
- strict compilation and standard linting;
- deterministic local services and seeds;
- contract drift and migration checks;
- behavioral tests at public boundaries;
- CI errors that point to governing docs and remediation.

“Self-healing” means agents can follow failures back to authoritative context and repair safely. It does not mean silently rewriting code or docs.

## Product first

The harness is successful only when it accelerates correct product delivery. Prove it with a real vertical slice. Avoid speculative abstraction, exhaustive policy machinery, and coverage theater. Build what protects the next set of parallel feature changes.
