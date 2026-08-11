import { type D1DatabasePort, D1EventRepository } from "./adapters/persistence/d1-event-repository";
import { D1IdentityDirectory } from "./adapters/persistence/d1-identity-directory";
import { D1ReviewRepository } from "./adapters/persistence/d1-review-repository";
import { D1SubmittedProposalAdapter } from "./adapters/persistence/d1-submitted-proposal-adapter";
import { D1CfpRepository } from "./adapters/persistence/d1-cfp-repository";
import { CfpService } from "./application/cfp/cfp-service";
import { EventService } from "./application/events/event-service";
import { ReviewService } from "./application/review/review-service";
import { createHttpApp } from "./transport/http/app";

interface Environment {
  DB: D1DatabasePort;
  DEMO_MODE?: string;
  SESSION_SECRET?: string;
  ENVIRONMENT?: string;
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
    const cfpService = new CfpService(
      new D1CfpRepository(environment.DB),
      () => crypto.randomUUID(),
      () => new Date(),
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
    const app = createHttpApp(
      service,
      logger,
      auth.demoMode
        ? { ...auth, resolveActor: (persona) => identityDirectory.findByPersona(persona) }
        : auth,
      reviewService,
      cfpService,
    );
    return Promise.resolve(app.fetch(request));
  },
};
