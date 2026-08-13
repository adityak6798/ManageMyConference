import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  checks: z.object({
    database: z.literal("configured"),
    sessionSigning: z.enum(["configured", "disabled"]),
  }),
  providerMode: z.literal("sql-r2"),
  logFormat: z.literal("structured-json"),
  /**
   * Which checkout started this Worker, and at which commit. Present only when the local
   * launcher supplied it, so a deployed instance simply omits it.
   *
   * This exists so a test run can prove it is talking to *its own* server. Both values are
   * non-secret by construction: a filesystem path and a commit SHA, the same two facts `git`
   * prints to anyone with the repository.
   */
  build: z
    .object({
      root: z.string(),
      commit: z.string(),
    })
    .optional(),
});

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "AGENDA_CONFLICT",
  // The unauthenticated CFP submission route is throttled per client and event; a caller
  // that exceeds the window is told so rather than being given a misleading 4xx.
  "RATE_LIMITED",
  // A third-party system this request had to read was unreachable or unusable. Distinct from
  // INTERNAL_ERROR on purpose: the registration sync failing because Accelevents is down is not
  // our bug and not the caller's mistake, and telling an organizer "internal error" sends them
  // to the wrong place. Carries a normalized code, never the upstream's own message.
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    correlationId: z.string(),
    fieldErrors: z.record(z.array(z.string())).optional(),
  }),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

/**
 * What a search hit is, as the console is allowed to know it. @spec PRD-OPS-001
 *
 * One kind per record type the operator can actually open. There is no `publication` kind
 * because publication state is a property of the event rather than a record you can land on.
 */
export const searchResultKindSchema = z.enum([
  "session",
  "speaker",
  "proposal",
  "task",
  "agenda-item",
  "delivery",
  "contact",
]);

export const searchResultSchema = z.object({
  kind: searchResultKindSchema,
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  /**
   * The console path this hit opens, already carrying its `?event=`.
   *
   * Produced by the server, never assembled in the browser: the route a hit belongs to depends
   * on the role that read it — a reviewer's proposal opens the review queue and an organizer's
   * opens the abstracts board — and a client that guessed would send a reviewer to a surface
   * their role cannot open.
   */
  href: z.string(),
});

/**
 * One source's contribution to a search answer, in three states rather than two.
 *
 * The two-state `{ ok }` union `organizerOverviewResponseSchema` uses cannot express the rule
 * `PRD-OPS-001` is built on. Overview is organizer-only, so a refusal there is a bug and the
 * whole request fails. Search is not: a reviewer legitimately cannot read the CRM, and calling
 * that an outage would report a working system as broken. So a source the caller may not read
 * is `unauthorized` — a fact about the caller — and only a genuine rejection is `failed`.
 */
export const searchSectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), results: z.array(searchResultSchema) }),
  z.object({ state: z.literal("unauthorized") }),
  z.object({ state: z.literal("failed"), error: apiErrorEnvelopeSchema.shape.error }),
]);

export const searchSectionsSchema = z.object({
  content: searchSectionSchema,
  review: searchSectionSchema,
  agenda: searchSectionSchema,
  communications: searchSectionSchema,
  crm: searchSectionSchema,
});

export const searchResponseSchema = z.object({
  /** Echoed back so a late answer to a stale keystroke can be recognized and dropped. */
  query: z.string(),
  limit: z.number().int(),
  sections: searchSectionsSchema,
});

/** The smallest query worth running. One character matches most of a conference. */
export const SEARCH_QUERY_MIN_LENGTH = 2;
/** Per-section cap. The whole answer is therefore bounded at five times this. */
export const SEARCH_SECTION_LIMIT_MAX = 25;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(SEARCH_QUERY_MIN_LENGTH, "Search for at least two characters.").max(120),
  limit: z.coerce.number().int().min(1).max(SEARCH_SECTION_LIMIT_MAX).default(10),
});

export type SearchResultKind = z.infer<typeof searchResultKindSchema>;
export type SearchResultDto = z.infer<typeof searchResultSchema>;
export type SearchSectionDto = z.infer<typeof searchSectionSchema>;
export type SearchSectionKey = keyof z.infer<typeof searchSectionsSchema>;
export type SearchResponseDto = z.infer<typeof searchResponseSchema>;
