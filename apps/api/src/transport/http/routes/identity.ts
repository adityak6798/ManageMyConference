/**
 * The demo-session endpoint and the session read. Harness-only identity: `/api/demo-session` exists solely when DEMO_MODE is on, and the runtime refuses it otherwise.
 *
 * Owned by the `identity-access` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import {
  demoSessionInputSchema,
  eventTokenRequestSchema,
  loginCodeRequestSchema,
  loginCodeVerifySchema,
} from "@greenroom/contracts";
import {
  AuthenticationRequiredError,
  requireEventCapability,
} from "../../../application/identity/actor";
import { createDemoSession } from "../../../application/identity/demo-session";
import {
  createEventToken,
  createLoginChallenge,
  createUserSession,
  exchangeLoginChallenge,
} from "../../../application/identity/real-auth";
import { setCookie } from "hono/cookie";
import { envelope, readJson } from "../runtime";
import { clientAddress, FixedWindowThrottle } from "../throttle";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/auth/config",
  "POST /api/auth/code",
  "POST /api/auth/verify",
  "POST /api/auth/tokens",
  "POST /api/demo-session",
  "GET /api/session",
] as const;
const loginThrottle = new FixedWindowThrottle(5, 60_000, 10_000);

export const identityRoutes: RouteModule = {
  domain: "identity-access",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { auth } = dependencies;
    app.get("/api/auth/config", (context) => context.json({ demoMode: auth.demoMode }));
    app.post("/api/auth/code", async (context) => {
      if (auth.demoMode || !auth.sessionSecret)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const throttle = loginThrottle.check(
        clientAddress(context.req.raw.headers),
        (auth.now ?? Date.now)(),
      );
      if (!throttle.allowed) {
        context.header("Retry-After", String(throttle.retryAfterSeconds));
        return context.json(
          envelope("RATE_LIMITED", "Try again later.", context.get("correlationId")),
          429,
        );
      }
      const parsed = loginCodeRequestSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Enter a valid email address.",
            context.get("correlationId"),
          ),
          400,
        );
      const email = parsed.data.email.trim().toLowerCase();
      const issued = await createLoginChallenge(
        email,
        auth.sessionSecret,
        (auth.now ?? Date.now)() + 600_000,
      );
      await auth.saveLoginChallenge(issued);
      // Send the same fixed-content message for every syntactically valid address. Verification
      // still requires a D1-linked identity, so this keeps account existence out of the response.
      await auth.sendLoginCode(email, issued.code);
      return context.json({ challenge: issued.challenge }, 202);
    });
    app.post("/api/auth/verify", async (context) => {
      if (auth.demoMode || !auth.sessionSecret)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const parsed = loginCodeVerifySchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "The login code is invalid.", context.get("correlationId")),
          400,
        );
      const now = (auth.now ?? Date.now)();
      const email = await exchangeLoginChallenge(
        parsed.data.challenge,
        parsed.data.code,
        auth.sessionSecret,
        now,
        auth.consumeLoginChallenge,
      );
      const actor = email ? await auth.resolveEmail(email) : null;
      if (!actor)
        return context.json(
          envelope(
            "UNAUTHORIZED",
            "The login code is invalid or expired.",
            context.get("correlationId"),
          ),
          401,
        );
      setCookie(
        context,
        "greenroom_session",
        await createUserSession(actor.id, auth.sessionSecret, now + 28_800_000),
        {
          httpOnly: true,
          sameSite: "Strict",
          secure: new URL(context.req.url).protocol === "https:",
          path: "/",
          maxAge: 28_800,
        },
      );
      return context.json({ authenticated: true as const });
    });
    app.post("/api/auth/tokens", async (context) => {
      if (auth.demoMode || !auth.sessionSecret)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const parsed = eventTokenRequestSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Event ID is malformed.", context.get("correlationId")),
          400,
        );
      const actor = requireEventCapability(
        context.get("actor"),
        parsed.data.eventId,
        "events:read",
      );
      const now = (auth.now ?? Date.now)();
      const expiresAt = now + 3_600_000;
      return context.json(
        {
          token: await createEventToken(
            actor.id,
            parsed.data.eventId,
            auth.sessionSecret,
            expiresAt,
          ),
          eventId: parsed.data.eventId,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        201,
      );
    });
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
