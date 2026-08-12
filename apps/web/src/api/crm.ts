import {
  type ApiErrorEnvelope,
  type ProspectDto,
  type ProspectOwnerDto,
  prospectListResponseSchema,
  prospectOwnerListResponseSchema,
  prospectResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";
export class CrmApiError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
    /** Server-named input paths, e.g. `ownerId`, so a refusal can be shown on its own control. */
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}

const decode = <T>(response: Response, schema: z.ZodType<T>) =>
  decodeResponse(
    response,
    schema,
    (envelope: ApiErrorEnvelope) =>
      new CrmApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

/** Field-level detail from a handled CRM failure, keyed by the input path the server named. */
export function crmFieldErrors(reason: unknown): Record<string, string[]> {
  return reason instanceof CrmApiError ? reason.fieldErrors : {};
}

/**
 * The identities the server will accept as a prospect owner on this event. The CRM cannot
 * derive this list — event staffing belongs to identity-access — so the select is populated
 * from the same query the write path validates against.
 */
export async function listProspectOwners(eventId: string): Promise<ProspectOwnerDto[]> {
  return (
    await decode(
      await fetch(`/api/events/${eventId}/prospects/owners`),
      prospectOwnerListResponseSchema,
    )
  ).owners;
}
export async function listProspects(eventId: string, filter = "all"): Promise<ProspectDto[]> {
  const query = filter === "all" ? "" : filter === "overdue" ? "?overdue=true" : `?stage=${filter}`;
  return (
    await decode(
      await fetch(`/api/events/${eventId}/prospects${query}`),
      prospectListResponseSchema,
    )
  ).prospects;
}
export async function createProspect(
  eventId: string,
  input: { name: string; email: string; ownerId: string; nextActionAt?: string | undefined },
) {
  const response = await fetch(`/api/events/${eventId}/prospects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      ownerId: input.ownerId,
      nextAction: "Send introductory outreach",
      nextActionAt: input.nextActionAt,
      contact: { name: input.name, email: input.email },
    }),
  });
  return (await decode(response, prospectResponseSchema)).prospect;
}
export async function convertProspect(eventId: string, prospectId: string) {
  return (
    await decode(
      await fetch(`/api/events/${eventId}/prospects/${prospectId}/convert`, { method: "POST" }),
      prospectResponseSchema,
    )
  ).prospect;
}
export async function updateProspect(
  eventId: string,
  prospectId: string,
  input: Record<string, unknown>,
) {
  return (
    await decode(
      await fetch(`/api/events/${eventId}/prospects/${prospectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      prospectResponseSchema,
    )
  ).prospect;
}
