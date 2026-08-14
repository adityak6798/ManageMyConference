/**
 * The browser's client for custom event roles and their per-field access.
 *
 * Addressed under the organization that owns the event, matching the routes: the organization in
 * the path is what authorizes the call, and the event is then checked to belong to it.
 *
 * Nothing here enforces anything. The screen hides a control the caller's role cannot use because
 * that is a better experience than a refusal, and the API refuses it anyway — a field the client
 * hides and the API returns is not hidden (`PRD-IAM-002`).
 *
 * @spec PRD-IAM-002
 */
import {
  type ApiErrorEnvelope,
  customRolePreviewResponseSchema,
  customRoleResponseSchema,
  customRolesResponseSchema,
  eventFieldLocksResponseSchema,
  membershipChangeResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class CustomRoleApiError extends Error {
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
      new CustomRoleApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

export type CustomRolesResponse = z.infer<typeof customRolesResponseSchema>;
export type CustomRolePreview = z.infer<typeof customRolePreviewResponseSchema>;
export type CustomRoleDraft = {
  name: string;
  description?: string;
  template: "av" | "programme-assistant" | "sponsor-liaison";
  capabilities: string[];
  fieldPolicies: {
    subject: "session" | "speaker" | "contact";
    field: string;
    policy: "view" | "lock" | "hide";
  }[];
};

const base = (organizationId: string, eventId: string) =>
  `/api/organizations/${organizationId}/events/${eventId}/custom-roles`;

const body = (method: "POST" | "PUT", payload: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

export async function listCustomRoles(
  organizationId: string,
  eventId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(await fetcher(base(organizationId, eventId)), customRolesResponseSchema);
}

export async function createCustomRole(
  organizationId: string,
  eventId: string,
  draft: CustomRoleDraft,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(base(organizationId, eventId), body("POST", draft)),
    customRoleResponseSchema,
  );
}

export async function updateCustomRole(
  organizationId: string,
  eventId: string,
  roleId: string,
  draft: CustomRoleDraft & { expectedRevision: number },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId, eventId)}/${roleId}`, body("PUT", draft)),
    customRoleResponseSchema,
  );
}

/**
 * The expected revision travels in the query string, not a body.
 *
 * A DELETE carrying a body is inconsistently forwarded by intermediaries, and losing the guard
 * rather than the request is exactly the failure optimistic concurrency exists to prevent.
 */
export async function deleteCustomRole(
  organizationId: string,
  eventId: string,
  roleId: string,
  expectedRevision: number,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `${base(organizationId, eventId)}/${roleId}?expectedRevision=${expectedRevision}`,
    { method: "DELETE" },
  );
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new CustomRoleApiError(
    envelope.error.correlationId,
    envelope.error.message,
    envelope.error.fieldErrors ?? {},
  );
}

/**
 * Replace this event's portal field locks with exactly this set.
 *
 * Whole-set replacement rather than a per-field toggle, so what is stored is what the organizer
 * confirmed on the screen; an omitted field is open, and there is no accumulated lock nobody
 * remembers setting. The current set arrives on `listCustomRoles`, beside the roles, so there is
 * no separate read.
 */
export async function setEventFieldLocks(
  organizationId: string,
  eventId: string,
  locks: readonly { subject: "session" | "speaker" | "contact"; field: string; policy: string }[],
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(
      `/api/organizations/${organizationId}/events/${eventId}/field-locks`,
      body("PUT", { locks }),
    ),
    eventFieldLocksResponseSchema,
  );
}

export async function previewCustomRole(
  organizationId: string,
  eventId: string,
  roleId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId, eventId)}/${roleId}/preview`),
    customRolePreviewResponseSchema,
  );
}

export async function assignCustomRole(
  organizationId: string,
  eventId: string,
  roleId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `${base(organizationId, eventId)}/${roleId}/holders/${userId}`,
    body("PUT", { userId }),
  );
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new CustomRoleApiError(
    envelope.error.correlationId,
    envelope.error.message,
    envelope.error.fieldErrors ?? {},
  );
}

export async function unassignCustomRole(
  organizationId: string,
  eventId: string,
  roleId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId, eventId)}/${roleId}/holders/${userId}`, {
      method: "DELETE",
    }),
    membershipChangeResponseSchema,
  );
}
