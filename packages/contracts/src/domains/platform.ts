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

/*
 * ---- reporting (issue #196) -------------------------------------------------
 *
 * A report is a question asked of an allowlisted dataset, never a stored answer and never a query
 * language. Every part of a query is re-validated against the catalogue server-side, which is what
 * makes a natural-language draft exactly as safe as a hand-built one.
 *
 * @spec PRD-OPS-004
 */
export const reportDatasetSchema = z.enum([
  "sessions",
  "speakers",
  "submissions",
  "reviews",
  "deliverables",
  "contacts",
  "agenda",
  "communications",
]);
export const reportOperatorSchema = z.enum([
  "equals",
  "not-equals",
  "contains",
  "starts-with",
  "greater-than",
  "less-than",
  "is-empty",
  "is-not-empty",
]);
export const reportFilterSchema = z.object({
  field: z.string().min(1).max(60),
  operator: reportOperatorSchema,
  value: z.string().max(200).optional(),
});
export const reportSortSchema = z.object({
  field: z.string().min(1).max(60),
  direction: z.enum(["asc", "desc"]),
});
export const reportFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "date"]),
  /** Masked unless the caller holds `reports:pii` and asked for it. */
  pii: z.boolean().optional(),
});
export const reportCatalogueResponseSchema = z.object({
  datasets: z.array(
    z.object({
      key: reportDatasetSchema,
      label: z.string(),
      source: z.string(),
      fields: z.array(reportFieldSchema),
    }),
  ),
  operators: z.array(reportOperatorSchema),
});
export const reportQuerySchema = z.object({
  dataset: reportDatasetSchema,
  fields: z.array(z.string()),
  filters: z.array(reportFilterSchema),
  groupBy: z.string().optional(),
  sort: reportSortSchema.optional(),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().min(0),
});
export const reportDefinitionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string(),
  dataset: reportDatasetSchema,
  query: reportQuerySchema,
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().min(1),
});
export const reportSaveInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  dataset: reportDatasetSchema,
  fields: z.array(z.string().min(1).max(60)).max(30).optional(),
  filters: z.array(reportFilterSchema).max(12).optional(),
  groupBy: z.string().min(1).max(60).optional(),
  sort: reportSortSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  reportId: z.string().uuid().optional(),
  expectedRevision: z.number().int().min(1).optional(),
});
export const reportRunInputSchema = z.object({
  reportId: z.string().uuid().optional(),
  dataset: reportDatasetSchema.optional(),
  fields: z.array(z.string().min(1).max(60)).max(30).optional(),
  filters: z.array(reportFilterSchema).max(12).optional(),
  groupBy: z.string().min(1).max(60).optional(),
  sort: reportSortSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  /** Refused with 403 unless the caller holds `reports:pii`; audited when it is honoured. */
  includePii: z.boolean().optional(),
});
export const reportResultSchema = z.object({
  dataset: reportDatasetSchema,
  fields: z.array(reportFieldSchema),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  totalRows: z.number().int().nonnegative(),
  groups: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() })),
  /** What the run cost and what it withheld. The issue asks for execution metadata by name. */
  meta: z.object({
    scannedRows: z.number().int().nonnegative(),
    limit: z.number().int().min(1),
    offset: z.number().int().nonnegative(),
    maskedFields: z.array(z.string()),
  }),
});
/**
 * A run degrades per dataset exactly as a search section does: a reviewer asking the CRM dataset
 * is told "not yours", which is the authorization model working rather than a fault.
 */
