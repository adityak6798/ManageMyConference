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
  itineraryCreatedResponseSchema,
  itineraryInputSchema,
  itineraryResponseSchema,
  itineraryTokenParamsSchema,
  publicationPreviewResponseSchema,
  publicationSettingsInputSchema,
  publicEventProjectionSchema,
  publicEventSlugParamsSchema,
  publicScheduleSchema,
  publicSitePageResponseSchema,
  publicSiteResponseSchema,
  siteConsentsResponseSchema,
  siteDetailResponseSchema,
  siteDraftSchema,
  sitePageParamsSchema,
  sitePrivacyNoticeInputSchema,
  sitePrivacyNoticeResponseSchema,
  siteRegistrationInputSchema,
  siteRegistrationResponseSchema,
  siteResponseSchema,
  siteRevisionInputSchema,
  sitesResponseSchema,
  siteSlugParamsSchema,
  siteUpdateSchema,
} from "@greenroom/contracts";
import {
  composePublicSchedule,
  ItineraryNotFoundError,
  PublicationSettingsError,
  PublicationSlugTakenError,
  SiteAlreadyRegisteredError,
  SiteConflictError,
  SiteConsentUnavailableError,
  SiteInvalidError,
  SiteNotFoundError,
  SiteSlugTakenError,
} from "../../../application/publishing/public";
import { envelope, type HttpContext, readJson, validationFields } from "../runtime";
import { clientAddress, FixedWindowThrottle } from "../throttle";
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
  "PATCH /api/publishing/events/:eventId/settings",
  "GET /api/public/events/:slug/schedule",
  // Attendee itineraries. Anonymous, and addressed by a capability token in the path — see
  // the comment on the mint route for why the token is in the URL rather than in a cookie.
  "POST /api/public/events/:slug/itinerary",
  "GET /api/public/itineraries/:token",
  "POST /api/public/itineraries/:token",
  /*
   * Sites and portals (issue #196). Their public prefix is `/api/public/sites/*`, which is what
   * keeps a Site's address and an event's address from ever needing to reserve against each
   * other: they are different namespaces rather than one namespace with two kinds of row.
   */
  "GET /api/public/sites/:slug",
  "GET /api/public/sites/:slug/pages/:pageSlug",
  "POST /api/public/sites/:slug/registrations",
  "GET /api/publishing/organizations/:organizationId/sites",
  "POST /api/publishing/organizations/:organizationId/sites",
  "GET /api/publishing/organizations/:organizationId/sites/:siteId",
  "PUT /api/publishing/organizations/:organizationId/sites/:siteId",
  "POST /api/publishing/organizations/:organizationId/sites/:siteId/privacy-notice",
  "POST /api/publishing/organizations/:organizationId/sites/:siteId/publish",
  "POST /api/publishing/organizations/:organizationId/sites/:siteId/unpublish",
  "GET /api/publishing/organizations/:organizationId/sites/:siteId/consents",
] as const;

/*
 * Minting an itinerary is row creation by an unauthenticated caller, so it is throttled
 * exactly as anonymous CFP submission is.
 *
 * The key is the caller's address ALONE. `throttle.ts` states the rule this obeys: the
 * counter table is bounded and evicts its oldest window when full, so a caller who can mint
 * distinct keys can evict its own exhausted counter and start over. The event slug comes
 * from the path and is never checked for existence before this point, so keying on it would
 * hand out exactly that ability.
 */
const itineraryThrottle = new FixedWindowThrottle(20, 60_000);

/*
 * Portal registration is the other anonymous row-creating write, and it is throttled on the same
 * terms and for the same reason. Tighter than itinerary minting because a registration carries a
 * name and an address: the cost of a flood is somebody's inbox rather than a wasted row.
 */
const registrationThrottle = new FixedWindowThrottle(10, 60_000);

