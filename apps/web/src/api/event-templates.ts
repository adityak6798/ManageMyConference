/*
 * The events domain's reusable-template client.
 *
 * Two scopes, and the URLs keep them apart because they authorize differently: a template
 * belongs to an *organization*, while previewing or applying one belongs to a single
 * destination *event*. The console resolves the organization from the event it is already
 * showing rather than from a control of its own, so the two can never disagree on screen.
 *
 * Nothing here interprets a stored payload. A version is described by the slice keys it
 * carries; what a CFP field or a routing rule means stays inside the domain that wrote it,
 * which is the same boundary the server holds (`ARC-FLOW-006`).
 */
import {
  type ApiErrorEnvelope,
  type ApplyEventTemplateInput,
  type EventTemplateDto,
  eventTemplateApplicationListResponseSchema,
  eventTemplateCaptureResponseSchema,
  eventTemplateDetailResponseSchema,
  eventTemplateListResponseSchema,
  eventTemplateResponseSchema,
  templateApplicationPlanResponseSchema,
  templateApplicationResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

/** A template refusal that still carries the server's correlation reference. */
export class EventTemplateApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new EventTemplateApiError(envelope));
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * A capture: the template, the version it produced, and what each category contributed.
 *
 * The per-category report is part of the answer rather than diagnostics. A category the
 * capturing account cannot read is stored as nothing, and a template that is quietly missing
 * its review configuration would apply cleanly and leave the destination wrong.
 */
export type EventTemplateCaptureDto = ReturnType<typeof eventTemplateCaptureResponseSchema.parse>;
export type EventTemplateDetailDto = ReturnType<typeof eventTemplateDetailResponseSchema.parse>;
export type TemplateApplicationPlanDto = ReturnType<
  typeof templateApplicationPlanResponseSchema.parse
>["plan"];
export type TemplateApplicationResultDto = ReturnType<
  typeof templateApplicationResponseSchema.parse
>["application"];
export type SlicePreviewDto = TemplateApplicationPlanDto["slices"][number];
export type SliceResultDto = TemplateApplicationResultDto["slices"][number];
export type EventTemplateApplicationDto = ReturnType<
  typeof eventTemplateApplicationListResponseSchema.parse
>["applications"][number];

// @spec PRD-EVT-002
export async function listEventTemplates(
  organizationId: string,
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateDto[]> {
  const response = await fetcher(
    `/api/organizations/${encodeURIComponent(organizationId)}/event-templates`,
  );
  return (await decode(response, eventTemplateListResponseSchema)).templates;
}

/** One template with its versions, newest first — the only route that reports them. */
export async function getEventTemplate(
  templateId: string,
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateDetailDto> {
  const response = await fetcher(`/api/event-templates/${encodeURIComponent(templateId)}`);
  return decode(response, eventTemplateDetailResponseSchema);
}

/** Capture an event's configuration as version 1 of a new template. Reads; never writes it. */
export async function saveEventTemplate(
  organizationId: string,
  input: { name: string; sourceEventId: string },
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateCaptureDto> {
  const response = await fetcher(
    `/api/organizations/${encodeURIComponent(organizationId)}/event-templates`,
    json(input),
  );
  return decode(response, eventTemplateCaptureResponseSchema);
}

/** Capture an event again as this template's next version. */
export async function captureEventTemplateVersion(
  templateId: string,
  sourceEventId: string,
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateCaptureDto> {
  const response = await fetcher(
    `/api/event-templates/${encodeURIComponent(templateId)}/versions`,
    json({ sourceEventId }),
  );
  return decode(response, eventTemplateCaptureResponseSchema);
}

/** Rename, archive, or restore. Both fields are optional; the server refuses an empty change. */
export async function updateEventTemplate(
  templateId: string,
  changes: { name?: string; state?: "active" | "archived" },
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateDto> {
  const response = await fetcher(`/api/event-templates/${encodeURIComponent(templateId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
  return (await decode(response, eventTemplateResponseSchema)).template;
}

/**
 * Copy the newest version into a new template under a new name.
 *
 * The history deliberately does not travel with it: every stored version names the event and
 * the person it was captured from, so re-stamping those onto the copy would invent provenance.
 */
export async function duplicateEventTemplate(
  templateId: string,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateCaptureDto> {
  const response = await fetcher(
    `/api/event-templates/${encodeURIComponent(templateId)}/duplications`,
    json({ name }),
  );
  return decode(response, eventTemplateCaptureResponseSchema);
}

/**
 * What applying this version to this event would do, per category.
 *
 * A POST that writes nothing: the destination range and the selected categories are the
 * question, and they are too structured to be a query string. Reading the plan is the only
 * honest way to answer "what would this clone actually change".
 */
// @spec PRD-EVT-002 ARC-FLOW-006
export async function previewTemplateApplication(
  eventId: string,
  input: ApplyEventTemplateInput,
  fetcher: typeof fetch = fetch,
): Promise<TemplateApplicationPlanDto> {
  const response = await fetcher(
    `/api/events/${encodeURIComponent(eventId)}/template-application-previews`,
    json(input),
  );
  return (await decode(response, templateApplicationPlanResponseSchema)).plan;
}

/**
 * Which template versions this event was configured from, and what each application did.
 *
 * The reason this exists is that an apply's per-category outcome used to be visible exactly
 * once — in the response to the click that caused it. An organizer who closed the tab, or who
 * inherited the event from a colleague, had no way to learn that one category never landed
 * (issue #175). Reading it back is what turns "applied in part" from a sentence that scrolls
 * away into a state the console can keep showing until somebody repairs it.
 */
// @spec PRD-EVT-002 ARC-FLOW-006
export async function listTemplateApplications(
  eventId: string,
  fetcher: typeof fetch = fetch,
): Promise<EventTemplateApplicationDto[]> {
  const response = await fetcher(
    `/api/events/${encodeURIComponent(eventId)}/template-applications`,
  );
  return (await decode(response, eventTemplateApplicationListResponseSchema)).applications;
}

/**
 * Apply one version to one event.
 *
 * 200 rather than 201 on the wire, and for the reason the console has to surface: applying
 * the same version twice is a supported, converging operation rather than a second creation.
 */
// @spec PRD-EVT-002 ARC-FLOW-006
export async function applyEventTemplate(
  eventId: string,
  input: ApplyEventTemplateInput,
  fetcher: typeof fetch = fetch,
): Promise<TemplateApplicationResultDto> {
  const response = await fetcher(
    `/api/events/${encodeURIComponent(eventId)}/template-applications`,
    json(input),
  );
  return (await decode(response, templateApplicationResponseSchema)).application;
}
