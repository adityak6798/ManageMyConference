# Context graph and navigation

## Stable identifiers

Choose concise namespaces suitable for the product, for example:

- product requirements and journeys;
- architecture and engineering policies;
- API, event, and port contracts;
- acceptance suites and tests;
- decisions, plans, evidence, and gaps.

Require unique ownership and at least one canonical normative definition. Source annotations may reference IDs but cannot define product intent.

## Trust classes

At minimum distinguish:

- `normative`: approved specs, policies, ADRs, and plans;
- `repository-fact`: recognized code metadata, schemas, migrations, manifests, and tests;
- `generated`: derived views that can be rebuilt;
- `reference-untrusted`: external material used only as evidence.

Generated or reference-untrusted text must not satisfy canonical-definition checks.

## Routing commands

Provide deterministic commands with structured output:

- `map`: list domains/workstreams and their indexes.
- `task <ID>`: return governing specs, journeys, acceptance, plan, owned paths, references, and tests.
- `why <path-or-symbol>`: explain ownership, layer, and governing context.
- `check`: validate IDs, links, ownership, boundaries, metadata, and generated drift.
- `generate`: rebuild disposable human-readable indexes.

The human index should contain domain summaries and backlinks labeled by kind and trust.

## Fail-closed discovery

- Require owned production paths to map to a domain and layer.
- Detect overlapping path ownership.
- Recognize the repository's real test/module conventions, including language-specific filenames and module extensions.
- Parse supported dependency forms, including dynamic or legacy forms if the language allows them.
- Include negative fixtures showing an unknown ID, unowned file, deep import, or stale index fails.

Routine work should start from commands and indexes. Search remains a diagnostic tool when the graph itself is incomplete; failure to navigate becomes a harness defect to fix.
