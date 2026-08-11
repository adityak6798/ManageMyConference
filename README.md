# Project Greenroom

An open conference-operations platform for the Kill My SaaS competition. Greenroom follows the lifecycle from CFP and review through speakers, agenda, communications, CRM, and public publishing.

The repository is deliberately organized as an agent-readable context graph. Start with [AGENTS.md](AGENTS.md) or browse the [documentation system of record](docs/README.md). `prototype.html` is a historical pre-implementation sketch, not the product.

## What is shipped, and what is not

The product runs **locally**, from a deterministic seed, with development-only demo identities:
there is no production authentication and nothing serves the built frontend against a configurable
API origin, so it cannot yet be handed over as a URL. Every provider is a deterministic fake. Of the
nine competition features, four are shipped — one of those with a named hole, one with no test on its
rows — three are partial, and two are missing. The per-feature verdict with a deciding file for each
is the [traceability table](docs/product/competition-traceability.md); the per-journey verdict, the
tests behind it, and exactly which commands were run to measure it are the
[quality scorecard](docs/quality/scorecard.md); everything deferred is in
[known gaps](docs/quality/known-gaps.md) and the
[technical debt register](docs/exec-plans/tech-debt.md). No hosted CI run exists for any commit on
this branch, so every result quoted anywhere in this repository is local.

## Run it

Follow the [competition demo runbook](docs/demo-runbook.md) for the deterministic evaluator path and its documented acceptance boundary.

```bash
npm ci
uv sync --locked
npm run setup:local
npm run context -- map
npm run reset
npm run dev
```

Run `npm run check` before opening a pull request; it runs the same three gates CI's `integrity`, `test-build`, and `d1` jobs run, including the production builds. It deliberately does **not** run the `browser` and `security` gates — [AGENTS.md](AGENTS.md#the-handoff-gate-is-not-the-whole-merge-gate) says why, and `npm run gate:browser` / `npm run gate:security` run them by hand. Product behavior and the implementation roadmap live under `docs/`; this README is only an entrypoint.
