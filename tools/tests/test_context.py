"""Tests for repository context routing.

@spec ENG-CI-001
@acceptance ACC-HARNESS
"""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from greenroom_tools.context import (
    ROOT,
    allowlist_problems,
    architecture_import_problems,
    canonical_markdown,
    check_repository,
    compose_manifest,
    context_locations,
    cross_domain_import_permitted,
    documentation_semantics_problems,
    domain_for,
    domain_fragments,
    duplicate_registration_problems,
    layer_for,
    load_manifest,
    migration_schema,
    module_specifiers,
    production_layer_problems,
    rendered_manifest,
    schema_drift_problems,
    spec_locations,
)


class ContextRoutingTest(unittest.TestCase):
    def assert_domain(self, query: str, expected: str) -> None:
        domain = domain_for(query, load_manifest())
        self.assertIsNotNone(domain)
        self.assertEqual(domain["id"], expected)  # type: ignore[index]

    def test_routes_spec_to_domain(self) -> None:
        self.assert_domain("PRD-EVT-001", "events")

    def test_routes_source_path_to_domain(self) -> None:
        self.assert_domain("apps/api/src/application/events/event-service.ts", "events")

    def test_routes_journey_acceptance_plan_and_symbol(self) -> None:
        self.assert_domain("JNY-001", "cfp")
        self.assert_domain("ACC-REVIEW", "review")
        self.assert_domain("PLAN-003", "publishing")
        self.assert_domain("EventService", "events")

    def test_routes_integrations_to_its_canonical_domain(self) -> None:
        self.assert_domain("JNY-009", "communications-integrations")
        self.assert_domain("ACC-INTEGRATION", "communications-integrations")

    def test_source_references_only_use_recognized_metadata(self) -> None:
        locations = spec_locations()
        self.assertNotIn("tools/tests/test_context.py", locations.get("PRD-EVT-001", []))

    def test_generated_docs_cannot_prove_context_ids(self) -> None:
        locations = context_locations()
        for records in locations.values():
            self.assertFalse(
                any(record["path"].startswith("docs/generated/") for record in records)
            )

    def test_cross_domain_imports_require_public_entrypoint(self) -> None:
        manifest = load_manifest()
        self.assertFalse(
            cross_domain_import_permitted(
                "apps/api/src/application/identity/actor.ts",
                "apps/api/src/domain/events/event.ts",
                manifest,
            )
        )
        self.assertTrue(
            cross_domain_import_permitted(
                "apps/api/src/transport/http/app.ts",
                "apps/api/src/application/events/event-service.ts",
                manifest,
            )
        )

    def test_ui_is_a_first_class_constrained_layer(self) -> None:
        manifest = load_manifest()
        self.assertEqual(layer_for("apps/web/src/App.tsx", manifest), "ui")
        self.assertTrue(
            architecture_import_problems(
                "apps/web/src/App.tsx",
                "import { D1EventRepository } from "
                '"../../api/src/adapters/persistence/d1-event-repository";',
                manifest,
            )
        )
        self.assertTrue(
            architecture_import_problems(
                "apps/web/src/App.tsx", 'import cloudflare from "hono";', manifest
            )
        )

    def test_owned_production_source_must_have_exactly_one_layer(self) -> None:
        manifest = load_manifest()
        self.assertEqual(layer_for("packages/contracts/src/index.ts", manifest), "contracts")
        unlayered = "apps/api/src/orphan/unowned-layer.ts"
        self.assertTrue(production_layer_problems(unlayered, manifest))
        self.assertTrue(
            architecture_import_problems(
                "packages/contracts/src/index.ts", 'import { Hono } from "hono";', manifest
            )
        )

    def test_string_literals_are_not_read_as_dependencies(self) -> None:
        """A domain may use the word `import` as a value without importing anything.

        The CRM's contact source and activity vocabularies both contain it. Read as a module
        specifier, `"import",` reported a package named `, ` and failed the architecture gate
        for a file with no such dependency.
        """
        content = "\n".join(
            [
                'import { z } from "zod";',
                'import type { Actor } from "../identity/actor";',
                'export const sources = z.enum(["manual", "import", "prospect"]);',
                "export const kinds = z.enum([",
                '  "note",',
                '  "import",',
                '  "merge",',
                "]);",
                'export * from "./contact";',
            ]
        )
        self.assertEqual(module_specifiers(content), {"zod", "../identity/actor", "./contact"})

    def test_multi_line_and_side_effect_imports_are_still_extracted(self) -> None:
        content = "\n".join(
            [
                "import {",
                "  envelope,",
                "  type Variables,",
                '} from "../runtime";',
                'import "./styles/crm.css";',
                'export type { CrmService } from "./crm-service";',
            ]
        )
        self.assertEqual(
            module_specifiers(content),
            {"../runtime", "./styles/crm.css", "./crm-service"},
        )

    def test_dynamic_and_commonjs_imports_cannot_bypass_boundaries(self) -> None:
        manifest = load_manifest()
        content = 'const one = import("hono"); const two = require("drizzle-orm/sqlite-core");'
        self.assertEqual(module_specifiers(content), {"hono", "drizzle-orm/sqlite-core"})
        problems = architecture_import_problems("apps/web/src/App.tsx", content, manifest)
        self.assertEqual(len(problems), 2)

    def test_migration_schema_replays_alter_table_history(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "0001.sql"
            second = root / "0002.sql"
            first.write_text("CREATE TABLE events (id TEXT PRIMARY KEY);", encoding="utf-8")
            second.write_text("ALTER TABLE events ADD COLUMN name TEXT;", encoding="utf-8")
            self.assertEqual(migration_schema([first, second]), {"events": {"id", "name"}})

    def test_an_empty_schema_fragment_set_is_not_mistaken_for_a_valid_schema(self) -> None:
        self.assertIn(
            "No Drizzle tables discovered in domain schema fragments",
            schema_drift_problems([], []),
        )

    def test_mjs_and_python_tests_are_context_backlinks(self) -> None:
        locations = context_locations()["ACC-HARNESS"]
        by_path = {record["path"]: record["kind"] for record in locations}
        self.assertEqual(by_path["tools/tests/check-errors.test.mjs"], "test")
        self.assertEqual(by_path["tools/tests/test_context.py"], "test")

    def test_repository_integrity_is_clean(self) -> None:
        self.assertEqual(check_repository(), [])


class DocumentationSemanticsTest(unittest.TestCase):
    """
    A canonical document can have every link resolve and still contradict another document, or
    the code. These fixtures prove the contradictions this repository has actually shipped.
    """

    def problems_with(self, edit) -> list[str]:
        """Run the semantic checks against a temporary copy of the repository's documents."""
        manifest = load_manifest()
        original = {}
        targets = [
            Path("docs/quality/scorecard.md"),
            Path("docs/exec-plans/active.md"),
            Path("docs/exec-plans/completed.md"),
            Path("docs/architecture/system-context.md"),
        ]
        for relative in targets:
            original[relative] = (ROOT / relative).read_text(encoding="utf-8")
        try:
            for relative, text in edit(dict(original)).items():
                (ROOT / relative).write_text(text, encoding="utf-8")
            return documentation_semantics_problems(manifest)
        finally:
            for relative, text in original.items():
                (ROOT / relative).write_text(text, encoding="utf-8")

    def test_the_repository_documents_are_consistent(self) -> None:
        self.assertEqual(documentation_semantics_problems(load_manifest()), [])

    def test_a_duplicated_acceptance_row_fails(self) -> None:
        def edit(documents):
            scorecard = Path("docs/quality/scorecard.md")
            row = next(
                line
                for line in documents[scorecard].splitlines()
                if line.startswith("| `ACC-CFP` |")
            )
            documents[scorecard] = documents[scorecard].replace(row, f"{row}\n{row}")
            return documents

        problems = self.problems_with(edit)
        self.assertTrue(any("more than one row" in problem for problem in problems), problems)

    def test_a_contradictory_verdict_fails(self) -> None:
        def edit(documents):
            scorecard = Path("docs/quality/scorecard.md")
            documents[scorecard] = documents[scorecard].replace(
                "| `ACC-CFP` | `JNY-001`, `JNY-002` | shipped |",
                "| `ACC-CFP` | `JNY-001`, `JNY-002` | planned |",
            )
            return documents

        problems = self.problems_with(edit)
        self.assertTrue(any("verdict 'planned'" in problem for problem in problems), problems)

    def test_an_acceptance_id_with_no_row_fails(self) -> None:
        def edit(documents):
            scorecard = Path("docs/quality/scorecard.md")
            documents[scorecard] = "\n".join(
                line
                for line in documents[scorecard].splitlines()
                if not line.startswith("| `ACC-AGENDA` |")
            )
            return documents

        problems = self.problems_with(edit)
        # The `ACC-AGENDA` case from #87: deleting the coverage a row rests on must surface,
        # not leave the row quietly true.
        self.assertTrue(
            any("ACC-AGENDA" in problem and "no row" in problem for problem in problems), problems
        )

    def test_a_completed_plan_left_in_the_active_document_fails(self) -> None:
        def edit(documents):
            active = Path("docs/exec-plans/active.md")
            documents[active] = documents[active].replace(
                "Status: active; single-artifact", "Status: completed; single-artifact", 1
            )
            return documents

        problems = self.problems_with(edit)
        self.assertTrue(
            any("sits in the active plans document" in problem for problem in problems), problems
        )

    def test_a_plan_in_both_documents_fails(self) -> None:
        def edit(documents):
            completed = Path("docs/exec-plans/completed.md")
            documents[completed] += "\n## `PLAN-002` Duplicated\n\nStatus: completed\n"
            return documents

        problems = self.problems_with(edit)
        self.assertTrue(any("appears in both" in problem for problem in problems), problems)

    def test_claiming_a_configured_resource_is_absent_fails(self) -> None:
        def edit(documents):
            context = Path("docs/architecture/system-context.md")
            documents[context] = documents[context].replace(
                "D1 stores canonical relational data, and R2 stores assets",
                "D1 stores canonical relational data; R2 is planned for assets and is "
                "not configured yet",
            )
            return documents

        # The exact sentence this repository shipped until 2026-08-11, while R2 was bound in
        # wrangler.toml and R2AssetStorage was wired in the Worker.
        problems = self.problems_with(edit)
        self.assertTrue(any("'r2' is not there yet" in problem for problem in problems), problems)
        self.assertTrue(any("r2-asset-storage.ts" in problem for problem in problems), problems)

    def test_generated_and_reference_documents_are_not_held_to_these_rules(self) -> None:
        scanned = {str(path.relative_to(ROOT)) for path in canonical_markdown()}
        self.assertFalse(any(path.startswith("docs/generated/") for path in scanned))
        self.assertFalse(any(path.startswith("docs/references/") for path in scanned))
        self.assertIn("docs/quality/scorecard.md", scanned)


class ArchitectureAllowlistTest(unittest.TestCase):
    """
    Widening a boundary has to look different from silencing a violation. Both happened one
    line apart in the same change once, and nothing in the tooling could tell them apart.
    """

    def manifest_with(self, name: str, entries: list[object]) -> dict:
        manifest = load_manifest()
        manifest["architecture"][name] = entries
        return manifest

    def test_an_entry_without_a_reason_fails_the_gate(self) -> None:
        for name in ("publicApplicationEntryPoints", "compositionRoots"):
            manifest = self.manifest_with(
                name, [{"path": "apps/api/src/index.ts", "governing": "ARC-001"}]
            )
            problems = allowlist_problems(manifest)
            self.assertTrue(any("needs a `reason`" in problem for problem in problems), problems)

    def test_a_placeholder_reason_is_not_a_reason(self) -> None:
        for placeholder in ("shared", "legacy", "needed", ""):
            manifest = self.manifest_with(
                "publicApplicationEntryPoints",
                [
                    {
                        "path": "apps/api/src/index.ts",
                        "governing": "ARC-001",
                        "reason": placeholder,
                    }
                ],
            )
            self.assertTrue(
                any("needs a `reason`" in problem for problem in allowlist_problems(manifest)),
                placeholder,
            )

    def test_a_bare_string_entry_fails_the_gate(self) -> None:
        manifest = self.manifest_with("compositionRoots", ["apps/api/src/index.ts"])
        problems = allowlist_problems(manifest)
        self.assertTrue(any("is not an entry object" in problem for problem in problems), problems)

    def test_an_entry_needs_a_governing_id(self) -> None:
        manifest = self.manifest_with(
            "publicApplicationEntryPoints",
            [
                {
                    "path": "apps/api/src/index.ts",
                    "reason": "A reason long enough to be a real one, describing the interface.",
                    "governing": "not-an-id",
                }
            ],
        )
        problems = allowlist_problems(manifest)
        self.assertTrue(any("`governing` spec or ADR id" in problem for problem in problems))

    def test_an_entry_naming_a_missing_path_fails_the_gate(self) -> None:
        manifest = self.manifest_with(
            "publicApplicationEntryPoints",
            [
                {
                    "path": "apps/api/src/application/ghost/public.ts",
                    "governing": "ARC-DOM-001",
                    "reason": "A reason long enough to be a real one, describing the interface.",
                }
            ],
        )
        problems = allowlist_problems(manifest)
        self.assertTrue(any("does not exist" in problem for problem in problems), problems)

    def test_every_shipped_entry_carries_a_specific_reason(self) -> None:
        self.assertEqual(allowlist_problems(load_manifest()), [])

    def test_a_blocked_import_is_told_what_the_allowlist_is_for(self) -> None:
        manifest = load_manifest()
        problems = architecture_import_problems(
            "apps/api/src/application/agenda/agenda-service.ts",
            'import { CrmService } from "../crm/crm-service";',
            manifest,
        )
        self.assertTrue(problems)
        message = "\n".join(problems)
        self.assertIn("publicApplicationEntryPoints", message)
        self.assertIn("reason", message)
        self.assertIn("governing", message)
        self.assertIn("docs/architecture/domain-boundaries.md", message)

    def test_all_three_readers_use_the_object_form(self) -> None:
        manifest = load_manifest()
        # Import direction, cross-domain reach, and the one-layer rule all read these lists;
        # a fourth reader added against bare strings is the failure this asserts against.
        self.assertTrue(
            cross_domain_import_permitted(
                "apps/api/src/transport/http/app.ts",
                "apps/api/src/application/events/event-service.ts",
                manifest,
            )
        )
        self.assertTrue(
            cross_domain_import_permitted(
                "apps/web/src/OverviewPage.tsx", "apps/web/src/api/review.ts", manifest
            )
        )
        self.assertEqual(production_layer_problems("apps/api/src/index.ts", manifest), [])


class DomainRegistrationTest(unittest.TestCase):
    """
    A domain declares its own routes, workspaces and context; nothing about adding one
    requires editing a file another domain owns. These prove the checks that keep two domains
    from silently claiming the same surface.
    """

    def write_modules(self, root: Path, kind: str, modules: dict[str, str]) -> None:
        directory = root / (
            "apps/api/src/transport/http/routes" if kind == "routes" else "apps/web/src/workspaces"
        )
        directory.mkdir(parents=True, exist_ok=True)
        for name, body in modules.items():
            (directory / name).write_text(body, encoding="utf-8")

    def route_module(self, domain: str, route: str) -> str:
        return (
            f'export const x: RouteModule = {{\n  domain: "{domain}",\n'
            f'  routes,\n}};\nconst routes = [\n  "{route}",\n] as const;\n'
        )

    def workspace_module(self, domain: str, path: str) -> str:
        return f'export const x = {{\n  domain: "{domain}",\n  path: "{path}",\n}};\n'

    def test_two_domains_cannot_claim_one_http_route(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_modules(
                root,
                "routes",
                {
                    "agenda.ts": self.route_module("agenda", "GET /api/events/:eventId/agenda"),
                    "review.ts": self.route_module("review", "GET /api/events/:eventId/agenda"),
                },
            )
            problems = duplicate_registration_problems(root)
            self.assertTrue(
                any("Duplicate HTTP route registration" in problem for problem in problems),
                problems,
            )
            self.assertTrue(any("'agenda' and 'review'" in problem for problem in problems))

    def test_two_domains_cannot_claim_one_workspace(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_modules(
                root,
                "workspaces",
                {
                    "crm.tsx": self.workspace_module("crm", "/speakers"),
                    "content.tsx": self.workspace_module("content", "/speakers"),
                },
            )
            problems = duplicate_registration_problems(root)
            self.assertTrue(
                any("Duplicate workspace registration" in problem for problem in problems),
                problems,
            )

    def test_one_domain_declaring_its_own_surfaces_is_clean(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_modules(
                root,
                "routes",
                {
                    "agenda.ts": self.route_module("agenda", "GET /api/events/:eventId/agenda"),
                    "review.ts": self.route_module("review", "GET /api/events/:eventId/review"),
                },
            )
            self.assertEqual(duplicate_registration_problems(root), [])

    def test_a_route_module_must_name_its_owning_domain(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_modules(root, "routes", {"orphan.ts": 'const routes = ["GET /x"];\n'})
            self.assertTrue(
                any(
                    "declares no owning domain" in problem
                    for problem in duplicate_registration_problems(root)
                ),
            )

    def test_aggregate_manifest_is_composed_from_the_fragments(self) -> None:
        manifest, problems = compose_manifest()
        self.assertEqual(problems, [])
        self.assertEqual(manifest, load_manifest())

    def test_generating_the_manifest_twice_produces_identical_bytes(self) -> None:
        first, _ = compose_manifest()
        second, _ = compose_manifest()
        self.assertEqual(rendered_manifest(first), rendered_manifest(second))

    def test_every_domain_declares_its_own_fragment(self) -> None:
        identifiers = [fragment["id"] for fragment in domain_fragments()]
        self.assertEqual(identifiers, [domain["id"] for domain in load_manifest()["domains"]])
        self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_no_domain_module_imports_another_domains_module(self) -> None:
        """
        The acceptance criterion, stated as an invariant: adding a domain's route or workspace
        touches that domain's module and one registry line, and nothing else. A module reaching
        sideways into a peer's would quietly reintroduce the coupling the split removed.
        """
        for directory, shared in (
            (
                Path("apps/api/src/transport/http/routes"),
                {"contract", "registry", "runtime", "throttle"},
            ),
            (Path("apps/web/src/workspaces"), {"contract", "registry"}),
        ):
            peers = {
                path.stem
                for path in (ROOT / directory).iterdir()
                if path.stem not in shared and path.is_file()
            }
            for module in sorted((ROOT / directory).iterdir()):
                if module.stem in shared or not module.is_file():
                    continue
                for specifier in module_specifiers(module.read_text(encoding="utf-8")):
                    target = specifier.rsplit("/", 1)[-1].removesuffix(".js")
                    self.assertNotIn(
                        target,
                        peers - {module.stem},
                        f"{module.relative_to(ROOT)} imports peer module '{specifier}'",
                    )

    def test_each_registered_symbol_has_exactly_one_owning_domain(self) -> None:
        owners: dict[str, list[str]] = {}
        for fragment in domain_fragments():
            for symbol in fragment.get("symbols") or {}:
                owners.setdefault(symbol, []).append(fragment["id"])
        duplicated = {symbol: names for symbol, names in owners.items() if len(names) > 1}
        self.assertEqual(duplicated, {})


if __name__ == "__main__":
    unittest.main()
