/**
 * A Site: one organization's branded portal over several programs.
 *
 * The domain type and the rules that hold whatever storage or transport is in front of them —
 * what a public address may look like, what a registration form must always ask, and what a
 * published portal is composed of.
 *
 * **A Site holds pointers, never copies.** `SiteProgram` names a kind and another domain's
 * identifier; resolving it into a title and a state happens at composition time through that
 * domain's public application interface. Copying a CFP's title into publishing would make the
 * first edit on the other side quietly wrong, and would make publishing a second source of truth
 * for data it does not own.
 *
 * @spec PRD-PUB-002 ARC-DOM-001
 */

export type SiteState = "draft" | "published" | "unpublished";
export type SiteTheme = "light" | "dark" | "auto";
export type SiteProgramKind = "event-cfp" | "interest-form" | "speaker-portal";
export type SiteFieldKind = "text" | "longtext" | "select" | "checkbox";

export interface SiteProgram {
  readonly kind: SiteProgramKind;
  /** Another domain's identifier. Deliberately opaque here. */
  readonly ref: string;
  readonly label: string;
  readonly position: number;
}

export interface SitePage {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  /** Already sanitized. Storing raw markup would leave the unsafe copy as the durable one. */
  readonly bodyHtml: string;
  readonly position: number;
  readonly visibility: "visible" | "hidden";
}

export interface SitePrivacyNotice {
  readonly version: number;
  readonly bodyHtml: string;
  readonly effectiveAt: string;
}

export interface SiteRegistrationField {
  readonly key: string;
  readonly label: string;
  readonly kind: SiteFieldKind;
  readonly required: boolean;
  readonly options: readonly string[];
  readonly position: number;
}

export interface Site {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly landingHeading: string;
  readonly landingBody: string;
  readonly loginHeading: string;
  readonly loginBody: string;
  readonly theme: SiteTheme;
  readonly primaryColor: string;
  readonly state: SiteState;
  readonly publishedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly programs: readonly SiteProgram[];
  readonly pages: readonly SitePage[];
  readonly registrationFields: readonly SiteRegistrationField[];
  /** The version in force. Null until the organizer publishes a first notice. */
  readonly privacyNotice: SitePrivacyNotice | null;
}

/**
 * The identity fields every Site's registration form asks, whatever else it is configured with.
 *
 * Fixed rather than configurable, and it is the same argument the consent record makes: a portal
 * that could remove the field it identifies a registrant by would collect rows nobody can act on
 * and no data-subject request can be answered from. Custom fields are *additional*.
 */
export const REQUIRED_REGISTRATION_FIELDS: readonly { key: string; label: string }[] = [
  { key: "name", label: "Full name" },
  { key: "email", label: "Email address" },
];

/** Reserved against custom fields, so a configured field cannot shadow an identity one. */
export const RESERVED_FIELD_KEYS: readonly string[] = REQUIRED_REGISTRATION_FIELDS.map(
  ({ key }) => key,
);

export const MAX_CUSTOM_REGISTRATION_FIELDS = 12;
export const MAX_SITE_PAGES = 20;
export const MAX_SITE_PROGRAMS = 30;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Readable, stable, and not a storage identifier — the rule every public address here follows. */
export function isPublicSlug(value: string): boolean {
  return value.length >= 1 && value.length <= 120 && SLUG.test(value);
}

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Six-digit hex, `#` included. Bounded branding rather than free CSS; see `1804_sites.sql`. */
export function isPrimaryColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** An address normalized the one way this product normalizes addresses. */
export function normalizeRegistrantEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * What a visitor is served: the Site, its visible pages, and its programs in order.
 *
 * Composed rather than stored, from a snapshot the publish took plus the live resolution of each
 * program. Hidden pages are absent from the composition rather than filtered in the client, and
 * the draft copy never appears here — an unpublished edit is not a public fact.
 */
export interface PublicSiteProgram {
  readonly kind: SiteProgramKind;
  readonly ref: string;
  readonly label: string;
  /** How a visitor reaches it. Produced here so no browser has to derive another domain's route. */
  readonly href: string;
  /** Absent when the program's own domain no longer has it; the organizer is told separately. */
  readonly title?: string | undefined;
  readonly state?: string | undefined;
}

export interface PublicSite {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly landing: { readonly heading: string; readonly body: string };
  readonly login: { readonly heading: string; readonly body: string };
  readonly theme: SiteTheme;
  readonly primaryColor: string;
  readonly programs: readonly PublicSiteProgram[];
  readonly pages: readonly { readonly slug: string; readonly title: string }[];
  readonly privacyNotice: SitePrivacyNotice | null;
  readonly registrationFields: readonly SiteRegistrationField[];
  readonly publishedAt: string;
}

/** Where a visitor goes for each kind of program. One place, so no client derives these. */
export function programHref(kind: SiteProgramKind, ref: string): string {
  if (kind === "event-cfp") return `/public/events/${ref}/cfp`;
  if (kind === "interest-form") return `/public/interest/${ref}`;
  return `/portal/${ref}`;
}

/**
 * Compose the public view of a Site.
 *
 * `resolved` carries whatever each program's owning domain answered; a program it could not
 * resolve keeps its label and its link and loses its title, rather than disappearing. Dropping it
 * silently would make a portal that had been arranged deliberately look shorter than the
 * organizer left it, with nothing to say why.
 */
export function composePublicSite(
  site: Site,
  resolved: ReadonlyMap<string, { title: string; state: string }>,
): PublicSite | null {
  if (site.state !== "published" || !site.publishedAt) return null;
  return {
    slug: site.slug,
    name: site.name,
    tagline: site.tagline,
    landing: { heading: site.landingHeading, body: site.landingBody },
    login: { heading: site.loginHeading, body: site.loginBody },
    theme: site.theme,
    primaryColor: site.primaryColor,
    programs: [...site.programs]
      .sort((left, right) => left.position - right.position || left.ref.localeCompare(right.ref))
      .map((program) => {
        const found = resolved.get(`${program.kind}:${program.ref}`);
        return {
          kind: program.kind,
          ref: program.ref,
          label: program.label || found?.title || program.ref,
          href: programHref(program.kind, program.ref),
          ...(found ? { title: found.title, state: found.state } : {}),
        };
      }),
    pages: [...site.pages]
      .filter((page) => page.visibility === "visible")
      .sort((left, right) => left.position - right.position || left.slug.localeCompare(right.slug))
      .map(({ slug, title }) => ({ slug, title })),
    privacyNotice: site.privacyNotice,
    registrationFields: [...site.registrationFields].sort(
      (left, right) => left.position - right.position || left.key.localeCompare(right.key),
    ),
    publishedAt: site.publishedAt,
  };
}
