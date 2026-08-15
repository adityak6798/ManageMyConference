import { createDeliverablesZip } from "./adapters/content/create-deliverables-zip";
import { D1SpeakerConversion } from "./adapters/content/d1-speaker-conversion";
import { parseSpeakerCsv } from "./adapters/content/parse-speaker-csv";
import {
  sanitizeResourceEmbed,
  sanitizeResourceHtml,
} from "./adapters/content/sanitize-resource-html";
import { GoogleOauthClient } from "./adapters/identity/google-oauth-client";
import { D1AccelEventsSyncRuns } from "./adapters/persistence/d1-accelevents-sync-runs";
import { D1AgendaRepository } from "./adapters/persistence/d1-agenda-repository";
import { D1ApiClientRepository } from "./adapters/persistence/d1-api-clients";
import {
  D1AuditRecordStore,
  preparedAuditWriter,
} from "./adapters/persistence/d1-audit-repository";
import { D1CfpRepository } from "./adapters/persistence/d1-cfp-repository";
import {
  D1CommunicationsRepository,
  preparedDeliveryWriter,
} from "./adapters/persistence/d1-communications-repository";
import { D1ContentRepository } from "./adapters/persistence/d1-content-repository";
import { D1CrmRepository } from "./adapters/persistence/d1-crm-repository";
import { type D1DatabasePort, D1EventRepository } from "./adapters/persistence/d1-event-repository";
import { D1EventTemplateRepository } from "./adapters/persistence/d1-event-template-repository";
import {
  D1IdentityDirectory,
  preparedOrganizerGrant,
} from "./adapters/persistence/d1-identity-directory";
import { D1MembershipRepository } from "./adapters/persistence/d1-identity-membership";
import { D1SessionStore } from "./adapters/persistence/d1-identity-sessions";
import { D1ItineraryRepository } from "./adapters/persistence/d1-itinerary-repository";
import { D1InboxDismissalStore } from "./adapters/persistence/d1-platform-repository";
import { D1PublicationRepository } from "./adapters/persistence/d1-publication-repository";
import { D1ReviewRepository } from "./adapters/persistence/d1-review-repository";
import { D1SubmittedProposalAdapter } from "./adapters/persistence/d1-submitted-proposal-adapter";
import { D1WebhookRepository } from "./adapters/persistence/d1-webhooks";
import { AesGcmWebhookSecretProtector } from "./adapters/persistence/webhook-secret-protector";
import { resolveProviders, resolveRegistrationSource } from "./adapters/providers/configuration";
import { TrustedWebhookEgress } from "./adapters/providers/trusted-webhook-egress";
import { R2AssetStorage, type R2BucketPort } from "./adapters/storage/r2-asset-storage";
import { resolveSuggestionProvider } from "./adapters/suggestions/configuration";
import { AgendaService } from "./application/agenda/agenda-service";
import {
  agendaTemplateSlice,
  type ScheduleReconciliation,
  type ScheduleSweepResult,
  sweepDriftedSchedules,
} from "./application/agenda/public";
import type { CfpNotificationPort } from "./application/cfp/cfp-service";
import { CfpService, CfpUnavailableError } from "./application/cfp/cfp-service";
import { cfpTemplateSlice } from "./application/cfp/public";
import { OutboxWorker } from "./application/communications/outbox-worker";
import type { DeliveryRequest } from "./application/communications/public";
import {
  AccelEventsSyncService,
  CommunicationsInputError,
  CommunicationsNotFoundError,
  CommunicationsService,
  lifecycleRecipientForAccount,
  MessageTemplateMissingError,
  UnverifiedRecipientCapError,
} from "./application/communications/public";
import { enqueueCfpDeadlineNotices } from "./application/communications/cfp-deadline-notices";
import { SchedulePublishedConsumer } from "./application/communications/schedule-published-consumer";
import { enqueueDueTaskReminders } from "./application/communications/task-reminders";
import type {
  WebhookEgress,
  WebhookSecretProtector,
} from "./application/communications/webhook-security";
import {
  FanoutDomainEventConsumer,
  WebhookFanoutConsumer,
  WebhookService,
  WebhookWorker,
} from "./application/communications/webhooks";
import type { SpeakerNotificationPort } from "./application/content/content-service";
import { ContentService } from "./application/content/content-service";
import { SpeakerReminderRejectedError } from "./application/content/reminder-dispatch";
import {
  SpeakerCalendarInviteService,
  speakerChecklistTemplateSlice,
  speakerResourceTemplateSlice,
} from "./application/content/public";
import { CrmService } from "./application/crm/crm-service";
import type { OutreachMessage } from "./application/crm/public";
import { OutreachRejectedError } from "./application/crm/public";
import { EventService, EventTemplateService } from "./application/events/public";
import {
  ApiClientResolver,
  ApiClientService,
  mintApiClientCredential,
} from "./application/identity/api-clients";
import {
  completeGoogleAuthorization,
  GoogleAuthenticationError,
  type GoogleConfiguration,
  startGoogleAuthorization,
  stateProof,
} from "./application/identity/google-oauth";
import { MembershipService, mintInvitationToken } from "./application/identity/membership";
import { issuingSecret } from "./application/identity/real-auth";
import { SignupService, UnverifiedProviderEmailError } from "./application/identity/signup";
import {
  AuditRecorder,
  createRequestIdentity,
  lifecycleAuditKey,
  PlatformOperationsService,
} from "./application/platform/public";
import { ItineraryService } from "./application/publishing/itinerary-service";
import { type ProjectionRefresh, publishingTemplateSlice } from "./application/publishing/public";
import { PublicationService } from "./application/publishing/publication-service";
import { reviewTemplateSlice } from "./application/review/public";
import type { ReviewNotificationPort } from "./application/review/review-service";
import { ReviewService } from "./application/review/review-service";
import type { ReviewSuggestionPort } from "./application/review/suggestion-port";
import { SuggestionUnavailableError } from "./application/review/suggestion-port";
import { createHttpAppFrom, type GoogleAuthProvider } from "./transport/http/app";

