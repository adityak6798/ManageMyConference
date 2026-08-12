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
import type { CommunicationsService } from "../../../application/communications/public";
import type { ContentService } from "../../../application/content/content-service";
import type { CrmService } from "../../../application/crm/public";
import type { EventService } from "../../../application/events/event-service";
import type { PublicationService } from "../../../application/publishing/public";
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
  crm?: CrmService | undefined;
  agenda?: AgendaService | undefined;
  communications?: CommunicationsService | undefined;
  publishing?: PublicationService | undefined;
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
  register(app: HttpApp, dependencies: HttpDependencies): void;
  /**
   * Translate this domain's application errors into a caller-facing refusal, or return null
   * to pass. Owning this here is what keeps `app.ts`'s error handler from being a second
   * central file that every domain has to edit.
   */
  readonly translateError?: ErrorTranslator;
}
