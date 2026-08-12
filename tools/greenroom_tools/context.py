"""Context discovery and repository-integrity checks.

@spec ENG-CI-001
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "context-manifest.json"
CONTEXT_DIR = ROOT / "context"
ARCHITECTURE_FRAGMENT = CONTEXT_DIR / "architecture.json"
DOMAIN_FRAGMENTS = CONTEXT_DIR / "domains"
DOMAIN_FIELDS = ("id", "index", "specs", "journeys", "acceptance", "plans", "paths")
SPEC_PATTERN = re.compile(
    r"\b(?:PRD|ARC|ENG|JNY|ACC|ADR|API|EVT|PORT|TST|PLAN|EVD|GAP)"
    r"(?:-[A-Z0-9]+)+\b"
)
METADATA_PATTERN = re.compile(r"@(spec|acceptance|plan)\s+(.+)")
LAYER_ORDER = {
    "domain": 0,
    "application": 1,
    "adapters": 2,
    "transport": 3,
    "ui": 4,
    "contracts": 5,
}


def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def domain_fragments() -> list[dict[str, Any]]:
    """Every domain's own context declaration, in the order they declare."""
    fragments = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(DOMAIN_FRAGMENTS.glob("*.json"))
    ]
    return sorted(fragments, key=lambda fragment: (fragment.get("order", 0), fragment["id"]))


def compose_manifest() -> tuple[dict[str, Any], list[str]]:
    """
    Build the aggregate manifest from `context/`.

    A domain declares its own specs, paths and symbols in `context/domains/<id>.json`; nothing
    about adding one requires editing a file another domain also edits. `context-manifest.json`
    is the generated join of those fragments, kept at its old path and shape so every reader of
    it is unaffected.
    """
    architecture = json.loads(ARCHITECTURE_FRAGMENT.read_text(encoding="utf-8"))
    problems: list[str] = []
    domains: list[dict[str, Any]] = []
    symbols: dict[str, str] = {}
    symbol_owner: dict[str, str] = {}
    seen_ids: dict[str, str] = {}
    for fragment in domain_fragments():
        identifier = fragment["id"]
        missing = [field for field in DOMAIN_FIELDS if field not in fragment]
        if missing:
            problems.append(
                f"context/domains/{identifier}.json is missing required "
                f"field(s): {', '.join(missing)}"
            )
            continue
        if identifier in seen_ids:
            problems.append(f"Two context fragments declare the domain '{identifier}'")
        seen_ids[identifier] = identifier
        domains.append({field: fragment[field] for field in DOMAIN_FIELDS})
        for symbol, path in (fragment.get("symbols") or {}).items():
            owner = symbol_owner.get(symbol)
            if owner is not None and owner != identifier:
                problems.append(
                    f"Symbol '{symbol}' is registered by both '{owner}' and '{identifier}'"
                )
                continue
            symbol_owner[symbol] = identifier
            symbols[symbol] = path
    manifest = {
        "schemaVersion": architecture["schemaVersion"],
        "trustClasses": architecture["trustClasses"],
        "architecture": architecture["architecture"],
        "domains": domains,
        "symbols": dict(sorted(symbols.items())),
    }
    return manifest, problems


def rendered_manifest(manifest: dict[str, Any]) -> str:
    return f"{json.dumps(manifest, indent=2)}\n"


def all_files(suffixes: tuple[str, ...]) -> list[Path]:
    ignored = {
        ".git",
        ".venv",
        ".wrangler",
        "coverage",
        "dist",
        "node_modules",
        "playwright-report",
        "test-results",
    }
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix in suffixes
        and not any(part in ignored for part in path.parts)
    ]


def spec_locations() -> dict[str, list[str]]:
    return {
        identifier: [record["path"] for record in records]
        for identifier, records in context_locations().items()
    }


