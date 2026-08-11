/**
 * Event identity and configuration: the list an actor may see, the one they may read, and creating a new one.
 *
 * Owned by the `events` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-EVT-001
 */
import { createEventInputSchema, eventIdParamsSchema } from "@greenroom/contracts";
import { requireCapability } from "../../../application/identity/actor";
import { createEventInputToCommand, eventToDto } from "../event-mappers";
import { envelope, validationFields, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/events",
  "GET /api/events/assigned",
  "POST /api/events",
  "GET /api/events/:eventId",
] as const;

export const eventsRoutes: RouteModule = {
  domain: "events",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { events: service } = dependencies;
    app.get("/api/events", async (context) =>
      context.json({ events: (await service.list(context.get("actor"))).map(eventToDto) }),
    );
    /*
     * Every event the signed-in actor holds any role on, whatever capabilities that role
     * carries — which is how the public demo identity, who holds no `events:read`, still sees
     * the event it was invited to.
     *
     * It lived at `GET /api/public/events` and answered 401 to anonymous callers, which made
     * "public" a lie and left the one namespace that has to work without a session holding a
     * route that cannot. Registered before `/api/events/:eventId` so the static segment wins
     * over the parameter.
     */
    app.get("/api/events/assigned", async (context) =>
      context.json({ events: (await service.listAssigned(context.get("actor"))).map(eventToDto) }),
    );
    app.post("/api/events", async (context) => {
      requireCapability(context.get("actor"), "events:create");
      const parsed = createEventInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The event could not be created.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      return context.json(
        {
          event: eventToDto(
            await service.create(context.get("actor"), createEventInputToCommand(parsed.data)),
          ),
        },
        201,
      );
    });
    app.get("/api/events/:eventId", async (context) => {
      requireCapability(context.get("actor"), "events:read");
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const event = await service.get(context.get("actor"), parsed.data.eventId);
      if (!event)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      return context.json({ event: eventToDto(event) });
    });
  },
};
