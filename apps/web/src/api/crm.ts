import {
  apiErrorEnvelopeSchema,
  type ProspectDto,
  type ProspectOwnerDto,
  prospectListResponseSchema,
  prospectOwnerListResponseSchema,
  prospectResponseSchema,
} from "@greenroom/contracts";
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

async function decode(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorEnvelopeSchema.safeParse(body);
    if (error.success)
      throw new CrmApiError(
        error.data.error.correlationId,
        error.data.error.message,
        error.data.error.fieldErrors ?? {},
      );
    throw new Error(`CRM API failed with status ${response.status}`);
  }
  return body;
}

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
  return prospectOwnerListResponseSchema.parse(
    await decode(await fetch(`/api/events/${eventId}/prospects/owners`)),
  ).owners;
}
export async function listProspects(eventId: string, filter = "all"): Promise<ProspectDto[]> {
  const query = filter === "all" ? "" : filter === "overdue" ? "?overdue=true" : `?stage=${filter}`;
  return prospectListResponseSchema.parse(
    await decode(await fetch(`/api/events/${eventId}/prospects${query}`)),
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
  return prospectResponseSchema.parse(await decode(response)).prospect;
}
export async function convertProspect(eventId: string, prospectId: string) {
  return prospectResponseSchema.parse(
    await decode(
      await fetch(`/api/events/${eventId}/prospects/${prospectId}/convert`, { method: "POST" }),
    ),
  ).prospect;
}
export async function updateProspect(
  eventId: string,
  prospectId: string,
  input: Record<string, unknown>,
) {
  return prospectResponseSchema.parse(
    await decode(
      await fetch(`/api/events/${eventId}/prospects/${prospectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),
  ).prospect;
}
