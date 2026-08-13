import { createDeliverablesZip } from "./adapters/content/create-deliverables-zip";
import { D1SpeakerConversion } from "./adapters/content/d1-speaker-conversion";
import { parseSpeakerCsv } from "./adapters/content/parse-speaker-csv";
import {
  sanitizeResourceEmbed,
  sanitizeResourceHtml,
} from "./adapters/content/sanitize-resource-html";
import { D1AgendaRepository } from "./adapters/persistence/d1-agenda-repository";
import { D1CfpRepository } from "./adapters/persistence/d1-cfp-repository";
import { D1AccelEventsSyncRuns } from "./adapters/persistence/d1-accelevents-sync-runs";
import {
  D1CommunicationsRepository,
  preparedDeliveryWriter,
} from "./adapters/persistence/d1-communications-repository";
import { D1ContentRepository } from "./adapters/persistence/d1-content-repository";
import { D1CrmRepository } from "./adapters/persistence/d1-crm-repository";
import { type D1DatabasePort, D1EventRepository } from "./adapters/persistence/d1-event-repository";
import { D1IdentityDirectory } from "./adapters/persistence/d1-identity-directory";
import { D1ItineraryRepository } from "./adapters/persistence/d1-itinerary-repository";
import { D1PublicationRepository } from "./adapters/persistence/d1-publication-repository";
import { D1ReviewRepository } from "./adapters/persistence/d1-review-repository";
import { D1SubmittedProposalAdapter } from "./adapters/persistence/d1-submitted-proposal-adapter";
import { resolveProviders, resolveRegistrationSource } from "./adapters/providers/configuration";
import { R2AssetStorage, type R2BucketPort } from "./adapters/storage/r2-asset-storage";
import { AgendaService } from "./application/agenda/agenda-service";
import { CfpService, CfpUnavailableError } from "./application/cfp/cfp-service";
import { OutboxWorker } from "./application/communications/outbox-worker";
import {
  AccelEventsSyncService,
  CommunicationsInputError,
  CommunicationsNotFoundError,
  CommunicationsService,
} from "./application/communications/public";
import type { DeliveryRequest } from "./application/communications/public";
import { SchedulePublishedConsumer } from "./application/communications/schedule-published-consumer";
import { enqueueDueTaskReminders } from "./application/communications/task-reminders";
import { ContentService } from "./application/content/content-service";
import type { SpeakerNotificationPort } from "./application/content/content-service";
import { SpeakerCalendarInviteService } from "./application/content/public";
import { CrmService } from "./application/crm/crm-service";
import type { OutreachMessage } from "./application/crm/public";
import { OutreachRejectedError } from "./application/crm/public";
import { EventService } from "./application/events/public";
import { ItineraryService } from "./application/publishing/itinerary-service";
import { PublicationService } from "./application/publishing/publication-service";
import { ReviewService } from "./application/review/review-service";
import type { ReviewNotificationPort } from "./application/review/review-service";
import { createHttpApp, type GoogleAuthProvider } from "./transport/http/app";
import { GoogleOauthClient } from "./adapters/identity/google-oauth-client";
import {
  completeGoogleAuthorization,
  type GoogleConfiguration,
  startGoogleAuthorization,
  stateProof,
} from "./application/identity/google-oauth";
import { SignupService } from "./application/identity/signup";
import { resolveSuggestionProvider } from "./adapters/suggestions/configuration";
import type { ReviewSuggestionPort } from "./application/review/suggestion-port";
import { SuggestionUnavailableError } from "./application/review/suggestion-port";

