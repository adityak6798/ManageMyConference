import { type D1DatabasePort, D1EventRepository } from "./adapters/persistence/d1-event-repository";
import { D1IdentityDirectory } from "./adapters/persistence/d1-identity-directory";
import { D1CommunicationsRepository } from "./adapters/persistence/d1-communications-repository";
import { DeterministicProvider } from "./adapters/providers/deterministic-provider";
import { D1AgendaRepository } from "./adapters/persistence/d1-agenda-repository";
import { AgendaService } from "./application/agenda/agenda-service";
import { D1CrmRepository } from "./adapters/persistence/d1-crm-repository";
import { D1SpeakerConversion } from "./adapters/content/d1-speaker-conversion";
import { D1ContentRepository } from "./adapters/persistence/d1-content-repository";
import { type R2BucketPort, R2AssetStorage } from "./adapters/storage/r2-asset-storage";
import { ContentService } from "./application/content/content-service";
import { D1ReviewRepository } from "./adapters/persistence/d1-review-repository";
import { D1SubmittedProposalAdapter } from "./adapters/persistence/d1-submitted-proposal-adapter";
import { D1CfpRepository } from "./adapters/persistence/d1-cfp-repository";
import { CfpService } from "./application/cfp/cfp-service";
import { CrmService } from "./application/crm/crm-service";
import { EventService } from "./application/events/event-service";
import { ReviewService } from "./application/review/review-service";
import { CommunicationsService } from "./application/communications/communications-service";
import { OutboxWorker } from "./application/communications/outbox-worker";
import { createHttpApp } from "./transport/http/app";

export interface Environment {
  DB: D1DatabasePort;
  ASSETS: R2BucketPort;
  DEMO_MODE?: string;
  SESSION_SECRET?: string;
  ENVIRONMENT?: string;
}

const communicationsRepository = (environment: Environment) =>
  new D1CommunicationsRepository(
    environment.DB as ConstructorParameters<typeof D1CommunicationsRepository>[0],
  );

export async function drainOutbox(environment: Environment, limit = 100): Promise<number> {
  const provider = new DeterministicProvider();
  const worker = new OutboxWorker(
    communicationsRepository(environment),
    { email: provider, airtable: provider, accelevents: provider },
    { newId: () => crypto.randomUUID(), now: () => new Date() },
  );
  let processed = 0;
  while (processed < limit && (await worker.runOne())) processed += 1;
  return processed;
}

export function runtimeAuth(
  environment: Pick<Environment, "DEMO_MODE" | "SESSION_SECRET" | "ENVIRONMENT">,
) {
  const demoMode = environment.DEMO_MODE === "true";
  if (demoMode && environment.ENVIRONMENT !== "development")
    throw new Error("DEMO_MODE is allowed only when ENVIRONMENT=development");
  if (
    demoMode &&
    (!environment.SESSION_SECRET || environment.SESSION_SECRET === "local-development-secret")
  )
    throw new Error("Demo mode requires a non-default SESSION_SECRET binding");
  if (demoMode)
    return { demoMode: true as const, sessionSecret: environment.SESSION_SECRET as string };
  return { demoMode: false as const };
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
    const content = new ContentService({
      repository: contentRepository,
      assetStorage: new R2AssetStorage(environment.ASSETS),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const cfpService = new CfpService(
      new D1CfpRepository(environment.DB),
      () => crypto.randomUUID(),
      () => new Date(),
    );
    const crm = new CrmService({
      repository: new D1CrmRepository(environment.DB),
      speakerConversion: new D1SpeakerConversion(
        environment.DB,
        () => crypto.randomUUID(),
        identityDirectory,
      ),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const now = () => new Date();
    const agenda = new AgendaService(
      new D1AgendaRepository(environment.DB, now),
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
    const reviewService = new ReviewService({
      repository: new D1ReviewRepository(environment.DB),
      proposals: new D1SubmittedProposalAdapter(environment.DB),
      identities: identityDirectory,
      events: service,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const communications = new CommunicationsService({
      repository: communicationsRepository(environment),
      eventDirectory: service,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
    const app = createHttpApp(
      service,
      logger,
      auth.demoMode
        ? { ...auth, resolveActor: (persona) => identityDirectory.findByPersona(persona) }
        : auth,
      reviewService,
      cfpService,
      content,
      crm,
      agenda,
      communications,
    );
    return Promise.resolve(app.fetch(request));
  },
  scheduled(_controller: unknown, environment: Environment): Promise<void> {
    return drainOutbox(environment).then(() => undefined);
  },
};
