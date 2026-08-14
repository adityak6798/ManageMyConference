/**
 * Composing, publishing and registering against an organization's portal.
 *
 * Issue #196's Sites area. Three properties are worth stating before the code, because each one
 * is a decision somebody could reasonably have made the other way.
 *
 * **A program is a pointer, resolved at read time.** `SiteProgramResolver` is the seam: the
 * composition root binds it to the CFP and content services' own public application interfaces,
 * and publishing never learns their tables. A program whose source has gone keeps its place in
 * the order and loses its title, and the organizer's own view names it as unresolved — dropping
 * it silently would make a deliberately arranged portal look shorter than it was left.
 *
 * **Consent records what was accepted, never what is current.** A registration stores the notice
 * *version* in force at that instant, and `site_privacy_notices` refuses an update to a version's
 * text, so the record can always produce the words somebody agreed to. Publishing a new notice
 * appends a version and leaves every earlier consent naming the version it named.
 *
 * **Publishing is the only thing a visitor sees.** Every organizer edit lands on the draft; the
 * public composition reads the published state. That is the same rule the public event projection
 * follows (`PRD-PUB-001`) and it is why an unpublished Site's address answers exactly as an
 * unknown one — a portal being *prepared* is not a portal that exists.
 *
 * @spec PRD-PUB-002 PRD-IAM-002 ARC-DOM-001
 */
import {
  composePublicSite,
  isPrimaryColor,
  isPublicSlug,
  MAX_CUSTOM_REGISTRATION_FIELDS,
  MAX_SITE_PAGES,
  MAX_SITE_PROGRAMS,
  normalizeRegistrantEmail,
  normalizeSlug,
  type PublicSite,
  RESERVED_FIELD_KEYS,
  REQUIRED_REGISTRATION_FIELDS,
  type Site,
  type SiteFieldKind,
  type SitePage,
  type SiteProgram,
  type SiteProgramKind,
  type SiteRegistrationField,
  type SiteTheme,
} from "../../domain/publishing/site";
import { type Actor, CapabilityDeniedError, requireCapability } from "../identity/actor";

export class SiteNotFoundError extends Error {}
export class SiteInvalidError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
export class SiteSlugTakenError extends Error {
  constructor() {
    super("That address is already in use by another site.");
  }
}
export class SiteConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("This site changed while you were editing it. Reload and reapply your changes.");
  }
}
/** The registrant already accepted a notice for this Site. Not an error the visitor caused. */
export class SiteAlreadyRegisteredError extends Error {}
/** A registration arrived before the organizer published a privacy notice. */
export class SiteConsentUnavailableError extends Error {}

/** One program's own domain, asked what it has. Bound in the composition root. */
export interface SiteProgramResolver {
  /**
   * Resolve a batch of program references, answering only what exists.
   *
   * A batch rather than one call per program: a portal listing twenty programs would otherwise
   * cost twenty round trips on every public read, and the public namespace is cached but not
   * free. A reference this resolver does not know is simply absent from the answer.
   */
  resolve(
    references: readonly { kind: SiteProgramKind; ref: string }[],
  ): Promise<ReadonlyMap<string, { title: string; state: string }>>;
}

/** The parser-backed boundary for organizer-authored markup. Bound to publishing's own adapter. */
export type SanitizeSiteHtml = (input: string) => string;

export interface SiteDraft {
  readonly slug: string;
  readonly name: string;
  readonly tagline?: string | undefined;
  readonly landingHeading?: string | undefined;
  readonly landingBody?: string | undefined;
  readonly loginHeading?: string | undefined;
  readonly loginBody?: string | undefined;
  readonly theme?: SiteTheme | undefined;
  readonly primaryColor?: string | undefined;
  readonly programs?:
    | readonly { kind: SiteProgramKind; ref: string; label?: string | undefined }[]
    | undefined;
  readonly pages?:
    | readonly {
        slug: string;
        title: string;
        bodyHtml: string;
        visibility?: "visible" | "hidden" | undefined;
      }[]
    | undefined;
  readonly registrationFields?:
    | readonly {
        key: string;
        label: string;
        kind: SiteFieldKind;
        required?: boolean | undefined;
        options?: readonly string[] | undefined;
      }[]
    | undefined;
}