export const reportRunResponseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    report: reportDefinitionSchema.nullable(),
    result: reportResultSchema,
  }),
  z.object({ state: z.literal("unauthorized"), report: reportDefinitionSchema.nullable() }),
  z.object({ state: z.literal("failed"), error: apiErrorEnvelopeSchema.shape.error }),
]);
export const reportsResponseSchema = z.object({ reports: z.array(reportDefinitionSchema) });
export const reportResponseSchema = z.object({ report: reportDefinitionSchema });
export const reportShareSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  viewLimit: z.number().int().min(1).nullable(),
  views: z.number().int().nonnegative(),
  allowPii: z.boolean(),
  revokedAt: z.string().datetime().nullable(),
  hasPassword: z.boolean(),
});
export const reportShareInputSchema = z.object({
  lifetimeHours: z.number().int().min(1).max(720),
  viewLimit: z.number().int().min(1).max(1000).optional(),
  password: z.string().min(8).max(200).optional(),
  allowPii: z.boolean().optional(),
});
/** The URL is returned once: only the token's digest is stored, as with every capability URL here. */
export const reportShareCreatedResponseSchema = z.object({
  share: reportShareSchema,
  url: z.string(),
});
export const reportSharesResponseSchema = z.object({ shares: z.array(reportShareSchema) });
export const reportShareResolveInputSchema = z.object({ password: z.string().max(200).optional() });
export const reportShareResolvedResponseSchema = z.object({
  report: z.object({ name: z.string(), description: z.string(), dataset: reportDatasetSchema }),
  result: reportResultSchema,
});
export const reportScheduleSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  minuteOfDay: z.number().int().min(0).max(1439),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  dayOfMonth: z.number().int().min(1).max(28).nullable(),
  timezone: z.string(),
  recipients: z.array(z.string()),
  linkLifetimeHours: z.number().int().min(1).max(720),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  pausedAt: z.string().datetime().nullable(),
  lastFiredKey: z.string().nullable(),
});
export const reportScheduleInputSchema = z.object({
  cadence: z.enum(["daily", "weekly", "monthly"]),
  minuteOfDay: z.number().int().min(0).max(1439),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  /** Capped at 28 so a monthly schedule fires in February. */
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  timezone: z.string().min(1).max(64),
  recipients: z.array(z.string().email().max(254)).min(1).max(20),
  linkLifetimeHours: z.number().int().min(1).max(720).optional(),
});
export const reportRunRecordSchema = z.object({
  id: z.string().uuid(),
  scheduleId: z.string().uuid(),
  occurrenceKey: z.string(),
  ranAt: z.string().datetime(),
  outcome: z.enum(["pending", "delivered", "failed"]),
  detail: z.string(),
});
export const reportSchedulesResponseSchema = z.object({
  schedules: z.array(
    z.object({ schedule: reportScheduleSchema, runs: z.array(reportRunRecordSchema) }),
  ),
});
export const reportParamsSchema = z.object({
  eventId: z.string().uuid(),
  reportId: z.string().uuid(),
});
export const reportShareParamsSchema = reportParamsSchema.extend({
  shareId: z.string().uuid(),
});
export const reportScheduleParamsSchema = reportParamsSchema.extend({
  scheduleId: z.string().uuid(),
});
export const reportShareTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
export const reportRevisionQuerySchema = z.object({
  expectedRevision: z.coerce.number().int().min(1),
});
export const reportDuplicateInputSchema = z.object({ name: z.string().min(1).max(120) });
export type ReportCatalogueDto = z.infer<typeof reportCatalogueResponseSchema>;
export type ReportDefinitionDto = z.infer<typeof reportDefinitionSchema>;
export type ReportResultDto = z.infer<typeof reportResultSchema>;
export type ReportRunResponseDto = z.infer<typeof reportRunResponseSchema>;
export type ReportShareDto = z.infer<typeof reportShareSchema>;
export type ReportScheduleDto = z.infer<typeof reportScheduleSchema>;

export type SearchResultKind = z.infer<typeof searchResultKindSchema>;
export type SearchResultDto = z.infer<typeof searchResultSchema>;
export type SearchSectionDto = z.infer<typeof searchSectionSchema>;
export type SearchSectionKey = keyof z.infer<typeof searchSectionsSchema>;
export type SearchResponseDto = z.infer<typeof searchResponseSchema>;
