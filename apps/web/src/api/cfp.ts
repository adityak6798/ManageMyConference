import {
  type CfpFormDto,
  cfpResponseSchema,
  cfpRoutingStatusesResponseSchema,
  cfpStateInputSchema,
  type CfpWindowInput,
  cfpWindowInputSchema,
  createProposalDraftInputSchema,
  proposalConfirmationResponseSchema,
  type SaveCfpInput,
  saveProposalInputSchema,
  type SubmitterProposalDto,
  submitProposalInputSchema,
  submitterProposalResponseSchema,
  submitterProposalsResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";
export class CfpApiError extends Error {
  constructor(readonly envelope: import("@greenroom/contracts").ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}
async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new CfpApiError(envelope));
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
  const body = input;
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
export async function loadCfpRoutingStatuses(eventId: string, fetcher: typeof fetch = fetch) {
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/routing-statuses`),
      cfpRoutingStatusesResponseSchema,
    )
  ).statuses;
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
/**
 * Replace the scheduled submission window.
 *
 * Its own call rather than a field of `saveCfp`, because the window is live state: an organizer
 * extending a deadline must not publish whatever unrelated edits are in the composer.
 */
export async function saveCfpWindow(
  eventId: string,
  window: CfpWindowInput,
  fetcher: typeof fetch = fetch,
): Promise<CfpFormDto> {
  const body = cfpWindowInputSchema.parse(window);
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/window`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      cfpResponseSchema,
    )
  ).cfp as CfpFormDto;
}

/**
 * The signed-in submitter's own proposals.
 *
 * Not under `/api/public/...`: that namespace is anonymous by construction and cacheable, neither
 * of which may be true of one person's drafts. These calls carry the session cookie the same way
 * every console call does.
 */
export async function loadMyProposals(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<SubmitterProposalDto[]> {
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/proposals`),
      submitterProposalsResponseSchema,
    )
  ).proposals;
}
export async function createProposalDraft(
  eventId: string,
  answers: Record<string, string>,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SubmitterProposalDto> {
  const body = createProposalDraftInputSchema.parse({ answers, idempotencyKey });
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      submitterProposalResponseSchema,
    )
  ).proposal;
}
export async function saveProposal(
  eventId: string,
  proposalId: string,
  answers: Record<string, string>,
  expectedRevision: number,
  fetcher: typeof fetch = fetch,
): Promise<SubmitterProposalDto> {
  const body = saveProposalInputSchema.parse({ answers, expectedRevision });
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/proposals/${proposalId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      submitterProposalResponseSchema,
    )
  ).proposal;
}
export async function submitOwnedProposal(
  eventId: string,
  proposalId: string,
  answers: Record<string, string>,
  expectedRevision: number,
  fetcher: typeof fetch = fetch,
): Promise<SubmitterProposalDto> {
  const body = saveProposalInputSchema.parse({ answers, expectedRevision });
  return (
    await decode(
      await fetcher(`/api/events/${eventId}/cfp/proposals/${proposalId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      submitterProposalResponseSchema,
    )
  ).proposal;
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
export type { CfpFormDto, SubmitterProposalDto };
