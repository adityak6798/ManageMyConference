import {
  apiErrorEnvelopeSchema,
  cfpResponseSchema,
  cfpStateInputSchema,
  proposalConfirmationResponseSchema,
  saveCfpInputSchema,
  submitProposalInputSchema,
  type CfpFormDto,
  type SaveCfpInput,
} from "@greenroom/contracts";
import type { z } from "zod";
export class CfpApiError extends Error {
  constructor(readonly envelope: import("@greenroom/contracts").ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}
async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorEnvelopeSchema.safeParse(body);
    if (error.success) throw new CfpApiError(error.data);
    throw new Error(`Invalid API response (${response.status})`);
  }
  return schema.parse(body);
}
export async function loadCfp(
  eventId: string,
  organizer: boolean,
  fetcher: typeof fetch = fetch,
): Promise<CfpFormDto> {
  const prefix = organizer ? "/api/events" : "/api/public/events";
  return (await decode(await fetcher(`${prefix}/${eventId}/cfp`), cfpResponseSchema))
    .cfp as CfpFormDto;
}
export async function saveCfp(
  eventId: string,
  input: SaveCfpInput,
  fetcher: typeof fetch = fetch,
): Promise<CfpFormDto> {
  const body = saveCfpInputSchema.parse(input);
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      cfpResponseSchema,
    )
  ).cfp as CfpFormDto;
}
export async function changeCfpState(
  eventId: string,
  state: "publish" | "close" | "reopen",
  fetcher: typeof fetch = fetch,
): Promise<CfpFormDto> {
  const body = cfpStateInputSchema.parse({ state });
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      cfpResponseSchema,
    )
  ).cfp as CfpFormDto;
}
export async function submitProposal(
  eventId: string,
  answers: Record<string, string>,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
) {
  const body = submitProposalInputSchema.parse({ answers, idempotencyKey });
  return (
    await decode(
      await fetcher(`/api/public/events/${eventId}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      proposalConfirmationResponseSchema,
    )
  ).submission;
}
export type { CfpFormDto };
