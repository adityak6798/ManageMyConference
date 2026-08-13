/**
 * The browser's client for organization membership and the identity audit log.
 *
 * Addressed by organization throughout, matching the routes: the answer spans events, so an
 * event-scoped address could not carry it and the organization is the one place the access is
 * authorized.
 *
 * @spec PRD-IAM-001 PRD-IAM-002
 */
import {
  acceptInvitationResponseSchema,
  type ApiErrorEnvelope,
  auditEventsResponseSchema,
  createInvitationResponseSchema,
  organizationMembersResponseSchema,
  membershipChangeResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class MembershipApiError extends Error {
  constructor(
    readonly correlationId: string,
    message: string,
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
      new MembershipApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type MembersResponse = z.infer<typeof organizationMembersResponseSchema>;

export function listMembers(organizationId: string, fetcher: typeof fetch = fetch) {
  return fetcher(`/api/organizations/${organizationId}/members`).then((response) =>
    decode(response, organizationMembersResponseSchema),
  );
}

/**
 * Invite an address, and answer the token.
 *
 * The token is returned once and never again: the API stores only its digest, so an organizer
 * who loses the link withdraws the invitation and sends another. The surface shows it
 * immediately for that reason.
 */
export async function inviteMember(
  organizationId: string,
  command: { email: string; role: "organizer" | "reviewer" | "speaker"; eventId?: string },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/organizations/${organizationId}/invitations`, json(command)),
    createInvitationResponseSchema,
  );
}

export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/organizations/${organizationId}/invitations/${invitationId}`, {
      method: "DELETE",
    }),
    membershipChangeResponseSchema,
  );
}

/** Accept as whoever is signed in. The body carries the token and deliberately nothing else. */
export async function acceptInvitation(token: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher("/api/invitations/accept", json({ token })),
    acceptInvitationResponseSchema,
  );
}

export async function removeMember(
  organizationId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/organizations/${organizationId}/members/${userId}`, { method: "DELETE" }),
    membershipChangeResponseSchema,
  );
}

export async function setEventRole(
  organizationId: string,
  eventId: string,
  userId: string,
  role: "organizer" | "reviewer" | "speaker",
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/organizations/${organizationId}/events/${eventId}/roles/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
    membershipChangeResponseSchema,
  );
}

export async function revokeEventRole(
  organizationId: string,
  eventId: string,
  userId: string,
  role: "organizer" | "reviewer" | "speaker",
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/organizations/${organizationId}/events/${eventId}/roles/${userId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
    membershipChangeResponseSchema,
  );
}

export async function listAuditEvents(organizationId: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher(`/api/organizations/${organizationId}/audit-events`),
    auditEventsResponseSchema,
  );
}
