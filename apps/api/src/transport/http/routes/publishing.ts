/**
 * The public event projection, the organizer's preview of it, and the published schedule the embed reads.
 *
 * Owned by the `publishing` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-PUB-001
 */
import {
  eventIdParamsSchema,
  publicEventProjectionSchema,
  publicEventSlugParamsSchema,
  publicScheduleSchema,
  publicationPreviewResponseSchema,
} from "@greenroom/contracts";
import { composePublicSchedule } from "../../../application/publishing/public";
import { envelope } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/public/events/:slug",
  "GET /api/publishing/events/:eventId/preview",
  // Registered by the loop below rather than one call each, which is exactly why they are
  // listed by hand: the table is what the duplicate check reads, so a route it cannot see is a
  // route another domain could claim without the construction-time failure this registry
  // promises.
  "POST /api/publishing/events/:eventId/publish",
  "POST /api/publishing/events/:eventId/unpublish",
  "GET /api/public/events/:slug/schedule",
] as const;

export const publishingRoutes: RouteModule = {
  domain: "publishing",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { publishing, agenda } = dependencies;
    app.get("/api/public/events/:slug", async (context) => {
      const slug = context.req.param("slug");
      if (!publishing || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        return context.json(
          envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
          404,
        );
      const parsed = publicEventProjectionSchema.safeParse(await publishing.publicBySlug(slug));
      if (!parsed.success)
        return context.json(
          envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
          404,
        );
      // Cache policy for this namespace belongs to the `/api/public/*` middleware above, which
      // gives every public representation the same bounded lifetime and an ETag.
      return context.json({ projection: parsed.data });
    });
    app.get("/api/publishing/events/:eventId/preview", async (context) => {
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const publication = await publishing?.preview(context.get("actor"), parsed.data.eventId);
      if (!publication)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      return context.json(publicationPreviewResponseSchema.parse({ publication }));
    });
    for (const action of ["publish", "unpublish"] as const)
      app.post(`/api/publishing/events/:eventId/${action}`, async (context) => {
        const parsed = eventIdParamsSchema.safeParse(context.req.param());
        if (!parsed.success)
          return context.json(
            envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
            400,
          );
        const publication =
          action === "publish"
            ? await publishing?.publish(context.get("actor"), parsed.data.eventId)
            : await publishing?.unpublish(context.get("actor"), parsed.data.eventId);
        if (!publication)
          return context.json(
            envelope(
              "NOT_FOUND",
              "The requested resource was not found.",
              context.get("correlationId"),
            ),
            404,
          );
        return context.json(publicationPreviewResponseSchema.parse({ publication }));
      });
    app.get("/api/public/events/:slug/schedule", async (context) => {
      const notPublished = () =>
        context.json(
          envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
          404,
        );
      const parsed = publicEventSlugParamsSchema.safeParse(context.req.param());
      // An unknown slug, a malformed slug, an unpublished event and an unpublished agenda
      // are one indistinguishable response, so the route cannot be used to enumerate events.
      if (!parsed.success || !agenda || !publishing) return notPublished();
      const projection = await publishing.publicBySlug(parsed.data.slug);
      if (!projection) return notPublished();
      const publication = await agenda.published(projection.event.eventId);
      if (!publication) return notPublished();
      // Parsed, not merely composed: the contract is what leaves the process, and a stored
      // snapshot that cannot satisfy it is withheld exactly like an unpublished one.
      const schedule = publicScheduleSchema.safeParse(
        composePublicSchedule(projection, publication),
      );
      if (!schedule.success) return notPublished();
      return context.json({ schedule: schedule.data });
    });
  },
};