export interface SiteRepository {
  listForOrganization(organizationId: string): Promise<readonly Site[]>;
  find(organizationId: string, siteId: string): Promise<Site | null>;
  /** By public address, whatever its state. The service decides what an unpublished one answers. */
  findBySlug(slug: string): Promise<Site | null>;
  create(site: Site): Promise<void>;
  /** Rewrites the Site and its child collections at `expectedRevision`; 0 means the row moved. */
  save(site: Site, expectedRevision: number): Promise<number>;
  /** Appends a notice version. Answers the version written. */
  appendPrivacyNotice(siteId: string, bodyHtml: string, effectiveAt: string): Promise<number>;
  /** Publish or withdraw at `expectedRevision`, appending the history row when publishing. */
  setState(input: {
    siteId: string;
    expectedRevision: number;
    state: "published" | "unpublished";
    at: string;
    snapshot: unknown | null;
  }): Promise<number>;
  recordConsent(consent: {
    id: string;
    siteId: string;
    noticeVersion: number;
    actorRef: string;
    acceptedAt: string;
    answers: Record<string, string>;
  }): Promise<boolean>;
  listConsents(
    siteId: string,
    limit: number,
  ): Promise<
    readonly {
      readonly id: string;
      readonly noticeVersion: number;
      readonly actorRef: string;
      readonly acceptedAt: string;
    }[]
  >;
  listPublications(
    siteId: string,
  ): Promise<readonly { readonly version: number; readonly publishedAt: string }[]>;
}

export interface SiteDependencies {
  repository: SiteRepository;
  /** Which events belong to an organization; asked, never joined. */
  events: {
    listEventIdsInOrganization(
      organizationId: string,
      candidateEventIds: readonly string[],
    ): Promise<readonly string[]>;
  };
  programs?: SiteProgramResolver | undefined;
  sanitize: SanitizeSiteHtml;
  newId(): string;
  now(): Date;
}

const trimmed = (value: string | undefined, limit: number) => (value ?? "").trim().slice(0, limit);

export class SiteService {
  constructor(private readonly dependencies: SiteDependencies) {}

  /**
   * Who may compose a portal.
   *
   * `events:settings:update` earned on an event of this organization, plus membership of it.
   * A portal is public-facing copy for the whole organization, so it takes the same capability
   * that publishing an event's public page takes rather than a weaker one — and deliberately not
   * `identity:manage`, which is about who people are rather than what visitors see.
   */
  private async authorize(actor: Actor | null, organizationId: string): Promise<Actor> {
    const authorized = requireCapability(actor, "events:settings:update");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    const candidates = authorized.eventAccess
      .filter(({ capabilities }) => capabilities.has("events:settings:update"))
      .map(({ eventId }) => eventId);
    if (
      (await this.dependencies.events.listEventIdsInOrganization(organizationId, candidates))
        .length > 0
    )
      return authorized;
    throw new CapabilityDeniedError("Actor lacks events:settings:update inside this organization");
  }

