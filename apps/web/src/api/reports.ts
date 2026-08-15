/**
 * The browser's client for saved reports, their exports, share links and schedules.
 *
 * The export is a plain navigation rather than a fetch, because a download is what the browser
 * does with a `content-disposition` and building a blob in script would only mean re-implementing
 * it. Everything else is JSON.
 *
 * @spec PRD-OPS-004
 */
import {
  type ApiErrorEnvelope,
  reportCatalogueResponseSchema,
  reportResponseSchema,
  reportRunResponseSchema,
  reportSchedulesResponseSchema,
  reportShareCreatedResponseSchema,
  reportShareResolvedResponseSchema,
  reportSharesResponseSchema,
  reportsResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

export class ReportApiError extends Error {
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
      new ReportApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

const post = (payload: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

export type ReportCatalogue = z.infer<typeof reportCatalogueResponseSchema>;
export type ReportsResponse = z.infer<typeof reportsResponseSchema>;
export type ReportRunResponse = z.infer<typeof reportRunResponseSchema>;
export type ReportSharesResponse = z.infer<typeof reportSharesResponseSchema>;
export type ReportSchedulesResponse = z.infer<typeof reportSchedulesResponseSchema>;
export type PublicReportResponse = z.infer<typeof reportShareResolvedResponseSchema>;

const base = (eventId: string) => `/api/events/${eventId}/reports`;

export async function resolvePublicReport(
  token: string,
  password?: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/public/reports/${encodeURIComponent(token)}`, post({ password })),
    reportShareResolvedResponseSchema,
  );
}

export async function readReportCatalogue(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(`${base(eventId)}/catalogue`), reportCatalogueResponseSchema);
}

export async function listReports(eventId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(base(eventId)), reportsResponseSchema);
}

export async function saveReport(eventId: string, draft: unknown, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(base(eventId), post(draft)), reportResponseSchema);
}

export async function runReport(eventId: string, query: unknown, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(`${base(eventId)}/run`, post(query)), reportRunResponseSchema);
}

export async function duplicateReport(
  eventId: string,
  reportId: string,
  name: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/${reportId}/duplicate`, post({ name })),
    reportResponseSchema,
  );
}

export async function deleteReport(
  eventId: string,
  reportId: string,
  expectedRevision: number,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `${base(eventId)}/${reportId}?expectedRevision=${expectedRevision}`,
    { method: "DELETE" },
  );
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new ReportApiError(
    envelope.error.correlationId,
    envelope.error.message,
    envelope.error.fieldErrors ?? {},
  );
}

/**
 * Where the browser should navigate to download this report.
 *
 * A URL rather than a fetch: the response carries `content-disposition`, and letting the browser
 * handle it is both simpler and the only way the file lands where the person expects.
 */
export function reportExportUrl(
  eventId: string,
  reportId: string,
  format: "csv" | "xlsx" | "json",
  includePii: boolean,
) {
  const pii = includePii ? "&includePii=true" : "";
  return `${base(eventId)}/${reportId}/export?format=${format}${pii}`;
}

export async function listReportShares(
  eventId: string,
  reportId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(await fetcher(`${base(eventId)}/${reportId}/shares`), reportSharesResponseSchema);
}

export async function createReportShare(
  eventId: string,
  reportId: string,
  input: {
    lifetimeHours: number;
    viewLimit?: number;
    password?: string;
    allowPii?: boolean;
  },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/${reportId}/shares`, post(input)),
    reportShareCreatedResponseSchema,
  );
}

export async function revokeReportShare(
  eventId: string,
  reportId: string,
  shareId: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${base(eventId)}/${reportId}/shares/${shareId}`, {
    method: "DELETE",
  });
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new ReportApiError(envelope.error.correlationId, envelope.error.message);
}

export async function listReportSchedules(
  eventId: string,
  reportId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(eventId)}/${reportId}/schedules`),
    reportSchedulesResponseSchema,
  );
}

export async function createReportSchedule(
  eventId: string,
  reportId: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${base(eventId)}/${reportId}/schedules`, post(input));
  if (response.ok) return;
  const envelope = (await response.json()) as ApiErrorEnvelope;
  throw new ReportApiError(
    envelope.error.correlationId,
    envelope.error.message,
    envelope.error.fieldErrors ?? {},
  );
}
