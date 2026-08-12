import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  checks: z.object({
    database: z.literal("configured"),
    sessionSigning: z.enum(["configured", "disabled"]),
  }),
  providerMode: z.literal("sql-r2"),
  logFormat: z.literal("structured-json"),
  /**
   * Which checkout started this Worker, and at which commit. Present only when the local
   * launcher supplied it, so a deployed instance simply omits it.
   *
   * This exists so a test run can prove it is talking to *its own* server. Both values are
   * non-secret by construction: a filesystem path and a commit SHA, the same two facts `git`
   * prints to anyone with the repository.
   */
  build: z
    .object({
      root: z.string(),
      commit: z.string(),
    })
    .optional(),
});

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "AGENDA_CONFLICT",
  // The unauthenticated CFP submission route is throttled per client and event; a caller
  // that exceeds the window is told so rather than being given a misleading 4xx.
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    correlationId: z.string(),
    fieldErrors: z.record(z.array(z.string())).optional(),
  }),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
