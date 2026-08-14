/**
 * Readiness. Not a domain surface: it belongs to the transport itself.
 *
 * Owned by the `platform` domain. Adding a path here changes no other domain's
 * fragment, and the aggregate `openapi.json` is still generated from all of them together.
 */
import {
  auditQuerySchema,
  auditResponseSchema,
  eventIdParamsSchema,
  healthResponseSchema,
  inboxDismissalInputSchema,
  inboxDismissalParamsSchema,
  inboxDismissalResponseSchema,
  inboxResponseSchema,
  organizerOverviewResponseSchema,
  reportCatalogueResponseSchema,
  reportParamsSchema,
  reportResponseSchema,
  reportRunInputSchema,
  reportRunResponseSchema,
  reportSaveInputSchema,
  reportScheduleInputSchema,
  reportSchedulesResponseSchema,
  reportShareCreatedResponseSchema,
  reportShareInputSchema,
  reportShareResolveInputSchema,
  reportShareResolvedResponseSchema,
  reportSharesResponseSchema,
  reportShareTokenParamsSchema,
  reportsResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
} from "../src/index";
import type { OpenApiFragment } from "./contract";

export const platformPaths: OpenApiFragment = {
  domain: "platform",
  register(registry, { json, errorResponse }) {
    registry.registerPath({
      method: "get",
      path: "/health",
      responses: {
        200: { description: "Runtime readiness", content: json(healthResponseSchema) },
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/overview",
      description: "Organizer landing-page composition with independently degradable panels.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Organizer overview", content: json(organizerOverviewResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/search",
      description:
        "Permission-aware search across one event. Each section is composed under the capability " +
        "its owning domain enforces: a section the caller may not read reports `unauthorized` " +
        "rather than failing the request, and only a genuine rejection reports `failed`.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema, query: searchQuerySchema },
      responses: {
        200: { description: "Search sections", content: json(searchResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/inbox",
      description:
        "Everything waiting on this event, derived on every read. Resolving the underlying " +
        "condition removes an item with no write; the only stored state is a dismissal. " +
        "Categories degrade independently under the same rule search uses.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Operational inbox", content: json(inboxResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/inbox/dismissals",
      description:
        "Record that the signed-in actor has seen an occurrence and is not acting on it. The " +
        "key is checked against the inbox this actor can derive now, so an item that has " +
        "already resolved — or one their role cannot read — is a 404 rather than a stored row.",
      security: [{ sessionCookie: [] }],
      request: {
        params: eventIdParamsSchema,
        body: { content: json(inboxDismissalInputSchema) },
      },
      responses: {
        201: { description: "Dismissal recorded", content: json(inboxDismissalResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "delete",
      path: "/api/events/{eventId}/inbox/dismissals/{itemKey}",
      description:
        "Undo a dismissal. Idempotent: a key that is not dismissed answers 204 as well, because " +
        "the caller asked for it to be gone and it is gone.",
      security: [{ sessionCookie: [] }],
      // Both path variables, or the template carries one a generated client cannot fill.
      request: { params: inboxDismissalParamsSchema },
      responses: {
        204: { description: "Dismissal removed" },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/audit",
      description:
        "The unified audit timeline for one event, newest first. Append-only in storage: two " +
        "triggers refuse an UPDATE and a DELETE, so a record cannot be edited or removed. " +
        "Gated on `events:settings:read`, and paged by an opaque cursor over " +
        "`(occurredAt, id)` — the id is in the key because two records written in the same " +
        "millisecond are ordinary. The idempotency key never leaves the server.",
      security: [{ sessionCookie: [] }],
      request: { params: eventIdParamsSchema, query: auditQuerySchema },
      responses: {
        200: { description: "Audit timeline page", content: json(auditResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        500: errorResponse,
      },
    });
    /*
     * Reporting (issue #196). A report is a question asked of an allowlisted dataset, never a
     * stored answer and never a query language — every part of a query is re-validated against
     * the catalogue server-side, which is what makes a natural-language draft exactly as safe as
     * a hand-built one.
     */
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/reports/catalogue",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      description:
        "Every dataset a report may be written against, its fields, which of them are personal " +
        "data, and the comparisons available. Carries no data — only the shape of the questions.",
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Report catalogue", content: json(reportCatalogueResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/reports",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      request: { params: eventIdParamsSchema },
      responses: {
        200: { description: "Saved reports", content: json(reportsResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/reports",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      description:
        "Save a report. Omit `reportId` to create; supply it with `expectedRevision` to replace, " +
        "which refuses a stale edit rather than interleaving it.",
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(reportSaveInputSchema) },
      },
      responses: {
        200: { description: "Report updated", content: json(reportResponseSchema) },
        201: { description: "Report created", content: json(reportResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        409: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/reports/run",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      description:
        "Run a saved report or an ad-hoc query. Personal fields are masked unless the caller " +
        "holds `reports:pii` and sets `includePii`, which is audited. A dataset the caller's " +
        "role cannot read answers `unauthorized` rather than refusing the request.",
      request: {
        params: eventIdParamsSchema,
        body: { required: true, content: json(reportRunInputSchema) },
      },
      responses: {
        200: { description: "Report result", content: json(reportRunResponseSchema) },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/reports/{reportId}/export",
      security: [{ sessionCookie: [] }, { eventBearer: [] }],
      description:
        "The report as CSV, XLSX or schema-versioned JSON. A *format* applied to the run rather " +
        "than a second query, so an export can never contain a field the screen would withhold.",
      request: { params: reportParamsSchema },
      responses: {
        200: { description: "Report export" },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/reports/{reportId}/shares",
      security: [{ sessionCookie: [] }],
      description:
        "Mint a capability URL onto this report. The link ships what `DEBT-012` says a capability " +
        "URL must: an expiry, an optional view limit, an optional password, and revocation. The " +
        "URL is returned once — only the token's digest is stored.",
      request: {
        params: reportParamsSchema,
        body: { required: true, content: json(reportShareInputSchema) },
      },
      responses: {
        201: {
          description: "Share link created",
          content: json(reportShareCreatedResponseSchema),
        },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/reports/{reportId}/shares",
      security: [{ sessionCookie: [] }],
      request: { params: reportParamsSchema },
      responses: {
        200: { description: "Share links", content: json(reportSharesResponseSchema) },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/events/{eventId}/reports/{reportId}/schedules",
      security: [{ sessionCookie: [] }],
      description:
        "Deliver this report on a cadence, in the event's own timezone. The recipient is sent an " +
        "expiring link rather than a rendered report, and the occurrence is named by local wall " +
        "clock so a retried tick delivers once.",
      request: {
        params: reportParamsSchema,
        body: { required: true, content: json(reportScheduleInputSchema) },
      },
      responses: {
        201: { description: "Schedule created" },
        400: errorResponse,
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/events/{eventId}/reports/{reportId}/schedules",
      security: [{ sessionCookie: [] }],
      request: { params: reportParamsSchema },
      responses: {
        200: {
          description: "Schedules and their recent runs",
          content: json(reportSchedulesResponseSchema),
        },
        401: errorResponse,
        403: errorResponse,
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "post",
      path: "/api/public/reports/{token}",
      description:
        "Resolve a share link, spending one of its views. Anonymous, and a POST because the " +
        "optional password travels in a body rather than in a URL beside the token it protects, " +
        "and because spending a view is a state change. Every refusal — unknown, revoked, " +
        "expired, spent, wrong password — is one indistinguishable 404.",
      request: {
        params: reportShareTokenParamsSchema,
        body: { required: false, content: json(reportShareResolveInputSchema) },
      },
      responses: {
        200: {
          description: "Report resolved under the share policy",
          content: json(reportShareResolvedResponseSchema),
        },
        404: errorResponse,
        500: errorResponse,
      },
    });
    registry.registerPath({
      method: "get",
      path: "/api/health",
      description:
        "The same readiness document under the `/api` prefix, so a caller behind a dev proxy that " +
        "forwards `/api/*` can read the build identity of the API it actually reaches.",
      responses: {
        200: { description: "Runtime readiness", content: json(healthResponseSchema) },
        500: errorResponse,
      },
    });
  },
};