  private validate(draft: SiteDraft, existing?: Site): Omit<Site, "id" | "organizationId"> {
    const fields: Record<string, string[]> = {};
    const slug = normalizeSlug(draft.slug);
    if (!isPublicSlug(slug))
      fields.slug = ["A public address is lower-case words joined by hyphens."];
    const name = draft.name.trim();
    if (name.length < 1 || name.length > 120) fields.name = ["A site name is 1 to 120 characters."];
    const primaryColor = (draft.primaryColor ?? existing?.primaryColor ?? "#2f5d50").trim();
    if (!isPrimaryColor(primaryColor))
      fields.primaryColor = ["Choose a six-digit hex colour, such as #2f5d50."];

    const programs = (draft.programs ?? []).slice(0, MAX_SITE_PROGRAMS);
    if ((draft.programs?.length ?? 0) > MAX_SITE_PROGRAMS)
      fields.programs = [`A site lists at most ${MAX_SITE_PROGRAMS} programs.`];
    const seenPrograms = new Set<string>();
    const composedPrograms: SiteProgram[] = [];
    for (const [index, program] of programs.entries()) {
      const key = `${program.kind}:${program.ref}`;
      // A duplicate is dropped rather than refused: the same program twice is an ordering
      // mistake, and refusing the whole save would cost the organizer every other edit.
      if (seenPrograms.has(key)) continue;
      seenPrograms.add(key);
      composedPrograms.push({
        kind: program.kind,
        ref: program.ref,
        label: trimmed(program.label, 120),
        position: index,
      });
    }

    const pages = draft.pages ?? [];
    if (pages.length > MAX_SITE_PAGES)
      fields.pages = [`A site carries at most ${MAX_SITE_PAGES} custom pages.`];
    const seenPages = new Set<string>();
    const composedPages: SitePage[] = [];
    for (const [index, page] of pages.slice(0, MAX_SITE_PAGES).entries()) {
      const pageSlug = normalizeSlug(page.slug);
      if (!isPublicSlug(pageSlug)) {
        fields[`pages.${index}.slug`] = ["A page address is lower-case words joined by hyphens."];
        continue;
      }
      if (seenPages.has(pageSlug)) {
        fields[`pages.${index}.slug`] = ["Two pages cannot share an address."];
        continue;
      }
      seenPages.add(pageSlug);
      composedPages.push({
        // A page keeps its identifier across a save so a link to it survives an edit.
        id: existing?.pages.find((held) => held.slug === pageSlug)?.id ?? this.dependencies.newId(),
        slug: pageSlug,
        title: page.title.trim().slice(0, 160),
        // Sanitized before it is stored, not on render: storing the raw markup would leave the
        // unsafe copy as the durable one, and the next reader might not sanitize.
        bodyHtml: this.dependencies.sanitize(page.bodyHtml).slice(0, 40_000),
        position: index,
        visibility: page.visibility ?? "visible",
      });
    }

    const registrationFields: SiteRegistrationField[] = [];
    const custom = draft.registrationFields ?? [];
    if (custom.length > MAX_CUSTOM_REGISTRATION_FIELDS)
      fields.registrationFields = [
        `A registration form carries at most ${MAX_CUSTOM_REGISTRATION_FIELDS} custom fields.`,
      ];
    const seenFields = new Set<string>();
    for (const [index, field] of custom.slice(0, MAX_CUSTOM_REGISTRATION_FIELDS).entries()) {
      const key = field.key.trim().toLowerCase();
      if (RESERVED_FIELD_KEYS.includes(key)) {
        fields[`registrationFields.${index}.key`] = [
          `${key} is always collected and cannot be redefined.`,
        ];
        continue;
      }
      if (!/^[a-z0-9_-]{1,60}$/.test(key)) {
        fields[`registrationFields.${index}.key`] = [
          "A field key is lower-case letters, digits, hyphens or underscores.",
        ];
        continue;
      }
      if (seenFields.has(key)) continue;
      seenFields.add(key);
      registrationFields.push({
        key,
        label: field.label.trim().slice(0, 120),
        kind: field.kind,
        required: field.required ?? false,
        options: (field.options ?? [])
          .map((option) => option.trim())
          .filter(Boolean)
          .slice(0, 20),
        position: index,
      });
    }

    if (Object.keys(fields).length > 0)
      throw new SiteInvalidError("Review the highlighted site details.", fields);

    const now = this.dependencies.now().toISOString();
    return {
      slug,
      name,
      tagline: trimmed(draft.tagline ?? existing?.tagline, 200),
      landingHeading: trimmed(draft.landingHeading ?? existing?.landingHeading, 160),
      landingBody: trimmed(draft.landingBody ?? existing?.landingBody, 2000),
      loginHeading: trimmed(draft.loginHeading ?? existing?.loginHeading, 160),
      loginBody: trimmed(draft.loginBody ?? existing?.loginBody, 2000),
      theme: draft.theme ?? existing?.theme ?? "light",
      primaryColor,
      state: existing?.state ?? "draft",
      publishedAt: existing?.publishedAt ?? null,
      revision: existing?.revision ?? 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      programs: composedPrograms,
      pages: composedPages,
      registrationFields,
      privacyNotice: existing?.privacyNotice ?? null,
    };
  }

  async list(actor: Actor | null, organizationId: string) {
    await this.authorize(actor, organizationId);
    return this.dependencies.repository.listForOrganization(organizationId);
  }

  /** One Site as its organizer sees it: the draft, plus which programs still resolve. */
  async get(actor: Actor | null, organizationId: string, siteId: string) {
    await this.authorize(actor, organizationId);
    const site = await this.dependencies.repository.find(organizationId, siteId);
    if (!site) throw new SiteNotFoundError("That site was not found");
    const resolved = await this.resolvePrograms(site.programs);
    return {
      site,
      // Named rather than implied by an absence: a program whose source has gone is a thing the
      // organizer has to fix, and a portal that quietly shortened itself says nothing.
      unresolvedPrograms: site.programs
        .filter((program) => !resolved.has(`${program.kind}:${program.ref}`))
        .map(({ kind, ref }) => ({ kind, ref })),
      publications: await this.dependencies.repository.listPublications(site.id),
    };
  }