def context_locations() -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {}
    for path in all_files((".md", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py")):
        relative = str(path.relative_to(ROOT))
        content = path.read_text(encoding="utf-8")
        if path.suffix == ".md":
            if relative.startswith("docs/generated/"):
                continue
            trust = (
                "reference-untrusted" if relative.startswith("docs/references/") else "normative"
            )
            kind = "reference" if trust == "reference-untrusted" else "specification"
            searchable = content
        else:
            trust = "repository-fact"
            kind = (
                "test"
                if re.search(r"\.(?:test|spec)\.", relative)
                or (path.suffix == ".py" and path.name.startswith("test_"))
                else "code"
            )
            searchable = "\n".join(match.group(2) for match in METADATA_PATTERN.finditer(content))
        for identifier in set(SPEC_PATTERN.findall(searchable)):
            result.setdefault(identifier, []).append(
                {"path": relative, "trust": trust, "kind": kind}
            )
    return result


def path_owns(declared: str, query: str) -> bool:
    target = ROOT / declared
    if target.is_file() or Path(declared).suffix:
        return query == declared
    return query == declared or query.startswith(f"{declared}/")


def allowlist(manifest: dict[str, Any], name: str) -> dict[str, dict[str, Any]]:
    """
    An architecture allowlist, keyed by path.

    Entries are objects carrying a `reason` and the `governing` spec or ADR that authorises
    them. They used to be bare strings, which made the cheapest way to silence a genuine
    violation — appending one path — indistinguishable in the diff from declaring a legitimate
    shared interface. Both happened one line apart in the same change (`#88`).
    """
    return {entry["path"]: entry for entry in manifest["architecture"][name] if "path" in entry}


def allowlist_problems(manifest: dict[str, Any], known_ids: set[str] | None = None) -> list[str]:
    """
    Every allowlist entry has to say what it is for, and under whose authority.

    The `governing` id is resolved against the normative documents, not merely shape-checked: a
    plausible-looking `ARC-DOES-NOT-EXIST` would otherwise pass and leave the exemption citing
    an authority nobody wrote.
    """
    problems: list[str] = []
    if known_ids is None:
        known_ids = {
            identifier
            for identifier, records in context_locations().items()
            if any(record["trust"] == "normative" for record in records)
        }
    for name in ("publicApplicationEntryPoints", "compositionRoots"):
        seen: set[str] = set()
        for index, entry in enumerate(manifest["architecture"][name]):
            where = f"architecture.{name}[{index}]"
            if not isinstance(entry, dict) or "path" not in entry:
                problems.append(
                    f"{where} is not an entry object. Each one is "
                    '{"path": …, "reason": …, "governing": …}; a bare path records no decision.'
                )
                continue
            path = entry["path"]
            if path in seen:
                problems.append(f"{where} repeats '{path}'")
            seen.add(path)
            if not (ROOT / path).exists():
                problems.append(f"{where} names a path that does not exist: {path}")
            reason = str(entry.get("reason", "")).strip()
            if len(reason) < 20:
                problems.append(
                    f"{where} ('{path}') needs a `reason` saying what the exemption is for. "
                    "A placeholder such as 'shared' or 'legacy' is not one."
                )
            governing = str(entry.get("governing", "")).strip()
            if not SPEC_PATTERN.fullmatch(governing):
                problems.append(
                    f"{where} ('{path}') needs a `governing` spec or ADR id, such as "
                    "'ARC-DOM-001'; received {governing!r}".replace(
                        "{governing!r}", repr(governing)
                    )
                )
            elif governing not in known_ids:
                problems.append(
                    f"{where} ('{path}') cites governing id '{governing}', which no normative "
                    "document defines. An exemption cannot rest on an authority nobody wrote."
                )
    return problems


def cross_domain_import_permitted(
    source_path: str, target_path: str, manifest: dict[str, Any]
) -> bool:
    source_domain = domain_for(source_path, manifest)
    target_domain = domain_for(target_path, manifest)
    if source_domain is None or target_domain is None or source_domain["id"] == target_domain["id"]:
        return True
    return target_path in allowlist(
        manifest, "publicApplicationEntryPoints"
    ) or source_path in allowlist(manifest, "compositionRoots")


def domain_for(query: str, manifest: dict[str, Any]) -> dict[str, Any] | None:
    query = query.removeprefix(str(ROOT) + "/")
    symbol_path = manifest.get("symbols", {}).get(query)
    if symbol_path:
        query = symbol_path
    matches: list[tuple[int, dict[str, Any]]] = []
    for domain in manifest["domains"]:
        identifiers = domain["specs"] + domain["journeys"] + domain["acceptance"] + domain["plans"]
        if query == domain["id"] or query in identifiers:
            return domain
        matches.extend((len(path), domain) for path in domain["paths"] if path_owns(path, query))
    return max(matches, key=lambda item: item[0])[1] if matches else None


def layer_for(query: str, manifest: dict[str, Any]) -> str | None:
    query = query.removeprefix(str(ROOT) + "/")
    matches = [
        (len(prefix), layer)
        for layer, prefixes in manifest["architecture"]["layerPaths"].items()
        for prefix in prefixes
        if path_owns(prefix, query)
    ]
    return max(matches)[1] if matches else None


def production_layer_problems(relative_path: str, manifest: dict[str, Any]) -> list[str]:
    if not (relative_path.startswith(("apps/", "packages/")) and "/src/" in f"/{relative_path}"):
        return []
    # The third reader of this allowlist. A composition root belongs to no single layer by
    # design, so it is exempt from the one-layer rule as well as from the import rule.
    if relative_path in allowlist(manifest, "compositionRoots"):
        return []
    matches = [
        layer
        for layer, prefixes in manifest["architecture"]["layerPaths"].items()
        for prefix in prefixes
        if path_owns(prefix, relative_path)
    ]
    if not matches:
        return [f"Owned production source has no architecture layer: {relative_path}"]
    if len(matches) > 1:
        return [
            f"Owned production source maps to multiple architecture layers "
            f"({', '.join(sorted(matches))}): {relative_path}"
        ]
    return []


def module_specifiers(content: str) -> set[str]:
    """Extract supported static, dynamic, and CommonJS literal dependencies."""
    return set(
        re.findall(r'(?:from\s+|import\s*)["\']([^"\']+)["\']', content)
        + re.findall(r'\bimport\s*\(\s*["\']([^"\']+)["\']\s*\)', content)
        + re.findall(r'\brequire\s*\(\s*["\']([^"\']+)["\']\s*\)', content)
    )


def architecture_import_problems(
    relative_path: str, content: str, manifest: dict[str, Any]
) -> list[str]:
    problems: list[str] = []
    current_layer = layer_for(relative_path, manifest)
    if current_layer is None:
        return problems
    path = ROOT / relative_path
    owning_domain = domain_for(relative_path, manifest)
    for imported in module_specifiers(content):
        if not imported.startswith("."):
            allowed = manifest["architecture"]["externalPackagesByLayer"][current_layer]
            if imported not in allowed:
                problems.append(
                    f"Layer '{current_layer}' imports disallowed package "
                    f"'{imported}' in {relative_path}"
                )
            continue
        resolved = (path.parent / imported).resolve()
        if not resolved.exists():
            for suffix in (".ts", ".tsx", "/index.ts", "/index.tsx"):
                candidate = Path(f"{resolved}{suffix}")
                if candidate.exists():
                    resolved = candidate
                    break
        try:
            target_relative = str(resolved.relative_to(ROOT))
        except ValueError:
            continue
        imported_layer = layer_for(target_relative, manifest)
        allowed_layers = manifest["architecture"]["allowedImportLayers"][current_layer]
        if imported_layer and imported_layer not in allowed_layers:
            problems.append(f"Architecture direction violation in {relative_path}: {imported}")
        target_domain = domain_for(target_relative, manifest)
        if target_relative and not cross_domain_import_permitted(
            relative_path, target_relative, manifest
        ):
            problems.append(
                f"Cross-domain deep import from '{owning_domain['id']}' to "
                f"'{target_domain['id']}': {relative_path} -> {target_relative}\n"
                f"    Either reach {target_domain['id']} through its public application "
                "interface, or — if this genuinely is a shared interface — add it to "
                "architecture.publicApplicationEntryPoints in context/architecture.json with a "
                'specific `reason` and a `governing` id: {"path": …, "governing": "ARC-DOM-001", '
                '"reason": "why this is a shared interface rather than a silenced violation"}. '
                "See docs/architecture/domain-boundaries.md."
            )
    return problems


def migration_schema(paths: list[Path]) -> dict[str, set[str]]:
    """Replay ordered migrations and return the resulting SQLite table shape."""
    tables: dict[str, set[str]] = {}
    with sqlite3.connect(":memory:") as database:
        for migration_path in sorted(paths):
            database.executescript(migration_path.read_text(encoding="utf-8"))
        table_names = database.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for (table,) in table_names:
            tables[table] = {
                row[1] for row in database.execute(f'PRAGMA table_info("{table}")').fetchall()
            }
    return tables


def drizzle_schema(paths: list[Path]) -> dict[str, set[str]]:
    """Read every domain Drizzle fragment; an empty registry is never a valid schema."""
    tables: dict[str, set[str]] = {}
    for schema_path in paths:
        schema_text = schema_path.read_text(encoding="utf-8")
        for table, body in re.findall(
            r'sqliteTable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*\{(.*?)\}\s*(?:,.*?)?\);',
            schema_text,
            re.DOTALL,
        ):
            tables[table] = set(
                re.findall(r'(?:text|integer|real)\("([A-Za-z_][A-Za-z0-9_]*)"', body)
            )
    return tables


def schema_drift_problems(schema_paths: list[Path], migration_paths: list[Path]) -> list[str]:
    """Compare declared and migrated table shapes, refusing empty declaration discovery."""
    problems: list[str] = []
    schema_tables = drizzle_schema(schema_paths)
    if not schema_tables:
        problems.append("No Drizzle tables discovered in domain schema fragments")
    migration_tables = migration_schema(migration_paths)
    if schema_tables != migration_tables:
        problems.append("Drizzle/migration table or column drift; regenerate and review migrations")
    return problems


SCORECARD = "docs/quality/scorecard.md"
ACTIVE_PLANS = "docs/exec-plans/active.md"
COMPLETED_PLANS = "docs/exec-plans/completed.md"
# `Last verified: 2026-08-11` and `**Last verified:** 2026-08-11` are both in use; the date is
# what has to be machine-readable, not the emphasis around the label.
LAST_VERIFIED_PATTERN = re.compile(r"Last verified:?\*{0,2}\s*(\d{4}-\d{2}-\d{2})")
PLAN_HEADING_PATTERN = re.compile(r"^## `(PLAN-[A-Z0-9-]+)`", re.MULTILINE)
PLAN_STATUS_PATTERN = re.compile(r"^Status: (active|completed)\b", re.MULTILINE)
SCORECARD_ROW_PATTERN = re.compile(r"^\| `(ACC-[A-Z0-9-]+)` \| ([^|]*)\| ([^|]*)\|", re.MULTILINE)
VERDICTS = {"shipped", "partial"}
# Phrases that assert a thing does not exist yet. Deliberately a short, closed list: the point
# is to catch a claim contradicting declared state, not to parse English.
STALE_CLAIM_PATTERN = re.compile(
    r"is planned\b|are planned\b|not configured yet|not implemented yet|"
    r"does not exist yet|do not exist yet|is not yet configured",
    re.IGNORECASE,
)


def canonical_markdown() -> list[Path]:
    """
    Normative documents only.

    `docs/generated/` is a projection of this metadata and `docs/references/` is untrusted
    external evidence; neither is a place where the repository states what is true, so neither
    is held to these rules.
    """
    return [
        path
        for path in all_files((".md",))
        if not str(path.relative_to(ROOT)).startswith(("docs/generated/", "docs/references/"))
    ]


def documentation_semantics_problems(manifest: dict[str, Any]) -> list[str]:
    """
    Contradictions canonical documents can hold while every link in them still resolves.

    Link and ownership checks prove a document is *well-formed*. These prove selected claims in
    it are not *contradicted* — by another document, or by declared machine-readable state.
    Nothing here guesses meaning from prose: every rule reads either a table this repository
    writes in a fixed shape, or a declared field.
    """
    problems: list[str] = []

    # 1. Acceptance rows: one row per ID, a known ID, and a verdict from the closed set.
    scorecard = (ROOT / SCORECARD).read_text(encoding="utf-8")
    declared = {identifier for domain in manifest["domains"] for identifier in domain["acceptance"]}
    seen: dict[str, str] = {}
    for identifier, _journey, verdict in SCORECARD_ROW_PATTERN.findall(scorecard):
        verdict = verdict.strip()
        if identifier in seen:
            problems.append(
                f"{SCORECARD}: acceptance ID '{identifier}' has more than one row. One row "
                "states one verdict; two rows can state two, and the reader cannot tell which "
                "is current."
            )
        seen[identifier] = verdict
        if identifier not in declared:
            problems.append(
                f"{SCORECARD}: row '{identifier}' is not an acceptance ID any domain declares "
                "in context/domains/*.json."
            )
        if verdict not in VERDICTS:
            problems.append(
                f"{SCORECARD}: row '{identifier}' has verdict '{verdict}'. Use one of "
                f"{', '.join(sorted(VERDICTS))}, so the state reads without interpreting prose."
            )
    for identifier in sorted(declared - set(seen)):
        problems.append(
            f"{SCORECARD}: acceptance ID '{identifier}' is declared by a domain but has no row. "
            "An acceptance with no stated verdict reads as passing."
        )

    # 2. Plan placement: a plan is active or completed, in the matching file, and in one file.
    placement: dict[str, list[str]] = {}
    for relative, expected in ((ACTIVE_PLANS, "active"), (COMPLETED_PLANS, "completed")):
        text = (ROOT / relative).read_text(encoding="utf-8")
        sections = re.split(PLAN_HEADING_PATTERN, text)
        for index in range(1, len(sections), 2):
            identifier = sections[index]
            status = PLAN_STATUS_PATTERN.search(sections[index + 1])
            placement.setdefault(identifier, []).append(relative)
            if status is None:
                problems.append(
                    f"{relative}: plan '{identifier}' has no `Status: active` or "
                    "`Status: completed` line, so its lifecycle state cannot be read."
                )
            elif status.group(1) != expected:
                problems.append(
                    f"{relative}: plan '{identifier}' says `Status: {status.group(1)}` but sits "
                    f"in the {expected} plans document. Move it, or correct the status."
                )
    for identifier, files in sorted(placement.items()):
        if len(files) > 1:
            problems.append(
                f"Plan '{identifier}' appears in both {' and '.join(files)}; it has one "
                "lifecycle state, so it belongs in one of them."
            )
    known_plans = {identifier for domain in manifest["domains"] for identifier in domain["plans"]}
    for identifier in sorted(set(placement) - known_plans):
        problems.append(
            f"Plan '{identifier}' is documented but declared by no domain in "
            "context/domains/*.json."
        )

    # 3. `Last verified` is a real date in a fixed format, on every canonical document.
    for path in canonical_markdown():
        relative = str(path.relative_to(ROOT))
        text = path.read_text(encoding="utf-8")
        if "Last verified" not in text:
            continue
        if not LAST_VERIFIED_PATTERN.search(text):
            problems.append(
                f"{relative}: `Last verified` must be an ISO date, as `Last verified: "
                "YYYY-MM-DD`. Freshness is not enforced as an age — a document does not rot on "
                "a timer — but the date has to be machine-readable to be checkable at all."
            )

    # 4. A claim that a declared-configured resource does not exist yet.
    for resource in manifest["architecture"].get("resources", []):
        if resource.get("state") != "configured":
            continue
        for path in canonical_markdown():
            relative = str(path.relative_to(ROOT))
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                if not STALE_CLAIM_PATTERN.search(line):
                    continue
                if not any(
                    re.search(rf"\b{re.escape(name)}\b", line) for name in resource["names"]
                ):
                    continue
                problems.append(
                    f"{relative}:{number}: says '{resource['id']}' is not there yet, but "
                    f"context/architecture.json declares it configured — see "
                    f"{resource['evidence']}. Correct the sentence, or change the declared "
                    "state if it really was removed."
                )
    return problems


ROUTE_TABLE_PATTERN = re.compile(r"const routes = \[(.*?)\] as const;", re.DOTALL)
ROUTE_ENTRY_PATTERN = re.compile(r'"([A-Z]+ /[^"]*)"')
WORKSPACE_PATH_PATTERN = re.compile(r'^\s*path: "(/[^"]*)",', re.MULTILINE)
MODULE_DOMAIN_PATTERN = re.compile(r'^\s*domain: "([^"]+)",', re.MULTILINE)


def duplicate_registration_problems(root: Path | None = None) -> list[str]:
    """
    Two domains claiming one HTTP route or one workspace route.

    Both registries refuse this at runtime, but a duplicate is a merge accident and the point
    of catching it here is that `npm run check` names both domains before anybody starts a
    server. The declared tables are read rather than the handlers, which is exactly why the
    tables are declared.
    """
    base = root or ROOT
    problems: list[str] = []
    for label, directory, extract in (
        (
            "HTTP route",
            base / "apps/api/src/transport/http/routes",
            lambda text: ROUTE_ENTRY_PATTERN.findall(
                "".join(ROUTE_TABLE_PATTERN.findall(text)),
            ),
        ),
        (
            "workspace",
            base / "apps/web/src/workspaces",
            lambda text: WORKSPACE_PATH_PATTERN.findall(text),
        ),
    ):
        if not directory.is_dir():
            continue
        owners: dict[str, str] = {}
        for module in sorted(directory.iterdir()):
            if module.name in {"contract.ts", "registry.ts", "registry.tsx"}:
                continue
            text = module.read_text(encoding="utf-8")
            relative = module.relative_to(base)
            declared = MODULE_DOMAIN_PATTERN.search(text)
            if not declared:
                problems.append(f"{relative} declares no owning domain")
                continue
            for route in extract(text):
                owner = owners.get(route)
                if owner is not None and owner != declared.group(1):
                    problems.append(
                        f"Duplicate {label} registration '{route}': claimed by both "
                        f"'{owner}' and '{declared.group(1)}'"
                    )
                    continue
                owners[route] = declared.group(1)
    return problems


def generated_index(manifest: dict[str, Any]) -> str:
    locations = context_locations()
    lines = [
        "<!-- GENERATED: do not edit; run `npm run context -- generate`. -->",
        "# Generated context index",
        "",
        "| Domain | Specs | Journeys | Acceptance | Plans | Index |",
        "|---|---|---|---|---|---|",
    ]
    for domain in manifest["domains"]:
        values = {
            key: ", ".join(f"`{item}`" for item in domain[key]) or "—"
            for key in ("specs", "journeys", "acceptance", "plans")
        }
        index = domain["index"]
        target = f"../{index.removeprefix('docs/')}"
        lines.append(
            f"| {domain['id']} | {values['specs']} | {values['journeys']} | "
            f"{values['acceptance']} | {values['plans']} | [{index}]({target}) |"
        )
    lines.extend(["", "## Identifier backlinks", ""])
    identifiers = sorted(
        {
            identifier
            for domain in manifest["domains"]
            for key in ("specs", "journeys", "acceptance", "plans")
            for identifier in domain[key]
        }
    )
    for identifier in identifiers:
        lines.append(f"### `{identifier}`")
        for record in sorted(locations.get(identifier, []), key=lambda item: item["path"]):
            lines.append(
                f"- `{record['kind']}` / `{record['trust']}`: [{record['path']}]"
                f"(../../{record['path']})"
            )
        lines.append("")
    lines.extend(["Trust: normative metadata plus declared repository facts.", ""])
    return "\n".join(lines)


def render(value: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, indent=2, sort_keys=True))
        return
    if isinstance(value, list):
        for item in value:
            print(f"- {item}")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            shown = ", ".join(item) if isinstance(item, list) else item
            print(f"{key}: {shown}")
        return
    print(value)


def check_repository() -> list[str]:
    manifest = load_manifest()
    problems: list[str] = []
    composed, composition_problems = compose_manifest()
    problems.extend(composition_problems)
    if rendered_manifest(composed) != MANIFEST.read_text(encoding="utf-8"):
        problems.append(
            "context-manifest.json does not match the fragments in context/; "
            "run `npm run context -- generate`"
        )
    problems.extend(allowlist_problems(manifest))
    problems.extend(documentation_semantics_problems(manifest))
    problems.extend(duplicate_registration_problems())
    locations = context_locations()
    unique_owners: dict[str, str] = {}
    for domain in manifest["domains"]:
        index = ROOT / domain["index"]
        if not index.exists():
            problems.append(f"Missing domain index: {domain['index']}")
        identifiers = domain["specs"] + domain["journeys"] + domain["acceptance"] + domain["plans"]
        for identifier in identifiers:
            if not any(record["trust"] == "normative" for record in locations.get(identifier, [])):
                problems.append(f"Context ID lacks canonical normative definition: {identifier}")
        for identifier in domain["specs"] + domain["journeys"] + domain["acceptance"]:
            prior_owner = unique_owners.setdefault(identifier, domain["id"])
            if prior_owner != domain["id"]:
                owners = f"'{prior_owner}' and '{domain['id']}'"
                problems.append(f"Context ID '{identifier}' is owned by both {owners}")
        for owned_path in domain["paths"]:
            if not (ROOT / owned_path).exists():
                problems.append(f"Declared context path does not exist: {owned_path}")

    all_owned_paths = [
        (path, domain["id"]) for domain in manifest["domains"] for path in domain["paths"]
    ]
    for index, (left, left_domain) in enumerate(all_owned_paths):
        for right, right_domain in all_owned_paths[index + 1 :]:
            if left_domain != right_domain and (path_owns(left, right) or path_owns(right, left)):
                first = f"{left_domain}:{left}"
                second = f"{right_domain}:{right}"
                problems.append(f"Overlapping context ownership: {first} and {second}")

    generated_path = ROOT / "docs/generated/context-index.md"
    expected_index = generated_index(manifest)
    if not generated_path.exists() or generated_path.read_text(encoding="utf-8") != expected_index:
        problems.append("Generated context index drift; run `npm run context -- generate`")

    markdown_files = all_files((".md",))
    link_pattern = re.compile(r"\[[^]]+\]\((?!https?://|#|mailto:)([^)#]+)(?:#[^)]+)?\)")
    for path in markdown_files:
        for target in link_pattern.findall(path.read_text(encoding="utf-8")):
            if not (path.parent / target).resolve().exists():
                problems.append(f"Broken link in {path.relative_to(ROOT)}: {target}")

    source_files = all_files((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"))
    valid_acceptance = {
        identifier for domain in manifest["domains"] for identifier in domain["acceptance"]
    }
    for path in source_files:
        relative_path = str(path.relative_to(ROOT))
        owning_domain = domain_for(relative_path, manifest)
        if relative_path.startswith(("apps/", "packages/")) and owning_domain is None:
            problems.append(f"Source file has no declared domain owner: {relative_path}")
        if owning_domain is not None:
            problems.extend(production_layer_problems(relative_path, manifest))
        lines = path.read_text(encoding="utf-8").splitlines()
        if re.search(r"\.(?:test|spec)\.", relative_path):
            declared_acceptance = {
                identifier
                for match in METADATA_PATTERN.finditer("\n".join(lines))
                if match.group(1) == "acceptance"
                for identifier in SPEC_PATTERN.findall(match.group(2))
            }
            if not declared_acceptance:
                problems.append(f"Test lacks @acceptance metadata: {relative_path}")
            for identifier in declared_acceptance - valid_acceptance:
                problems.append(
                    f"Test declares unknown acceptance ID '{identifier}': {relative_path}"
                )
        problems.extend(architecture_import_problems(relative_path, "\n".join(lines), manifest))

        if owning_domain:
            content = "\n".join(lines)
            referenced_tables = re.findall(
                r"\b(?:FROM|INTO|JOIN|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)",
                content,
                flags=re.IGNORECASE,
            )
            ownership_data = json.loads(
                (ROOT / "table-ownership.json").read_text(encoding="utf-8")
            )["tables"]
            for table in referenced_tables:
                owner = ownership_data.get(table)
                if owner and owner != owning_domain["id"]:
                    problems.append(
                        f"Domain '{owning_domain['id']}' reads table '{table}' owned by '{owner}'"
                    )

    ownership = json.loads((ROOT / "table-ownership.json").read_text(encoding="utf-8"))
    declared_tables = ownership["tables"]
    domain_ids = {domain["id"] for domain in manifest["domains"]}
    for table, owner in declared_tables.items():
        if owner not in domain_ids:
            problems.append(f"Table '{table}' has unknown owning domain '{owner}'")
    for migration in all_files((".sql",)):
        for table in re.findall(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)",
            migration.read_text(encoding="utf-8"),
            flags=re.IGNORECASE,
        ):
            if table not in declared_tables and not table.startswith("d1_"):
                problems.append(
                    f"Table '{table}' in {migration.relative_to(ROOT)} has no declared owner"
                )

    schema_directory = ROOT / "apps/api/src/adapters/persistence/schema"
    schema_paths = sorted(schema_directory.glob("*.ts"))
    migration_paths = sorted(path for path in all_files((".sql",)) if "migrations" in path.parts)
    problems.extend(schema_drift_problems(schema_paths, migration_paths))
    return problems


def command_map(as_json: bool) -> None:
    manifest = load_manifest()
    render(
        [
            {
                "domain": domain["id"],
                "specs": domain["specs"],
                "index": domain["index"],
                "trust": "normative",
            }
            for domain in manifest["domains"]
        ],
        as_json,
    )


def command_task(query: str, as_json: bool) -> None:
    manifest = load_manifest()
    matching = [
        domain
        for domain in manifest["domains"]
        if query in domain["specs"] + domain["journeys"] + domain["acceptance"] + domain["plans"]
    ]
    domain = domain_for(query, manifest)
    if domain is None:
        raise ValueError(f"Unknown workstream/spec '{query}'. Run `npm run context -- map`.")
    selected = matching or [domain]
    locations = context_locations()
    identifiers = list(
        dict.fromkeys(
            identifier
            for item in selected
            for key in ("specs", "journeys", "acceptance", "plans")
            for identifier in item[key]
        )
    )
    selected_paths = [value for item in selected for value in item["paths"]]
    related_tests = sorted(
        {
            record["path"]
            for records in locations.values()
            for record in records
            if record["kind"] == "test"
            and any(path_owns(path, record["path"]) for path in selected_paths)
        }
    )
    result = {
        "domain": domain["id"] if len(selected) == 1 else "cross-domain-workstream",
        "relatedDomains": [item["id"] for item in selected],
        "index": list(dict.fromkeys(item["index"] for item in selected)),
        "specs": list(dict.fromkeys(value for item in selected for value in item["specs"])),
        "journeys": list(dict.fromkeys(value for item in selected for value in item["journeys"])),
        "acceptance": list(
            dict.fromkeys(value for item in selected for value in item["acceptance"])
        ),
        "plans": list(dict.fromkeys(value for item in selected for value in item["plans"])),
        "paths": list(dict.fromkeys(value for item in selected for value in item["paths"])),
        "references": {identifier: locations.get(identifier, []) for identifier in identifiers},
        "tests": related_tests,
        "activePlan": "docs/exec-plans/active.md",
    }
    render(result, as_json)


def command_why(query: str, as_json: bool) -> None:
    manifest = load_manifest()
    domain = domain_for(query, manifest)
    if domain is None:
        raise ValueError(
            f"No declared owner for '{query}'. Inspect context-manifest.json and docs/README.md."
        )
    command_task(domain["id"], as_json)


def command_generate() -> None:
    composed, problems = compose_manifest()
    if problems:
        render(problems, False)
        raise SystemExit(1)
    MANIFEST.write_text(rendered_manifest(composed), encoding="utf-8")
    print(f"Generated {MANIFEST.relative_to(ROOT)}")
    destination = ROOT / "docs/generated/context-index.md"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(generated_index(composed), encoding="utf-8")
    print(f"Generated {destination.relative_to(ROOT)}")


def main() -> None:
    as_json = "--json" in sys.argv[1:]
    if as_json:
        sys.argv.remove("--json")
    parser = argparse.ArgumentParser(description="Navigate and validate Project Greenroom context")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("map")
    task_parser = subparsers.add_parser("task")
    task_parser.add_argument("query")
    why_parser = subparsers.add_parser("why")
    why_parser.add_argument("query")
    subparsers.add_parser("check")
    subparsers.add_parser("generate")
    args = parser.parse_args()
    try:
        if args.command == "map":
            command_map(as_json)
        elif args.command == "task":
            command_task(args.query, as_json)
        elif args.command == "why":
            command_why(args.query, as_json)
        elif args.command == "check":
            problems = check_repository()
            if problems:
                render(problems, as_json)
                raise SystemExit(1)
            render({"status": "ok", "message": "Repository context integrity passed."}, as_json)
        else:
            command_generate()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"context error: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
