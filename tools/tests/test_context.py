"""Tests for repository context routing.

@spec ENG-CI-001
"""

import unittest

from greenroom_tools.context import (
    architecture_import_problems,
    check_repository,
    context_locations,
    cross_domain_import_permitted,
    domain_for,
    layer_for,
    load_manifest,
    production_layer_problems,
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

    def test_repository_integrity_is_clean(self) -> None:
        self.assertEqual(check_repository(), [])


if __name__ == "__main__":
    unittest.main()