export interface Environment {
  DB: D1DatabasePort;
  ASSETS: R2BucketPort;
  DEMO_MODE?: string;
  SESSION_SECRET?: string;
  /**
   * The secret being rotated *away from*, set only while a rotation is in flight.
   *
   * Issuance always uses `SESSION_SECRET`; verification tries it and then this. Set it to the old
   * value, deploy, and unset it after one full session lifetime — see
   * docs/engineering/security-operations.md. Refused at boot when it equals `SESSION_SECRET` or
   * is the development placeholder, because either is a rotation that did not happen.
   */
  SESSION_SECRET_PREVIOUS?: string;
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
  /** HTTPS SSRF-enforcement service. Both bindings are required to enable webhook mutations. */
  WEBHOOK_EGRESS_ENDPOINT?: string;
  /** Worker secret used only to authenticate Greenroom to `WEBHOOK_EGRESS_ENDPOINT`. */
  WEBHOOK_EGRESS_TOKEN?: string;
  /** Current AES-GCM envelope key version; non-secret metadata. */
  WEBHOOK_WRAPPING_KEY_VERSION?: string;
  /** Worker secret: JSON object mapping versions to base64-encoded 32-byte AES keys. */
  WEBHOOK_WRAPPING_KEYS?: string;
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
/**
 * Module scope, and that is the whole point of it.
 *
 * The Worker builds a fresh application for every request — `FixedWindowThrottle` is at module
 * scope for exactly this reason — so a client constructed inside `fetch` starts every callback
 * with an empty key cache, and the five-minute cache the adapter documents would never once be
 * read. Holding it here is what makes a burst of sign-ins one JWKS request rather than N, and
 * what lets a warm isolate carry sign-ins through a brief Google outage.
 *
 * It holds no credential and no per-request state: the configuration and the code arrive as
 * arguments on each call, so one instance is safe to share across every request in an isolate.
 */
const googleOauthClient = new GoogleOauthClient();

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
interface WebhookRuntime {
  repository: D1WebhookRepository;
  egress: WebhookEgress;
}
const webhookRuntime = async (environment: Environment): Promise<WebhookRuntime | null> => {
  const configured = [
    environment.WEBHOOK_EGRESS_ENDPOINT,
    environment.WEBHOOK_EGRESS_TOKEN,
    environment.WEBHOOK_WRAPPING_KEY_VERSION,
    environment.WEBHOOK_WRAPPING_KEYS,
  ];
  if (configured.every((value) => !value)) return null;
  if (configured.some((value) => !value))
    throw new Error(
      "Webhook configuration requires WEBHOOK_EGRESS_ENDPOINT, WEBHOOK_EGRESS_TOKEN, WEBHOOK_WRAPPING_KEY_VERSION, and WEBHOOK_WRAPPING_KEYS together",
    );
  const secrets: WebhookSecretProtector = await AesGcmWebhookSecretProtector.fromConfiguration({
    currentVersion: environment.WEBHOOK_WRAPPING_KEY_VERSION as string,
    keyringJson: environment.WEBHOOK_WRAPPING_KEYS as string,
  });
  return {
    repository: new D1WebhookRepository(
      environment.DB as ConstructorParameters<typeof D1WebhookRepository>[0],
      secrets,
    ),
    egress: new TrustedWebhookEgress(
      environment.WEBHOOK_EGRESS_ENDPOINT as string,
      environment.WEBHOOK_EGRESS_TOKEN as string,
    ),
  };
};

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

/**
 * Announce a CFP deadline before it passes, and its closure after (issue #210).
 *
 * Composed here for the same reason the task reminder is: it needs the CFP domain's calls, the
 * events domain's name and timezone, and identity's addresses, and none of those three may reach
 * into another's tables. Each arrives as its own declared interface.
 */
export async function announceCfpDeadlines(environment: Environment) {
  const { events, service } = scheduledCommunications(environment);
  const directory = new D1IdentityDirectory(environment.DB);
  return enqueueCfpDeadlineNotices({
    calls: new D1CfpRepository(environment.DB),
    enqueue: service,
    alreadyEnqueued: (organizationId, key) => service.alreadyEnqueued(organizationId, key),
    eventOf: (eventId) => events.describeForNotice(eventId),
    findRecipient: (userId) => directory.findRecipient(userId),
    organizersOf: (eventId) => directory.listOrganizersForEvent(eventId),
    now: () => new Date(),
    onFailure(fields) {
      // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
      console.warn(JSON.stringify({ level: "warn", message: "cfp.deadline.failed", ...fields }));
    },
  });
}

export async function drainOutbox(environment: Environment, limit = 100): Promise<number> {
  const communications = scheduledCommunications(environment).service;
  const configuredWebhooks = await webhookRuntime(environment);
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
    new FanoutDomainEventConsumer([
      new SchedulePublishedConsumer({
        enqueue: communications,
        speakerDirectory: new D1IdentityDirectory(environment.DB),
        calendarUrl: speakerCalendarUrl(environment),
      }),
      ...(configuredWebhooks
        ? [
            new WebhookFanoutConsumer(
              configuredWebhooks.repository,
              () => crypto.randomUUID(),
              () => new Date(),
            ),
          ]
        : []),
    ]),
  );
  const runBounded = async (runOne: () => Promise<boolean>) => {
    let processed = 0;
    while (processed < limit && (await runOne())) processed += 1;
    return processed;
  };
  if (!configuredWebhooks) return runBounded(() => worker.runOne());

  const webhookWorker = new WebhookWorker(configuredWebhooks.repository, {
    egress: configuredWebhooks.egress,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
  // Start both independently bounded drains together. A slow provider in either queue must not
  // prevent the other queue from leasing and durably completing work during this scheduled turn.
  const [communicationsProcessed, webhooksProcessed] = await Promise.all([
    runBounded(() => worker.runOne()),
    runBounded(() => webhookWorker.runOne()),
  ]);
  return communicationsProcessed + webhooksProcessed;
}

/**
 * Told about every repair of `agenda_session_schedules`, from whichever path performed it.
 *
 * This line is the whole answer to the objection the design invites: repairing automatically can
 * hide the writer producing the drift, because a future importer writing publications directly
 * would be corrected forever and look correct. Leaving the damage in place is not the alternative
 * it appears to be — the failure it causes is mail, in both directions, and nothing surfaces the
 * condition to a human. So the repair is loud instead.
 *
 * It is bound to the *repository* rather than to the sweep, and that placement is load-bearing: a
 * read repairs the moment anybody opens the workspace or presses Send, so the tick only ever
 * reaches events nobody read. An observer on the sweep alone would report exactly the events that
 * matter least, and "a repair is never silent" would be false for the path that runs most.
 *
 * How to read one. A repair whose three drift counts are all zero is migration `1602`'s backfill
 * claiming a watermark it deliberately left unclaimed — one per already-published event, once, and
 * never again. Any repair with a non-zero count is a real divergence: one is a deploy that raced a
 * publication, and a recurring one names a writer that needs fixing.
 */
const logScheduleRepair = (report: ScheduleReconciliation) => {
  // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
  console.warn(
    JSON.stringify({
      level: "warn",
      message: "agenda.schedule.drift_repaired",
      eventId: report.eventId,
      publicationWatermark: report.publicationWatermark,
      materializedWatermark: report.materializedWatermark,
      publications: report.publications,
      // Counts rather than session ids: this line reaches a shared log sink, and which sessions
      // moved is organizer data. The three counts are what distinguishes a settling backfill from
      // a missed publication from a table somebody wrote directly, which is what the line is for.
      missing: report.drift.missing.length,
      phantom: report.drift.phantom.length,
      divergent: report.drift.divergent.length,
    }),
  );
};

/**
 * The agenda's storage, with the repair observer already attached.
 *
 * A factory rather than two `new D1AgendaRepository(...)` calls because the observer has to reach
 * *both* compositions — the request-scoped one, where a read repairs the moment anybody opens the
 * workspace, and the tick's. Wiring them separately is not a hypothetical mistake: it was made,
 * reviewed, reported, and then made again in the commit that claimed to fix it, because nothing
 * about two independent argument lists says they must agree. One place to attach it is the fix
 * that a test could not have been.
 */
const agendaRepository = (
  environment: Environment,
  now: () => Date,
  writePublicationEvent?: ConstructorParameters<typeof D1AgendaRepository>[2],
) => new D1AgendaRepository(environment.DB, now, writePublicationEvent, logScheduleRepair);

/**
 * Repair the events whose stored schedule revisions have fallen behind their history (issue #169).
 *
 * The composition is deliberately the repository alone. `AgendaService` needs the content domain's
 * schedulable-session query to answer anything about a board, and a reconciliation asks nothing
 * about a board: it replays immutable snapshots the agenda already owns. Building a service here
 * to reach one method would make the tick depend on a domain it has no business in.
 *
 * The repair itself is reported by `logScheduleRepair` below, which is bound to the repository
 * rather than to this sweep — see the note there for why that placement is load-bearing.
 */
export async function reconcileScheduleMaterializations(
  environment: Environment,
): Promise<ScheduleSweepResult> {
  const swept = await sweepDriftedSchedules({
    schedules: agendaRepository(environment, () => new Date()),
    onFailure(fields) {
      // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "agenda.schedule.drift_repair_failed",
          ...fields,
        }),
      );
    },
    /*
     * A drifted event that neither repaired nor threw lost every attempt to a concurrent
     * publication. Nothing else says so — the repair observer only fires on success and
     * `onFailure` only on a throw — so without this an event being published faster than its
     * history can be walked would be swept, declined and forgotten every minute in silence.
     */
    onContention(fields) {
      // biome-ignore lint/suspicious/noConsole: Workers emit structured JSON at this telemetry boundary.
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "agenda.schedule.drift_unrepaired",
          ...fields,
        }),
      );
    },
  });
  return swept;
}

export function pruneItineraries(environment: Environment): Promise<void> {
  const repository = new D1PublicationRepository(environment.DB);
  return new ItineraryService(new D1ItineraryRepository(environment.DB), {
    currentPublicBySlug: (slug) => repository.findPublicBySlug(slug),
    currentPublicByEventId: (eventId) => repository.findByEventId(eventId),
  }).prune();
}

