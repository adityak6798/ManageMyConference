/**
 * The extension point a domain implements to put its paths in the generated OpenAPI
 * document.
 *
 * One artifact is still produced — `openapi.json` — but it is composed from per-domain
 * fragments rather than written in one 1041-line script that every feature branch edited.
 *
 * @spec ARC-001 ENG-CI-001
 */
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { ZodType } from "zod";

/** The two things nearly every path definition needs, supplied rather than re-declared. */
export interface PathHelpers {
  json(schema: ZodType): { "application/json": { schema: ZodType } };
  errorResponse: { description: string; content: { "application/json": { schema: ZodType } } };
}

export interface OpenApiFragment {
  /** The `context-manifest.json` domain that owns these paths. */
  readonly domain: string;
  register(registry: OpenAPIRegistry, helpers: PathHelpers): void;
}
