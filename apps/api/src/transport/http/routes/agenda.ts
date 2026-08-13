/**
 * Rooms, tracks, slots, placements, and the publication that freezes a schedule for the public site.
 *
 * Owned by the `agenda` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-AGD-001
 */
import {
  agendaAutoPlaceSchema,
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
} from "@greenroom/contracts";
import {
  AgendaConflictError,
  AgendaNotFoundError,
  AgendaPublicationConflictError,
  AgendaResourceInUseError,
  type ScheduleReconciliation,
} from "../../../application/agenda/public";
import { requireEventCapability } from "../../../application/identity/actor";
import type { Context } from "hono";
import { envelope, validationFields, readJson, type Variables } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

type AgendaContext = Context<{ Variables: Variables }>;

const routes = [
  "GET /api/events/:eventId/agenda",
  "PUT /api/events/:eventId/agenda/resources",
  "PUT /api/events/:eventId/agenda/placements/:placementId",
  "POST /api/events/:eventId/agenda/assisted-placements",
  "DELETE /api/events/:eventId/agenda/placements/:placementId",
  "POST /api/events/:eventId/agenda/publications",
  "GET /api/events/:eventId/agenda/schedule-reconciliation",
  "POST /api/events/:eventId/agenda/schedule-reconciliation",
] as const;

/**
 * The application's reconciliation, as the wire reports it.
 *
 * `inSync` is passed through rather than recomputed from `drift`. An earlier version derived it
 * here, and the two answers diverged for exactly the events migration `1602` backfills: correct
 * rows, an unclaimed watermark, so the wire said "in sync" while the reconciler kept queueing the
 * event for repair and the `POST` on the same event answered `repaired: true`. One definition,
 * held by the storage that decides it.
 */
const reconciliationBody = (report: ScheduleReconciliation) => ({
  eventId: report.eventId,
  publicationWatermark: report.publicationWatermark,
  materializedWatermark: report.materializedWatermark,
  publications: report.publications,
  inSync: report.inSync,
  repaired: report.repaired,
  drift: report.drift,
});

