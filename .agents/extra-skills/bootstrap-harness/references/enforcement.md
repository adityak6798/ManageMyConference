# Architecture and policy enforcement

## Boundaries

Model the target architecture explicitly rather than inferring it from folder spelling:

- business domains and their owned paths/data;
- layers and allowed dependency directions;
- public application entrypoints;
- composition roots;
- allowed external packages by layer;
- storage/table ownership;
- narrowly documented exemptions.

Every owned production file must match exactly one layer unless it is an explicit composition root or justified exemption. Apply cross-domain rules to UI, shared contracts, scripts, and alternate module forms where relevant.

Prefer `domain <- application <- adapters/transport/UI` as the dependency shape: domain is framework-free; application coordinates ports; adapters implement them; external transports translate input/output. Restrict “shared” to true primitives.

## Interfaces and storage

- Keep provider SDK types outside domain/application contracts.
- Generate public API documentation from runtime-validating schemas.
- Enforce generated-artifact drift.
- Assign one owner per table or storage aggregate.
- Preserve ordered, immutable migrations and validate their resulting schema by replay, not regex alone.
- Cross-domain reads use public queries/commands or declared events, never direct tables.

## Loud errors

Expected failures use stable codes, safe messages, optional field errors, and visible UI states. Unexpected failures are logged once with safe allowlisted context and correlation, then converted to a standard envelope.

Forbid empty catches, ignored rejections, undocumented fallbacks, bare console output, and silent discarded results. An intentional discard requires an adjacent reason marker. Use an AST/parser-aware checker and negative fixtures; avoid raw scans that mistake fixture strings or comments for code.

## Enforcement budget

Enforce only claims the repository depends on. A small, well-tested rule is better than a large heuristic scanner. Whenever possible use the language parser, compiler, schema generator, migration engine, or package manager rather than reconstructing semantics with regex.
