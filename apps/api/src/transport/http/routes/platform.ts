/** Public API discovery routes owned by the platform domain. @spec ARC-001 ENG-CI-001 PRD-OPS-001 */
import {
  auditQuerySchema,
  eventIdParamsSchema,
  inboxDismissalInputSchema,
  inboxDismissalParamsSchema,
  reportCatalogueResponseSchema,
  reportDuplicateInputSchema,
  reportResponseSchema,
  reportRevisionQuerySchema,
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
} from "@greenroom/contracts";
import type { Context } from "hono";
import openApiDocument from "../../../../../../packages/contracts/openapi.json";
import { AgendaNotFoundError } from "../../../application/agenda/public";
import {
  AuthenticationRequiredError,
  CapabilityDeniedError,
} from "../../../application/identity/actor";
import {
  INBOX_CATEGORY_KEYS,
  InboxItemNotFoundError,
  ReportConflictError,
  ReportInvalidError,
  ReportNameTakenError,
  ReportNotFoundError,
  ReportPiiDeniedError,
  ReportQueryInvalidError,
  ReportShareUnavailableError,
  ReportTooExpensiveError,
  SEARCH_SECTION_KEYS,
  SearchQueryTooShortError,
} from "../../../application/platform/public";
import {
  type ErrorTranslation,
  envelope,
  readJson,
  type Variables,
  validationFields,
} from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /openapi.json",
  "GET /docs",
  "GET /api/events/:eventId/overview",
  "GET /api/events/:eventId/search",
  "GET /api/events/:eventId/inbox",
  "POST /api/events/:eventId/inbox/dismissals",
  "DELETE /api/events/:eventId/inbox/dismissals/:itemKey",
  "GET /api/events/:eventId/audit",
  /*
   * Reporting (issue #196). Event-addressed, because a report is a question about one event and
   * every dataset behind it is authorized by the domain that owns it.
   *
   * The share resolver is the exception, and it is under `/api/public/*` for the same reason the
   * itinerary is: the link is the credential, the namespace reads no session, and a wildcard CORS
   * origin means a cookie could not identify a caller there even if one were sent.
   */
  "GET /api/events/:eventId/reports/catalogue",
  "GET /api/events/:eventId/reports",
  "POST /api/events/:eventId/reports",
  "POST /api/events/:eventId/reports/run",
  "DELETE /api/events/:eventId/reports/:reportId",
  "POST /api/events/:eventId/reports/:reportId/duplicate",
  "GET /api/events/:eventId/reports/:reportId/export",
  "GET /api/events/:eventId/reports/:reportId/shares",
  "POST /api/events/:eventId/reports/:reportId/shares",
  "DELETE /api/events/:eventId/reports/:reportId/shares/:shareId",
  "GET /api/events/:eventId/reports/:reportId/schedules",
  "POST /api/events/:eventId/reports/:reportId/schedules",
  "DELETE /api/events/:eventId/reports/:reportId/schedules/:scheduleId",
  "POST /api/public/reports/:token",
] as const;

const docsPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Greenroom API reference</title>
    <style>
      :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
      body { margin: 0 auto; max-width: 72rem; padding: 2rem; }
      header { border-bottom: 1px solid #8886; margin-bottom: 2rem; }
      article { border: 1px solid #8886; border-radius: .5rem; margin: 1rem 0; padding: 1rem; }
      code { overflow-wrap: anywhere; }
      details { margin: .75rem 0; }
      pre { background: #8881; border-radius: .25rem; overflow: auto; padding: .75rem; }
      table { border-collapse: collapse; display: block; overflow-x: auto; width: 100%; }
      th, td { border-bottom: 1px solid #8884; padding: .5rem; text-align: left; vertical-align: top; }
      .method { display: inline-block; font-weight: 700; min-width: 4rem; text-transform: uppercase; }
      .meta { display: flex; flex-wrap: wrap; gap: .5rem; }
      .pill { background: #8882; border-radius: 999px; padding: .125rem .5rem; }
      .error { color: #c33; }
    </style>
  </head>
  <body>
    <header><h1>Greenroom API reference</h1><p id="summary">Loading <a href="/openapi.json">OpenAPI JSON</a>…</p></header>
    <main id="operations" aria-live="polite"></main>
    <script>
      const summary = document.querySelector("#summary");
      const operations = document.querySelector("#operations");
      const appendJson = (parent, value) => {
        const pre = window.document.createElement("pre");
        pre.textContent = JSON.stringify(value, null, 2);
        parent.append(pre);
      };
      const appendDetails = (parent, label, value) => {
        if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
        const details = window.document.createElement("details");
        const detailsSummary = window.document.createElement("summary");
        detailsSummary.textContent = label;
        details.append(detailsSummary);
        appendJson(details, value);
        parent.append(details);
      };
      fetch("/openapi.json").then((response) => {
        if (!response.ok) throw new Error("OpenAPI request failed: " + response.status);
        return response.json();
      }).then((specification) => {
        window.document.title = specification.info.title + " API reference";
        summary.textContent = specification.info.description || specification.info.title;
        for (const [path, methods] of Object.entries(specification.paths)) {
          for (const [method, operation] of Object.entries(methods)) {
            const article = window.document.createElement("article");
            const heading = window.document.createElement("h2");
            const methodLabel = window.document.createElement("span");
            methodLabel.className = "method";
            methodLabel.textContent = method;
            const pathLabel = window.document.createElement("code");
            pathLabel.textContent = path;
            heading.append(methodLabel, pathLabel);
            const description = window.document.createElement("p");
            description.textContent = operation.summary || operation.description || "";
            const metadata = window.document.createElement("div");
            metadata.className = "meta";
            for (const tag of operation.tags || []) {
              const pill = window.document.createElement("span");
              pill.className = "pill";
              pill.textContent = tag;
              metadata.append(pill);
            }
            article.append(heading, description, metadata);
            appendDetails(article, "Authentication", operation.security || specification.security);
            appendDetails(article, "Parameters", operation.parameters);
            appendDetails(article, "Request body", operation.requestBody);
            appendDetails(article, "Responses", operation.responses);
            operations.append(article);
          }
        }
        const components = window.document.createElement("article");
        const componentsHeading = window.document.createElement("h2");
        componentsHeading.textContent = "Reusable schemas and security definitions";
        components.append(componentsHeading);
        appendJson(components, specification.components || {});
        operations.append(components);
      }).catch((error) => {
        summary.textContent = "The API reference could not be loaded.";
        operations.className = "error";
        operations.textContent = error instanceof Error ? error.message : String(error);
      });
    </script>
  </body>
</html>`;

/**
 * One degraded source, rendered for the caller and logged exactly once.
 *
 * A refused source arrives as `unauthorized` and is deliberately *not* logged: it is the ordinary
 * answer to a reviewer opening one of these surfaces, and logging it would fill the telemetry
 * with the authorization model working. Only a genuine rejection is logged, and the application
 * layer hands the rejection itself across rather than a message, so the correlation id and the
 * demo-only stack stay the transport's to decide.
 *
 * Shared by search and the inbox because they degrade identically; two copies is how one surface
 * ends up logging what the other omits.
 */
type DegradableSection =
  | { readonly state: "ok" }
  | { readonly state: "unauthorized" }
  | { readonly state: "failed"; readonly reason: unknown };

function wireSection<T extends DegradableSection>(
  context: Context<{ Variables: Variables }>,
  { logger, auth }: HttpDependencies,
  operation: string,
  section: T,
) {
  if (section.state !== "failed") return section;
  const error =
    section.reason instanceof Error ? section.reason : new Error(String(section.reason));
  logger.error(
    {
      correlationId: context.get("correlationId"),
      operation,
      actorId: context.get("actor")?.id,
      errorName: error.name,
      ...(auth.demoMode ? { errorMessage: error.message, errorStack: error.stack } : {}),
    },
    "request.exception",
  );
  return {
    state: "failed" as const,
    error: envelope("INTERNAL_ERROR", "Something went wrong.", context.get("correlationId")).error,
  };
}

export const platformRoutes: RouteModule = {
  domain: "platform",
  routes,
  /*
   * Whose request this is, told to platform once, before any route in any domain runs.
   *
   * The transport mounts every module's request scope before it registers any module's routes,
   * so this covers the whole `/api/*` surface however the registry happens to be ordered — it
   * used to depend on `platformRoutes` being listed first, which is an invariant an array's
   * order cannot carry (issue #178). The transport's own auth middleware is mounted before any
   * module's, so the actor here is resolved.
   *
   * Everything that records an audit row afterwards sits deep inside a domain that has no
   * business being handed an actor, and this is what lets those writers attribute a record
   * without nine domains learning about auditing. `/api/*` only: the public namespace has no
   * session and nothing to attribute.
   *
   * The scope is ended in a `finally`, which does two things. The holder is empty once the
   * request is over, so a later write with no request behind it is attributed to nobody instead
   * of to whoever happened to be last; and the holder can see two requests overlapping on it,
   * which is what a hoisted composition would look like (issue #179).
   */
  registerRequestScope(app: HttpApp, dependencies: HttpDependencies) {
    app.use("/api/*", async (context, next) => {
      const scope = dependencies.platformOps?.observeRequest(
        context.get("actor"),
        context.get("correlationId"),
      );
      try {
        await next();
      } finally {
        scope?.end();
      }
    });
  },
  register(app: HttpApp, dependencies: HttpDependencies) {
    app.get("/openapi.json", (context) => context.json(openApiDocument));
    app.get("/docs", (context) =>
      context.html(docsPage, 200, {
        "cache-control": "public, max-age=300",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      }),
    );
    app.get("/api/events/:eventId/overview", async (context) => {
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const { content, review, agenda, publishing, logger, auth } = dependencies;
      const actor = context.get("actor");
      const missing = (name: string) => Promise.reject(new Error(`${name} service is unavailable`));
      const settled = await Promise.allSettled([
        content?.workspace(actor, parsed.data.eventId) ?? missing("Content"),
        review?.organizerWorkspace(actor, parsed.data.eventId) ?? missing("Review"),
        agenda?.draft(actor, parsed.data.eventId) ?? missing("Agenda"),
        publishing?.preview(actor, parsed.data.eventId) ?? missing("Publishing"),
      ]);
      const refusal = settled.find(
        (result) =>
          result.status === "rejected" &&
          (result.reason instanceof AuthenticationRequiredError ||
            result.reason instanceof CapabilityDeniedError),
      );
      if (refusal?.status === "rejected") throw refusal.reason;
      const names = ["content", "review", "agenda", "publication"] as const;
      const panel = (result: PromiseSettledResult<unknown>, index: number) => {
        if (result.status === "fulfilled") return { ok: true as const, data: result.value };
        const error =
          result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        const notFound = error instanceof AgendaNotFoundError;
        if (!notFound)
          logger.error(
            {
              correlationId: context.get("correlationId"),
              operation: `overview.${names[index]}`,
              actorId: actor?.id,
              errorName: error.name,
              ...(auth.demoMode ? { errorMessage: error.message, errorStack: error.stack } : {}),
            },
            "request.exception",
          );
        return {
          ok: false as const,
          error: envelope(
            notFound ? "NOT_FOUND" : "INTERNAL_ERROR",
            notFound ? "No agenda has been configured." : "Something went wrong.",
            context.get("correlationId"),
          ).error,
        };
      };
      return context.json({
        content: panel(settled[0], 0),
        review: panel(settled[1], 1),
        agenda: panel(settled[2], 2),
        publication: panel(settled[3], 3),
      });
    });
    app.get("/api/events/:eventId/search", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      const query = searchQuerySchema.safeParse(context.req.query());
      if (!params.success || !query.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The search request is malformed.",
            context.get("correlationId"),
            validationFields([
              ...(params.success ? [] : params.error.issues),
              ...(query.success ? [] : query.error.issues),
            ]),
          ),
          400,
        );
      const { platformOps } = dependencies;
      if (!platformOps) throw new Error("Platform operations service is not configured");
      const answer = await platformOps.search(
        context.get("actor"),
        params.data.eventId,
        query.data.q,
        query.data.limit,
      );
      return context.json({
        query: answer.query,
        limit: answer.limit,
        sections: Object.fromEntries(
          SEARCH_SECTION_KEYS.map((key) => [
            key,
            wireSection(context, dependencies, `search.${key}`, answer.sections[key]),
          ]),
        ),
      });
    });
    app.get("/api/events/:eventId/inbox", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Event ID is malformed.",
            context.get("correlationId"),
            validationFields(params.error.issues),
          ),
          400,
        );
      const { platformOps } = dependencies;
      if (!platformOps) throw new Error("Platform operations service is not configured");
      const answer = await platformOps.inbox(context.get("actor"), params.data.eventId);
      return context.json({
        derivedAt: answer.derivedAt,
        categories: Object.fromEntries(
          INBOX_CATEGORY_KEYS.map((key) => [
            key,
            wireSection(context, dependencies, `inbox.${key}`, answer.categories[key]),
          ]),
        ),
      });
    });
    app.post("/api/events/:eventId/inbox/dismissals", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      const body = inboxDismissalInputSchema.safeParse(await readJson(context.req));
      if (!params.success || !body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The dismissal request is malformed.",
            context.get("correlationId"),
            validationFields([
              ...(params.success ? [] : params.error.issues),
              ...(body.success ? [] : body.error.issues),
            ]),
          ),
          400,
        );
      const { platformOps } = dependencies;
      if (!platformOps) throw new Error("Platform operations service is not configured");
      return context.json(
        {
          dismissal: await platformOps.dismissInboxItem(
            context.get("actor"),
            params.data.eventId,
            body.data.itemKey,
          ),
        },
        201,
      );
    });
    /*
     * Undo, and idempotent on purpose. The caller asked for the dismissal to be gone; a second
     * request finding it already gone has got what it asked for, and answering 404 would turn a
     * double click into an error message about a state the operator wanted.
     */
    app.delete("/api/events/:eventId/inbox/dismissals/:itemKey", async (context) => {
      const params = inboxDismissalParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The dismissal request is malformed.",
            context.get("correlationId"),
            validationFields(params.error.issues),
          ),
          400,
        );
      const { platformOps } = dependencies;
      if (!platformOps) throw new Error("Platform operations service is not configured");
      await platformOps.restoreInboxItem(
        context.get("actor"),
        params.data.eventId,
        params.data.itemKey,
      );
      return context.body(null, 204);
    });
    app.get("/api/events/:eventId/audit", async (context) => {
      const params = eventIdParamsSchema.safeParse(context.req.param());
      const query = auditQuerySchema.safeParse(context.req.query());
      if (!params.success || !query.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The audit request is malformed.",
            context.get("correlationId"),
            validationFields([
              ...(params.success ? [] : params.error.issues),
              ...(query.success ? [] : query.error.issues),
            ]),
          ),
          400,
        );
      const { platformOps } = dependencies;
      if (!platformOps) throw new Error("Platform operations service is not configured");
      const page = await platformOps.auditTimeline(context.get("actor"), params.data.eventId, {
        limit: query.data.limit,
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      });
      /*
       * The idempotency key never leaves the server. It is derived from the fact and is the one
       * field a caller could use to guess at records they were not shown; the timeline's job is
       * to say what happened, not to expose how the writer deduplicates.
       */
      return context.json({
        records: page.records.map((record) => ({
          id: record.id,
          occurredAt: record.occurredAt,
          actorId: record.actorId,
          actorName: record.actorName,
          source: record.source,
          action: record.action,
          targetType: record.targetType,
          targetId: record.targetId,
          correlationId: record.correlationId,
        })),
        nextCursor: page.nextCursor,
      });
    });

    /*
     * ---- reporting (issue #196) -------------------------------------------
     *
     * Every read here is authorized twice: `events:read` on this event to reach the surface at
     * all, and then the owning domain's own rule per dataset. A run therefore degrades rather
     * than refuses — a reviewer opening a CRM report is told "not yours", which is the
     * authorization model working rather than a fault.
     */
    const noReporting = (context: Context<{ Variables: Variables }>) =>
      context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );
    const eventOf = (context: Context<{ Variables: Variables }>) =>
      context.req.param("eventId") ?? "";
    const invalidReport = (
      context: Context<{ Variables: Variables }>,
      issues: readonly { path: PropertyKey[]; message: string }[],
    ) =>
      context.json(
        envelope(
          "VALIDATION_FAILED",
          "Review the highlighted report settings.",
          context.get("correlationId"),
          validationFields([...issues]),
        ),
        400,
      );

    app.get("/api/events/:eventId/reports/catalogue", (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      // What a query builder renders, so the screen cannot offer a field the service refuses. It
      // carries no data, only the shape of the questions available.
      return context.json(reportCatalogueResponseSchema.parse(reporting.catalogue()));
    });

    app.get("/api/events/:eventId/reports", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      return context.json(
        reportsResponseSchema.parse({
          reports: await reporting.list(context.get("actor"), eventOf(context)),
        }),
      );
    });

    app.post("/api/events/:eventId/reports", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const body = reportSaveInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidReport(context, body.error.issues);
      const report = await reporting.save(context.get("actor"), eventOf(context), body.data);
      return context.json(reportResponseSchema.parse({ report }), body.data.reportId ? 200 : 201);
    });

    app.post("/api/events/:eventId/reports/run", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const body = reportRunInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidReport(context, body.error.issues);
      const answer = await reporting.run(context.get("actor"), eventOf(context), body.data);
      if (answer.state === "failed")
        return context.json(
          reportRunResponseSchema.parse(wireSection(context, dependencies, "reports.run", answer)),
          500,
        );
      return context.json(reportRunResponseSchema.parse(answer));
    });

    app.delete("/api/events/:eventId/reports/:reportId", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const query = reportRevisionQuerySchema.safeParse(context.req.query());
      if (!query.success) return invalidReport(context, query.error.issues);
      await reporting.remove(
        context.get("actor"),
        eventOf(context),
        context.req.param("reportId") ?? "",
        query.data.expectedRevision,
      );
      return context.body(null, 204);
    });

    app.post("/api/events/:eventId/reports/:reportId/duplicate", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const body = reportDuplicateInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidReport(context, body.error.issues);
      const report = await reporting.duplicate(
        context.get("actor"),
        eventOf(context),
        context.req.param("reportId") ?? "",
        body.data.name,
      );
      return context.json(reportResponseSchema.parse({ report }), 201);
    });

    /*
     * The export is a *format* applied to the run, never a second query.
     *
     * That is what makes "the export goes through the same field-access decision as the screen"
     * true by construction rather than by discipline: the rows have already been filtered by the
     * caller's grants, redacted by their custom role and masked by the PII rule before either
     * renderer sees them. `includePii=true` is refused with 403 for a caller without the
     * capability, exactly as the on-screen run is.
     */
    app.get("/api/events/:eventId/reports/:reportId/export", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const format = context.req.query("format") ?? "csv";
      if (format !== "csv" && format !== "xlsx" && format !== "json")
        return invalidReport(context, [
          { path: ["format"], message: "Export as csv, xlsx or json." },
        ]);
      const rendered = await reporting.export(context.get("actor"), eventOf(context), {
        reportId: context.req.param("reportId") ?? "",
        format,
        includePii: context.req.query("includePii") === "true",
      });
      if (rendered.state !== "ok")
        return context.json(
          envelope(
            rendered.state === "unauthorized" ? "FORBIDDEN" : "INTERNAL_ERROR",
            rendered.state === "unauthorized"
              ? "Your role cannot read this report's data."
              : "Something went wrong.",
            context.get("correlationId"),
          ),
          rendered.state === "unauthorized" ? 403 : 500,
        );
      return context.body(rendered.body as unknown as ArrayBuffer, 200, {
        "content-type": rendered.contentType,
        "content-disposition": `attachment; filename="${rendered.filename}"`,
      });
    });

    app.get("/api/events/:eventId/reports/:reportId/shares", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      return context.json(
        reportSharesResponseSchema.parse({
          shares: await reporting.listShares(
            context.get("actor"),
            eventOf(context),
            context.req.param("reportId") ?? "",
          ),
        }),
      );
    });

    app.post("/api/events/:eventId/reports/:reportId/shares", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const body = reportShareInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidReport(context, body.error.issues);
      const created = await reporting.createShare(
        context.get("actor"),
        eventOf(context),
        context.req.param("reportId") ?? "",
        body.data,
      );
      // The URL is returned once and never again: only the token's digest is stored.
      return context.json(
        reportShareCreatedResponseSchema.parse({ share: created.share, url: created.url }),
        201,
      );
    });

    app.delete("/api/events/:eventId/reports/:reportId/shares/:shareId", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      return context.json({
        changed: await reporting.revokeShare(
          context.get("actor"),
          eventOf(context),
          context.req.param("reportId") ?? "",
          context.req.param("shareId") ?? "",
        ),
      });
    });

    app.get("/api/events/:eventId/reports/:reportId/schedules", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      return context.json(
        reportSchedulesResponseSchema.parse({
          schedules: await reporting.listSchedules(
            context.get("actor"),
            eventOf(context),
            context.req.param("reportId") ?? "",
          ),
        }),
      );
    });

    app.post("/api/events/:eventId/reports/:reportId/schedules", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      const body = reportScheduleInputSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidReport(context, body.error.issues);
      const schedule = await reporting.createSchedule(
        context.get("actor"),
        eventOf(context),
        context.req.param("reportId") ?? "",
        body.data,
      );
      return context.json({ schedule }, 201);
    });

    app.delete("/api/events/:eventId/reports/:reportId/schedules/:scheduleId", async (context) => {
      const { reporting } = dependencies;
      if (!reporting) return noReporting(context);
      return context.json({
        changed: await reporting.removeSchedule(
          context.get("actor"),
          eventOf(context),
          context.req.param("reportId") ?? "",
          context.req.param("scheduleId") ?? "",
        ),
      });
    });

    /*
     * Resolving a share link. Anonymous, and a POST rather than a GET on purpose: the optional
     * password travels in a body rather than in a URL a browser would keep in history beside the
     * token it protects, and the resolve *spends a view*, which is a state change however it is
     * spelled. `DEBT-012` is the entry that says a capability URL leaks the way URLs leak; this
     * one adds the password, the expiry, the view limit and the revocation that entry withholds
     * from the itinerary.
     */
    app.post("/api/public/reports/:token", async (context) => {
      const { reporting } = dependencies;
      const parsed = reportShareTokenParamsSchema.safeParse(context.req.param());
      if (!reporting || !parsed.success)
        return context.json(
          envelope("NOT_FOUND", "That share link is not available.", context.get("correlationId")),
          404,
        );
      const body = reportShareResolveInputSchema.safeParse((await readJson(context.req)) ?? {});
      const resolved = await reporting.resolveShare(
        parsed.data.token,
        body.success ? body.data.password : undefined,
      );
      return context.json(
        reportShareResolvedResponseSchema.parse({
          report: {
            name: resolved.report.name,
            description: resolved.report.description,
            dataset: resolved.report.dataset,
          },
          result: resolved.result,
        }),
      );
    });
  },
  /**
   * The platform errors a caller can act on.
   *
   * The search route's own Zod check refuses a short query first, so that translation is the
   * defence behind it rather than the usual path: the service enforces its own minimum, and a
   * caller reaching it some other way is told the same thing on the same field instead of a 500.
   *
   * An unknown item key is a 404 rather than a validation failure, and the distinction is real:
   * the string was well formed, and what it names simply is not waiting on this event — either
   * because the condition resolved while the list was on screen, or because it never existed.
   */
  translateError(error: unknown): ErrorTranslation | null {
    if (error instanceof SearchQueryTooShortError)
      return {
        code: "VALIDATION_FAILED",
        message: "Search for at least two characters.",
        status: 400,
        fields: { q: [error.message] },
      };
    if (error instanceof InboxItemNotFoundError)
      return {
        code: "NOT_FOUND",
        message: "That item is no longer waiting on this event.",
        status: 404,
      };
    // A report that is not on this event and one that does not exist answer alike, so a report id
    // cannot be probed from an event it does not belong to.
    if (error instanceof ReportNotFoundError)
      return { code: "NOT_FOUND", message: "That report was not found.", status: 404 };
    if (error instanceof ReportNameTakenError)
      return {
        code: "CONFLICT",
        message: error.message,
        status: 409,
        fields: { name: [error.message] },
      };
    if (error instanceof ReportConflictError)
      return { code: "CONFLICT", message: error.message, status: 409 };
    if (error instanceof ReportInvalidError)
      return {
        code: "VALIDATION_FAILED",
        message: error.message,
        status: 400,
        fields: error.fields,
      };
    if (error instanceof ReportQueryInvalidError)
      return {
        code: "VALIDATION_FAILED",
        message: error.message,
        status: 400,
        fields: error.fields,
      };
    // Actionable, which is what issue #196 asks a cost bound to be: the message says to narrow it.
    if (error instanceof ReportTooExpensiveError)
      return { code: "VALIDATION_FAILED", message: error.message, status: 400 };
    if (error instanceof ReportPiiDeniedError)
      return { code: "FORBIDDEN", message: error.message, status: 403 };
    /*
     * One answer for an unknown token, a revoked link, an expired one, one out of views and a
     * wrong password. Telling them apart would say whether a guessed token named a real report.
     */
    if (error instanceof ReportShareUnavailableError)
      return { code: "NOT_FOUND", message: error.message, status: 404 };
    return null;
  },
};
