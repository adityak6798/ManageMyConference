import { z } from "zod";

export const demoPersonaSchema = z.enum(["organizer", "reviewer", "speaker", "public"]);
export const demoSessionInputSchema = z.object({ persona: demoPersonaSchema });
export const demoSessionResponseSchema = z.object({ persona: demoPersonaSchema });
export const loginCodeRequestSchema = z.object({ email: z.string().email().max(254) });
export const loginCodeRequestResponseSchema = z.object({ challenge: z.string().min(1) });
export const loginCodeVerifySchema = z.object({
  challenge: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export const loginCodeVerifyResponseSchema = z.object({ authenticated: z.literal(true) });
export const eventTokenRequestSchema = z.object({ eventId: z.string().uuid() });
export const eventTokenResponseSchema = z.object({
  token: z.string().min(1),
  eventId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});
/**
 * Which doors this deployment actually offers, so the sign-in surface renders what works rather
 * than what exists in the codebase. `google` is false whenever the deployment carries no Google
 * configuration; a half configuration never reaches here, because `runtimeAuth` refuses to boot.
 */
export const authConfigResponseSchema = z.object({
  demoMode: z.boolean(),
  google: z.boolean(),
});
/**
 * Sign-out clears the session cookie. It is deliberately not called "revoke": the cookie is a
 * signed bearer with its own expiry and nothing server-side tracks it, so signing out ends this
 * browser's session and does not invalidate a copy taken elsewhere. Durable revocation is issue
 * #12; naming this honestly is what keeps that distinction visible.
 */
export const signOutResponseSchema = z.object({ signedOut: z.literal(true) });
/**
 * What Google appends to the redirect. Declared because a caller reading the document otherwise
 * sees a parameterless endpoint, and the route answers a missing parameter with the same refusal
 * redirect as a forged one — so this is the only place the requirement is legible.
 *
 * Not used to validate the request: the callback deliberately treats a malformed return exactly
 * as it treats a refused one.
 */
export const googleCallbackQuerySchema = z.object({
  code: z.string().describe("The authorization code Google issued for this attempt."),
  state: z.string().describe("The opaque per-attempt value this deployment issued."),
});
export const capabilitySchema = z.enum([
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "communications:manage",
  "agenda:manage",
  "crm:manage",
  "content:read",
  "content:manage",
  "review:manage",
  "review:evaluate",
]);

export const sessionEventAccessSchema = z.object({
  eventId: z.string().uuid(),
  role: demoPersonaSchema,
  capabilities: z.array(capabilitySchema),
});
export const sessionResponseSchema = z.object({
  actor: z.object({ id: z.string(), name: z.string(), persona: demoPersonaSchema }),
  organizations: z.array(z.object({ id: z.string().uuid() })),
  eventAccess: z.array(sessionEventAccessSchema),
  capabilities: z.array(capabilitySchema),
  /**
   * Which kind of credential this session was resolved from.
   *
   * A demo persona and a real user session arrive in the same cookie, and the two are undone
   * differently: a persona is *switched*, a session is *signed out of*. Without this the console
   * cannot tell them apart, so it either offers a sign-out that does nothing to a persona or
   * withholds one from someone who genuinely needs it — which is what happened before this
   * field existed, on every deep link and on every demo deployment with Google configured.
   *
   * Optional because a frontend can meet an API a version behind that does not send it; callers
   * fall back rather than failing to read the session at all. The server always sends it.
   */
  authentication: z.enum(["session", "demo", "bearer"]).optional(),
});
export type SessionDto = z.infer<typeof sessionResponseSchema>;