  private async resolvePrograms(programs: readonly SiteProgram[]) {
    if (!this.dependencies.programs || programs.length === 0)
      return new Map<string, { title: string; state: string }>();
    return this.dependencies.programs.resolve(programs.map(({ kind, ref }) => ({ kind, ref })));
  }

  async create(actor: Actor | null, organizationId: string, draft: SiteDraft): Promise<Site> {
    await this.authorize(actor, organizationId);
    const site: Site = {
      id: this.dependencies.newId(),
      organizationId,
      ...this.validate(draft),
    };
    await this.dependencies.repository.create(site);
    return site;
  }

  async update(
    actor: Actor | null,
    organizationId: string,
    siteId: string,
    draft: SiteDraft & { expectedRevision: number },
  ): Promise<Site> {
    await this.authorize(actor, organizationId);
    const existing = await this.dependencies.repository.find(organizationId, siteId);
    if (!existing) throw new SiteNotFoundError("That site was not found");
    if (existing.revision !== draft.expectedRevision)
      throw new SiteConflictError(existing.revision);
    const next: Site = {
      ...existing,
      ...this.validate(draft, existing),
      id: existing.id,
      organizationId,
      revision: existing.revision + 1,
    };
    if ((await this.dependencies.repository.save(next, draft.expectedRevision)) === 0)
      throw new SiteConflictError(existing.revision);
    return next;
  }

  /**
   * Append a privacy-notice version.
   *
   * Append, never rewrite. Editing the text in place would leave every stored consent naming a
   * version whose words had changed underneath it — a consent record that cannot produce what was
   * consented to is not a consent record. Migration `1804` refuses the update at the table too.
   */
  async publishPrivacyNotice(
    actor: Actor | null,
    organizationId: string,
    siteId: string,
    bodyHtml: string,
  ): Promise<{ version: number; effectiveAt: string }> {
    await this.authorize(actor, organizationId);
    const site = await this.dependencies.repository.find(organizationId, siteId);
    if (!site) throw new SiteNotFoundError("That site was not found");
    const sanitized = this.dependencies.sanitize(bodyHtml).trim();
    if (!sanitized)
      throw new SiteInvalidError("A privacy notice needs some text.", {
        bodyHtml: ["A privacy notice needs some text."],
      });
    const effectiveAt = this.dependencies.now().toISOString();
    const version = await this.dependencies.repository.appendPrivacyNotice(
      site.id,
      sanitized.slice(0, 40_000),
      effectiveAt,
    );
    return { version, effectiveAt };
  }

  async publish(
    actor: Actor | null,
    organizationId: string,
    siteId: string,
    expectedRevision: number,
  ): Promise<Site> {
    return this.transition(actor, organizationId, siteId, expectedRevision, "published");
  }

  /**
   * Withdraw the portal.
   *
   * The address stops answering and the history stays, which is what makes this reversible and
   * what makes "there is no delete for a Site" a workable rule (`1804_sites.sql`).
   */
  async unpublish(
    actor: Actor | null,
    organizationId: string,
    siteId: string,
    expectedRevision: number,
  ): Promise<Site> {
    return this.transition(actor, organizationId, siteId, expectedRevision, "unpublished");
  }

  private async transition(
    actor: Actor | null,
    organizationId: string,
    siteId: string,
    expectedRevision: number,
    state: "published" | "unpublished",
  ): Promise<Site> {
    await this.authorize(actor, organizationId);
    const site = await this.dependencies.repository.find(organizationId, siteId);
    if (!site) throw new SiteNotFoundError("That site was not found");
    if (site.revision !== expectedRevision) throw new SiteConflictError(site.revision);
    if (state === "published" && !site.privacyNotice)
      throw new SiteInvalidError(
        "Publish a privacy notice before the site goes live; registration records the version somebody accepted.",
        { privacyNotice: ["Publish a privacy notice first."] },
      );
    const at = this.dependencies.now().toISOString();
    const next: Site = {
      ...site,
      state,
      publishedAt: state === "published" ? at : site.publishedAt,
      revision: site.revision + 1,
      updatedAt: at,
    };
    const changed = await this.dependencies.repository.setState({
      siteId: site.id,
      expectedRevision,
      state,
      at,
      // The snapshot is what was served at this version, so "what did the portal say in March"
      // has an answer that does not depend on the draft it has since become.
      snapshot:
        state === "published"
          ? composePublicSite(next, await this.resolvePrograms(next.programs))
          : null,
    });
    if (changed === 0) throw new SiteConflictError(site.revision);
    return next;
  }

