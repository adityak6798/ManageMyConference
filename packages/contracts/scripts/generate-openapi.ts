/**
 * Compose one OpenAPI document from every domain's path fragment.
 *
 * This script used to *be* the API surface: 1041 lines and 56 `registerPath` calls, edited by
 * every feature branch and merged by hand. It now owns only what is true of the document as a
 * whole — the security scheme, the shared error response, one non-expressible constraint, and
 * the deterministic serialisation.
 *
 * @spec ENG-CI-001 ARC-001
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z, type ZodType } from "zod";
import { openApiFragments } from "../openapi/registry";
import { apiErrorEnvelopeSchema } from "../src/index";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();
const json = (schema: ZodType) => ({ "application/json": { schema } });
const errorResponse = {
  description: "Standard error envelope",
  content: json(apiErrorEnvelopeSchema),
};
registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "greenroom_session",
});

// A path claimed by two fragments would silently produce one merged entry, so the domains
// are checked against each other before anything is generated.
const claimed = new Map<string, string>();
for (const fragment of openApiFragments) {
  const before = new Set(registry.definitions.map((definition) => JSON.stringify(definition)));
  fragment.register(registry, { json, errorResponse });
  for (const definition of registry.definitions) {
    if (before.has(JSON.stringify(definition)) || definition.type !== "route") continue;
    const key = `${definition.route.method.toUpperCase()} ${definition.route.path}`;
    const owner = claimed.get(key);
    if (owner && owner !== fragment.domain)
      throw new Error(
        `OpenAPI path ${key} is claimed by both '${owner}' and '${fragment.domain}'. ` +
          "Each path belongs to exactly one fragment in packages/contracts/openapi.",
      );
    claimed.set(key, fragment.domain);
  }
}

const document = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: "3.0.3",
  info: { title: "Project Greenroom API", version: "0.1.0" },
});
const patchOperation = document.paths["/api/events/{eventId}/prospects/{prospectId}"]?.patch as
  | { requestBody?: { content?: Record<string, { schema?: { minProperties?: number } }> } }
  | undefined;
const patchSchema = patchOperation?.requestBody?.content?.["application/json"]?.schema;
if (!patchSchema) throw new Error("CRM prospect PATCH schema was not generated");
patchSchema.minProperties = 1;

// Sorted rather than left in registration order, so the artifact depends on the set of paths
// and not on the order fragments happen to be listed in. Adding a domain then produces a diff
// of exactly its own paths instead of reshuffling the file.
document.paths = Object.fromEntries(
  Object.entries(document.paths).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  ),
);

const output = `${JSON.stringify(document, null, 2)}\n`;
const artifact = fileURLToPath(new URL("../openapi.json", import.meta.url));
if (process.argv.includes("--check")) {
  if ((await readFile(artifact, "utf8")) !== output)
    throw new Error(
      "openapi.json is stale; run npm run openapi:generate --workspace @greenroom/contracts",
    );
} else await writeFile(artifact, output);
