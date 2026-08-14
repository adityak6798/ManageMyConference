/**
 * The demo-session endpoint and the session read. Harness-only identity: `/api/demo-session` exists solely when DEMO_MODE is on, and the runtime refuses it otherwise.
 *
 * Owned by the `identity-access` domain. Adding a route here changes no other domain's
 * module and does not touch `app.ts`.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import {
  acceptInvitationSchema,
  createApiClientSchema,
  createInvitationSchema,
  customRoleDeleteQuerySchema,
  customRoleDraftSchema,
  customRolePreviewResponseSchema,
  customRoleResponseSchema,
  customRolesResponseSchema,
  customRoleUpdateSchema,
  demoSessionInputSchema,
  eventFieldLocksInputSchema,
  eventFieldLocksResponseSchema,
  eventRoleSchema,
  eventTokenRequestSchema,
  loginCodeRequestSchema,
  loginCodeVerifySchema,
} from "@greenroom/contracts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  AuthenticationRequiredError,
  type Capability,
  requireEventCapability,
} from "../../../application/identity/actor";
import {
  ApiClientConflictError,
  ApiClientInputError,
  ApiClientNotFoundError,
  type PublicApiClient,
} from "../../../application/identity/api-clients";
import type { AuditContext } from "../../../application/identity/audit";
import {
  CustomRoleConflictError,
  CustomRoleInvalidError,
  CustomRoleNameTakenError,
  CustomRoleNotFoundError,
  CustomRoleRefusedError,
} from "../../../application/identity/custom-roles";
import { createDemoSession, isDemoPersonaId } from "../../../application/identity/demo-session";
import {
  EventOutsideOrganizationError,
  type InvitableRole,
  InvitationInvalidError,
  MembershipRefusedError,
} from "../../../application/identity/membership";
import { LastAdministratorError } from "../../../application/identity/organization-administration";
import {
  createEventToken,
  createLoginChallenge,
  createUserSession,
  exchangeLoginChallenge,
  sessionIdFrom,
} from "../../../application/identity/real-auth";
import {
  parseAttemptCookie,
  serializeAttemptCookie,
  withAttempt,
  withoutAttempt,
} from "../oauth-attempt-cookie";
import { envelope, type HttpContext, readJson, validationFields } from "../runtime";
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
  "POST /api/auth/sessions/revoke-all",
  "POST /api/demo-session",
  "GET /api/session",
  "GET /api/organizations/{organizationId}/members",
  "POST /api/organizations/{organizationId}/invitations",
  "DELETE /api/organizations/{organizationId}/invitations/{invitationId}",
  "POST /api/invitations/accept",
  "DELETE /api/organizations/{organizationId}/members/{userId}",
  "PUT /api/organizations/{organizationId}/events/{eventId}/roles/{userId}",
  "DELETE /api/organizations/{organizationId}/events/{eventId}/roles/{userId}",
  "GET /api/organizations/{organizationId}/audit-events",
  "POST /api/organizations/{organizationId}/api-clients",
  "GET /api/organizations/{organizationId}/api-clients",
  "POST /api/organizations/{organizationId}/api-clients/{clientId}/rotate",
  "DELETE /api/organizations/{organizationId}/api-clients/{clientId}",
  // Custom event roles (issue #196), addressed under the organization that owns the event for
  // the same reason built-in event roles are: the address is where the authorization happens.
  "GET /api/organizations/{organizationId}/events/{eventId}/custom-roles",
  "POST /api/organizations/{organizationId}/events/{eventId}/custom-roles",
  "PUT /api/organizations/{organizationId}/events/{eventId}/custom-roles/{roleId}",
  "DELETE /api/organizations/{organizationId}/events/{eventId}/custom-roles/{roleId}",
  "GET /api/organizations/{organizationId}/events/{eventId}/custom-roles/{roleId}/preview",
  "PUT /api/organizations/{organizationId}/events/{eventId}/custom-roles/{roleId}/holders/{userId}",
  "DELETE /api/organizations/{organizationId}/events/{eventId}/custom-roles/{roleId}/holders/{userId}",
  // Per-event portal field locks: what an organizer closed on this event's own write surface.
  "PUT /api/organizations/{organizationId}/events/{eventId}/field-locks",
] as const;
const loginThrottle = new FixedWindowThrottle(5, 60_000, 10_000);
/**
 * A sign-in attempt costs a D1 write and a redirect, so it is rate limited on the caller's
 * address alone — nothing the caller supplies enters the key, for the reason
 * `FixedWindowThrottle` documents: a key a client can rotate lets a flooder evict its own
 * exhausted counter.
 */
