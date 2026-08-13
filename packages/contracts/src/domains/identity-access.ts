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
 * Sign-out revokes the session and clears the cookie.
 *
 * It *is* revocation now: the cookie names a row in `identity_sessions`, the row is marked
 * revoked before the cookie is cleared, and every credential that named it — a copy of the
 * cookie taken from another device, an event bearer token minted from that session — stops
 * being accepted on its next request.
 *
 * The field is still `signedOut` rather than `revoked`, and deliberately so. It is a shape
 * every deployed client already reads, and renaming it would break them to say something the
 * body does not actually claim: the value is `true` whether or not the caller held a session,
 * because reporting *that* would tell an unauthenticated caller whether a cookie it presented
 * was real. What was revoked is not in this response for the same reason. The count of sessions
 * ended lives on `POST /api/auth/sessions/revoke-all`, which requires a session first, so its
 * number is the caller's own data.
 */
export const signOutResponseSchema = z.object({ signedOut: z.literal(true) });
/**
 * "Sign out on every device": how many live sessions this caller had, all of them now revoked.
 *
 * Safe to report, unlike sign-out's, because the route refuses anybody who has not already
 * proved the identity being counted.
 */
export const revokeAllSessionsResponseSchema = z.object({ revoked: z.number().int().min(0) });
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
/**
 * Membership administration.
 *
 * The role vocabulary is three values, not four: `public` is what everybody already has and
 * cannot be granted. An invitation naming an event grants that role on that event; one naming no
 * event grants organization membership, which is only ever the organizer role because that is
 * what `organization_memberships` stores.
 */
export const invitableRoleSchema = z.enum(["organizer", "reviewer", "speaker"]);
export const createInvitationSchema = z
  .object({
    email: z.string().email().max(254),
    role: invitableRoleSchema,
    /** Omit to invite into the organization; name an event to staff somebody on it. */
    eventId: z.string().uuid().optional(),
  })
  .refine((value) => value.eventId !== undefined || value.role === "organizer", {
    message: "An organization invitation grants the organizer role",
    path: ["role"],
  });
/**
 * The created invitation, and the **only** time its token exists outside the caller's own
 * request. The database stores a SHA-256 digest, so nothing can reissue this value; an organizer
 * who loses it revokes the invitation and sends another.
 */
export const invitationSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  email: z.string(),
  role: invitableRoleSchema,
  invitedByUserId: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  acceptedByUserId: z.string().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export const createInvitationResponseSchema = z.object({
  invitation: invitationSchema,
  token: z.string().min(1),
});
/**
 * A role somebody actually holds on an event.
 *
 * The same four values as `demoPersonaSchema` and the `event_roles` CHECK, declared separately
 * because they are a different thing that happens to coincide: this is a production grant, and
 * naming the *demo persona* vocabulary in a production response would make the two impossible to
 * change apart. Wider than `invitableRoleSchema`, which excludes `public` because nobody is
 * invited into what everybody already has.
 */
export const eventRoleNameSchema = z.enum(["organizer", "reviewer", "speaker", "public"]);
export const organizationMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /** Null where the directory holds no address for this member. */
  email: z.string().nullable(),
  eventRoles: z.array(z.object({ eventId: z.string().uuid(), role: eventRoleNameSchema })),
});
export const organizationMembersResponseSchema = z.object({
  members: z.array(organizationMemberSchema),
  invitations: z.array(invitationSchema),
});
/**
 * Acceptance carries the token and nothing else.
 *
 * There is deliberately no address, no user id and no organization in this body: the token says
 * *which* invitation and the caller's session says *who*. A body that named the person would be
 * the address-lookup acceptance `docs/architecture/authorization.md` forbids.
 */
export const acceptInvitationSchema = z.object({ token: z.string().min(1) });
export const acceptInvitationResponseSchema = z.object({
  organizationId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  role: invitableRoleSchema,
});
export const eventRoleSchema = z.object({ role: invitableRoleSchema });
/** How many rows the write changed. Zero is a legitimate answer, not a failure. */
export const membershipChangeResponseSchema = z.object({ changed: z.number().int().min(0) });
/**
 * One organizer-visible audit row.
 *
 * `detail` is opaque JSON text rather than a parsed object: its shape belongs to the action, and
 * a schema that pinned it would have to change every time an action gained a field. No row here
 * ever carries a credential.
 */
export const auditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string().datetime(),
  action: z.string(),
  outcome: z.enum(["succeeded", "refused"]),
  source: z.enum(["human", "api", "system"]),
  actorUserId: z.string().nullable(),
  subjectUserId: z.string().nullable(),
  eventId: z.string().uuid().nullable(),
  correlationId: z.string(),
  detail: z.string().nullable(),
});
export const auditEventsResponseSchema = z.object({ events: z.array(auditEventSchema) });

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
  "identity:manage",
]);

/** Organization-scoped machine credentials. Plaintext credentials exist only in create/rotate. */
export const createApiClientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(capabilitySchema).min(1).max(12),
  eventIds: z.array(z.string().uuid()).min(1).max(100),
  expiresAt: z.string().datetime().optional(),
});
export const apiClientSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  scopes: z.array(capabilitySchema),
  eventIds: z.array(z.string().uuid()),
});
export const createApiClientResponseSchema = z.object({
  client: apiClientSchema,
  credential: z.string().startsWith("grn_"),
});
export const apiClientsResponseSchema = z.object({ clients: z.array(apiClientSchema) });
export const apiClientOrganizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});
export const apiClientParamsSchema = apiClientOrganizationParamsSchema.extend({
  clientId: z.string().uuid(),
});
export const rotateApiClientResponseSchema = z.object({
  credential: z.string().startsWith("grn_"),
  previousCredentialExpiresAt: z.string().datetime(),
});

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