export const agendaRoutes: RouteModule = {
  domain: "agenda",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { agenda } = dependencies;
    app.get("/api/events/:eventId/agenda", async (context) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const parsed = agendaIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      return context.json({
        agenda: await agenda.draft(context.get("actor"), parsed.data.eventId),
      });
    });
    app.put("/api/events/:eventId/agenda/resources", async (context) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const params = agendaIdParamsSchema.safeParse(context.req.param());
      const body = agendaResourcesSchema.safeParse(await readJson(context.req));
      if (!params.success || !body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Agenda resources are invalid.",
            context.get("correlationId"),
            body.success ? undefined : validationFields(body.error.issues),
          ),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "agenda:manage");
      return context.json({
        agenda: await agenda.configure(context.get("actor"), params.data.eventId, body.data),
      });
    });
    app.put("/api/events/:eventId/agenda/placements/:placementId", async (context) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const params = agendaIdParamsSchema.safeParse(context.req.param());
      const body = agendaPlacementSchema.safeParse(await readJson(context.req));
      if (!params.success || !body.success || body.data.id !== context.req.param("placementId"))
        return context.json(
          envelope("VALIDATION_FAILED", "Placement is invalid.", context.get("correlationId")),
          400,
        );
      requireEventCapability(context.get("actor"), params.data.eventId, "agenda:manage");
      return context.json({
        agenda: await agenda.place(context.get("actor"), params.data.eventId, body.data),
      });
    });
    /*
     * Generating a draft is a placement edit, not a publication: it writes the same draft rows
     * a drag writes, needs the same `agenda:manage`, and reaches no public surface. It is a
     * POST because it is not idempotent in the HTTP sense — the board it produces depends on
     * the board it starts from — though re-running it converges rather than duplicating,
     * because each session's assisted placement keeps the same id.
     */
    app.post("/api/events/:eventId/agenda/assisted-placements", async (context) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const params = agendaIdParamsSchema.safeParse(context.req.param());
      if (!params.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      // Authorized before the body is read, so an unauthenticated caller is told it is
      // unauthenticated rather than being handed a critique of a payload it may not send.
      requireEventCapability(context.get("actor"), params.data.eventId, "agenda:manage");
      // "Place everything" is the natural meaning of this action, so an absent body means it.
      // A body that is present but not JSON is still a caller mistake and still fails.
      const body = agendaAutoPlaceSchema.safeParse(
        context.req.raw.body === null ? {} : ((await readJson(context.req)) ?? {}),
      );
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Assisted placement request is invalid.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      return context.json({
        agenda: await agenda.autoPlace(
          context.get("actor"),
          params.data.eventId,
          body.data.sessionIds,
        ),
      });
    });
    app.delete("/api/events/:eventId/agenda/placements/:placementId", async (context) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const parsed = agendaIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      await agenda.remove(
        context.get("actor"),
        parsed.data.eventId,
        context.req.param("placementId"),
      );
      return context.body(null, 204);
    });
    app.post("/api/events/:eventId/agenda/publications", async (context) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const parsed = agendaIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      /*
       * `Idempotency-Key` is optional and means "this is a retry of one intent, not a new one".
       * Without it every call allocates the next version, which is correct for an organizer
       * pressing Publish again after editing; with it, a client that never saw the first
       * response gets that response rather than a second immutable version of the same board.
       */
      const commandKey = context.req.header("idempotency-key")?.trim();
      // The key is stored for idempotency and not echoed: it tells the caller only what the
      // caller already sent, and `publishedScheduleSchema` is the shape this route promises.
      const { commandKey: _storedKey, ...schedule } = await agenda.publish(
        context.get("actor"),
        parsed.data.eventId,
        commandKey || undefined,
      );
      return context.json({ schedule }, 201);
    });
    /*
     * Does the stored schedule still describe the publication history, and can it be put right?
     *
     * Two methods on one path because they are the same question asked with and without consent
     * to act on the answer. `GET` replays and compares and writes nothing at all, which is what
     * makes it usable for "is this event sound" — a check that repaired as a side effect could
     * only ever be run once. `POST` does the same work and then writes the replayed answer back.
     *
     * Neither is the primary defence, and saying so here keeps the next reader from over-reading
     * them: every read of a schedule already re-derives a drifted answer before serving it, and
     * the one-minute tick sweeps the events nobody reads. What only these routes can do is find a
     * divergence the watermark cannot see — a derived table edited directly leaves the watermark
     * undisturbed, so no cheap check will ever notice it — and answer the question without
     * changing it (issue #169, closing `GAP-024`).
     */
    const reconciliation = (repair: boolean) => async (context: AgendaContext) => {
      if (!agenda) throw new AgendaNotFoundError("Agenda not configured");
      const parsed = agendaIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      return context.json({
        reconciliation: reconciliationBody(
          await agenda.reconcileSchedule(context.get("actor"), parsed.data.eventId, { repair }),
        ),
      });
    };
    app.get("/api/events/:eventId/agenda/schedule-reconciliation", reconciliation(false));
    app.post("/api/events/:eventId/agenda/schedule-reconciliation", reconciliation(true));
    /*
     * The public schedule is addressed by the event's public slug, like every other public
     * route, and is gated on the publication being live: unpublishing has to take the whole
     * public surface down.
     *
     * The slug is not a secrecy measure, and nothing here pretends otherwise: the projection
     * this route reads publishes `event.eventId` to anonymous callers, and that UUID is the
     * address of `GET /api/public/events/{eventId}/cfp` and
     * `POST /api/public/events/{eventId}/submissions`, which is how the public CFP form is
     * fetched and filled in. The slug is the *readable, stable* public name — derived from the
     * event's own name, never a storage id — and using it consistently is what keeps storage
     * identifiers out of the addresses a visitor sees, links, and shares. Authorization is
     * carried by publication state on every one of these routes, never by an unguessable id.
     *
     * Publishing owns "is this event public"; agenda owns the snapshot. Neither reads the
     * other's tables — this route composes their two public application interfaces.
     *
     * What each contributes is deliberate. The agenda publication says *whether* a numbered
     * immutable snapshot exists and *which* one is in force; the published projection says
     * what may be shown. Handing back the agenda snapshot itself published the organizer's
     * whole board — a session still in `draft` came out with its title, and every session
     * and speaker arrived as its storage UUID — on the one route whose entire purpose is the
     * published surface (`ACC-AGENDA`, `PRD-PUB-001`).
     *
     * So the placement detail here is the projection's copy, which is the same copy the event
     * hub serves: the two public views of one session can never disagree. Republishing the
     * agenda advances `version` before that detail follows, exactly as republishing any other
     * source moves ahead of the snapshot until the organizer publishes the site again — which
     * is the rule `PRD-PUB-001` states for the whole public surface, and which the publishing
     * workspace already reports on screen.
     */
  },
  translateError(error: unknown) {
    if (error instanceof AgendaConflictError)
      return {
        code: "AGENDA_CONFLICT" as const,
        message: "Resolve schedule conflicts before publishing.",
        status: 409 as const,
        fields: {
          conflicts: error.conflicts.map(
            ({ kind, resourceId, message }) => `${kind}:${resourceId}: ${message}`,
          ),
        },
      };
    if (error instanceof AgendaNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "The requested resource was not found.",
        status: 404 as const,
      };
    if (error instanceof AgendaResourceInUseError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 409 as const };
    // Losing the version race repeatedly is contention, not a malformed request: the board is
    // publishable and the same command will succeed once the concurrent publications settle.
    if (error instanceof AgendaPublicationConflictError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    return null;
  },
};