const googleStartThrottle = new FixedWindowThrottle(10, 60_000, 10_000);

/**
 * Where this browser's outstanding attempt ids live between the redirect to Google and the
 * callback. A set rather than one id, because two tabs are two sign-ins in flight — see
 * `oauth-attempt-cookie.ts` for what the cookie is for and why it is still here.
 */
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

/**
 * The request half of an audit row.
 *
 * `source` is `human` for every audited action in this module, and that is a fact about the
 * module rather than a default: each of them is somebody pressing something in a browser. An
 * `api` source belongs to a bearer-authenticated caller, and the one bearer-minting route here
 * writes no audit row.
 */
const auditContext = (context: HttpContext): AuditContext => ({
  correlationId: context.get("correlationId"),
  actorUserId: context.get("actor")?.id ?? null,
  source: "human",
});

const apiClientDto = (client: PublicApiClient) => ({
  ...client,
  createdAt: new Date(client.createdAt).toISOString(),
  expiresAt: client.expiresAt === null ? null : new Date(client.expiresAt).toISOString(),
  revokedAt: client.revokedAt === null ? null : new Date(client.revokedAt).toISOString(),
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
      // Minting an attempt is a D1 write. Left to the transport's error boundary it would answer a
      // JSON 500 to a plain link click, which is a dead end in the address bar; the person gets the
      // sign-in page back instead, and the reason goes to the log with their correlation id.
      let started: { authorizationUrl: string; attemptId: string };
      try {
        started = await auth.google.start(now);
      } catch (error) {
        // ERROR-INTENT: reported at error level because a sign-in that cannot even begin is this
        // deployment failing, not a caller being refused.
        dependencies.logger.error(
          {
            correlationId: context.get("correlationId"),
            reason: error instanceof Error ? error.message : String(error),
          },
          "auth.google.failed",
        );
        return context.redirect("/signin?auth=failed", 302);
      }
      // Appended rather than assigned. Overwriting is what made a second tab refuse the first
      // (issue #166); the cap is what stops the cookie growing without bound.
      const outstanding = withAttempt(
        parseAttemptCookie(getCookie(context, OAUTH_COOKIE)),
        started.attemptId,
      );
      setCookie(
        context,
        OAUTH_COOKIE,
        serializeAttemptCookie(outstanding),
        oauthCookieOptions(isSecure(context)),
      );
      return context.redirect(started.authorizationUrl, 302);
    });

    /**
     * Google's return leg.
     *
     * Every *refusal* lands on the same destination — `/signin?auth=failed` — and the reason
     * stays in the Worker log. A callback is reachable by anybody with a browser, so telling
     * them *which* check refused (unknown attempt, wrong `state`, expired, bad signature,
     * unverified address) would hand an attacker the oracle this flow exists to deny them.
     *
     * A failure that is **ours** is told apart, and only that one: `/signin?auth=unavailable`
     * says the deployment broke rather than the person's account, which is what issue #164 asks
     * for. It is not an oracle, and the reason is independence rather than ordering: an
     * operational failure is reachable at any point in the flow — the attempt lookup is itself a
     * D1 write — but whether storage is up is uncorrelated with whether this caller's `state`
     * matched anything, so learning it tells a forger nothing about their forgery. Either way
     * `complete` catches rather than throwing, because the transport's error boundary would
     * answer a JSON envelope, rendered as raw JSON in the address bar on a top-level navigation.
     *
     * The redirect targets are string literals in this file. Nothing from the request decides
     * where the browser goes next, which is the open redirect this route would otherwise be.
     *
     * **The cookie is no longer cleared before the attempt is identified.** Doing that is what
     * made an older tab's failed callback destroy a newer tab's live attempt (issue #166). Only
     * the attempt this callback actually spent is dropped; every other attempt this browser
     * holds stays outstanding, and a spent one is already unusable because its row is gone.
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
      const attemptIds = parseAttemptCookie(getCookie(context, OAUTH_COOKIE));
      const code = context.req.query("code");
      const state = context.req.query("state");
      /** Rewrite the cookie to whatever this browser still has in flight, and answer. */
      const settle = (spentAttemptId: string | null, destination: string) => {
        const remaining = withoutAttempt(attemptIds, spentAttemptId);
        if (remaining.length === 0)
          deleteCookie(context, OAUTH_COOKIE, {
            path: "/",
            secure,
            httpOnly: true,
            sameSite: "Lax",
          });
        else
          setCookie(
            context,
            OAUTH_COOKIE,
            serializeAttemptCookie(remaining),
            oauthCookieOptions(secure),
          );
        return context.redirect(destination, 302);
      };
      const failed = (spentAttemptId: string | null = null) =>
        settle(spentAttemptId, "/signin?auth=failed");
      const unavailable = (spentAttemptId: string | null = null) =>
        settle(spentAttemptId, "/signin?auth=unavailable");
      if (attemptIds.length === 0 || !code || !state) {
        // ERROR-INTENT: reported rather than swallowed. A callback from a browser that started
        // nothing is the CSRF case this cookie exists to refuse, and it is worth telling apart
        // from a `state` that simply did not match — issue #166 asks for exactly that split.
        dependencies.logger.warn(
          {
            correlationId: context.get("correlationId"),
            reason: attemptIds.length === 0 ? "no_attempt_presented" : "callback_incomplete",
          },
          "auth.google.refused",
        );
        return failed();
      }
      const now = (auth.now ?? Date.now)();
      const { spentAttemptId, outcome } = await auth.google.complete({
        attemptIds,
        state,
        code,
        now,
        correlationId: context.get("correlationId"),
      });
      if (outcome.status === "unavailable") return unavailable(spentAttemptId);
      if (outcome.status === "refused") return failed(spentAttemptId);
      // A verified Google identity that resolved *to a seeded demo persona* is refused here, and
      // this is the crossing the guard exists for. On a demo deployment with Google configured,
      // account linking matches a verified address, and `seed/reset.sql` gives the personas real
      // addresses — so signing in as `organizer@greenroom.test` would otherwise link the provider
      // account to `seed-organizer` and mint a real session for the identity the landing page
      // hands to the next visitor who presses "Continue as organizer".
      if (isDemoPersonaId(outcome.actor.id)) {
        // ERROR-INTENT: reported rather than swallowed, and as a refusal rather than a failure —
        // the deployment is misconfigured (a seeded address is claimable by a real provider
        // account), not broken. The caller gets the same indistinguishable redirect as every
        // other callback refusal, for the reason this route's own docstring gives.
        dependencies.logger.warn(
          { correlationId: context.get("correlationId"), reason: "demo-persona-subject" },
          "auth.google.refused",
        );
        return failed(spentAttemptId);
      }
      const expiresAt = now + SESSION_LIFETIME_MS;
      const sessionId = crypto.randomUUID();
      // The record comes before the cookie, and its failure is a failed sign-in rather than a
      // 500: this is a top-level navigation, so the transport's JSON error envelope would be
      // rendered as raw text in the address bar. A cookie issued without its record would
      // resolve to nothing on the very next request anyway, which is a sign-in that silently
      // did not happen.
      try {
        await auth.sessions.issue(
          {
            id: sessionId,
            userId: outcome.actor.id,
            issuedAt: now,
            expiresAt,
          },
          {
            correlationId: context.get("correlationId"),
            actorUserId: outcome.actor.id,
            source: "human",
          },
        );
      } catch (error) {
        // ERROR-INTENT: reported at error level, because a sign-in that verified and then could
        // not be recorded is this deployment failing rather than a caller being refused.
        dependencies.logger.error(
          {
            correlationId: context.get("correlationId"),
            reason: error instanceof Error ? error.message : String(error),
          },
          "auth.session.issue_failed",
        );
        return unavailable(spentAttemptId);
      }
      setCookie(
        context,
        "greenroom_session",
        await createUserSession(
          sessionId,
          outcome.actor.id,
          auth.sessionSecret as string,
          expiresAt,
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
      // tables. Same-origin literal, and the flag carries no identity. The attempt this callback
      // spent leaves the cookie; any other tab's attempt stays outstanding.
      return settle(spentAttemptId, outcome.provisioned ? "/?welcome=1" : "/");
    });

    /**
     * End this browser's session — and the session itself.
     *
     * Revocation first, cookie second. The record named by the cookie's `sid` is marked revoked,
     * which is what stops a copy of the same cookie taken from another device, and what stops an
     * event bearer token minted from that session; then the cookie is cleared.
     *
     * Still 200 whether or not a session was present, and still `{ signedOut: true }` rather than
     * a count: the response must not report whether the caller held a session, and the number of
     * rows revoked would. `POST /api/auth/sessions/revoke-all` reports a count because it
     * requires a session first, so the count is the caller's own data.
     *
     * A demo persona cookie carries no `sid`, so it takes no lookup at all. Nor does an expired
     * one: `sessionIdFrom` refuses a payload past its expiry, which is what stops a dead but
     * validly-signed cookie being replayed here as an unlimited supply of database writes.
     *
     * A store failure is deliberately *not* swallowed. `{ signedOut: true }` on a session that is
     * still live is the pre-#12 behaviour with a more reassuring label, which is the more
     * dangerous product; the caller gets a 500 and the correlation id instead.
     */
    app.post("/api/auth/signout", async (context) => {
      const now = (auth.now ?? Date.now)();
      const sessionId = auth.sessionSecret
        ? await sessionIdFrom(getCookie(context, "greenroom_session"), auth.sessionSecret, now)
        : null;
      // `auth.sessions` is absent only on a deployment that records no sessions — demo without
      // Google, or no signing secret at all — and on those no cookie can resolve as a real
      // session in the first place, so there is nothing here to revoke. Cookie clearing below
      // still runs, which is the whole of what sign-out meant on such a deployment before.
      if (sessionId && auth.sessions)
        await auth.sessions.revoke(sessionId, now, auditContext(context));
      deleteCookie(context, "greenroom_session", {
        path: "/",
        secure: isSecure(context),
        httpOnly: true,
        sameSite: "Strict",
      });
      return context.json({ signedOut: true as const });
    });

    /**
     * Sign out on every device.
     *
     * Requires a real session — a persona cookie resolves as `demo` and is refused here, so no
     * demo caller can end anything. The count is safe to report because the caller had to prove
     * the identity it counts: these are their own sessions and nobody else's.
     *
     * 404 where the deployment records no sessions at all, matching every other door this
     * module offers conditionally.
     */
    app.post("/api/auth/sessions/revoke-all", async (context) => {
      if (!auth.sessions)
        return context.json(
          envelope(
            "NOT_FOUND",
            "The requested resource was not found.",
            context.get("correlationId"),
          ),
          404,
        );
      const actor = context.get("actor");
      if (context.get("authentication") !== "session" || !actor)
        throw new AuthenticationRequiredError("A user session is required to end every session");
      return context.json({
        revoked: await auth.sessions.revokeAllForUser(
          actor.id,
          (auth.now ?? Date.now)(),
          auditContext(context),
        ),
      });
    });
    /*
     * Membership administration.
     *
     * Addressed by organization, because that is the scope the answer spans and because it gives
     * cross-event visibility exactly one place to be authorized — the same reasoning the CRM
     * directory records. `MembershipService` owns the three-condition authorization and the
     * demo-persona guard; these handlers own shape and status and nothing else.
     *
     * Every one of them 404s when the service is unwired, rather than 500ing, because a
     * deployment composed without it genuinely does not have these doors.
     */
    const membership = dependencies.membership;
    const customRoles = dependencies.customRoles;
    const noMembership = (context: HttpContext) =>
      context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );
    /** Instants cross the wire as ISO strings; the database keeps them as epoch milliseconds. */
    const asInvitationDto = (invitation: {
      id: string;
      organizationId: string;
      eventId: string | null;
      email: string;
      role: InvitableRole;
      invitedByUserId: string;
      createdAt: number;
      expiresAt: number;
      acceptedAt: number | null;
      acceptedByUserId: string | null;
      revokedAt: number | null;
    }) => ({
      ...invitation,
      createdAt: new Date(invitation.createdAt).toISOString(),
      expiresAt: new Date(invitation.expiresAt).toISOString(),
      acceptedAt: invitation.acceptedAt ? new Date(invitation.acceptedAt).toISOString() : null,
      revokedAt: invitation.revokedAt ? new Date(invitation.revokedAt).toISOString() : null,
    });

    app.get("/api/organizations/:organizationId/members", async (context) => {
      if (!membership) return noMembership(context);
      const organizationId = context.req.param("organizationId");
      const actor = context.get("actor");
      const [members, invitations] = await Promise.all([
        membership.listMembers(actor, organizationId),
        membership.listInvitations(actor, organizationId),
      ]);
      return context.json({ members, invitations: invitations.map(asInvitationDto) });
    });

    app.post("/api/organizations/:organizationId/invitations", async (context) => {
      if (!membership) return noMembership(context);
      const parsed = createInvitationSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Check the address and role.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      const { invitation, token } = await membership.invite(
        context.get("actor"),
        context.req.param("organizationId"),
        parsed.data,
        auditContext(context),
      );
      // The token is answered once and never stored in the clear. The console builds the
      // acceptance link from it; a reload of the members list will not show it again.
      return context.json({ invitation: asInvitationDto(invitation), token }, 201);
    });

    app.delete("/api/organizations/:organizationId/invitations/:invitationId", async (context) => {
      if (!membership) return noMembership(context);
      return context.json({
        changed: await membership.revokeInvitation(
          context.get("actor"),
          context.req.param("organizationId"),
          context.req.param("invitationId"),
          auditContext(context),
        ),
      });
    });

    /**
     * Accept an invitation, as whoever is signed in.
     *
     * `authentication === "session"` is required and is the whole of rule 1: the token says which
     * invitation, the session says who, and a demo persona resolves as `demo` and never gets
     * past this line. Not addressed by organization, because the caller does not yet belong to
     * one — that is what they are accepting.
     */
    app.post("/api/invitations/accept", async (context) => {
      if (!membership) return noMembership(context);
      if (context.get("authentication") !== "session")
        throw new AuthenticationRequiredError("A user session is required to accept an invitation");
      const parsed = acceptInvitationSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "That invitation is not valid.",
            context.get("correlationId"),
          ),
          400,
        );
      return context.json(
        await membership.accept(context.get("actor"), parsed.data.token, auditContext(context)),
      );
    });

    app.delete("/api/organizations/:organizationId/members/:userId", async (context) => {
      if (!membership) return noMembership(context);
      return context.json({
        changed: await membership.removeMember(
          context.get("actor"),
          context.req.param("organizationId"),
          context.req.param("userId"),
          auditContext(context),
        ),
      });
    });

    /*
     * Event roles are addressed under the organization that owns the event, not under the event
     * alone. The address is the authorization boundary: `requireOrganization` runs against the
     * organization in the path, and the event is then checked to belong to it, so a grant earned
     * in one organization cannot staff somebody in another.
     */
    app.put("/api/organizations/:organizationId/events/:eventId/roles/:userId", async (context) => {
      if (!membership) return noMembership(context);
      const parsed = eventRoleSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope("VALIDATION_FAILED", "Choose a valid role.", context.get("correlationId")),
          400,
        );
      return context.json({
        changed: await membership.setEventRole(
          context.get("actor"),
          context.req.param("organizationId"),
          context.req.param("eventId"),
          context.req.param("userId"),
          parsed.data.role,
          auditContext(context),
        ),
      });
    });

    app.delete(
      "/api/organizations/:organizationId/events/:eventId/roles/:userId",
      async (context) => {
        if (!membership) return noMembership(context);
        const parsed = eventRoleSchema.safeParse(await readJson(context.req));
        if (!parsed.success)
          return context.json(
            envelope("VALIDATION_FAILED", "Choose a valid role.", context.get("correlationId")),
            400,
          );
        return context.json({
          changed: await membership.revokeEventRole(
            context.get("actor"),
            context.req.param("organizationId"),
            context.req.param("eventId"),
            context.req.param("userId"),
            parsed.data.role,
            auditContext(context),
          ),
        });
      },
    );

    /*
     * ---- custom event roles (issue #196) ----------------------------------
     *
     * Same address shape as a built-in event role, and for the same reason: the organization in
     * the path is what `requireOrganizationAdministration` runs against, and the event is then
     * checked to belong to it. A role composed in one organization can therefore never be
     * addressed from another.
     *
     * The reads are open to any organization administrator, including a demo persona — the
     * screen is a real console surface. Every write refuses a persona, exactly as membership
     * administration does, because anything a persona wrote would be real state in the demo
     * organization handed to whoever presses **Continue as organizer** next.
     */
    const noCustomRoles = (context: HttpContext) =>
      context.json(
        envelope(
          "NOT_FOUND",
          "The requested resource was not found.",
          context.get("correlationId"),
        ),
        404,
      );
    const roleScope = (context: HttpContext) =>
      [context.req.param("organizationId") ?? "", context.req.param("eventId") ?? ""] as const;

    app.get("/api/organizations/:organizationId/events/:eventId/custom-roles", async (context) => {
      if (!customRoles) return noCustomRoles(context);
      const [organizationId, eventId] = roleScope(context);
      return context.json(
        customRolesResponseSchema.parse(
          await customRoles.list(context.get("actor"), organizationId, eventId),
        ),
      );
    });

    app.post("/api/organizations/:organizationId/events/:eventId/custom-roles", async (context) => {
      if (!customRoles) return noCustomRoles(context);
      const body = customRoleDraftSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Review the highlighted role details.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const [organizationId, eventId] = roleScope(context);
      return context.json(
        customRoleResponseSchema.parse({
          role: await customRoles.create(
            context.get("actor"),
            organizationId,
            eventId,
            body.data,
            auditContext(context),
          ),
        }),
        201,
      );
    });

    app.put(
      "/api/organizations/:organizationId/events/:eventId/custom-roles/:roleId",
      async (context) => {
        if (!customRoles) return noCustomRoles(context);
        const body = customRoleUpdateSchema.safeParse(await readJson(context.req));
        if (!body.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Review the highlighted role details.",
              context.get("correlationId"),
              validationFields(body.error.issues),
            ),
            400,
          );
        const [organizationId, eventId] = roleScope(context);
        return context.json(
          customRoleResponseSchema.parse({
            role: await customRoles.update(
              context.get("actor"),
              organizationId,
              eventId,
              context.req.param("roleId"),
              body.data,
              auditContext(context),
            ),
          }),
        );
      },
    );

    app.delete(
      "/api/organizations/:organizationId/events/:eventId/custom-roles/:roleId",
      async (context) => {
        if (!customRoles) return noCustomRoles(context);
        // The expected revision is a query parameter because a DELETE carrying a body is
        // inconsistently forwarded by intermediaries, and dropping the guard rather than the
        // request is exactly the failure optimistic concurrency exists to prevent.
        const query = customRoleDeleteQuerySchema.safeParse(context.req.query());
        if (!query.success)
          return context.json(
            envelope(
              "VALIDATION_FAILED",
              "Reload the roles list and try again.",
              context.get("correlationId"),
            ),
            400,
          );
        const [organizationId, eventId] = roleScope(context);
        await customRoles.remove(
          context.get("actor"),
          organizationId,
          eventId,
          context.req.param("roleId"),
          query.data.expectedRevision,
          auditContext(context),
        );
        return context.body(null, 204);
      },
    );

    app.get(
      "/api/organizations/:organizationId/events/:eventId/custom-roles/:roleId/preview",
      async (context) => {
        if (!customRoles) return noCustomRoles(context);
        const [organizationId, eventId] = roleScope(context);
        return context.json(
          customRolePreviewResponseSchema.parse(
            await customRoles.previewAs(
              context.get("actor"),
              organizationId,
              eventId,
              context.req.param("roleId"),
            ),
          ),
        );
      },
    );

    app.put(
      "/api/organizations/:organizationId/events/:eventId/custom-roles/:roleId/holders/:userId",
      async (context) => {
        if (!customRoles) return noCustomRoles(context);
        const [organizationId, eventId] = roleScope(context);
        await customRoles.assign(
          context.get("actor"),
          organizationId,
          eventId,
          context.req.param("roleId"),
          context.req.param("userId"),
          auditContext(context),
        );
        return context.body(null, 204);
      },
    );

    app.delete(
      "/api/organizations/:organizationId/events/:eventId/custom-roles/:roleId/holders/:userId",
      async (context) => {
        if (!customRoles) return noCustomRoles(context);
        const [organizationId, eventId] = roleScope(context);
        return context.json({
          changed: await customRoles.unassign(
            context.get("actor"),
            organizationId,
            eventId,
            context.req.param("roleId"),
            context.req.param("userId"),
            auditContext(context),
          ),
        });
      },
    );

    /*
     * The event's own portal field locks, beside the roles because they answer the same question
     * from the other side: what a role may see, and what the person whose record it is may
     * change. Whole-set replacement, so the stored locks are exactly what the organizer confirmed.
     */
    app.put("/api/organizations/:organizationId/events/:eventId/field-locks", async (context) => {
      if (!customRoles) return noCustomRoles(context);
      const body = eventFieldLocksInputSchema.safeParse(await readJson(context.req));
      if (!body.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "Review the highlighted field locks.",
            context.get("correlationId"),
            validationFields(body.error.issues),
          ),
          400,
        );
      const [organizationId, eventId] = roleScope(context);
      return context.json(
        eventFieldLocksResponseSchema.parse({
          locks: await customRoles.setFieldLocks(
            context.get("actor"),
            organizationId,
            eventId,
            body.data.locks,
          ),
        }),
      );
    });

    app.get("/api/organizations/:organizationId/audit-events", async (context) => {
      if (!membership) return noMembership(context);
      // `Number("")` is 0 and `Number.isSafeInteger(0)` is true, so `?limit=` would have clamped
      // the page to one row and `?before=` would have asked for rows older than the epoch — an
      // empty page where the caller asked for the first one. An empty value means absent.
      const positiveInteger = (name: string) => {
        const raw = context.req.query(name);
        if (raw === undefined || raw.trim() === "") return undefined;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
      };
      const limit = positiveInteger("limit");
      const before = positiveInteger("before");
      const events = await membership.listAuditEvents(
        context.get("actor"),
        context.req.param("organizationId"),
        {
          ...(limit === undefined ? {} : { limit }),
          ...(before === undefined ? {} : { before }),
        },
      );
      return context.json({
        events: events.map((entry) => ({
          ...entry,
          occurredAt: new Date(entry.occurredAt).toISOString(),
        })),
      });
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
      // A seeded demo persona is never a valid session subject, even when the address resolves.
      // `resolveEmail` is an address lookup, and `seed/reset.sql` gives the personas real
      // addresses; the same indistinguishable 401 as an unknown address, because which of the two
      // it was is not the caller's business.
      const actor = email ? await auth.resolveEmail(email) : null;
      if (!actor || isDemoPersonaId(actor.id))
        return context.json(
          envelope(
            "UNAUTHORIZED",
            "The login code is invalid or expired.",
            context.get("correlationId"),
          ),
          401,
        );
      const expiresAt = now + SESSION_LIFETIME_MS;
      const sessionId = crypto.randomUUID();
      // Recorded before it is signed, so a cookie can never name a row that does not exist. A
      // store failure reaches the transport's error boundary as a 500, which is the right answer
      // to a fetch: this route is called by script, not by a top-level navigation.
      await auth.sessions.issue(
        { id: sessionId, userId: actor.id, issuedAt: now, expiresAt },
        { correlationId: context.get("correlationId"), actorUserId: actor.id, source: "human" },
      );
      setCookie(
        context,
        "greenroom_session",
        await createUserSession(sessionId, actor.id, auth.sessionSecret, expiresAt),
        {
          httpOnly: true,
          sameSite: "Strict",
          secure: new URL(context.req.url).protocol === "https:",
          path: "/",
          maxAge: SESSION_LIFETIME_MS / 1000,
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
      // The token inherits the session it was minted from, so signing out ends it too. The
      // guard above already established that this cookie is a real session, which is what makes
      // a missing `sid` here impossible rather than merely unlikely.
      const now = (auth.now ?? Date.now)();
      const sessionId = await sessionIdFrom(
        getCookie(context, "greenroom_session"),
        auth.sessionSecret,
        now,
      );
      if (!sessionId)
        throw new AuthenticationRequiredError("A user session is required to create a token");
      const expiresAt = now + 3_600_000;
      return context.json(
        {
          token: await createEventToken(
            sessionId,
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
    app.post("/api/organizations/:organizationId/api-clients", async (context) => {
      if (context.get("authentication") !== "session")
        throw new AuthenticationRequiredError("A user session is required to create an API client");
      if (!dependencies.apiClients) throw new Error("API client service is not configured");
      const parsed = createApiClientSchema.safeParse(await readJson(context.req));
      if (!parsed.success)
        return context.json(
          envelope(
            "VALIDATION_FAILED",
            "API client details are invalid.",
            context.get("correlationId"),
            validationFields(parsed.error.issues),
          ),
          400,
        );
      const created = await dependencies.apiClients.create(
        context.get("actor"),
        context.req.param("organizationId"),
        {
          name: parsed.data.name,
          scopes: parsed.data.scopes as Capability[],
          eventIds: parsed.data.eventIds,
          ...(parsed.data.expiresAt
            ? { expiresAt: new Date(parsed.data.expiresAt).getTime() }
            : {}),
        },
        auditContext(context),
      );
      return context.json(
        { client: apiClientDto(created.client), credential: created.credential },
        201,
      );
    });
    app.get("/api/organizations/:organizationId/api-clients", async (context) => {
      if (context.get("authentication") !== "session")
        throw new AuthenticationRequiredError("A user session is required to list API clients");
      if (!dependencies.apiClients) throw new Error("API client service is not configured");
      const clients = await dependencies.apiClients.list(
        context.get("actor"),
        context.req.param("organizationId"),
      );
      return context.json({ clients: clients.map(apiClientDto) });
    });
    app.post("/api/organizations/:organizationId/api-clients/:clientId/rotate", async (context) => {
      if (context.get("authentication") !== "session")
        throw new AuthenticationRequiredError("A user session is required to rotate an API client");
      if (!dependencies.apiClients) throw new Error("API client service is not configured");
      const rotated = await dependencies.apiClients.rotate(
        context.get("actor"),
        context.req.param("organizationId"),
        context.req.param("clientId"),
        auditContext(context),
      );
      return context.json({
        credential: rotated.credential,
        previousCredentialExpiresAt: new Date(rotated.previousCredentialExpiresAt).toISOString(),
      });
    });
    app.delete("/api/organizations/:organizationId/api-clients/:clientId", async (context) => {
      if (context.get("authentication") !== "session")
        throw new AuthenticationRequiredError("A user session is required to revoke an API client");
      if (!dependencies.apiClients) throw new Error("API client service is not configured");
      await dependencies.apiClients.revoke(
        context.get("actor"),
        context.req.param("organizationId"),
        context.req.param("clientId"),
        auditContext(context),
      );
      return context.body(null, 204);
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
          ...(access.customRole ? { customRole: access.customRole } : {}),
          // Reported so the console can hide a control the API would refuse — a mirror of the
          // decision, never the enforcement. `fieldAccessFor` on the server is what actually
          // narrows a projection, and it reads the same map.
          ...(access.fieldPolicies
            ? {
                fieldPolicies: [...access.fieldPolicies].map(([key, policy]) => {
                  const separator = key.indexOf(":");
                  return {
                    subject: key.slice(0, separator),
                    field: key.slice(separator + 1),
                    policy,
                  };
                }),
              }
            : {}),
        })),
        capabilities: [...actor.capabilities],
        // The middleware already decided this; reporting it is what lets the console tell a
        // persona from a session on a deployment that serves both. "none" cannot reach here —
        // an unresolved actor threw two lines up.
        authentication: context.get("authentication"),
      });
    });
  },

  /**
   * This domain's refusals, translated once here rather than in a central handler every domain
   * has to edit.
   *
   * The invitation refusal is 404 rather than 403 or 400, and that is the interesting one: an
   * unknown token, an expired one, a revoked one and one already spent are a single answer,
   * because telling them apart would say whether a guessed token named a real invitation.
   */
  translateError(error: unknown) {
    if (error instanceof ApiClientNotFoundError)
      return { code: "NOT_FOUND" as const, message: "API client not found.", status: 404 as const };
    if (error instanceof ApiClientConflictError)
      return {
        code: "CONFLICT" as const,
        message: "That API client is already revoked or unavailable.",
        status: 409 as const,
      };
    if (error instanceof ApiClientInputError)
      return {
        code: "VALIDATION_FAILED" as const,
        message: error.message,
        status: 400 as const,
      };
    if (error instanceof InvitationInvalidError)
      return {
        code: "NOT_FOUND" as const,
        message: "That invitation is not valid.",
        status: 404 as const,
      };
    if (error instanceof MembershipRefusedError)
      return {
        code: "FORBIDDEN" as const,
        message: "That change is not allowed on this deployment.",
        status: 403 as const,
      };
    if (error instanceof EventOutsideOrganizationError)
      return {
        code: "FORBIDDEN" as const,
        message: "That event is not part of this organization.",
        status: 403 as const,
      };
    // A role that is not on this event and an event that is not in this organization answer the
    // same 404, so a role id cannot be probed from an organization it does not belong to.
    if (error instanceof CustomRoleNotFoundError)
      return {
        code: "NOT_FOUND" as const,
        message: "That role was not found.",
        status: 404 as const,
      };
    if (error instanceof CustomRoleNameTakenError)
      return {
        code: "CONFLICT" as const,
        message: error.message,
        status: 409 as const,
        // Named so the form can put the refusal on the input that caused it.
        fields: { name: [error.message] },
      };
    if (error instanceof CustomRoleConflictError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    if (error instanceof CustomRoleInvalidError)
      return { code: "VALIDATION_FAILED" as const, message: error.message, status: 400 as const };
    if (error instanceof CustomRoleRefusedError)
      return { code: "FORBIDDEN" as const, message: error.message, status: 403 as const };
    /*
     * 409 rather than 403, because the caller *is* allowed to do this and the state is what
     * refuses. The message carries the remedy — staff a second administrator first — which is
     * the documented recovery path issue #196 asks for, and it is the message rather than a
     * generic one precisely so the person is not left guessing what to do next.
     */
    if (error instanceof LastAdministratorError)
      return { code: "CONFLICT" as const, message: error.message, status: 409 as const };
    return null;
  },
};
