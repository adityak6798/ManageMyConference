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
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { envelope, readJson } from "../runtime";
import { clientAddress, FixedWindowThrottle } from "../throttle";
import type { HttpApp, HttpDependencies, RouteModule } from "./contract";

const routes = [
  "GET /api/auth/config",
  "POST /api/auth/code",
  "POST /api/auth/verify",
  "POST /api/auth/tokens",
  "GET /api/auth/google/start",
  "GET /api/auth/google/callback",
  "POST /api/auth/signout",
  "POST /api/demo-session",
  "GET /api/session",
] as const;
const loginThrottle = new FixedWindowThrottle(5, 60_000, 10_000);
/**
 * A sign-in attempt costs a D1 write and a redirect, so it is rate limited on the caller's
 * address alone — nothing the caller supplies enters the key, for the reason
 * `FixedWindowThrottle` documents: a key a client can rotate lets a flooder evict its own
 * exhausted counter.
 */
const googleStartThrottle = new FixedWindowThrottle(10, 60_000, 10_000);

/** Where an attempt id lives between the redirect to Google and the callback. */
const OAUTH_COOKIE = "greenroom_oauth";
/** The session lifetime the emailed-code route already uses; Google issues the same session. */
const SESSION_LIFETIME_MS = 28_800_000;

/**
 * `SameSite=Lax`, and this is the one place in this file that is not `Strict`.
 *
 * The callback is a top-level GET navigation that Google initiates, which makes it cross-site.
 * A `Strict` cookie is not sent on such a navigation, so the attempt id would be missing and
 * every sign-in would fail the `state` check — the flow would be broken in exactly the way that
 * looks like a CSRF defence working. `Lax` is sent on top-level GET navigations and on nothing
 * else, which is precisely this case and no other.
 */
const oauthCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: "Lax" as const,
  secure,
  path: "/",
  maxAge: 600,
});

export const identityRoutes: RouteModule = {
  domain: "identity-access",
  routes,
  register(app: HttpApp, dependencies: HttpDependencies) {
    const { auth } = dependencies;
    const isSecure = (context: { req: { url: string } }) =>
      new URL(context.req.url).protocol === "https:";
    app.get("/api/auth/config", (context) =>
      context.json({ demoMode: auth.demoMode, google: Boolean(auth.google) }),
    );

    /**
     * Begin the authorization-code flow.
     *
     * A plain redirect rather than a JSON endpoint the client follows, so the button is an
     * ordinary link: no script, no CORS preflight, and the browser's own navigation carries the
     * `Lax` cookie back on the callback.
     *
     * 404 rather than 503 when Google is unconfigured, matching the emailed-code routes: a door
     * this deployment does not have is a route that does not exist, not a feature that is having
     * a bad day.
     */
    app.get("/api/auth/google/start", async (context) => {
      if (!auth.google)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const now = (auth.now ?? Date.now)();
      const throttle = googleStartThrottle.check(clientAddress(context.req.raw.headers), now);
      if (!throttle.allowed) {
        context.header("Retry-After", String(throttle.retryAfterSeconds));
        return context.json(
          envelope("RATE_LIMITED", "Try again later.", context.get("correlationId")),
          429,
        );
      }
      const { authorizationUrl, attemptId } = await auth.google.start(now);
      setCookie(context, OAUTH_COOKIE, attemptId, oauthCookieOptions(isSecure(context)));
      return context.redirect(authorizationUrl, 302);
    });

    /**
     * Google's return leg.
     *
     * Everything that can go wrong lands on the same destination — `/signin?auth=failed` — and
     * the reason stays in the Worker log. A callback is reachable by anybody with a browser, so
     * telling them *which* check refused (unknown attempt, wrong `state`, expired, bad
     * signature, unverified address) would hand an attacker the oracle this flow exists to deny
     * them.
     *
     * The redirect targets are string literals in this file. Nothing from the request decides
     * where the browser goes next, which is the open redirect this route would otherwise be.
     */
    app.get("/api/auth/google/callback", async (context) => {
      if (!auth.google)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const secure = isSecure(context);
      const attemptId = getCookie(context, OAUTH_COOKIE);
      // Spent or not, this browser is done with the attempt: clearing first means an abandoned
      // or failed sign-in leaves nothing behind to be retried against.
      deleteCookie(context, OAUTH_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
      const code = context.req.query("code");
      const state = context.req.query("state");
      const failed = () => context.redirect("/signin?auth=failed", 302);
      if (!attemptId || !code || !state) return failed();
      const now = (auth.now ?? Date.now)();
      const outcome = await auth.google.complete({ attemptId, state, code, now });
      if (!outcome) return failed();
      setCookie(
        context,
        "greenroom_session",
        await createUserSession(
          outcome.actor.id,
          auth.sessionSecret as string,
          now + SESSION_LIFETIME_MS,
        ),
        {
          httpOnly: true,
          sameSite: "Strict",
          secure,
          path: "/",
          maxAge: SESSION_LIFETIME_MS / 1000,
        },
      );
      // A brand-new workspace lands on its own welcome rather than on a console full of empty
      // tables. Same-origin literal, and the flag carries no identity.
      return context.redirect(outcome.provisioned ? "/?welcome=1" : "/", 302);
    });

    /**
     * End this browser's session.
     *
     * Clearing the cookie, and nothing more — see `signOutResponseSchema`. Answering 200 whether
     * or not a session was present keeps this from reporting whether the caller had one.
     */
    app.post("/api/auth/signout", (context) => {
      deleteCookie(context, "greenroom_session", {
        path: "/",
        secure: isSecure(context),
        httpOnly: true,
        sameSite: "Strict",
      });
      return context.json({ signedOut: true as const });
    });
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
      if (context.get("authentication") !== "session")
        throw new AuthenticationRequiredError("A user session is required to create a token");
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
