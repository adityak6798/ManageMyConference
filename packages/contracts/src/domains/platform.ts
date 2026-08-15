import { z } from "zod";

/**
 * The version of Greenroom's public HTTP contract.
 *
 * URLs remain unversioned; this value is the one source used by both the generated OpenAPI
 * document and the response header emitted by the Worker. See `docs/interfaces/api-compatibility.md`.
 */
export const API_CONTRACT_VERSION = "0.1.0";
export const API_VERSION_HEADER = "Greenroom-API-Version";

/** Shared bounds and coercion for an opaque cursor page query. */
export const cursorPageParams = ({
  max,
  default: defaultLimit,
}: {
  max: number;
  default: number;
}) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(max).default(defaultLimit),
    cursor: z.string().min(1).max(500).optional(),
  });

/**
 * Shared cursor-page response envelope.
 *
 * `collection` defaults to `items`; the optional name lets an established endpoint adopt the
 * contract without a breaking rename of its existing collection field.
 */
export const cursorPage = <Item extends z.ZodTypeAny, Collection extends string = "items">(
  itemSchema: Item,
  collection = "items" as Collection,
) => {
  type Shape = { [Key in Collection]: z.ZodArray<Item> } & {
    nextCursor: z.ZodNullable<z.ZodString>;
  };
  const shape = {
    [collection]: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  } as Shape;
  return z.object(shape);
};

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
  "WEBHOOK_UNAVAILABLE",
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

/**
 * An operational inbox item. @spec PRD-OPS-002
 *
 * Derived on every read, never stored: resolving the underlying condition removes the item with
 * no write anywhere. `key` is identity *and* occurrence — it carries the task's deadline or the
 * delivery's attempt count — because it is what a dismissal is recorded against, and the
 * operator should be told again when the occurrence genuinely changes.
 */
export const inboxItemSchema = z.object({
  key: z.string(),
  category: z.enum([
    "reviews",
    "speakerWork",
    "programme",
    "deliveries",
    "publication",
    "configuration",
  ]),
  title: z.string(),
  subtitle: z.string().optional(),
  priority: z.enum(["high", "normal", "low"]),
  status: z.enum(["open", "dismissed"]),
  owner: z.string().optional(),
  dueAt: z.string().optional(),
  href: z.string(),
  dismissedAt: z.string().optional(),
});

/** Same three states as a search section, and for the same reason. */
export const inboxSectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), items: z.array(inboxItemSchema) }),
  z.object({ state: z.literal("unauthorized") }),
  z.object({ state: z.literal("failed"), error: apiErrorEnvelopeSchema.shape.error }),
]);

export const inboxCategoriesSchema = z.object({
  reviews: inboxSectionSchema,
  speakerWork: inboxSectionSchema,
  programme: inboxSectionSchema,
  deliveries: inboxSectionSchema,
  publication: inboxSectionSchema,
  /**
   * Configuration this event was cloned into and never finished receiving (issue #203).
   *
   * The sixth category, and the one #188 deliberately did not add: a partial template
   * application was surfaced only in the templates workspace, so an operator who never opened
   * that page was never told. What made it cheap to add here is that the events domain answers
   * the question — platform declares one call and holds no knowledge of templates or slices.
   */
  configuration: inboxSectionSchema,
});

export const inboxResponseSchema = z.object({
  categories: inboxCategoriesSchema,
  /** When the answer was derived; every relative label on the surface is measured from it. */
  derivedAt: z.string(),
});

export const inboxDismissalInputSchema = z.object({
  itemKey: z.string().trim().min(1).max(400),
});

/**
 * The DELETE route's path parameters — both of them.
 *
 * Declaring only `eventId` left `{itemKey}` as a path template variable with no parameter, which
 * is invalid under OAS 3 and leaves a generated client no way to fill the segment.
 */
export const inboxDismissalParamsSchema = z.object({
  eventId: z.string().uuid(),
  itemKey: z.string().min(1).max(400),
});

export const inboxDismissalResponseSchema = z.object({
  dismissal: z.object({
    eventId: z.string(),
    itemKey: z.string(),
    actorId: z.string(),
    dismissedAt: z.string(),
  }),
});

export type InboxDismissalDto = z.infer<typeof inboxDismissalResponseSchema>["dismissal"];
export type InboxItemDto = z.infer<typeof inboxItemSchema>;
export type InboxSectionDto = z.infer<typeof inboxSectionSchema>;
export type InboxCategoryKey = keyof z.infer<typeof inboxCategoriesSchema>;
export type InboxResponseDto = z.infer<typeof inboxResponseSchema>;

/**
 * One entry on the unified audit timeline. @spec PRD-OPS-003
 *
 * `actorId` is null for a record nobody signed — a lifecycle consequence with no request behind
 * it — and `actorName` still says what it was, so a reader is never shown a blank. `source`
 * distinguishes a person from a program; only `human` and `system` are produced today.
 */
export const auditRecordSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string(),
  source: z.enum(["human", "api", "agent", "system"]),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  targetVersion: z.number().int().nonnegative().optional(),
  correlationId: z.string().nullable(),
});

export const AUDIT_PAGE_LIMIT_MAX = 50;

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_LIMIT_MAX).default(25),
  cursor: z.string().min(1).max(200).optional(),
});

export const auditResponseSchema = z.object({
  records: z.array(auditRecordSchema),
  /** Absent as `null` rather than omitted, so "no more" and "not asked" cannot be confused. */
  nextCursor: z.string().nullable(),
});

export type AuditRecordDto = z.infer<typeof auditRecordSchema>;
export type AuditResponseDto = z.infer<typeof auditResponseSchema>;

export type SearchResultKind = z.infer<typeof searchResultKindSchema>;
export type SearchResultDto = z.infer<typeof searchResultSchema>;
export type SearchSectionDto = z.infer<typeof searchSectionSchema>;
export type SearchSectionKey = keyof z.infer<typeof searchSectionsSchema>;
export type SearchResponseDto = z.infer<typeof searchResponseSchema>;
