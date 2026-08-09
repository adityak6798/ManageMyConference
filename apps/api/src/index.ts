import { type D1DatabasePort, D1EventRepository } from "./adapters/persistence/d1-event-repository";
import { EventService } from "./application/events/event-service";
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
  if (environment.ENVIRONMENT === "production" && demoMode)
    throw new Error("DEMO_MODE must be disabled in production");
  if (
    demoMode &&
    (!environment.SESSION_SECRET || environment.SESSION_SECRET === "local-development-secret")
  )
    throw new Error("Demo mode requires a non-default SESSION_SECRET binding");
  return {
    demoMode,
    ...(environment.SESSION_SECRET ? { sessionSecret: environment.SESSION_SECRET } : {}),
  };
}

// @spec PRD-EVT-001 ARC-OBS-001
export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    const auth = runtimeAuth(environment);
    const service = new EventService({
      repository: new D1EventRepository(environment.DB),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    });
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
    const app = createHttpApp(service, logger, auth);
    return Promise.resolve(app.fetch(request));
  },
};
