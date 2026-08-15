/**
 * The browser's client for organization portals.
 *
 * Two halves with different rules. The organizer half is addressed under the organization and
 * needs a session; the public half is anonymous, and its reads are the ones an embedded or
 * shared portal page makes. They live in one module because they are one product surface, and
 * separating them would mean two files that had to agree about the same shapes.
 *
 * @spec PRD-PUB-002
 */
import {
  type ApiErrorEnvelope,
  publicSitePageResponseSchema,
  publicSiteResponseSchema,
  siteConsentsResponseSchema,
  siteDetailResponseSchema,
  sitePrivacyNoticeResponseSchema,
  siteRegistrationResponseSchema,
  siteResponseSchema,
  sitesResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { apiFetch as fetch, decodeResponse } from "./config";

export class SiteApiError extends Error {
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
      new SiteApiError(
        envelope.error.correlationId,
        envelope.error.message,
        envelope.error.fieldErrors ?? {},
      ),
  );

const body = (method: "POST" | "PUT", payload: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

export type SitesResponse = z.infer<typeof sitesResponseSchema>;
export type SiteDetail = z.infer<typeof siteDetailResponseSchema>;
export type PublicSiteResponse = z.infer<typeof publicSiteResponseSchema>;
export type SiteConsents = z.infer<typeof siteConsentsResponseSchema>;

const base = (organizationId: string) => `/api/publishing/organizations/${organizationId}/sites`;

export async function listSites(organizationId: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(base(organizationId)), sitesResponseSchema);
}

export async function getSite(
  organizationId: string,
  siteId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(await fetcher(`${base(organizationId)}/${siteId}`), siteDetailResponseSchema);
}

export async function createSite(
  organizationId: string,
  draft: unknown,
  fetcher: typeof fetch = fetch,
) {
  return decode(await fetcher(base(organizationId), body("POST", draft)), siteResponseSchema);
}

export async function updateSite(
  organizationId: string,
  siteId: string,
  draft: unknown,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId)}/${siteId}`, body("PUT", draft)),
    siteResponseSchema,
  );
}

export async function publishPrivacyNotice(
  organizationId: string,
  siteId: string,
  bodyHtml: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId)}/${siteId}/privacy-notice`, body("POST", { bodyHtml })),
    sitePrivacyNoticeResponseSchema,
  );
}

export async function setSiteState(
  organizationId: string,
  siteId: string,
  action: "publish" | "unpublish",
  expectedRevision: number,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(
      `${base(organizationId)}/${siteId}/${action}`,
      body("POST", { expectedRevision }),
    ),
    siteResponseSchema,
  );
}

export async function listSiteConsents(
  organizationId: string,
  siteId: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`${base(organizationId)}/${siteId}/consents`),
    siteConsentsResponseSchema,
  );
}

/** The anonymous half. No credential is sent, and none would be accepted. */
export async function readPublicSite(slug: string, fetcher: typeof fetch = fetch) {
  return decode(await fetcher(`/api/public/sites/${slug}`), publicSiteResponseSchema);
}

export async function readPublicSitePage(
  slug: string,
  pageSlug: string,
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/public/sites/${slug}/pages/${pageSlug}`),
    publicSitePageResponseSchema,
  );
}

export async function registerForSite(
  slug: string,
  submission: {
    name: string;
    email: string;
    accepted: boolean;
    answers?: Record<string, string>;
  },
  fetcher: typeof fetch = fetch,
) {
  return decode(
    await fetcher(`/api/public/sites/${slug}/registrations`, body("POST", submission)),
    siteRegistrationResponseSchema,
  );
}
