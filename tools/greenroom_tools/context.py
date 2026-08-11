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


def cross_domain_import_permitted(
    source_path: str, target_path: str, manifest: dict[str, Any]
) -> bool:
    source_domain = domain_for(source_path, manifest)
    target_domain = domain_for(target_path, manifest)
    if source_domain is None or target_domain is None or source_domain["id"] == target_domain["id"]:
        return True
    return (
        target_path in manifest["architecture"]["publicApplicationEntryPoints"]
        or source_path in manifest["architecture"]["compositionRoots"]
    )


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
    if relative_path in manifest["architecture"]["compositionRoots"]:
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
                f"'{target_domain['id']}': {relative_path} -> {target_relative}"
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

    schema_tables: dict[str, set[str]] = {}
    for schema_path in all_files((".ts",)):
        if schema_path.name != "schema.ts":
            continue
        schema_text = schema_path.read_text(encoding="utf-8")
        for table, body in re.findall(
            r'sqliteTable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*\{(.*?)\}\s*(?:,.*?)?\);',
            schema_text,
            re.DOTALL,
        ):
            schema_tables[table] = set(
                re.findall(r'(?:text|integer|real)\("([A-Za-z_][A-Za-z0-9_]*)"\)', body)
            )
    migration_paths = sorted(path for path in all_files((".sql",)) if "migrations" in path.parts)
    migration_tables = migration_schema(migration_paths)
    if schema_tables != migration_tables:
        problems.append("Drizzle/migration table or column drift; regenerate and review migrations")
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
    destination = ROOT / "docs/generated/context-index.md"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(generated_index(load_manifest()), encoding="utf-8")
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