export const publishingRoutes: RouteModule = {
  domain: "publishing",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { publishing, agenda, itineraries, sites, auth } = dependencies;
    app.get("/api/public/events/:slug", async (context) => {
      const slug = context.req.param("slug");
      if (!publishing || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        return context.json(
          envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
          404,
        );
      const snapshot = await publishing.publicSnapshotBySlug(slug);
      const parsed = publicEventProjectionSchema.safeParse(snapshot?.projection);
      if (!snapshot || !parsed.success)
        return context.json(
          envelope("NOT_FOUND", "This event is not published.", context.get("correlationId")),
          404,
        );
      // Cache policy for this namespace belongs to the `/api/public/*` middleware above, which
      // gives every public representation the same bounded lifetime and an ETag.
      return context.json({
        projection: parsed.data,
        publication: {
          version: snapshot.version,
          publishedAt: snapshot.publishedAt,
          provenance: snapshot.provenance,
        },
      });
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
    /*
     * The only write in this module that is not a state transition. It edits the draft the
     * organizer is composing — `summary`, `venue`, the two dates and the public address —
     * and deliberately leaves the published snapshot alone, so an edit here changes what
     * publishing *would* produce rather than what visitors are being served.
     */
    app.patch("/api/publishing/events/:eventId/settings", async (context) => {
      const parsed = eventIdParamsSchema.safeParse(context.req.param());
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const body = publicationSettingsInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Review the highlighted public details.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const publication = await publishing?.updateSettings(
        context.get("actor"),
        parsed.data.eventId,
        body.data,
      );
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
      if (!parsed.success || !publishing) return notPublished();
      const snapshot = await publishing.publicSnapshotBySlug(parsed.data.slug);
      if (!snapshot) return notPublished();
      let agendaVersion = snapshot.provenance?.agendaVersion;
      let agendaPublishedAt = snapshot.provenance?.agendaPublishedAt;
      /*
       * Rows composed before migration 1803 have no provenance. A public read through the D1
       * repository reconciles and fills it before reaching here; this fallback is for legacy
       * in-memory compositions only, and can disappear once every test adapter versions snapshots.
       */
      if ((!agendaVersion || !agendaPublishedAt) && agenda) {
        const legacy = await agenda.published(snapshot.projection.event.eventId);
        agendaVersion = legacy?.version;
        agendaPublishedAt = legacy?.publishedAt;
      }
      if (!agendaVersion || !agendaPublishedAt) return notPublished();
      // Parsed, not merely composed: the contract is what leaves the process, and a stored
      // snapshot that cannot satisfy it is withheld exactly like an unpublished one.
      const schedule = publicScheduleSchema.safeParse(
        composePublicSchedule(snapshot.projection, {
          version: agendaVersion,
          publishedAt: agendaPublishedAt,
        }),
      );
      if (!schedule.success) return notPublished();
      return context.json({ schedule: schedule.data });
    });

    /*
     * ---- attendee itineraries ---------------------------------------------
     *
     * These live under `/api/public/*` and read no session, which keeps the namespace's
     * promise intact. That promise is load-bearing rather than decorative: the CORS policy
     * answers every origin with `Access-Control-Allow-Origin: *`, browsers refuse to send
     * credentials to a wildcard origin, and so a cookie could not identify an attendee on
     * an embedded page even if one were set.
     *
     * The token therefore goes in the path, which also settles the caching question. These
     * responses are ETagged and revalidated by shared caches; a per-attendee body on one
     * shared URL would be served to the wrong attendee. One itinerary, one URL, and the
     * cache key is correct by construction.
     *
     * The trade is real and stated rather than hidden: a capability URL leaks through
     * referrer headers, browser history and shared screens. For a list of public sessions
     * somebody starred, that is an acceptable exchange for needing no account.
     */
    const itineraryNotFound = (correlationId: string) =>
      envelope("NOT_FOUND", "This itinerary was not found.", correlationId);

    app.post("/api/public/events/:slug/itinerary", async (context) => {
      const throttled = itineraryThrottle.check(
        clientAddress(context.req.raw.headers),
        (auth.now ?? Date.now)(),
      );
      if (!throttled.allowed) {
        context.header("retry-after", String(throttled.retryAfterSeconds));
        return context.json(
          envelope(
            "RATE_LIMITED",
            "Too many itineraries from this address. Try again shortly.",
            context.get("correlationId"),
          ),
          429,
        );
      }
      const parsed = publicEventSlugParamsSchema.safeParse(context.req.param());
      if (!parsed.success || !itineraries)
        return context.json(itineraryNotFound(context.get("correlationId")), 404);
      /*
       * The body is required and a malformed one is refused rather than quietly treated as
       * an empty itinerary. It used to be the second: the contract advertised the body as
       * optional while `readJson` rejected an absent one, and any body that parsed as JSON
       * but failed the schema — an over-limit list, a slug that is not a slug — produced a
       * 201 with nothing saved, which is the least useful answer available.
       */
      const body = itineraryInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The itinerary could not be created.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const created = await itineraries.create(parsed.data.slug, body.data.sessionSlugs);
      return context.json(itineraryCreatedResponseSchema.parse(created), 201);
    });

    app.get("/api/public/itineraries/:token", async (context) => {
      const parsed = itineraryTokenParamsSchema.safeParse(context.req.param());
      if (!parsed.success || !itineraries)
        return context.json(itineraryNotFound(context.get("correlationId")), 404);
      const itinerary = await itineraries.read(parsed.data.token);
      return context.json(itineraryResponseSchema.parse({ itinerary }));
    });

    app.post("/api/public/itineraries/:token", async (context) => {
      const parsed = itineraryTokenParamsSchema.safeParse(context.req.param());
      if (!parsed.success || !itineraries)
        return context.json(itineraryNotFound(context.get("correlationId")), 404);
      const body = itineraryInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "The itinerary could not be saved.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const itinerary = await itineraries.save(parsed.data.token, body.data.sessionSlugs);
      return context.json(itineraryResponseSchema.parse({ itinerary }));
    });

    /*
     * ---- Sites and portals (issue #196) -----------------------------------
     *
     * The public reads answer a draft, an unpublished Site and an unknown address identically, so
     * the routes cannot be used to discover a portal somebody is still preparing — the same rule
     * the public event hub follows.
     *
     * Registration is a row created by an unauthenticated caller, so it is throttled exactly as
     * itinerary minting and anonymous CFP submission are, and on the caller's address alone for
     * the reason `throttle.ts` states.
     */
    const noSite = (correlationId: string) =>
      envelope("NOT_FOUND", "This site is not published.", correlationId);
    const siteScope = (context: HttpContext) =>
      [context.req.param("organizationId") ?? "", context.req.param("siteId") ?? ""] as const;
    const invalidSite = (context: HttpContext, error: { issues: readonly unknown[] }) =>
      context.json(
        envelope(
          "VALIDATION_FAILED",
          "Review the highlighted site details.",
          context.get("correlationId"),
          validationFields(error.issues as never),
        ),
        400,
      );

    app.get("/api/public/sites/:slug", async (context) => {
      const parsed = siteSlugParamsSchema.safeParse(context.req.param());
      if (!parsed.success || !sites) return context.json(noSite(context.get("correlationId")), 404);
      const site = await sites.publicSite(parsed.data.slug);
      if (!site) return context.json(noSite(context.get("correlationId")), 404);
      return context.json(publicSiteResponseSchema.parse({ site }));
    });

    app.get("/api/public/sites/:slug/pages/:pageSlug", async (context) => {
      const parsed = sitePageParamsSchema.safeParse(context.req.param());
      if (!parsed.success || !sites) return context.json(noSite(context.get("correlationId")), 404);
      const found = await sites.publicPage(parsed.data.slug, parsed.data.pageSlug);
      // A hidden page is *not found* rather than forbidden: telling a visitor a page exists but
      // is not for them is the enumeration the public namespace avoids everywhere else.
      if (!found) return context.json(noSite(context.get("correlationId")), 404);
      return context.json(publicSitePageResponseSchema.parse(found));
    });

    app.post("/api/public/sites/:slug/registrations", async (context) => {
      const throttled = registrationThrottle.check(
        clientAddress(context.req.raw.headers),
        (auth.now ?? Date.now)(),
      );
      if (!throttled.allowed) {
        context.header("retry-after", String(throttled.retryAfterSeconds));
        return context.json(
          envelope(
            "RATE_LIMITED",
            "Too many registrations from this address. Try again shortly.",
            context.get("correlationId"),
          ),
          429,
        );
      }
      const parsed = siteSlugParamsSchema.safeParse(context.req.param());
      if (!parsed.success || !sites) return context.json(noSite(context.get("correlationId")), 404);
      const body = siteRegistrationInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Review the highlighted registration details.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const recorded = await sites.register(parsed.data.slug, {
        name: body.data.name,
        email: body.data.email,
        accepted: body.data.accepted,
        answers: body.data.answers ?? {},
      });
      return context.json(
        siteRegistrationResponseSchema.parse({ registered: true, ...recorded }),
        201,
      );
    });

    const noSites = (context: HttpContext) =>
      context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );

    app.get("/api/publishing/organizations/:organizationId/sites", async (context) => {
      if (!sites) return noSites(context);
      const [organizationId] = siteScope(context);
      return context.json(
        sitesResponseSchema.parse({
          sites: await sites.list(context.get("actor"), organizationId),
        }),
      );
    });

    app.post("/api/publishing/organizations/:organizationId/sites", async (context) => {
      if (!sites) return noSites(context);
      const body = siteDraftSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidSite(context, body.error);
      const [organizationId] = siteScope(context);
      return context.json(
        siteResponseSchema.parse({
          site: await sites.create(context.get("actor"), organizationId, body.data),
        }),
        201,
      );
    });

    app.get("/api/publishing/organizations/:organizationId/sites/:siteId", async (context) => {
      if (!sites) return noSites(context);
      const [organizationId, siteId] = siteScope(context);
      return context.json(
        siteDetailResponseSchema.parse(
          await sites.get(context.get("actor"), organizationId, siteId),
        ),
      );
    });

    app.put("/api/publishing/organizations/:organizationId/sites/:siteId", async (context) => {
      if (!sites) return noSites(context);
      const body = siteUpdateSchema.safeParse(await readJson(context.req));
      if (!body.success) return invalidSite(context, body.error);
      const [organizationId, siteId] = siteScope(context);
      return context.json(
        siteResponseSchema.parse({
          site: await sites.update(context.get("actor"), organizationId, siteId, body.data),
        }),
      );
    });

    app.post(
      "/api/publishing/organizations/:organizationId/sites/:siteId/privacy-notice",
      async (context) => {
        if (!sites) return noSites(context);
        const body = sitePrivacyNoticeInputSchema.safeParse(await readJson(context.req));
        if (!body.success) return invalidSite(context, body.error);
        const [organizationId, siteId] = siteScope(context);
        return context.json(
          sitePrivacyNoticeResponseSchema.parse(
            await sites.publishPrivacyNotice(
              context.get("actor"),
              organizationId,
              siteId,
              body.data.bodyHtml,
            ),
          ),
          201,
        );
      },
    );

    for (const action of ["publish", "unpublish"] as const)
      app.post(
        `/api/publishing/organizations/:organizationId/sites/:siteId/${action}`,
        async (context) => {
          if (!sites) return noSites(context);
          const body = siteRevisionInputSchema.safeParse(await readJson(context.req));
          if (!body.success) return invalidSite(context, body.error);
          const [organizationId, siteId] = siteScope(context);
          const site =
            action === "publish"
              ? await sites.publish(
                  context.get("actor"),
                  organizationId,
                  siteId,
                  body.data.expectedRevision,
                )
              : await sites.unpublish(
                  context.get("actor"),
                  organizationId,
                  siteId,
                  body.data.expectedRevision,
                );
          return context.json(siteResponseSchema.parse({ site }));
        },
      );

    app.get(
      "/api/publishing/organizations/:organizationId/sites/:siteId/consents",
      async (context) => {
        if (!sites) return noSites(context);
        const [organizationId, siteId] = siteScope(context);
        return context.json(
          siteConsentsResponseSchema.parse({
            consents: await sites.consents(context.get("actor"), organizationId, siteId),
          }),
        );
      },
    );
  },
  translateError(error: unknown) {
    // One answer for an unknown token, an unpublished event and a withdrawn one, so the
    // route cannot be used to tell those apart — the same rule the public event hub follows.
    if (error instanceof ItineraryNotFoundError)
      return { code: "NOT_FOUND" as const, message: error.message, status: 404 as const };
    if (error instanceof PublicationSlugTakenError)
      return {
        code: "CONFLICT" as const,
        message: error.message,
        status: 409 as const,
        // Named so the form can put the refusal on the field that caused it, rather than
        // printing "already taken" above a form of five inputs.
        fields: { slug: [error.message] },
      };
    /*
     * A Site that is not in this organization, one that does not exist, and an unpublished one
     * are a single 404 — the same indistinguishability rule the public event hub follows, so a
     * site id cannot be probed from an organization it does not belong to.
     */
    if (error instanceof SiteNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "That site was not found.",
        status: 404 as const,
      };
    if (error instanceof SiteSlugTakenError)
      return {
        code: "CONFLICT" as const,
        message: error.message,
        status: 409 as const,
        fields: { slug: [error.message] },
      };
    if (error instanceof SiteConflictError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    if (error instanceof SiteInvalidError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
        fields: error.fields,
      };
    // 409 rather than 400: the registrant did nothing wrong, and telling them they are already
    // registered is more useful than refusing the form they just filled in.
    if (error instanceof SiteAlreadyRegisteredError)
      return {
        code: "CONFLICT" as const,
        message: "That address is already registered for this site.",
        status: 409 as const,
      };
    if (error instanceof SiteConsentUnavailableError)
      return {
        code: "CONFLICT" as const,
        message: "This site is not accepting registrations yet.",
        status: 409 as const,
      };
    if (error instanceof PublicationSettingsError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
        // Both fields: the failure describes the relationship between them, and the
        // translator cannot know which one the organizer actually touched. Naming only
        // `endsOn` highlighted an untouched input and left the changed one unexplained.
        fields: { startsOn: [error.message], endsOn: [error.message] },
      };
    return null;
  },
};