export interface Environment {
  DB: D1DatabasePort;
  ASSETS: R2BucketPort;
  DEMO_MODE?: string;
  SESSION_SECRET?: string;
  AUTH_EMAIL_ENDPOINT?: string;
  AUTH_EMAIL_TOKEN?: string;
  INITIAL_ORGANIZER_USER_ID?: string;
  INITIAL_ORGANIZER_EMAIL?: string;
  ENVIRONMENT?: string;
  /**
   * Public origin of this deployment, for links inside messages the outbox sends.
   *
   * The scheduled drain has no request to read an origin from, so a link in a schedule
   * confirmation has to come from configuration. Non-secret; belongs in vars.
   */
  PUBLIC_BASE_URL?: string;
  /**
   * `fixture` (the default) or `live`.
   *
   * `live` requires everything below except `AIRTABLE_REFERENCE_FIELD`, which defaults. The three
   * `*_TOKEN` bindings are credentials and must be Worker **secrets**; the endpoints, sender
   * address and Airtable identifiers are non-secret configuration and belong in vars. See
   * docs/engineering/communications-providers.md.
   */
  COMMUNICATIONS_PROVIDERS?: string;
  EMAIL_API_ENDPOINT?: string;
  EMAIL_API_TOKEN?: string;
  EMAIL_SENDER?: string;
  AIRTABLE_BASE_ID?: string;
  AIRTABLE_TABLE_ID?: string;
  AIRTABLE_TOKEN?: string;
  AIRTABLE_REFERENCE_FIELD?: string;
  ACCELEVENTS_API_ENDPOINT?: string;
  ACCELEVENTS_TOKEN?: string;
  /** Origin the inbound registration read is appended to. Distinct from the projection endpoint. */
  ACCELEVENTS_API_ORIGIN?: string;
  /** The Accelevents event the inbound registration sync reads. Non-secret; a var, not a secret. */
  ACCELEVENTS_EVENT_REF?: string;
  /** The Greenroom event `ACCELEVENTS_EVENT_REF` corresponds to. Non-secret. */
  ACCELEVENTS_GREENROOM_EVENT_ID?: string;
  /**
   * Fallback `ORGANIZER` for calendar invitations when no mail sender is configured.
   *
   * `EMAIL_SENDER` wins when set, because a calendar client checks the organizer against the
   * sending identity. This exists so the configurations that send no mail — local development,
   * CI, Playwright, the demo — can still produce an invitation instead of refusing. Defaulted in
   * `wrangler.toml` to a reserved `.invalid` address.
   */
  CALENDAR_ORGANIZER_EMAIL?: string;
  /**
   * Supplied by `tools/local-wrangler.mjs` when it starts a development Worker, so `/health`
   * can say which checkout and commit it belongs to. Absent in a deployment.
   */
  GREENROOM_WORKTREE_ROOT?: string;
  GREENROOM_COMMIT?: string;
  /**
   * `fixture` (the default), `live`, or `off` — the AI review suggestion port (#110).
   *
   * Its own switch rather than a share of `COMMUNICATIONS_PROVIDERS`, because it is a different
   * domain with a different credential and a different failure: a deployment can perfectly
   * reasonably send real mail while drafting suggestions with the fixture, or the reverse.
   * `off` withdraws the assistant entirely and the rest of review is unchanged.
   * See docs/engineering/review-suggestions.md.
   */
  REVIEW_AI_PROVIDER?: string;
  /** Anthropic API key. A Worker **secret**; required by `live` and by nothing else. */
  REVIEW_AI_API_KEY?: string;
  /** Pins the model `live` drafts with. Non-secret; a var. Defaults in the adapter. */
  REVIEW_AI_MODEL?: string;
  /**
   * Google sign-in. All three or none; a partial configuration refuses to boot
   * (`resolveGoogleConfiguration`), because a deployment that believes it offers Google sign-in
   * and cannot complete one is worse than a deployment that never offers it.
   *
   * `GOOGLE_CLIENT_ID` is the OAuth client's public identifier and belongs in vars.
   * `GOOGLE_CLIENT_SECRET` is a credential and must be a Worker **secret**
   * (`npx wrangler secret put GOOGLE_CLIENT_SECRET`); it is never written to `wrangler.toml`.
   * `GOOGLE_REDIRECT_URI` is the exact URI registered in the Google Cloud console for this
   * deployment. It is configuration rather than something derived from the request, which is
   * what stops a request parameter deciding where an authorization code is delivered — and it
   * cannot be derived from `PUBLIC_BASE_URL` either, because local development inherits that
   * value from the deployed demo. See docs/engineering/local-development.md.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

/**
 * Google configuration, or nothing, and never anything in between.
 *
 * The three bindings are one unit: with a client id and no secret the token exchange fails after
 * the user has already been sent to Google and back, which reads to them as the product being
 * broken, and to an operator as nothing at all. So a partial configuration throws by name at
 * boot, exactly as a missing `SESSION_SECRET` does, and an absent configuration simply means the
 * door is not offered — `/api/auth/config` reports `google: false` and the routes answer 404.
 *
 * The message names bindings, never values.
 */
export function resolveGoogleConfiguration(
  environment: Pick<
    Environment,
    "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REDIRECT_URI"
  >,
): GoogleConfiguration | null {
  const bindings = [
    ["GOOGLE_CLIENT_ID", environment.GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", environment.GOOGLE_CLIENT_SECRET],
    ["GOOGLE_REDIRECT_URI", environment.GOOGLE_REDIRECT_URI],
  ] as const;
  const missing = bindings.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length === bindings.length) return null;
  if (missing.length > 0)
    throw new Error(`Google sign-in is partly configured; missing ${missing.join(", ")}`);
  const redirectUri = environment.GOOGLE_REDIRECT_URI as string;
  // A redirect URI that is not an absolute http(s) URL cannot be what Google has registered, and
  // failing here names the binding instead of producing an authorization request Google refuses
  // with an error page the user cannot act on.
  if (!/^https?:\/\//.test(redirectUri))
    throw new Error("GOOGLE_REDIRECT_URI must be an absolute http(s) URL");
  return {
    clientId: environment.GOOGLE_CLIENT_ID as string,
    clientSecret: environment.GOOGLE_CLIENT_SECRET as string,
    redirectUri,
  };
}

const communicationsRepository = (environment: Environment) =>
  new D1CommunicationsRepository(
    environment.DB as ConstructorParameters<typeof D1CommunicationsRepository>[0],
  );

/**
 * Where a speaker downloads the calendar for an event.
 *
 * `PUBLIC_BASE_URL` is deployment configuration, not something this domain can infer: the
 * scheduled drain has no request to read an origin from, and a message containing a relative
 * path reaches somebody's inbox as text they cannot click. Absent, the confirmation still goes
 * out and simply says where to look instead of linking there — a message with a broken link is
 * worse than one with none.
 */
const speakerCalendarUrl = (environment: Environment) => (eventId: string) =>
  environment.PUBLIC_BASE_URL
    ? `${environment.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/events/${eventId}/speaker-calendar.ics`
    : "your event's schedule page";

/**
 * The composition the cron tick uses. Not a request, so it builds its own.
 *
 * Only the enqueue surface is reached, which takes no actor by design — a cron tick has none.
 */
const scheduledCommunications = (environment: Environment) => {
  const events = new EventService({
    repository: new D1EventRepository(environment.DB),
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
  return {
    events,
    service: new CommunicationsService({
      repository: communicationsRepository(environment),
      eventDirectory: events,
      speakerDirectory: new D1IdentityDirectory(environment.DB),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    }),
  };
};

/** Queue a reminder for every open speaker task now inside the reminder window (issue #52). */
export async function remindDueSpeakerTasks(environment: Environment) {
  const { events, service } = scheduledCommunications(environment);
  return enqueueDueTaskReminders({
    work: new D1ContentRepository(environment.DB),
    enqueue: service,
    organizationOf: (eventId) => events.organizationOf(eventId),
    now: () => new Date(),
    onFailure(fields) {
      // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
      console.warn(JSON.stringify({ level: "warn", message: "task.reminder.failed", ...fields }));
    },
  });
}

export async function drainOutbox(environment: Environment, limit = 100): Promise<number> {
  const communications = scheduledCommunications(environment).service;
  const worker = new OutboxWorker(
    communicationsRepository(environment),
    // Throws rather than falling back if `live` is half-configured, so a scheduled drain that
    // believes it is sending mail cannot quietly be appending to an in-memory array.
    resolveProviders(environment),
    { newId: () => crypto.randomUUID(), now: () => new Date() },
    {
      // What the provider did, per attempt: enough to correlate a delivery with a provider's own
      // logs and to see rate limiting as it happens. Never the recipient, the message, the
      // payload or any credential — this line is emitted to a shared log sink.
      attempt(record) {
        // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
        console.info(JSON.stringify({ level: "info", message: "delivery.attempt", ...record }));
      },
    },
    new SchedulePublishedConsumer({
      enqueue: communications,
      speakerDirectory: new D1IdentityDirectory(environment.DB),
      calendarUrl: speakerCalendarUrl(environment),
    }),
  );
  let processed = 0;
  while (processed < limit && (await worker.runOne())) processed += 1;
  return processed;
}

export function pruneItineraries(environment: Environment): Promise<void> {
  return new ItineraryService(
    new D1ItineraryRepository(environment.DB),
    new D1PublicationRepository(environment.DB),
  ).prune();
}

export function runtimeAuth(
  environment: Pick<
    Environment,
    | "DEMO_MODE"
    | "SESSION_SECRET"
    | "ENVIRONMENT"
    | "AUTH_EMAIL_ENDPOINT"
    | "AUTH_EMAIL_TOKEN"
    | "GOOGLE_CLIENT_ID"
    | "GOOGLE_CLIENT_SECRET"
    | "GOOGLE_REDIRECT_URI"
  >,
) {
  const demoMode = environment.DEMO_MODE === "true";
  if (demoMode && environment.ENVIRONMENT !== "development")
    throw new Error("DEMO_MODE is allowed only when ENVIRONMENT=development");
  if (!environment.SESSION_SECRET || environment.SESSION_SECRET === "local-development-secret")
    throw new Error("Authentication requires a non-default SESSION_SECRET binding");
  // Checked in both modes and before either return, so a half-configured Google binding is a
  // boot failure rather than a surprise on somebody's first sign-in. Omitted from the result
  // when absent, so a deployment without it is byte-for-byte the configuration it was before.
  const google = resolveGoogleConfiguration(environment);
  if (demoMode)
    return {
      demoMode: true as const,
      sessionSecret: environment.SESSION_SECRET as string,
      ...(google ? { google } : {}),
    };
  // Emailed-code sign-in remains this deployment's requirement even with Google configured:
  // Google is an additional provider, not a replacement, and `GAP-007` records the emailed-code
  // path as the one that partially closed production auth.
  if (!environment.AUTH_EMAIL_ENDPOINT || !environment.AUTH_EMAIL_TOKEN)
    throw new Error(
      "Production authentication requires AUTH_EMAIL_ENDPOINT and AUTH_EMAIL_TOKEN bindings",
    );
  return {
    demoMode: false as const,
    sessionSecret: environment.SESSION_SECRET,
    ...(google ? { google } : {}),
  };
}

// @spec PRD-EVT-001 ARC-OBS-001
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    const auth = runtimeAuth(environment);
    const identityDirectory = new D1IdentityDirectory(environment.DB);
    const service = new EventService({
      repository: new D1EventRepository(environment.DB),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
      grantOrganizer: (eventId, userId) => identityDirectory.grantOrganizer(eventId, userId),
    });
    const contentRepository = new D1ContentRepository(environment.DB);
    const publicationRepository = new D1PublicationRepository(environment.DB);
    const speakerConversion = new D1SpeakerConversion(
      environment.DB,
      () => crypto.randomUUID(),
      identityDirectory,
    );
    const cfpService = new CfpService(
      new D1CfpRepository(environment.DB),
      () => crypto.randomUUID(),
      () => new Date(),
      new D1SubmittedProposalAdapter(environment.DB),
    );
    const now = () => new Date();
    const communications = new CommunicationsService({
      repository: communicationsRepository(environment),
      eventDirectory: service,
      // Who an event's speakers are is identity's answer, not a read of content's profiles.
      speakerDirectory: identityDirectory,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    /**
     * Closes `DEBT-006`: the writer that makes a schedule publication and its announcement one
     * durable operation (issue #22).
     *
     * The agenda derived an `EVT-SCHEDULE-PUBLISHED` payload on every commit and dropped it,
     * because nothing could be bound here — the outbox modelled a delivery to a provider, and
     * routing a domain event through it would have queued a fabricated Airtable push. The
     * `event` channel added for this is what makes the binding expressible.
     *
     * `prepareEnqueue` resolves the row and writes nothing; `preparedDeliveryWriter` renders it
     * into statements the agenda appends to the batch its publication was already running. So
     * the SQL and the column names stay inside communications, the agenda never learns either,
     * and a failure on one side leaves neither row.
     *
     * The idempotency key is the event's own derived id, so a retried publish command that lands
     * on the same version produces exactly one record — and republishing after an edit allocates
     * a new version, a new key, and a new record, which is what a second publication means.
     */
    const writePublicationEvent = preparedDeliveryWriter(
      environment.DB as Parameters<typeof preparedDeliveryWriter>[0],
    );
    const agenda = new AgendaService(
      new D1AgendaRepository(environment.DB, now, async (_database, event) => {
        const organizationId = await service.organizationOf(event.eventId);
        // A publication whose event has no owning organization cannot be announced to anyone.
        // Throwing fails the batch, so the publication does not commit either — which is the
        // point of sharing one: a schedule nobody can be told about is not a published schedule.
        if (!organizationId)
          throw new Error(`Event ${event.eventId} has no owning organization to announce to`);
        return writePublicationEvent(
          await communications.prepareEnqueue({
            organizationId,
            eventId: event.eventId,
            idempotencyKey: event.id,
            triggerType: "schedule.published",
            channel: "event",
            recipientRef: `event:${event.eventId}`,
            payload: { ...event },
          }),
        );
      }),
      now,
      contentRepository,
      async (actor, eventId) => {
        const event = await service.get(actor, eventId);
        return Boolean(event && actor.organizations.some(({ id }) => id === event.organizationId));
      },
    );
    const logger = {
      info(fields: Record<string, unknown>, message: string) {
        // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
        console.info(JSON.stringify({ level: "info", message, ...fields }));
      },
      warn(fields: Record<string, unknown>, message: string) {
        // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
        console.warn(JSON.stringify({ level: "warn", message, ...fields }));
      },
      error(fields: Record<string, unknown>, message: string) {
        // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
        console.error(JSON.stringify({ level: "error", message, ...fields }));
      },
    };
    /**
     * The Google sign-in door, assembled only when the deployment is configured for it.
     *
     * Three collaborators meet here and nowhere else: the protocol (`application/identity`), the
     * network (`adapters/identity`), and the provisioning workflow whose organization and event
     * writes go through the events domain's public interface. Composing them in the composition
     * root is what keeps identity from importing the events service directly and keeps the
     * client secret out of every type the transport can see.
     */
    const googleAuth: GoogleAuthProvider | undefined = auth.google
      ? ((configuration: GoogleConfiguration, sessionSecret: string): GoogleAuthProvider => {
          const client = new GoogleOauthClient();
          const signup = new SignupService({
            directory: identityDirectory,
            workspace: {
              provisionOrganization: (command) => service.provisionOrganization(command),
              // The ordinary authorized creation path, reached with the actor the membership
              // written a moment earlier has just made an organizer. Nothing here bypasses
              // `EventService.create`'s own capability and membership checks, which is the point:
              // a first event is created exactly as every later one is.
              createFirstEvent: (actor, command) => service.create(actor, command),
            },
            newId: () => crypto.randomUUID(),
            now: () => Date.now(),
          });
          return {
            async start(now) {
              const started = await startGoogleAuthorization(configuration, sessionSecret, now);
              await identityDirectory.saveOauthAttempt(started.attempt);
              return {
                authorizationUrl: started.authorizationUrl,
                attemptId: started.attempt.id,
              };
            },
            async complete({ attemptId, state, code, now }) {
              // The attempt is spent before the code is exchanged. A callback that fails
              // verification has still consumed its one use, so a stolen `state` cannot be
              // retried against a different code.
              const spent = await identityDirectory.consumeOauthAttempt(
                attemptId,
                await stateProof(state, sessionSecret),
                now,
              );
              if (!spent) {
                logger.warn({ reason: "attempt_not_current" }, "auth.google.refused");
                return null;
              }
              try {
                const identity = await completeGoogleAuthorization(
                  { code, attempt: spent, configuration, now },
                  { exchange: client.exchange, keys: client.keys },
                );
                return await signup.signInWithGoogle(identity);
              } catch (error) {
                // ERROR-INTENT: every refusal in this flow is reported here and reduced to one
                // indistinguishable answer for the browser — see the callback route. The reason
                // is an operator's, not a caller's, and the log line carries no address, no
                // token and no code.
                logger.warn(
                  { reason: error instanceof Error ? error.message : String(error) },
                  "auth.google.refused",
                );
                return null;
              }
            },
            resolveUserActor: (userId: string) => identityDirectory.findByUserId(userId),
          };
        })(auth.google, auth.sessionSecret)
      : undefined;
    /**
     * Turns a lifecycle fact into a queued delivery, and never lets that failure become the
     * lifecycle action's failure.
     *
     * Every caller of this has already committed the change it is announcing: the session
     * exists, the tasks are written, the decision is recorded. Throwing here would report a
     * failure for work that succeeded, and for `requestTasks` — whose task ids are minted per
     * call — the organizer's retry would create a second set of tasks. So the enqueue is
     * awaited, and a failure is logged rather than propagated.
     *
     * The log line carries the identifiers a human needs to send the message by hand: the event,
     * and whatever the fact was about. That is the difference between a suppressed error and a
     * recoverable one.
     */
    const notifyLifecycle = async (
      eventId: string,
      subject: Record<string, string>,
      request: (organizationId: string) => Omit<DeliveryRequest, "organizationId" | "eventId">,
    ): Promise<void> => {
      try {
        const organizationId = await service.organizationOf(eventId);
        // Not an error to swallow quietly: an event with no owning organization means the id is
        // wrong or the row is gone, and either way there is nobody to address the message to.
        if (!organizationId) throw new Error("Event has no owning organization");
        await communications.enqueue({
          organizationId,
          eventId,
          ...request(organizationId),
        });
      } catch (error) {
        // ERROR-INTENT: a message that cannot be queued must not fail the already-committed
        // action that caused it; see `SpeakerNotificationPort`. Reported at error level with the
        // identifiers needed to send it by hand, so this is visible and recoverable rather than
        // discarded.
        logger.error(
          { eventId, ...subject, error: error instanceof Error ? error.message : String(error) },
          "lifecycle.notification.failed",
        );
      }
    };
    const speakerNotifications: SpeakerNotificationPort = {
      speakerAccepted: (fact) =>
        notifyLifecycle(fact.eventId, { profileId: fact.profileId }, () => ({
          idempotencyKey: `speaker-invite:${fact.eventId}:${fact.profileId}`,
          triggerType: "speaker.invited",
          channel: "email",
          recipientRef: fact.speakerEmail,
          payload: { speakerName: fact.speakerName, sessionTitle: fact.sessionTitle },
          templateKey: "speaker-invite",
        })),
      taskAssigned: (fact) =>
        notifyLifecycle(fact.eventId, { taskId: fact.taskId, profileId: fact.profileId }, () => ({
          idempotencyKey: `speaker-task:${fact.taskId}`,
          triggerType: "speaker.task_assigned",
          channel: "email",
          recipientRef: fact.speakerEmail,
          payload: {
            speakerName: fact.speakerName,
            taskTitle: fact.taskTitle,
            dueAt: fact.dueAt,
          },
          templateKey: "speaker-task",
        })),
    };
    const reviewNotifications: ReviewNotificationPort = {
      async reviewerAssigned(fact) {
        const reviewer = await identityDirectory.findRecipient(fact.reviewerId);
        // No address means nobody to write to. Logged rather than queued, because a delivery to
        // a non-address would burn an attempt and fail terminally with a code that describes the
        // provider's refusal rather than the reason: this reviewer has no email linked.
        if (!reviewer?.email) {
          logger.warn(
            { eventId: fact.eventId, reviewerId: fact.reviewerId },
            "lifecycle.notification.unaddressable",
          );
          return;
        }
        await notifyLifecycle(fact.eventId, { reviewerId: fact.reviewerId }, () => ({
          idempotencyKey: `reviewer-assigned:${fact.eventId}:${fact.reviewerId}:r${fact.round}`,
          triggerType: "reviewer.assigned",
          channel: "email",
          recipientRef: reviewer.email as string,
          payload: { reviewerName: reviewer.name, round: fact.round },
          templateKey: "reviewer-assignment",
        }));
      },
      async decisionRecorded(fact) {
        if (!fact.submitterEmail) {
          logger.warn(
            { eventId: fact.eventId, proposalId: fact.proposalId },
            "lifecycle.notification.unaddressable",
          );
          return;
        }
        await notifyLifecycle(fact.eventId, { proposalId: fact.proposalId }, () => ({
          // The outcome is in the key on purpose: a reversed decision is a different thing to
          // announce, so re-deciding sends the corrected message instead of being deduplicated
          // into silence by the first one.
          idempotencyKey: `decision:${fact.eventId}:${fact.proposalId}:${fact.outcome}`,
          triggerType: "decision.recorded",
          channel: "email",
          recipientRef: fact.submitterEmail as string,
          payload: { submitterName: fact.submitterName, proposalTitle: fact.proposalTitle },
          templateKey: fact.outcome === "accepted" ? "decision-accepted" : "decision-declined",
        }));
      },
    };
    /*
     * The AI suggestion port (#110), resolved once per request and never able to take review down.
     *
     * Three outcomes, and the middle one is the interesting one:
     *
     * - `off` — no port. The queue offers no Draft control and review behaves as it did before
     *   this feature existed.
     * - misconfigured `live` — a port that refuses on use. Resolution throws naming the missing
     *   binding, and that throw is caught *here* rather than allowed to escape, because a
     *   reviewer's queue must not go dark because the assistant's key is absent. The binding name
     *   goes to the log; the reviewer is told the assistant is unavailable and scores by hand.
     * - otherwise — the fixture or the live adapter.
     *
     * This is deliberately the opposite trade from `resolveProviders`, which lets a misconfigured
     * `live` throw into the scheduled drain. There, throwing is how a deployment avoids believing
     * it has sent mail. Here, nothing is claimed to have happened at all if the port never
     * answers, so the safe direction is to keep the rest of review working.
     */
    const suggestions: ReviewSuggestionPort | undefined = (() => {
      try {
        return resolveSuggestionProvider(environment) ?? undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          suggest() {
            // ERROR-INTENT: the configuration message names bindings, not values, and belongs in
            // the operator's log rather than in a reviewer's response. The reviewer gets the
            // normalized code and the manual path.
            logger.error({ detail }, "review.suggestions.misconfigured");
            return Promise.reject(new SuggestionUnavailableError("PROVIDER_UNCONFIGURED"));
          },
        };
      }
    })();
    const reviewService = new ReviewService({
      repository: new D1ReviewRepository(environment.DB),
      proposals: new D1SubmittedProposalAdapter(environment.DB),
      identities: identityDirectory,
      events: service,
      notifications: reviewNotifications,
      ...(suggestions ? { suggestions } : {}),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    // Content resolves accepted proposals through the review domain's public application
    // interface, never by reading `cfp_submissions` (`ARC-FLOW-001`).
    const content = new ContentService({
      repository: contentRepository,
      // Acceptance and task assignment now reach the speaker. Content states the fact; this
      // binding decides the template, the trigger and the idempotency key.
      speakerNotifications,
      assetStorage: new R2AssetStorage(environment.ASSETS),
      proposals: reviewService,
      // The agenda owns when a session happens; content asks rather than keeping a second copy,
      // so the speaker portal, the .ics export and the published schedule cannot disagree.
      agenda,
      speakerConversion,
      // Publishing owns "is this event public"; content asks rather than reading the
      // projection table, so unpublishing an event withdraws the assets its page exposed.
      eventPublication: {
        isEventPublished: async (eventId) =>
          (await publicationRepository.findByEventId(eventId))?.state === "published",
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
      sanitizeResourceHtml,
      sanitizeResourceEmbed,
      parseSpeakerCsv,
      createDeliverablesZip,
    });
    // The inbound Accelevents registration sync (#58). `fixture` is the default and answers from
    // an in-repository roster, which is what lets the demo and a fresh clone sync with no
    // credential; `live` requires the Accelevents bindings and throws naming the missing ones.
    // Registrants reach content through its own public import command, never through its tables.
    const communicationsMode = environment.COMMUNICATIONS_PROVIDERS === "live" ? "live" : "fixture";
    const accelEventsSync = new AccelEventsSyncService({
      // Resolved when a sync actually runs, not when the Worker builds its services. `live`
      // throws on a missing binding, and doing that here would take down every route in the
      // application — the health check, the public schedule, the CFP form — because one
      // integration is misconfigured. Deferred, the failure lands on the request that needed it,
      // naming the binding, and nothing else notices.
      source: {
        listRegistrants: (eventId) =>
          resolveRegistrationSource(environment).listRegistrants(eventId),
      },
      content,
      runs: new D1AccelEventsSyncRuns(
        environment.DB as ConstructorParameters<typeof D1AccelEventsSyncRuns>[0],
      ),
      mode: communicationsMode,
      now: () => new Date(),
    });
    // Sending a speaker the iTIP invitation for their own session (#56). Composes content's
    // session and speaker data with communications' outbox, and carries the sender address that
    // becomes every invitation's ORGANIZER. Deliberately not defaulted: a calendar client refuses
    // an invitation whose organizer is not the sender, so a fabricated address would produce one
    // that looks delivered and does nothing. Unconfigured, the send route refuses and says so.
    const speakerCalendarInvites = new SpeakerCalendarInviteService({
      content,
      communications,
      events: service,
      // The mail sender when there is one, because the invitation has to come from the identity
      // the mail comes from. Otherwise the documented placeholder, so a fixture deployment still
      // sends something rather than refusing a button the demo runbook tells an evaluator to press.
      organizerEmail: environment.EMAIL_SENDER ?? environment.CALENDAR_ORGANIZER_EMAIL,
      now: () => new Date(),
    });
    /**
     * Binds the CRM's outreach port to communications' published enqueue interface.
     *
     * The CRM declares the port and imports nothing of communications; this adapter is the one
     * place the two meet, and it lives in the composition root precisely so neither domain has
     * to know the other's module. It also converts communications' typed refusals into the
     * CRM's own `OutreachRejectedError`, so the CRM can report "that template does not exist"
     * to the organizer who pressed Send without importing the class that says so.
     *
     * `CommunicationsEnqueue` rather than `trigger`, and so without an actor: that is the
     * surface communications publishes for other domains, and its contract puts the trust
     * boundary in the already-authorized action that decided to send. The CRM's is authorized
     * three ways — the organization, the event-scoped capability, and that the event belongs to
     * the organization — before either of these is reached.
     */
    const deliveryRequest = (message: OutreachMessage) => ({
      organizationId: message.organizationId,
      eventId: message.eventId,
      idempotencyKey: message.idempotencyKey,
      // A prospective speaker being asked to speak. Communications owns this vocabulary; the
      // CRM picks the member that describes what it is doing.
      triggerType: "speaker.invited" as const,
      channel: "email" as const,
      recipientRef: message.recipientRef,
      payload: message.payload,
      templateKey: message.templateKey,
      templateVersion: message.templateVersion,
    });
    const asOutreachRefusal = (error: unknown) => {
      // Caller mistakes — an unknown template, an incoherent request — become the CRM's own
      // error so its transport can report them without importing these classes.
      if (error instanceof CommunicationsInputError || error instanceof CommunicationsNotFoundError)
        return new OutreachRejectedError(error.message);
      return error;
    };
    const crm = new CrmService({
      repository: new D1CrmRepository(environment.DB),
      speakerConversion,
      identities: identityDirectory,
      events: service,
      outreach: {
        async prepare(message) {
          try {
            await communications.prepareEnqueue(deliveryRequest(message));
          } catch (error) {
            throw asOutreachRefusal(error);
          }
        },
        async send(message) {
          try {
            const delivery = await communications.enqueue(deliveryRequest(message));
            return { deliveryId: delivery.id, created: delivery.created };
          } catch (error) {
            throw asOutreachRefusal(error);
          }
        },
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const publishing = new PublicationService(publicationRepository, {
      event: async (actor, eventId) => {
        const event = await service.get(actor, eventId);
        return event ? { name: event.name, timezone: event.timezone } : null;
      },
      cfp: async (eventId) => {
        let form: Awaited<ReturnType<CfpService["getPublished"]>>;
        try {
          form = await cfpService.getPublished(eventId);
        } catch (error) {
          if (error instanceof CfpUnavailableError) return null;
          throw error;
        }
        return {
          title: form.title,
          description: form.description,
          status: form.status === "closed" ? "closed" : "open",
          publishedAt: form.publishedAt,
        };
      },
      content: contentRepository,
      schedule: (eventId) => agenda.published(eventId),
    });
    const itineraries = new ItineraryService(
      new D1ItineraryRepository(environment.DB),
      publicationRepository,
    );
    const app = createHttpApp(
      service,
      logger,
      auth.demoMode
        ? {
            demoMode: true as const,
            sessionSecret: auth.sessionSecret,
            resolveActor: (persona: "organizer" | "reviewer" | "speaker" | "public") =>
              identityDirectory.findByPersona(persona),
            // `auth.google` is the *configuration*; the transport is handed the *provider*, so
            // no credential is reachable from a route module.
            ...(googleAuth ? { google: googleAuth } : {}),
          }
        : {
            demoMode: false as const,
            sessionSecret: auth.sessionSecret,
            ...(googleAuth ? { google: googleAuth } : {}),
            resolveActor: (userId: string) => identityDirectory.findByUserId(userId),
            resolveEmail: async (email: string) => {
              if (
                environment.INITIAL_ORGANIZER_USER_ID &&
                environment.INITIAL_ORGANIZER_EMAIL?.toLowerCase() === email
              )
                await identityDirectory.linkEmail(environment.INITIAL_ORGANIZER_USER_ID, email);
              return identityDirectory.findByEmail(email);
            },
            saveLoginChallenge: (challenge: {
              id: string;
              email: string;
              codeProof: string;
              expiresAt: number;
            }) => identityDirectory.saveLoginChallenge(challenge),
            consumeLoginChallenge: (id: string, proof: string, now: number) =>
              identityDirectory.consumeLoginChallenge(id, proof, now),
            sendLoginCode: async (email: string, code: string) => {
              if (!environment.AUTH_EMAIL_ENDPOINT || !environment.AUTH_EMAIL_TOKEN)
                throw new Error("Production authentication email provider is not configured");
              const response = await fetch(environment.AUTH_EMAIL_ENDPOINT, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${environment.AUTH_EMAIL_TOKEN}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ to: email, code }),
              });
              if (!response.ok)
                throw new Error(`Authentication email provider returned ${response.status}`);
            },
          },
      reviewService,
      cfpService,
      content,
      crm,
      agenda,
      communications,
      publishing,
      environment.GREENROOM_WORKTREE_ROOT && environment.GREENROOM_COMMIT
        ? { root: environment.GREENROOM_WORKTREE_ROOT, commit: environment.GREENROOM_COMMIT }
        : undefined,
      itineraries,
      speakerCalendarInvites,
      accelEventsSync,
    );
    return Promise.resolve(app.fetch(request));
  },
  /**
   * The one-minute tick.
   *
   * Reminders run *before* the drain and are awaited, so a reminder decided this minute goes out
   * this minute rather than next. Their failures cannot stall it: `enqueueDueTaskReminders`
   * reports rather than throws, including when the open-task read itself fails, precisely so one
   * broken template cannot leave every queued delivery unsent.
   *
   * The drain and the itinerary prune stay concurrent with each other, as they were: neither
   * depends on the other and both are bounded.
   */
  async scheduled(_controller: unknown, environment: Environment): Promise<void> {
    await remindDueSpeakerTasks(environment);
    await Promise.all([drainOutbox(environment), pruneItineraries(environment)]);
  },
};
