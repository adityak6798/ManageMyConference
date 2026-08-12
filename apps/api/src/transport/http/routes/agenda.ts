/**
 * Rooms, tracks, slots, placements, and the publication that freezes a schedule for the public site.
 *
 * Owned by the `agenda` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-AGD-001
 */
import {
  agendaIdParamsSchema,
  agendaPlacementSchema,
  agendaResourcesSchema,
} from "@greenroom/contracts";
import {
  AgendaConflictError,
  AgendaNotFoundError,
  AgendaResourceInUseError,
} from "../../../application/agenda/public";
import { requireEventCapability } from "../../../application/identity/actor";
import { envelope, validationFields, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events/:eventId/agenda",
  "PUT /api/events/:eventId/agenda/resources",
  "PUT /api/events/:eventId/agenda/placements/:placementId",
  "DELETE /api/events/:eventId/agenda/placements/:placementId",
  "POST /api/events/:eventId/agenda/publications",
] as const;

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
      return context.json(
        { schedule: await agenda.publish(context.get("actor"), parsed.data.eventId) },
        201,
      );
    });
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
    return null;
  },
};