export function runtimeAuth(
  environment: Pick<
    Environment,
    | "DEMO_MODE"
    | "SESSION_SECRET"
    | "SESSION_SECRET_PREVIOUS"
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
  /*
   * The optional second secret a rotation is in flight across.
   *
   * Both refusals are the same kind as the one above — a configuration that looks like a
   * rotation and is not. `previous === current` is a rotation somebody believes they performed:
   * every token still verifies, nothing has moved, and the operator would unset `previous` after
   * the window believing they were done. The placeholder is the default-secret refusal again, in
   * the one place it would otherwise be admitted through the back door.
   */
  const previous = environment.SESSION_SECRET_PREVIOUS;
  if (previous !== undefined) {
    if (previous === environment.SESSION_SECRET)
      throw new Error("SESSION_SECRET_PREVIOUS must differ from SESSION_SECRET");
    if (!previous || previous === "local-development-secret")
      throw new Error("SESSION_SECRET_PREVIOUS must be a non-default secret, or unset");
  }
  const sessionSecret = previous
    ? { current: environment.SESSION_SECRET, previous }
    : environment.SESSION_SECRET;
  // Checked in both modes and before either return, so a half-configured Google binding is a
  // boot failure rather than a surprise on somebody's first sign-in. Omitted from the result
  // when absent, so a deployment without it is byte-for-byte the configuration it was before.
  const google = resolveGoogleConfiguration(environment);
  if (demoMode)
    return {
      demoMode: true as const,
      sessionSecret,
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
    sessionSecret,
    ...(google ? { google } : {}),
  };
}

