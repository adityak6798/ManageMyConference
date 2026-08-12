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
export const authConfigResponseSchema = z.object({ demoMode: z.boolean() });
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
});
export type SessionDto = z.infer<typeof sessionResponseSchema>;
