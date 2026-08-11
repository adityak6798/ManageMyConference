import {
  apiErrorEnvelopeSchema,
  type ProspectDto,
  prospectListResponseSchema,
  prospectResponseSchema,
} from "@greenroom/contracts";
export class CrmApiError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
  ) {
    super(message);
  }
}

async function decode(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorEnvelopeSchema.safeParse(body);
    if (error.success)
      throw new CrmApiError(error.data.error.correlationId, error.data.error.message);
    throw new Error(`CRM API failed with status ${response.status}`);
  }
  return body;
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
