import {
  type ApiErrorEnvelope,
  type ContactFiltersDto,
  contactDashboardResponseSchema,
  contactListResponseSchema,
  contactResponseSchema,
  duplicateListResponseSchema,
  importContactsResponseSchema,
  importPreviewResponseSchema,
  outreachPreviewResponseSchema,
  outreachResponseSchema,
  type ProspectDto,
  type ProspectOwnerDto,
  prospectListResponseSchema,
  prospectOwnerListResponseSchema,
  prospectResponseSchema,
  pushContactToEventResponseSchema,
  segmentListResponseSchema,
  segmentResponseSchema,
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

/* ------------------------------------------------------------------------------------------
 * The organization-wide directory.
 *
 * Addressed by organization, never by event, exactly as the API is. The workspace reads the
 * organization from the selected event, and the server decides whether this identity may see it.
 * ---------------------------------------------------------------------------------------- */

const directory = (organizationId: string, path: string) =>
  `/api/organizations/${organizationId}/crm/${path}`;

const send = (url: string, body: unknown, method = "POST") =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Serialised the way `contactListQuerySchema` reads them, tags included. */
export function contactQuery(filters: ContactFiltersDto): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === "") continue;
    query.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export async function listContacts(
  organizationId: string,
  filters: ContactFiltersDto & { segmentId?: string } = {},
) {
  return decode(
    await fetch(directory(organizationId, `contacts${contactQuery(filters)}`)),
    contactListResponseSchema,
  );
}

export async function getContact(organizationId: string, contactId: string) {
  return (
    await decode(
      await fetch(directory(organizationId, `contacts/${contactId}`)),
      contactResponseSchema,
    )
  ).contact;
}

export async function createContact(
  organizationId: string,
  input: {
    name: string;
    email: string;
    company?: string;
    title?: string;
    tags?: readonly string[];
  },
) {
  return (
    await decode(await send(directory(organizationId, "contacts"), input), contactResponseSchema)
  ).contact;
}

export async function updateContact(
  organizationId: string,
  contactId: string,
  input: Record<string, unknown>,
) {
  return (
    await decode(
      await send(directory(organizationId, `contacts/${contactId}`), input, "PATCH"),
      contactResponseSchema,
    )
  ).contact;
}

export async function pushContactToEvent(
  organizationId: string,
  contactId: string,
  input: { eventId: string; ownerId: string; convert: boolean },
) {
  return decode(
    await send(directory(organizationId, `contacts/${contactId}/events`), input),
    pushContactToEventResponseSchema,
  );
}

export async function listDuplicates(organizationId: string) {
  return (
    await decode(await fetch(directory(organizationId, "duplicates")), duplicateListResponseSchema)
  ).groups;
}

export async function mergeContacts(
  organizationId: string,
  input: { primaryId: string; duplicateIds: readonly string[] },
) {
  return (
    await decode(await send(directory(organizationId, "merges"), input), contactResponseSchema)
  ).contact;
}

export async function listSegments(organizationId: string) {
  return (
    await decode(await fetch(directory(organizationId, "segments")), segmentListResponseSchema)
  ).segments;
}

export async function createSegment(
  organizationId: string,
  input: { name: string; filters: ContactFiltersDto },
) {
  return (
    await decode(await send(directory(organizationId, "segments"), input), segmentResponseSchema)
  ).segment;
}

export async function previewImport(
  organizationId: string,
  input: { filename: string; csv: string },
) {
  return decode(
    await send(directory(organizationId, "imports/preview"), input),
    importPreviewResponseSchema,
  );
}

export async function commitImport(
  organizationId: string,
  input: { filename: string; csv: string },
) {
  return decode(
    await send(directory(organizationId, "imports"), input),
    importContactsResponseSchema,
  );
}

export async function previewOutreach(
  organizationId: string,
  input: {
    eventId: string;
    templateKey: string;
    contactIds?: readonly string[];
    segmentId?: string;
  },
) {
  return decode(
    await send(directory(organizationId, "outreach/preview"), input),
    outreachPreviewResponseSchema,
  );
}

export async function sendOutreach(
  organizationId: string,
  input: {
    eventId: string;
    templateKey: string;
    contactIds?: readonly string[];
    segmentId?: string;
  },
) {
  return decode(await send(directory(organizationId, "outreach"), input), outreachResponseSchema);
}

export async function getContactDashboard(organizationId: string) {
  return decode(
    await fetch(directory(organizationId, "dashboard")),
    contactDashboardResponseSchema,
  );
}
