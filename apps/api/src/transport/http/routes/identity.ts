/**
 * The demo-session endpoint and the session read. Harness-only identity: `/api/demo-session` exists solely when DEMO_MODE is on, and the runtime refuses it otherwise.
 *
 * Owned by the `identity-access` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import { demoSessionInputSchema } from "@greenroom/contracts";
import { AuthenticationRequiredError } from "../../../application/identity/actor";
import { createDemoSession } from "../../../application/identity/demo-session";
import { setCookie } from "hono/cookie";
import { envelope, readJson } from "../runtime";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = ["POST /api/demo-session", "GET /api/session"] as const;

export const identityRoutes: RouteModule = {
  domain: "identity-access",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { auth } = dependencies;
    app.post("/api/demo-session", async (context) => {
      if (!auth.demoMode)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const parsed = demoSessionInputSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Choose a valid demo persona.",
            context.get("correlationId"),
          ),
          400,
        );
      const sessionSecret = auth.sessionSecret;
      const now = (auth.now ?? Date.now)();
      setCookie(
        context,
        "greenroom_session",
        await createDemoSession(parsed.data.persona, sessionSecret, now + 28_800_000),
        {
          httpOnly: true,
          sameSite: "Strict",
          secure: new URL(context.req.url).protocol === "https:",
          path: "/",
          maxAge: 28_800,
        },
      );
      return context.json({ persona: parsed.data.persona });
    });
    app.get("/api/session", (context) => {
      const actor = context.get("actor");
      if (!actor) throw new AuthenticationRequiredError("Authentication is required");
      return context.json({
        actor: { id: actor.id, name: actor.name, persona: actor.persona },
        organizations: actor.organizations,
        eventAccess: actor.eventAccess.map((access) => ({
          eventId: access.eventId,
          role: access.role,
          capabilities: [...access.capabilities],
        })),
        capabilities: [...actor.capabilities],
      });
    });
  },
};