// @spec PRD-EVT-001 ARC-OBS-001
export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const auth = runtimeAuth(environment);
    const identityDirectory = new D1IdentityDirectory(environment.DB);
    // Behaviour, not credentials: the transport is handed this object and never the signing
    // secret, the same rule `GoogleAuthProvider` follows.
    const sessions = new D1SessionStore(environment.DB);
    const service = new EventService({
      // The organizer grant travels with the event row rather than after it: identity-access
      // owns `event_roles`, so the events adapter is handed the statement writer and never the
      // table (issue #164). Bound here because this is the only composition that creates events.
      repository: new D1EventRepository(environment.DB, preparedOrganizerGrant),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const contentRepository = new D1ContentRepository(environment.DB);
    const publicationRepository = new D1PublicationRepository(environment.DB);
    const speakerConversion = new D1SpeakerConversion(
      environment.DB,
      () => crypto.randomUUID(),
      identityDirectory,
    );
    const now = () => new Date();
    /*
     * The audit timeline (issue #99). Constructed here rather than beside the other platform
     * services because two things below need it: the agenda's publication batch, which commits a
     * record with the publication, and the lifecycle ports, which record after the fact.
     *
     * `requestIdentity` is what makes a record say who did it. Platform's own transport
     * middleware opens a scope on it once per request and ends it when the request does; every
     * writer below reads it rather than being handed an actor, because a domain reporting a
     * lifecycle fact has no business knowing about audit.
     *
     * **It is constructed here, inside `fetch`, and that is load-bearing.** One holder per
     * invocation is what stops two concurrent requests seeing each other's actor. Hoisting this
     * line — or anything below that closes over it — out of `fetch` for reuse would break that,
     * so the holder reports it and stops attributing rather than renaming somebody's records
     * (issue #179).
     */
    const requestIdentity = createRequestIdentity({
      report: (error, context) =>
        logger.error(
          { ...context, error: error instanceof Error ? error.message : String(error) },
          "audit.attribution.ambiguous",
        ),
    });
    const auditRecorder = new AuditRecorder({
      store: new D1AuditRecordStore(environment.DB),
      identity: requestIdentity,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
      report: (error, context) =>
        // The recorder never throws, so this line is the only way a lost record is visible. It
        // carries the idempotency key, which is what makes the record reconstructible by hand.
        logger.error(
          { ...context, error: error instanceof Error ? error.message : String(error) },
          "audit.record.failed",
        ),
    });
    const writeAuditRecord = preparedAuditWriter(
      environment.DB as Parameters<typeof preparedAuditWriter>[0],
    );
    const communications = new CommunicationsService({
      repository: communicationsRepository(environment),
      eventDirectory: {
        belongsToOrganization: (eventId, organizationId) =>
          service.belongsToOrganization(eventId, organizationId),
        // For `{{eventName}}`. Events owns what an event is called; communications asks rather
        // than storing a copy that would drift the first time somebody renames one.
        name: (eventId) => service.nameOf(eventId),
      },
      // Who an event's speakers are is identity's answer, not a read of content's profiles.
      speakerDirectory: identityDirectory,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const configuredWebhooks = await webhookRuntime(environment);
    const webhooks = configuredWebhooks
      ? new WebhookService({
          repository: configuredWebhooks.repository,
          eventDirectory: service,
          egress: configuredWebhooks.egress,
          newId: () => crypto.randomUUID(),
          now: () => new Date(),
        })
      : undefined;
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
    // The two services meet only through closures invoked after this composition is complete:
    // publishing reads agenda's public snapshot, while agenda's durable event writer asks
    // publishing for opaque statements. Explicit declarations make that runtime cycle visible
    // without creating a module dependency in either direction.
    let publishing: PublicationService;
    const agenda: AgendaService = new AgendaService(
      agendaRepository(environment, now, async (_database, event, schedule) => {
        const organizationId = await service.organizationOf(event.eventId);
        // A publication whose event has no owning organization cannot be announced to anyone.
        // Throwing fails the batch, so the publication does not commit either — which is the
        // point of sharing one: a schedule nobody can be told about is not a published schedule.
        if (!organizationId)
          throw new Error(`Event ${event.eventId} has no owning organization to announce to`);
        /*
         * Three things in one batch: the publication, the announcement, and the audit record.
         *
         * The record is prepared rather than written, for the same reason the announcement is —
         * a published schedule with no record of who published it, or a record of a publication
         * that rolled back, are both worse than neither. The idempotency key is the event's own
         * derived id, so a retried publish converges on one record and republishing after an
         * edit allocates a new version, a new key, and a new record.
         */
        const projectionRefresh: ProjectionRefresh | null = await publishing.prepareScheduleRefresh(
          event,
          schedule,
        );
        return [
          ...(projectionRefresh
            ? publicationRepository.prepareRefreshStatements(projectionRefresh)
            : []),
          ...writePublicationEvent(
            await communications.prepareEnqueue({
              organizationId,
              eventId: event.eventId,
              idempotencyKey: event.id,
              triggerType: "schedule.published",
              channel: "event",
              recipientRef: `event:${event.eventId}`,
              payload: { ...event },
            }),
          ),
          ...writeAuditRecord(
            auditRecorder.prepare({
              organizationId,
              eventId: event.eventId,
              action: "agenda.schedule_published",
              targetType: "agenda-publication",
              targetId: event.id,
              idempotencyKey: lifecycleAuditKey({
                action: "agenda.schedule_published",
                eventId: event.eventId,
                targetId: event.id,
              }),
            }),
          ),
        ];
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
          const client = googleOauthClient;
          const signup = new SignupService({
            directory: identityDirectory,
            workspace: {
              provisionOrganization: (command) => service.provisionOrganization(command),
              // The ordinary authorized creation path, reached with the actor the membership
              // written a moment earlier has just made an organizer. Nothing here bypasses the
              // events domain's own capability and membership checks, which is the point: a first
              // event is created exactly as every later one is — with one difference the events
              // domain owns, its provisioning key, so a second concurrent callback adopts this
              // event instead of creating another (issue #164).
              createFirstEvent: (actor, command) => service.provisionFirstEvent(actor, command),
              // The counterweight to `provisionOrganization`: an organization this signup created
              // and could not use is removed rather than left for a data-aware reset to refuse on.
              discardUnusedOrganization: (organizationId) =>
                service.discardUnusedOrganization(organizationId),
              // Scoped by the actor's own memberships, so this reads the organization it has
              // just been made a member of and nothing else.
              eventsInOrganization: async (actor, organizationId) =>
                (await service.list(actor)).filter(
                  (event) => event.organizationId === organizationId,
                ),
            },
            newId: () => crypto.randomUUID(),
            now: () => Date.now(),
            // An orphaned organization is invisible to the product and refuses every later demo
            // restore (`GAP-019`), so the one case that leaves one behind says so.
            report: (fields, event) => logger.error(fields, event),
          });
          return {
            async start(now, workspaceIntent) {
              const started = await startGoogleAuthorization(
                configuration,
                sessionSecret,
                now,
                workspaceIntent,
              );
              await identityDirectory.saveOauthAttempt(started.attempt);
              return {
                authorizationUrl: started.authorizationUrl,
                attemptId: started.attempt.id,
              };
            },
            async complete({ attemptIds, state, code, now, correlationId }) {
              let spentAttemptId: string | null = null;
              try {
                /*
                 * The attempt is spent before the code is exchanged. A callback that fails
                 * verification has still consumed its one use, so a stolen `state` cannot be
                 * retried against a different code.
                 *
                 * Every id the browser presented goes in, and the `state` proof picks exactly one
                 * of them (issue #166): a person with two tabs open has two attempts in flight,
                 * and which one returns first is not something either tab controls. The proof is
                 * still what identifies the attempt, so widening the id set widens nothing about
                 * what a caller can complete — an id the browser never held is not in the list,
                 * and an id it held with a `state` it cannot produce still matches nothing.
                 */
                const spent = await identityDirectory.consumeOauthAttempt(
                  attemptIds,
                  await stateProof(state, sessionSecret),
                  now,
                );
                if (!spent) {
                  /*
                   * One statement decided this, and no second one investigates it.
                   *
                   * Issue #166 asked for a superseded attempt to be distinguishable in the log
                   * from a `state` mismatch. A start now appends to the browser's set rather than
                   * replacing it, so the ordinary supersession that issue described — a second
                   * tab evicting the first — is gone. What remains of it is the cap: a browser
                   * that starts more than `MAX_OUTSTANDING_ATTEMPTS` sign-ins drops its oldest id
                   * from the cookie while that attempt is still live in D1, and a callback for it
                   * then refuses here indistinguishably from a forged `state`. `presented` is
                   * logged as a hint rather than a discriminator — it is neither necessary nor
                   * sufficient for that case — and the row itself expires ten minutes after it
                   * was minted (`ATTEMPT_LIFETIME_MS`), so the state is bounded rather than
                   * durable.
                   *
                   * Narrowing it further would take a second query, which would double the D1
                   * cost of the cheapest unauthenticated request in the deployment, since a
                   * caller can present a cookie of their own making — and would answer, to
                   * whoever asked, whether the `state` they sent was live.
                   */
                  logger.warn(
                    { correlationId, reason: "attempt_not_current", presented: attemptIds.length },
                    "auth.google.refused",
                  );
                  return { spentAttemptId: null, outcome: { status: "refused" } };
                }
                spentAttemptId = spent.id;
                const identity = await completeGoogleAuthorization(
                  { code, attempt: spent, configuration, now },
                  { exchange: client.exchange, keys: client.keys },
                );
                // The door this sign-in was started from, read back off the attempt row it just
                // spent rather than from anything the callback carried (migration `1005`).
                const session = await signup.signInWithGoogle(identity, spent.workspaceIntent);
                return {
                  spentAttemptId,
                  outcome: {
                    status: "signed-in",
                    actor: session.actor,
                    provisioned: session.provisioned,
                  },
                };
              } catch (error) {
                /*
                 * ERROR-INTENT: the browser is told the same thing whichever of these happened —
                 * naming the failed check would hand an attacker an oracle — but the *log* has to
                 * separate them, because one is somebody being refused and the other is this
                 * deployment being broken.
                 *
                 * A protocol refusal (a token that does not verify, an unverified address) is
                 * traffic: warn. Anything else reaching here is ours — D1 unavailable, Google
                 * answering 5xx, the key fetch timing out, provisioning failing part-way — and is
                 * logged at error with the request's correlation id, so a person reporting "I
                 * cannot sign in" can be found in the log and an alert can fire on sign-in being
                 * down rather than on sign-ins being refused. The same split now reaches the
                 * person: an operational failure sends them to `/signin?auth=unavailable`, which
                 * says the deployment broke rather than telling them to check their account
                 * (issue #164).
                 *
                 * `consumeOauthAttempt` is inside this try for a second reason: it is a D1 write,
                 * and a throw escaping here reached the transport's error boundary and answered a
                 * JSON 500 — rendered as raw JSON in the address bar, because a callback is a
                 * top-level navigation. The route promises every outcome lands on one destination;
                 * this is what makes that true.
                 */
                const operational = !(
                  error instanceof GoogleAuthenticationError ||
                  error instanceof UnverifiedProviderEmailError
                );
                const fields = {
                  correlationId,
                  reason: error instanceof Error ? error.message : String(error),
                };
                if (operational) logger.error(fields, "auth.google.failed");
                else logger.warn(fields, "auth.google.refused");
                return {
                  spentAttemptId,
                  outcome: { status: operational ? "unavailable" : "refused" },
                };
              }
            },
            resolveUserActor: (userId: string) => identityDirectory.findByUserId(userId),
          };
        })(
          auth.google,
          // The current secret only, deliberately. The `state` proof is the one piece of
          // signed state a rotation cannot span cheaply: an attempt lives ten minutes
          // (`ATTEMPT_LIFETIME_MS`), so the whole exposure of rotating is that sign-ins begun
          // in the ten minutes before the deploy fail their `state` check and the person
          // presses the button again. That is a smaller cost than carrying a second secret
          // through the attempt table, and it is what the runbook documents.
          issuingSecret(auth.sessionSecret),
        )
      : undefined;
    /**
     * "Which organization runs this event?", answered once per event per request.
     *
     * Every lifecycle helper below resolves this for itself, because the domains reporting these
     * facts are event-scoped and have no reason to know. That is the right shape and the wrong
     * cost: one speaker acceptance calls it **eight** times — a decision record, a decision
     * delivery, an acceptance record, an invitation delivery, and a record and a delivery for
     * each of the two onboarding tasks — and each call was a separate read of the same
     * unchanging row. Issue #207 measured them as eight of the path's sixty-five sequential
     * round trips to D1.
     *
     * Safe to hold for exactly this long and no longer. The Worker constructs these services
     * inside `fetch`, so the map lives and dies with one request — the same lifetime the
     * attribution holder relies on (`PRD-OPS-003`) — and an event's owning organization cannot
     * change under a request in flight: nothing in the product moves an event between
     * organizations. A miss and a `null` are cached alike, because "there is nobody to address
     * this to" is as stable an answer as the id is.
     *
     * The *promise* is memoized rather than its value, so two announcements issued together
     * share one read instead of both missing an empty cache.
     */
    const owningOrganizations = new Map<string, Promise<string | null>>();
    const organizationOf = (eventId: string): Promise<string | null> => {
      const known = owningOrganizations.get(eventId);
      if (known) return known;
      // A rejection is dropped from the cache rather than kept. Caching one would turn a single
      // transient read failure into a failure for every later announcement in the request, which
      // is the opposite of what these helpers exist to prevent.
      const resolving = service.organizationOf(eventId).catch((error: unknown) => {
        owningOrganizations.delete(eventId);
        // ERROR-INTENT: re-raised unchanged to the caller, which is one of the two helpers below;
        // both already report it. Nothing is swallowed here — the entry is only evicted.
        throw error;
      });
      owningOrganizations.set(eventId, resolving);
      return resolving;
    };
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
      // Held outside the try so the catch can put a configuration failure on this event's own
      // timeline, which needs the organization the failure happened in.
      let organizationId: string | null = null;
      try {
        organizationId = await organizationOf(eventId);
        // Not an error to swallow quietly: an event with no owning organization means the id is
        // wrong or the row is gone, and either way there is nobody to address the message to.
        if (!organizationId) throw new Error("Event has no owning organization");
        const enqueued = await communications.enqueue({
          organizationId,
          eventId,
          ...request(organizationId),
        });
        // The delivery is communications' mutation, and it belongs on the timeline as one: an
        // organizer reading the log should see the message go out beside the thing that caused
        // it. Keyed on the delivery, so a converged retry records once.
        await auditRecorder.record({
          organizationId,
          eventId,
          action: "communications.delivery_enqueued",
          targetType: "delivery",
          targetId: enqueued.id,
          idempotencyKey: lifecycleAuditKey({
            action: "communications.delivery_enqueued",
            eventId,
            targetId: enqueued.id,
          }),
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
        /*
         * The catch above was written for a **transient** failure — a D1 read that rejects — and
         * issue #217 showed it hiding a different class entirely. A missing lifecycle template is
         * permanent and total for that organization: the action succeeds, no delivery row is
         * written, and from every surface an organizer can see it is indistinguishable from a
         * message that went out. A Worker log line is not a surface an organizer reads.
         *
         * So that one class also lands on the event's own timeline, beside the action that
         * should have sent it — the same place `communications.delivery_enqueued` goes, which is
         * exactly the record whose absence is the symptom. The catch itself stays: nothing here
         * fails the committed action, and this is a second report rather than a rethrow.
         *
         * Keyed on `(event, template key)` with no occurrence, so a condition that repeats every
         * time anybody triggers that message records **once** rather than filling the timeline
         * with the same permanent fact. Defaults are provisioned on resolution now, so reaching
         * this at all means something an operator has to look at.
         */
        if (error instanceof MessageTemplateMissingError && organizationId)
          await auditRecorder.record({
            organizationId,
            eventId,
            action: "communications.template_missing",
            targetType: "message-template",
            targetId: error.templateKey,
            idempotencyKey: lifecycleAuditKey({
              action: "communications.template_missing",
              eventId,
              targetId: error.templateKey,
            }),
          });
        /*
         * And the second class the catch would otherwise hide: a message refused because this
         * event has reached its cap for an address nobody proved they control (issue #132).
         *
         * An organizer who records a decline and hears nothing has no way to tell "sent" from
         * "refused because ninety-nine other proposals name that address". The subject the caller
         * supplied identifies which action it was — a proposal id, a profile id — and the
         * recipient is deliberately **not** in the key or the record: it is the address of
         * somebody who did not ask to be here, and this timeline is read by every organizer on
         * the event.
         */
        if (error instanceof UnverifiedRecipientCapError && organizationId) {
          /*
           * `subject` is the structured-logging bag every caller already passes, and its first
           * entry is the identifier the message is *about* — the proposal, the profile, the
           * task. `taskAssigned` is the only caller with two, and it names `taskId` first for
           * this reason. Object literals preserve insertion order for string keys, so this is a
           * stated convention rather than an accident; the fallback keeps the record on the
           * event if a future caller passes nothing.
           *
           * No occurrence in the key, so an organizer who retries the same decision three times
           * gets one entry rather than three of the same permanent fact. A *different* decision
           * carries a different subject id and records again, which is the distinction that
           * matters when reading the timeline.
           */
          const subjectId = Object.values(subject)[0] ?? eventId;
          await auditRecorder.record({
            organizationId,
            eventId,
            action: "communications.recipient_cap_reached",
            targetType: "delivery",
            targetId: subjectId,
            idempotencyKey: lifecycleAuditKey({
              action: "communications.recipient_cap_reached",
              eventId,
              targetId: subjectId,
            }),
          });
        }
      }
    };
    /**
     * Record a lifecycle fact on the timeline.
     *
     * Resolves the owning organization itself rather than taking one, because the domains that
     * report these facts are event-scoped and have no reason to know which organization runs the
     * event.
     *
     * **Never throws, and the try/catch is the whole of that promise.** `AuditRecorder.record` is
     * already safe, but `organizationOf` is a D1 read that can reject, and this is the *first*
     * statement of five lifecycle ports whose owning domains await them unguarded and whose own
     * documentation says an implementation must not throw. Without the wrapper, a transient read
     * failure fails an action that has already committed: `requestTasks` would 500 after writing
     * its tasks, and the organizer's retry would mint a second set of them and a second set of
     * speaker emails — precisely the failure `SpeakerNotificationPort` exists to prevent. The
     * sibling `notifyLifecycle` below wraps the identical call for the identical reason.
     *
     * The key is scoped to the **event** as well as the action and target. The uniqueness
     * constraint behind it is `(organization_id, idempotency_key)`, and several targets are only
     * unique within an event — a reviewer's round number, a proposal id — so an event-less key
     * silently dropped the second event's record on an organization running two conferences.
     * `occurrence` is for a fact that can genuinely happen again to the same target: a decision
     * that is reversed and reinstated is three things that happened, not one.
     */
    const recordLifecycle = async (
      eventId: string,
      entry: {
        action: string;
        targetType: string;
        targetId: string;
        targetVersion?: number;
        occurrence?: string;
        actor?: { id: string | null; name: string; source: "human" | "api" | "agent" | "system" };
      },
    ): Promise<void> => {
      try {
        const organizationId = await organizationOf(eventId);
        if (!organizationId) throw new Error("Event has no owning organization");
        await auditRecorder.record({
          organizationId,
          eventId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          ...(entry.targetVersion !== undefined ? { targetVersion: entry.targetVersion } : {}),
          ...(entry.actor ? { actor: entry.actor } : {}),
          idempotencyKey: lifecycleAuditKey({ ...entry, eventId }),
        });
      } catch (error) {
        // ERROR-INTENT: reported rather than raised — the change this describes is already
        // durable, and failing here would undo nothing while breaking the action that succeeded.
        // Carries what the record would have said, so it can be reconstructed by hand.
        logger.error(
          {
            eventId,
            action: entry.action,
            targetId: entry.targetId,
            error: error instanceof Error ? error.message : String(error),
          },
          "audit.record.failed",
        );
      }
    };
    const speakerNotifications: SpeakerNotificationPort = {
      speakerAccepted: async (fact) => {
        await recordLifecycle(fact.eventId, {
          action: "content.speaker_accepted",
          targetType: "speaker-profile",
          targetId: fact.profileId,
        });
        await notifyLifecycle(fact.eventId, { profileId: fact.profileId }, () => ({
          idempotencyKey: `speaker-invite:${fact.eventId}:${fact.profileId}`,
          triggerType: "speaker.invited",
          channel: "email",
          recipientRef: fact.speakerEmail,
          payload: { speakerName: fact.speakerName, sessionTitle: fact.sessionTitle },
          templateKey: "speaker-invite",
        }));
      },
      taskAssigned: async (fact) => {
        await recordLifecycle(fact.eventId, {
          action: "content.task_assigned",
          targetType: "speaker-task",
          targetId: fact.taskId,
        });
        await notifyLifecycle(
          fact.eventId,
          { taskId: fact.taskId, profileId: fact.profileId },
          () => ({
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
          }),
        );
      },
    };
    /*
     * Resolve a lifecycle recipient without letting the lookup fail the thing that already happened.
     *
     * `recordLifecycle` and `notifyLifecycle` each swallow their own failures, and every lifecycle
     * port's docstring says an implementation must not throw — but the recipient read sat *between*
     * the two, unwrapped, so a transient D1 error answered 500 over an action that had already
     * committed. For a submitted proposal that is the worst shape available: submission is one-way,
     * so the applicant's retry is then refused with "already submitted" and no confirmation is ever
     * queued. Both ports below resolve through this instead.
     *
     * A failure logs here and the caller then logs `unaddressable` — two lines for one incident,
     * deliberately: this one carries the reason, and that one is also true, because the caller
     * genuinely has no address to use.
     */
    const recipientFor = async (userId: string, subject: Record<string, string>) => {
      try {
        const found = await identityDirectory.findRecipient(userId);
        /*
         * Shaped as an `AccountAddressLookup` so it can be handed to `lifecycleRecipient`
         * unchanged.
         *
         * An earlier version returned the recipient and let the caller build the discriminated
         * pair, which put the whole fail-closed property back in one hand-written line — and a
         * line that reads `{ asked: true, … }` unconditionally reintroduces the vulnerability
         * while typechecking. `name` rides along for the callers that render it; `email` and
         * `asked` are the two fields the rule is decided from, and nothing downstream re-derives
         * them.
         */
        return { asked: true as const, email: found?.email ?? null, name: found?.name ?? null };
      } catch (error) {
        // ERROR-INTENT: reported at error level with the identifiers needed to send the message by
        // hand, and swallowed so the committed action is still reported as the success it was.
        logger.error(
          { ...subject, error: error instanceof Error ? error.message : String(error) },
          "lifecycle.notification.failed",
        );
        /*
         * `asked: false` is the whole reason this returns a pair rather than a recipient.
         *
         * "This account has no linked address" and "we could not find out" are different facts,
         * and a caller that collapses them picks a *worse* address on the strength of a transient
         * error. The decision notification below is where that matters: falling through to the
         * form-supplied address on a failed lookup would send an accept or decline to whatever a
         * public form was told, which is precisely the exposure the account preference exists to
         * remove — and the delivery key holds the revision, so a retry converges on the row
         * already addressed wrongly rather than correcting it.
         */
        return { asked: false as const };
      }
    };
    const reviewNotifications: ReviewNotificationPort = {
      async reviewerAssigned(fact) {
        // Recorded before the message is resolved, deliberately: a reviewer with no linked
        // address is unreachable but the assignment still happened, and a timeline that only
        // showed the reachable ones would be describing the mail rather than the event.
        await recordLifecycle(fact.eventId, {
          action: "review.reviewer_assigned",
          targetType: "review-round",
          targetId: `${fact.reviewerId}:r${fact.round}`,
        });
        const reviewer = await recipientFor(fact.reviewerId, {
          eventId: fact.eventId,
          reviewerId: fact.reviewerId,
        });
        // No address means nobody to write to. Logged rather than queued, because a delivery to
        // a non-address would burn an attempt and fail terminally with a code that describes the
        // provider's refusal rather than the reason: this reviewer has no email linked.
        if (!reviewer.asked || !reviewer.email) {
          logger.warn(
            { eventId: fact.eventId, reviewerId: fact.reviewerId },
            "lifecycle.notification.unaddressable",
          );
          return;
        }
        const reviewerAddress = reviewer.email;
        const reviewerName = reviewer.name;
        await notifyLifecycle(fact.eventId, { reviewerId: fact.reviewerId }, () => ({
          idempotencyKey: `reviewer-assigned:${fact.eventId}:${fact.reviewerId}:r${fact.round}`,
          triggerType: "reviewer.assigned",
          channel: "email",
          recipientRef: reviewerAddress,
          payload: { reviewerName, round: fact.round },
          templateKey: "reviewer-assignment",
        }));
      },
      /*
       * The one lifecycle port that answers.
       *
       * `notifyLifecycle` is deliberately not used here, and the difference is the whole reason
       * this method exists rather than being a third call to it: that helper swallows its own
       * failures because nothing upstream of it can act on one — a speaker welcome that could not
       * be queued must not fail an acceptance that already committed. A reminder is the opposite
       * shape. An organizer pressed a button, is watching, and has to be told what happened to
       * each person: queued, already sent, or nobody to write to. Swallowing that would show
       * "reminded 4 reviewers" over four messages that do not exist.
       *
       * So this reports rather than throws — the port's contract still holds, and a real failure
       * is logged and surfaces as `unaddressable` rather than as a 500 over an authorized action.
       *
       * The idempotency key is `(event, reviewer, round)`, which is what makes pressing twice
       * queue once. It carries no timestamp and no occurrence counter, deliberately: this is the
       * manual "please finish your reviews" nudge, sent once per round, and a key that let it
       * repeat would make the button a way to mail somebody as many times as you can click. A
       * recurring weekly reminder is a different message with a different key and is not this.
       */
      async remindOutstanding(fact) {
        await recordLifecycle(fact.eventId, {
          action: "review.reviewer_reminded",
          targetType: "review-round",
          targetId: `${fact.reviewerId}:r${fact.round}`,
        });
        const reviewer = await recipientFor(fact.reviewerId, {
          eventId: fact.eventId,
          reviewerId: fact.reviewerId,
        });
        if (!reviewer.asked || !reviewer.email) {
          logger.warn(
            { eventId: fact.eventId, reviewerId: fact.reviewerId },
            "lifecycle.notification.unaddressable",
          );
          return "unaddressable";
        }
        try {
          const organizationId = await organizationOf(fact.eventId);
          if (!organizationId) throw new Error("Event has no owning organization");
          const enqueued = await communications.enqueue({
            organizationId,
            eventId: fact.eventId,
            idempotencyKey: `reviewer-reminder:${fact.eventId}:${fact.reviewerId}:r${fact.round}`,
            triggerType: "reviewer.reminder",
            channel: "email",
            recipientRef: reviewer.email,
            payload: {
              reviewerName: reviewer.name ?? "reviewer",
              round: fact.round,
              roundName: fact.roundName,
              outstanding: fact.outstanding,
            },
            templateKey: "reviewer-reminder",
          });
          // Only a delivery that was actually written belongs on the timeline; a converged retry
          // wrote nothing and recording it would put a second "reminder sent" beside one message.
          if (enqueued.created)
            await auditRecorder.record({
              organizationId,
              eventId: fact.eventId,
              action: "communications.delivery_enqueued",
              targetType: "delivery",
              targetId: enqueued.id,
              idempotencyKey: lifecycleAuditKey({
                action: "communications.delivery_enqueued",
                eventId: fact.eventId,
                targetId: enqueued.id,
              }),
            });
          return enqueued.created ? "queued" : "already_sent";
        } catch (error) {
          // ERROR-INTENT: reported at error level with the identifiers needed to send the message
          // by hand, and answered rather than thrown — the organizer's request is authorized and
          // the review state it read is real, so this reports one reviewer as unreachable rather
          // than failing the whole action.
          logger.error(
            {
              eventId: fact.eventId,
              reviewerId: fact.reviewerId,
              error: error instanceof Error ? error.message : String(error),
            },
            "lifecycle.notification.failed",
          );
          return "unaddressable";
        }
      },
      async decisionRecorded(fact) {
        // The outcome is in the key for the same reason it is in the delivery's: a reversed
        // decision is a different thing that happened, and the log has to hold both.
        /*
         * The revision is the occurrence, and it is the decision's own fact rather than this
         * clock's. Re-deciding the same way holds it, so a retried `decide` — which review
         * documents as how a half-finished decision heals — converges on one record. Accept,
         * decline, accept again advances it to 3, so the reinstatement is a third record rather
         * than a re-derivation of the first. Migration 1311 is what made both true at once.
         */
        await recordLifecycle(fact.eventId, {
          action: `review.decision_${fact.outcome}`,
          targetType: "proposal",
          targetId: fact.proposalId,
          occurrence: `r${fact.revision}`,
        });
        /*
         * Prefer the address identity holds for the owning account over the one the form
         * collected (issue #132).
         *
         * A decision is the most sensitive thing this system mails an applicant, and until
         * issue #190 its only possible recipient was an `email`-typed form answer that nobody
         * verified — so anyone could have a stranger's decision delivered to them by typing that
         * stranger's address. For an account-bound proposal the owner proved control of their
         * mailbox to sign in, and the trigger in `1201` makes the owner immutable, so this is a
         * strictly better address for exactly the same message.
         *
         * A guest submission still uses the form answer, which is why this **narrows** #132 rather
         * than closing it: the per-(event, recipient) cap or double opt-in that anonymous path
         * needs is a product decision with storage behind it, and is not taken here.
         *
         * An owned proposal whose account holds no address sends **nothing** — it does not fall
         * back. That fallback was here and it was wrong: the form answer on an owned proposal is
         * still unverified and possibly a stranger's, so using it would reintroduce the exact
         * misdirection preferring the account removes. The owner is not left in the dark, because
         * a decision is on their own dashboard; that is why `PRD-CFP-004` makes the dashboard the
         * guarantee and the message a courtesy.
         */
        /*
         * `undefined` for a guest, not a stand-in account, and the difference is the whole rule.
         *
         * `lifecycleRecipient` decides on *whether there is an account*: absent means guest and
         * reaches the form address, present means the account's answer is final. A guest was
         * represented here as `{ asked: true, email: null }` — which was right while an account
         * with no address fell through to the form, and became wrong the moment that fallback was
         * removed, because the sentinel is an account object and so answered "this account has no
         * address": every guest decision stopped being sent, silently.
         *
         * `recipientFor` answers in the shape the rule is decided from, so an account passes
         * straight through and there is no line here that could collapse "failed" into "no
         * address" either.
         */
        const recipient = await lifecycleRecipientForAccount({
          accountId: fact.submitterUserId,
          declaredEmail: fact.submitterEmail,
          askIdentity: (accountId) =>
            recipientFor(accountId, { eventId: fact.eventId, proposalId: fact.proposalId }),
        });
        if (!recipient) {
          logger.warn(
            { eventId: fact.eventId, proposalId: fact.proposalId },
            "lifecycle.notification.unaddressable",
          );
          return;
        }
        await notifyLifecycle(fact.eventId, { proposalId: fact.proposalId }, () => ({
          // The occurrence joins the outcome because a reinstatement is another real decision:
          // accept → decline → accept must not reuse the first acceptance's delivery key. A retry
          // holds the revision, so it still converges on the original delivery.
          idempotencyKey: `decision:${fact.eventId}:${fact.proposalId}:${fact.outcome}:r${fact.revision}`,
          triggerType: "decision.recorded",
          channel: "email",
          recipientRef: recipient,
          /*
           * The one place in this file where an **anonymous** submitter chose the address
           * (issue #132). `lifecycleRecipientForAccount` returns the account's address when there
           * is an account and the form answer when there is not, so the absence of
           * `submitterUserId` *is* the answer to "was this verified" — and it is passed on rather
           * than re-derived inside communications, which has no way to know.
           *
           * `declared` puts this delivery under `UNVERIFIED_RECIPIENT_CAP`. It does not make the
           * address verified: `DEBT-012` stands, bounded.
           *
           * It is not the only unproven address this file writes to — `fact.speakerEmail` above
           * is typed into a speaker profile and nobody proves that one either — and it is
           * deliberately the only one marked `declared`. The cap bounds *who can aim the mail*:
           * a speaker address is chosen by an authenticated organizer of that event, who can
           * already send to any address through the composer, so capping it would restrain
           * somebody the product does not restrain anyway. This address is chosen by whoever
           * filled in a public form. `DEBT-012` records the addresses; this line records which
           * of them an untrusted party picked.
           */
          recipientTrust: fact.submitterUserId ? "account" : "declared",
          payload: { submitterName: fact.submitterName, proposalTitle: fact.proposalTitle },
          templateKey: fact.outcome === "accepted" ? "decision-accepted" : "decision-declined",
        }));
      },
    };
    /*
     * The submission confirmation (issue #190), and the one line that makes it safe.
     *
     * `findRecipient` resolves the address from the **user id the session carried**, so the
     * recipient of this message is by construction somebody who proved control of that mailbox at
     * sign-in. Nothing a submitter typed into the form reaches it. That is the difference between
     * this message and the one decision `D5` refused to ship: the anonymous door sends nothing, and
     * an address on a form buys ownership of nothing (`#132`).
     *
     * An account with no linked address is logged rather than queued, exactly as an unaddressable
     * reviewer is — a delivery to a non-address burns an attempt and fails with a provider code
     * that describes the refusal instead of the reason.
     */
    const cfpNotifications: CfpNotificationPort = {
      async proposalSubmitted(fact) {
        await recordLifecycle(fact.eventId, {
          action: "cfp.proposal_submitted",
          targetType: "proposal",
          targetId: fact.proposalId,
        });
        const submitter = await recipientFor(fact.submitterUserId, {
          eventId: fact.eventId,
          proposalId: fact.proposalId,
        });
        if (!submitter.asked || !submitter.email) {
          logger.warn(
            { eventId: fact.eventId, proposalId: fact.proposalId },
            "lifecycle.notification.unaddressable",
          );
          return;
        }
        const submitterAddress = submitter.email;
        const submitterName = submitter.name;
        await notifyLifecycle(fact.eventId, { proposalId: fact.proposalId }, () => ({
          // One confirmation per proposal, not per revision: a submitter who fixes a typo and saves
          // again has not submitted a second proposal, and telling them twice would say they had.
          idempotencyKey: `proposal-submitted:${fact.eventId}:${fact.proposalId}`,
          triggerType: "proposal.submitted",
          channel: "email",
          recipientRef: submitterAddress,
          payload: {
            submitterName,
            // The proposal's own name, or a neutral stand-in: a form that asks for no title at all
            // is a form an organizer may legitimately have published.
            proposalTitle: fact.proposalTitle ?? "your proposal",
          },
          templateKey: "proposal-submitted",
        }));
      },
    };
    /*
     * Constructed here rather than beside the other domain services, because it takes the port
     * above and `notifyLifecycle` is defined in terms of the audit recorder and the events service.
     * Every reader of `cfpService` — the public projection slice, the template slice, and the
     * transport dependencies — is below this line.
     */
    const cfpService = new CfpService(
      new D1CfpRepository(environment.DB),
      () => crypto.randomUUID(),
      now,
      new D1SubmittedProposalAdapter(environment.DB),
      cfpNotifications,
    );
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
      // Turns the actor id on a revision into the name Edit history prints (#154). Identity's
      // public application interface, never a join against `users` from content's repository.
      identities: identityDirectory,
      // Acceptance and task assignment now reach the speaker. Content states the fact; this
      // binding decides the template, the trigger and the idempotency key.
      speakerNotifications,
      profileAudit: {
        profileUpdated: async (fact) =>
          recordLifecycle(fact.eventId, {
            action: "content.speaker_profile_updated",
            targetType: "speaker-profile",
            targetId: fact.profileId,
            targetVersion: fact.version,
            occurrence: `v${fact.version}`,
            actor: { id: fact.actorId, name: fact.actorName, source: fact.source },
          }),
      },
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
      /*
       * An organizer chasing a chosen set of open tasks, through the same delivery the cron
       * sweep uses. Content states "remind these people"; this binding turns that into the
       * delivering domain's request, exactly as the CRM's outreach port does above.
       *
       * The key is content's own (`taskReminderKey`), so a deliberate chase and the automatic
       * sweep converge on one delivery per (task, deadline) rather than sending twice.
       */
      reminders: {
        async send(reminder) {
          try {
            const delivery = await communications.enqueue({
              organizationId: reminder.organizationId,
              eventId: reminder.eventId,
              idempotencyKey: reminder.idempotencyKey,
              triggerType: "speaker.task_reminder",
              channel: "email",
              recipientRef: reminder.recipientRef,
              payload: reminder.payload,
              templateKey: reminder.templateKey,
            });
            return { deliveryId: delivery.id, created: delivery.created };
          } catch (error) {
            // A caller mistake — an unknown template, an incoherent request — becomes content's
            // own error so its transport can report it without importing these classes.
            if (
              error instanceof CommunicationsInputError ||
              error instanceof CommunicationsNotFoundError
            )
              throw new SpeakerReminderRejectedError(error.message);
            throw error;
          }
        },
        /*
         * An organizer inviting a speaker into the portal deliberately, and again if need be.
         *
         * `speaker.invited` rather than `speaker.task_reminder`: the trigger is this domain's
         * vocabulary, and it is the whole reason content declares two methods instead of one
         * generalised `send`. An invitation filed under the reminder trigger would be invisible
         * to anybody reading the delivery log for "what have we sent this person".
         *
         * The key is content's own (`speakerInvitationKey`), and carries the occurrence the
         * profile claimed, so pressing Invite again is a second delivery rather than one
         * deduplicated into the welcome `speakerAccepted` sent when the proposal was accepted —
         * whose unnumbered key is untouched above and stays exactly as idempotent as it was.
         */
        async invite(invitation) {
          try {
            const delivery = await communications.enqueue({
              organizationId: invitation.organizationId,
              eventId: invitation.eventId,
              idempotencyKey: invitation.idempotencyKey,
              triggerType: "speaker.invited",
              channel: "email",
              recipientRef: invitation.recipientRef,
              payload: invitation.payload,
              templateKey: invitation.templateKey,
            });
            return { deliveryId: delivery.id, created: delivery.created };
          } catch (error) {
            if (
              error instanceof CommunicationsInputError ||
              error instanceof CommunicationsNotFoundError
            )
              throw new SpeakerReminderRejectedError(error.message);
            throw error;
          }
        },
      },
      // Events owns which organization runs an event; content asks rather than joining.
      organizationOf: (eventId) => service.organizationOf(eventId),
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
    // `service` is the events domain's own application interface, which is how identity reaches
    // "does this event belong to that organization" without reading the events tables.
    const membership = new MembershipService({
      repository: new D1MembershipRepository(environment.DB),
      events: service,
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      mintToken: mintInvitationToken,
    });
    const apiClientRepository = new D1ApiClientRepository(environment.DB);
    const apiClients = new ApiClientService({
      repository: apiClientRepository,
      events: service,
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      mintCredential: mintApiClientCredential,
    });
    const apiClientResolver = new ApiClientResolver({
      repository: apiClientRepository,
      resolveCreator: (userId) => identityDirectory.findByUserId(userId),
      events: service,
      now: () => Date.now(),
    });
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
    publishing = new PublicationService(
      publicationRepository,
      {
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
            version: form.version,
            title: form.title,
            description: form.description,
            // The state applicants are in, not the publication flag. Reading `form.status` alone
            // put "open for submissions" on the published site and in the organizer's publication
            // preview for a call whose deadline had passed — the same misleading claim the composer
            // was corrected for, on the one surface a visitor actually reads.
            status: form.effectiveStatus === "open" ? "open" : "closed",
            publishedAt: form.publishedAt,
          };
        },
        content: contentRepository,
        schedule: (eventId) => agenda.published(eventId),
      },
      () => new Date(),
      /*
       * The last of the five domains on the audit timeline (#99).
       *
       * Publishing had no seam to observe, which is why a site going live was the one change the
       * log could not account for. The port it now declares states the fact; deciding that the
       * fact belongs on a timeline is this file's decision, exactly as it is for content's and
       * review's lifecycle ports. Recording never throws, so a page that is live stays live even
       * if its record cannot be written.
       */
      {
        eventPublished: (fact) =>
          recordLifecycle(fact.eventId, {
            action: "publishing.event_published",
            targetType: "public-page",
            // The instant is in the target, because publishing the same page twice is two things
            // that happened rather than one retried command.
            targetId: `${fact.slug}@${fact.publishedAt}`,
          }),
        eventUnpublished: (fact) =>
          recordLifecycle(fact.eventId, {
            action: "publishing.event_unpublished",
            targetType: "public-page",
            targetId: `${fact.slug}@${fact.unpublishedAt}`,
          }),
      },
    );
    const itineraries = new ItineraryService(new D1ItineraryRepository(environment.DB), publishing);
    // --- events (issue #102) ---
    /*
     * The orchestration seam for reusable event templates.
     *
     * Events declares `EventConfigurationSlice`; each domain implements its own slice inside
     * its own application directory; this file — the declared composition root, and the only
     * place allowed to know about more than one domain — binds them. That is why
     * `application/events` imports no other domain and `context/architecture.json` gains
     * nothing (`ARC-FLOW-006`).
     *
     * SLICE ORDER IS APPLY ORDER, and the first pair of it is load-bearing rather than
     * cosmetic: `CfpService.save` validates every routing rule against the destination's
     * configured triage statuses and drops the ones naming a status it does not have, so
     * review's slice — which writes that status set — has to run before CFP's or a cloned form
     * arrives with its routing silently thinned. The rest are independent of one another.
     */
    const eventTemplates = new EventTemplateService({
      repository: new D1EventTemplateRepository(environment.DB),
      events: service,
      slices: [
        reviewTemplateSlice(reviewService),
        cfpTemplateSlice(cfpService),
        agendaTemplateSlice(agenda),
        publishingTemplateSlice(
          publishing,
          publicationRepository,
          async (actor, eventId) => (await service.get(actor, eventId))?.name ?? null,
        ),
        /*
         * The empty embed allowlist is the honest argument, not a placeholder.
         *
         * A resource's iframe host is authorized per request by the organizer saving it
         * (`createSpeakerResourceInputSchema.embedAllowedHosts`) and is never stored — what
         * persists is the already-sanitized markup — so an import has no caller to ask and this
         * deployment holds no allowlist to fall back on. Reading one out of the stored payload
         * would let a template authorize its own iframe, which is the whole point of
         * re-sanitizing on import. So a cloned resource carrying an embed is reported as
         * `incompatible` by name, and the organizer re-authorizes the host when they save it in
         * the destination. Visible and safe beats convenient and forgeable.
         */
        speakerResourceTemplateSlice(content, []),
        speakerChecklistTemplateSlice(content),
      ],
      /*
       * So the console names the person who captured a version and the person who applied one,
       * rather than printing the stored account id (#176). Structural: the directory satisfies
       * the narrow `TemplateActorNamePort` events declares, and events imports nothing from
       * identity's adapter to say so.
       */
      actorNames: identityDirectory,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
      /*
       * Where a slice's unexpected throw is written, once, at the boundary that owns it.
       *
       * The organizer is told the category failed and that applying again is the repair; the
       * cause is here, because a per-category `reason` is a product surface and the driver's
       * text belongs in a log a responder reads (`ARC-OBS-001`). Which slice, which stage and
       * which event — never a payload, which is another domain's business by construction.
       */
      onSliceFault: ({ sliceKey, stage, eventId, error }) => {
        logger.error(
          {
            sliceKey,
            stage,
            eventId,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          "event.template.slice.failed",
        );
      },
    });
    // --- end events ---
    /*
     * The named form. The positional `createHttpApp` this used to call sorts its fourth
     * argument out at runtime by testing for a method on it, and it has no slot for a service
     * added after it was written — so a new domain either renames the seam or is unreachable.
     * `createHttpAppFrom` is what app.ts already tells new code to use; the mapping below is
     * exactly what the positional wrapper did, argument for argument.
     */
    // --- platform (issue #99) ---
    /*
     * Every source is the *same instance* the domain's own routes are composed from, and each is
     * handed the request's actor untouched. There is no platform-owned copy of any of this data
     * and no system-trust shortcut into it: an operator searching sees exactly the records their
     * role already lets them open, because the reads are the same reads.
     */
    const platformOps = new PlatformOperationsService({
      sources: {
        events: service,
        content,
        review: reviewService,
        agenda,
        publishing,
        communications,
        crm,
        // The same instance the events routes use, handed the request's actor untouched like
        // every other source. Platform learns nothing about templates from it beyond what an
        // inbox item says: the events domain does the folding (issue #203).
        eventConfiguration: eventTemplates,
      },
      dismissals: new D1InboxDismissalStore(environment.DB),
      now: () => new Date(),
      audit: auditRecorder,
      identity: requestIdentity,
    });
    // --- end platform ---
    const app = createHttpAppFrom({
      events: service,
      logger,
      auth: auth.demoMode
        ? {
            demoMode: true as const,
            sessionSecret: auth.sessionSecret,
            resolveActor: (persona: "organizer" | "reviewer" | "speaker" | "public") =>
              identityDirectory.findByPersona(persona),
            // `auth.google` is the *configuration*; the transport is handed the *provider*, so
            // no credential is reachable from a route module. The session store travels with
            // it: a demo deployment issues no session of its own, and the one case where it can
            // hold a real one is the case where Google is configured beside the personas.
            ...(googleAuth ? { google: googleAuth, sessions } : {}),
          }
        : {
            demoMode: false as const,
            sessionSecret: auth.sessionSecret,
            sessions,
            ...(googleAuth ? { google: googleAuth } : {}),
            resolveActor: (userId: string) => identityDirectory.findByUserId(userId),
            resolveApiClient: (credential: string) => apiClientResolver.resolve(credential),
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
      review: reviewService,
      cfp: cfpService,
      content,
      crm,
      agenda,
      communications,
      webhooks,
      publishing,
      itineraries,
      speakerCalendarInvites,
      accelEventsSync,
      membership,
      apiClients,
      eventTemplates,
      platformOps,
      build:
        environment.GREENROOM_WORKTREE_ROOT && environment.GREENROOM_COMMIT
          ? { root: environment.GREENROOM_WORKTREE_ROOT, commit: environment.GREENROOM_COMMIT }
          : undefined,
    });
    return app.fetch(request);
  },
  /**
   * The one-minute tick.
   *
   * Reminders run *before* the drain and are awaited, so a reminder decided this minute goes out
   * this minute rather than next. Their failures cannot stall it: `enqueueDueTaskReminders`
   * reports rather than throws, including when the open-task read itself fails, precisely so one
   * broken template cannot leave every queued delivery unsent.
   *
   * The drain, the itinerary prune and the schedule reconciliation stay concurrent with each
   * other: none depends on the others and all three are bounded.
   *
   * The reconciliation joins them rather than running before the drain, even though the drift it
   * repairs is what makes a calendar invitation wrong, because nothing in the drain sends one —
   * `SpeakerCalendarInviteService.send` is reached only from the organizer's explicit Send. There
   * is no ordering here that would make a queued delivery more correct.
   */
  async scheduled(_controller: unknown, environment: Environment): Promise<void> {
    // Both reminder passes run before the drain and are awaited, so a message decided this minute
    // goes out this minute. Neither can stall it: both report rather than throw, including when
    // their own read fails.
    await Promise.all([remindDueSpeakerTasks(environment), announceCfpDeadlines(environment)]);
    await Promise.all([
      drainOutbox(environment),
      pruneItineraries(environment),
      reconcileScheduleMaterializations(environment),
    ]);
  },
};