  /**
   * The public portal at this address, or null.
   *
   * A draft, an unpublished Site and an unknown address are one answer, so the route cannot be
   * used to discover portals that are being prepared.
   */
  async publicSite(slug: string): Promise<PublicSite | null> {
    const site = await this.dependencies.repository.findBySlug(slug);
    if (!site) return null;
    return composePublicSite(site, await this.resolvePrograms(site.programs));
  }

  /** One published page, or null. Hidden pages are not found rather than forbidden. */
  async publicPage(slug: string, pageSlug: string) {
    const site = await this.dependencies.repository.findBySlug(slug);
    if (!site || site.state !== "published") return null;
    const page = site.pages.find(
      (candidate) => candidate.slug === pageSlug && candidate.visibility === "visible",
    );
    return page ? { site: { slug: site.slug, name: site.name }, page } : null;
  }

  /**
   * Register against the portal, recording the exact notice version accepted.
   *
   * The version comes from the *Site*, never from the request: a client that supplied it could
   * claim consent to a version the visitor never saw. Every required field must be answered, and
   * a field the organizer did not configure is dropped rather than stored — a registration is
   * bounded by the form, not by what a caller chose to send.
   */
  async register(
    slug: string,
    submission: { name: string; email: string; answers: Record<string, string>; accepted: boolean },
  ): Promise<{ noticeVersion: number; acceptedAt: string }> {
    const site = await this.dependencies.repository.findBySlug(slug);
    if (!site || site.state !== "published") throw new SiteNotFoundError("That site was not found");
    if (!site.privacyNotice)
      throw new SiteConsentUnavailableError("This site is not accepting registrations yet");
    if (!submission.accepted)
      throw new SiteInvalidError("The privacy notice has to be accepted to register.", {
        accepted: ["The privacy notice has to be accepted to register."],
      });
    const fields: Record<string, string[]> = {};
    const name = submission.name.trim();
    if (!name) fields.name = ["Tell us your name."];
    const email = normalizeRegistrantEmail(submission.email);
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) fields.email = ["Enter an email address."];
    const answers: Record<string, string> = {};
    for (const field of site.registrationFields) {
      const value = (submission.answers[field.key] ?? "").trim();
      if (field.required && !value) fields[field.key] = [`${field.label} is required.`];
      if (field.kind === "select" && value && !field.options.includes(value))
        fields[field.key] = [`Choose one of the offered options for ${field.label}.`];
      if (value) answers[field.key] = value.slice(0, 2000);
    }
    if (Object.keys(fields).length > 0)
      throw new SiteInvalidError("Review the highlighted registration details.", fields);

    const acceptedAt = this.dependencies.now().toISOString();
    const recorded = await this.dependencies.repository.recordConsent({
      id: this.dependencies.newId(),
      siteId: site.id,
      noticeVersion: site.privacyNotice.version,
      actorRef: email,
      acceptedAt,
      answers: { ...answers, name },
    });
    // A second submission from one address converges rather than growing a second consent row:
    // one person, one record of what they accepted.
    if (!recorded)
      throw new SiteAlreadyRegisteredError("That address is already registered for this site");
    return { noticeVersion: site.privacyNotice.version, acceptedAt };
  }

  /** Who registered and which notice version they accepted. Organizer-only, and never public. */
  async consents(actor: Actor | null, organizationId: string, siteId: string, limit = 200) {
    await this.authorize(actor, organizationId);
    const site = await this.dependencies.repository.find(organizationId, siteId);
    if (!site) throw new SiteNotFoundError("That site was not found");
    return this.dependencies.repository.listConsents(site.id, Math.min(Math.max(limit, 1), 500));
  }

  /** The fixed identity fields, published so a form cannot drift from what registration requires. */
  requiredFields() {
    return REQUIRED_REGISTRATION_FIELDS;
  }
}
