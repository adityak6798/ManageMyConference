/**
 * The extension point a domain implements to put itself on the HTTP surface.
 *
 * A domain adds routes by writing one module in this directory and adding one line to
 * `registry.ts`. It does not edit `app.ts`, and it does not edit another domain's module —
 * which is the whole point: CFP, review, content, CRM, agenda, communications and publishing
 * branches all used to modify one 1800-line `app.ts`, and every merge between them needed
 * manual conflict resolution over code neither branch had touched the meaning of.
 *
 * @spec ARC-001 ARC-DOM-001
 */
import type { Hono } from "hono";
import type { AgendaService } from "../../../application/agenda/public";
import type { CfpService } from "../../../application/cfp/public";
import type {
  AccelEventsSyncService,
  CommunicationsService,
  WebhookService,
} from "../../../application/communications/public";
import type { ContentService } from "../../../application/content/content-service";
import type { SpeakerCalendarInviteService } from "../../../application/content/public";
import type { CrmService } from "../../../application/crm/public";
import type { EventService } from "../../../application/events/event-service";
import type { EventTemplateService } from "../../../application/events/public";
import type { CustomRoleService } from "../../../application/identity/public";
import type { MembershipService } from "../../../application/identity/membership";
import type { ApiClientService } from "../../../application/identity/public";
import type {
  PlatformOperationsService,
  ReportingService,
} from "../../../application/platform/public";
import type {
  ItineraryService,
  PublicationService,
  SiteService,
} from "../../../application/publishing/public";
import type { ReviewService } from "../../../application/review/review-service";
import type {
  BuildIdentity,
  ErrorTranslator,
  RuntimeAuthConfig,
  StructuredLogger,
  Variables,
} from "../runtime";

export type HttpApp = Hono<{ Variables: Variables }>;

/**
 * Every service the transport can hand a route module, by name.
 *
 * Named rather than positional on purpose. The previous signature took eleven positional
 * parameters and sniffed which service it had been given by testing for a method on it
 * (`"organizerWorkspace" in reviewOrCfpService`), so passing the wrong one in the wrong slot
 * was a silent no-op rather than a type error.
 *
 * The services are optional because a test may compose only the domains it exercises.
 *
 * A module whose service is absent does **not** promise a graceful answer, and this is worth
 * being exact about. Some raise a typed domain error their own `translateError` maps to a 404
 * (agenda, CFP); others raise a plain `Error`, which the boundary handler turns into a 500. The
 * second is deliberate: a route reached with its service unwired is a composition bug, not a
 * caller mistake, and a 500 with the failure logged once is the honest answer to it. What none
 * of them do is answer as though the resource merely did not exist.
 */
export interface HttpDependencies {
  events: EventService;
  logger: StructuredLogger;
  auth: RuntimeAuthConfig;
  review?: ReviewService | undefined;
  cfp?: CfpService | undefined;
  content?: ContentService | undefined;
  /**
   * Sends speakers the iTIP invitation for their own sessions.
   *
   * Separate from `content` because it composes two domains — content's session and speaker data
   * and communications' outbox — and holds the configured sender address that becomes every
   * invitation's `ORGANIZER`.
   */
  speakerCalendarInvites?: SpeakerCalendarInviteService | undefined;
  crm?: CrmService | undefined;
  /**
   * Organization membership and event-role administration.
   *
   * On `HttpDependencies` rather than on `auth`, and the difference is not cosmetic: `auth`
   * carries what the transport needs to *resolve a credential*, and this is a domain service the
   * way `crm` and `review` are. It is also why a demo-mode deployment gets one — the members
   * screen is a real console surface a persona can open, while every write behind it refuses a
   * persona.
   */
  membership?: MembershipService | undefined;
  /**
   * Custom event roles and their per-field View/Lock/Hide policies (issue #196).
   *
   * Separate from `membership` because it administers a different thing — what a role *is*,
   * rather than who holds one — and because a deployment can perfectly well offer membership
   * administration without it, in which case those routes 404 rather than 500.
   */
  customRoles?: CustomRoleService | undefined;
  /** Organization-scoped machine-credential administration. */
  apiClients?: ApiClientService | undefined;
  agenda?: AgendaService | undefined;
  communications?: CommunicationsService | undefined;
  webhooks?: WebhookService | undefined;
  /** The inbound Accelevents registration sync, and the last-run state its surface reads. */
  accelEventsSync?: AccelEventsSyncService | undefined;
  publishing?: PublicationService | undefined;
  itineraries?: ItineraryService | undefined;
  /**
   * Organization-owned portals composing several programs (issue #196).
   *
   * Separate from `publishing` because a Site is not a public-event projection and shares none of
   * its machinery: it composes pointers to programs other domains own, resolved at read time.
   */
  sites?: SiteService | undefined;
  eventTemplates?: EventTemplateService | undefined;
  platformOps?: PlatformOperationsService | undefined;
  /**
   * Saved reports, their share links and their schedules (issue #196).
   *
   * Separate from `platformOps` because it owns durable state — definitions, shares, schedules,
   * runs — while the operations service derives everything it answers on each request. A
   * deployment composed without it answers 404 on the reporting routes rather than 500.
   */
  reporting?: ReportingService | undefined;
  build?: BuildIdentity | undefined;
}

export interface RouteModule {
  /** The `context-manifest.json` domain that owns this module. */
  readonly domain: string;
  /**
   * Every route this module registers, as `"METHOD /path"`.
   *
   * Declared rather than discovered so that two domains claiming one route is a startup
   * failure with both domains named, instead of whichever module happened to register last
   * quietly winning.
   */
  readonly routes: readonly string[];
  /**
   * Middleware this module needs to run before *any* route handler in the app, whoever owns it.
   *
   * Hono's matching order is registration order, and middleware only applies to handlers
   * registered after it. So a module that mounts middleware inside `register` covers the modules
   * listed below it and nothing above — an invariant carried by the order of an array, which the
   * next person to sort it alphabetically would silently delete.
   *
   * `createHttpAppFrom` runs every module's `registerRequestScope` before it registers any
   * module's routes, so what is mounted here applies to the whole surface regardless of where its
   * module sits in the registry. Platform's audit attribution is the case this exists for
   * (issue #178): it has to see the resolved actor of a request whose mutation happens in another
   * domain's route.
   *
   * Mount only per-request middleware here, and only middleware that must precede other domains'
   * handlers. Anything scoped to this module's own routes belongs in `register`.
   */
  registerRequestScope?(app: HttpApp, dependencies: HttpDependencies): void;
  register(app: HttpApp, dependencies: HttpDependencies): void;
  /**
   * Translate this domain's application errors into a caller-facing refusal, or return null
   * to pass. Owning this here is what keeps `app.ts`'s error handler from being a second
   * central file that every domain has to edit.
   */
  readonly translateError?: ErrorTranslator;
}
