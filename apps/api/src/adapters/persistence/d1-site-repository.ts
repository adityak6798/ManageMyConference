/**
 * `SiteRepository` against D1.
 *
 * A Site is one row plus four child collections, and a save rewrites all of them. That is why the
 * guarded `UPDATE` goes first in the batch and every statement after it re-tests the stored
 * revision rather than `changes()`: `changes()` reports only the statement immediately before, so
 * a chain whose length depends on how many pages a portal has cannot use it. Reading the revision
 * back is the guard that stays correct however many statements a save adds — the same shape
 * `d1-custom-roles.ts` uses, for the same reason.
 *
 * Two writes here answer a boolean rather than a count, and both are deliberate. Recording a
 * consent uses `INSERT … ON CONFLICT DO NOTHING` so a repeat submission from one address
 * converges on the record already stored instead of growing a second one. Appending a privacy
 * notice computes its version inside the statement (`MAX(version) + 1`), so two organizers
 * publishing a notice at once produce two versions rather than one lost update.
 *
 * @spec PRD-PUB-002 ARC-003
 */
import { type SiteRepository, SiteSlugTakenError } from "../../application/publishing/site-service";
import type {
  Site,
  SiteFieldKind,
  SitePage,
  SiteProgramKind,
  SiteState,
  SiteTheme,
} from "../../domain/publishing/site";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface SiteDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface SiteRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  tagline: string;
  landing_heading: string;
  landing_body: string;
  login_heading: string;
  login_body: string;
  theme: SiteTheme;
  primary_color: string;
  state: SiteState;
  published_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const SITE_COLUMNS =
  "id, organization_id, slug, name, tagline, landing_heading, landing_body, login_heading, login_body, theme, primary_color, state, published_at, revision, created_at, updated_at";

export class D1SiteRepository implements SiteRepository {
  constructor(private readonly database: SiteDatabasePort) {}

  private async rows<T>(query: string, ...values: unknown[]): Promise<T[]> {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .all<T>();
    if (!result.success)
      throw new Error(`D1 failed to read a site: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }

  private async compose(rows: readonly SiteRow[]): Promise<Site[]> {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((row) => row.id));
    const inIds = "site_id IN (SELECT value FROM json_each(?))";
    const [programs, pages, fields, notices] = await Promise.all([
      this.rows<{
        site_id: string;
        program_kind: SiteProgramKind;
        program_ref: string;
        label: string;
        position: number;
      }>(
        `SELECT site_id, program_kind, program_ref, label, position FROM site_programs WHERE ${inIds} ORDER BY position, program_ref`,
        ids,
      ),
      this.rows<{
        site_id: string;
        id: string;
        slug: string;
        title: string;
        body_html: string;
        position: number;
        visibility: SitePage["visibility"];
      }>(
        `SELECT site_id, id, slug, title, body_html, position, visibility FROM site_pages WHERE ${inIds} ORDER BY position, slug`,
        ids,
      ),
      this.rows<{
        site_id: string;
        field_key: string;
        label: string;
        kind: SiteFieldKind;
        required: number;
        options: string;
        position: number;
      }>(
        `SELECT site_id, field_key, label, kind, required, options, position FROM site_registration_fields WHERE ${inIds} ORDER BY position, field_key`,
        ids,
      ),
      // The version in force is the highest one, which is what `register` stamps a consent with.
      this.rows<{ site_id: string; version: number; body_html: string; effective_at: string }>(
        `SELECT n.site_id, n.version, n.body_html, n.effective_at FROM site_privacy_notices n
           JOIN (SELECT site_id, MAX(version) AS version FROM site_privacy_notices WHERE ${inIds} GROUP BY site_id) latest
             ON latest.site_id = n.site_id AND latest.version = n.version`,
        ids,
      ),
    ]);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      slug: row.slug,
      name: row.name,
      tagline: row.tagline,
      landingHeading: row.landing_heading,
      landingBody: row.landing_body,
      loginHeading: row.login_heading,
      loginBody: row.login_body,
      theme: row.theme,
      primaryColor: row.primary_color,
      state: row.state,
      publishedAt: row.published_at,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      programs: programs
        .filter((program) => program.site_id === row.id)
        .map(({ program_kind, program_ref, label, position }) => ({
          kind: program_kind,
          ref: program_ref,
          label,
          position,
        })),
      pages: pages
        .filter((page) => page.site_id === row.id)
        .map(({ id, slug, title, body_html, position, visibility }) => ({
          id,
          slug,
          title,
          bodyHtml: body_html,
          position,
          visibility,
        })),
      registrationFields: fields
        .filter((field) => field.site_id === row.id)
        .map(({ field_key, label, kind, required, options, position }) => ({
          key: field_key,
          label,
          kind,
          required: required === 1,
          options: JSON.parse(options) as string[],
          position,
        })),
      privacyNotice: (() => {
        const notice = notices.find((candidate) => candidate.site_id === row.id);
        return notice
          ? {
              version: notice.version,
              bodyHtml: notice.body_html,
              effectiveAt: notice.effective_at,
            }
          : null;
      })(),
    }));
  }

  async listForOrganization(organizationId: string): Promise<readonly Site[]> {
    return this.compose(
      await this.rows<SiteRow>(
        `SELECT ${SITE_COLUMNS} FROM sites WHERE organization_id = ? ORDER BY name, id`,
        organizationId,
      ),
    );
  }

  async find(organizationId: string, siteId: string): Promise<Site | null> {
    const rows = await this.rows<SiteRow>(
      `SELECT ${SITE_COLUMNS} FROM sites WHERE organization_id = ? AND id = ? LIMIT 1`,
      organizationId,
      siteId,
    );
    return (await this.compose(rows))[0] ?? null;
  }

  async findBySlug(slug: string): Promise<Site | null> {
    const rows = await this.rows<SiteRow>(
      `SELECT ${SITE_COLUMNS} FROM sites WHERE slug = ? LIMIT 1`,
      slug,
    );
    return (await this.compose(rows))[0] ?? null;
  }

  /** The child rows a save or a create writes, sharing one guard so the two cannot drift. */
  private childStatements(site: Site, guard: string, guardValues: readonly unknown[]) {
    const guarded = (query: string, ...values: unknown[]) =>
      this.database.prepare(`${query} ${guard}`).bind(...values, ...guardValues);
    return [
      ...site.programs.map((program) =>
        guarded(
          "INSERT INTO site_programs (site_id, program_kind, program_ref, label, position) SELECT ?, ?, ?, ?, ?",
          site.id,
          program.kind,
          program.ref,
          program.label,
          program.position,
        ),
      ),
      ...site.pages.map((page) =>
        guarded(
          "INSERT INTO site_pages (id, site_id, slug, title, body_html, position, visibility) SELECT ?, ?, ?, ?, ?, ?, ?",
          page.id,
          site.id,
          page.slug,
          page.title,
          page.bodyHtml,
          page.position,
          page.visibility,
        ),
      ),
      ...site.registrationFields.map((field) =>
        guarded(
          "INSERT INTO site_registration_fields (site_id, field_key, label, kind, required, options, position) SELECT ?, ?, ?, ?, ?, ?, ?",
          site.id,
          field.key,
          field.label,
          field.kind,
          field.required ? 1 : 0,
          JSON.stringify(field.options),
          field.position,
        ),
      ),
    ];
  }

  async create(site: Site): Promise<void> {
    await this.runBatch(
      [
        this.database
          .prepare(`INSERT INTO sites (${SITE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(
            site.id,
            site.organizationId,
            site.slug,
            site.name,
            site.tagline,
            site.landingHeading,
            site.landingBody,
            site.loginHeading,
            site.loginBody,
            site.theme,
            site.primaryColor,
            site.state,
            site.publishedAt,
            site.revision,
            site.createdAt,
            site.updatedAt,
          ),
        // `WHERE 1` rather than a revision test: the parent insert either landed or the batch
        // failed, and D1 applies a batch atomically.
        ...this.childStatements(site, "WHERE 1", []),
      ],
      "create a site",
    );
  }

  async save(site: Site, expectedRevision: number): Promise<number> {
    const guard = "WHERE (SELECT revision FROM sites WHERE id = ?) = ?";
    const results = await this.runBatch(
      [
        this.database
          .prepare(
            "UPDATE sites SET slug = ?, name = ?, tagline = ?, landing_heading = ?, landing_body = ?, " +
              "login_heading = ?, login_body = ?, theme = ?, primary_color = ?, revision = ?, updated_at = ? " +
              "WHERE id = ? AND revision = ?",
          )
          .bind(
            site.slug,
            site.name,
            site.tagline,
            site.landingHeading,
            site.landingBody,
            site.loginHeading,
            site.loginBody,
            site.theme,
            site.primaryColor,
            site.revision,
            site.updatedAt,
            site.id,
            expectedRevision,
          ),
        this.database
          .prepare(
            `DELETE FROM site_programs WHERE site_id = ? AND (SELECT revision FROM sites WHERE id = ?) = ?`,
          )
          .bind(site.id, site.id, site.revision),
        this.database
          .prepare(
            `DELETE FROM site_pages WHERE site_id = ? AND (SELECT revision FROM sites WHERE id = ?) = ?`,
          )
          .bind(site.id, site.id, site.revision),
        this.database
          .prepare(
            `DELETE FROM site_registration_fields WHERE site_id = ? AND (SELECT revision FROM sites WHERE id = ?) = ?`,
          )
          .bind(site.id, site.id, site.revision),
        ...this.childStatements(site, guard, [site.id, site.revision]),
      ],
      "save a site",
    );
    const [updated] = results;
    if (!updated) throw new Error("D1 returned no result while saving a site");
    return changedRows(updated, "save a site");
  }

  /**
   * Append the next notice version, computed inside the statement.
   *
   * `MAX(version) + 1` in SQL rather than a read followed by an insert, so two organizers
   * publishing a notice at the same moment produce versions 3 and 4 rather than one of them
   * silently overwriting the other's row — the primary key would refuse the second anyway, and
   * the caller would meet a constraint error instead of a version number.
   */
  async appendPrivacyNotice(
    siteId: string,
    bodyHtml: string,
    effectiveAt: string,
  ): Promise<number> {
    const result = await this.database
      .prepare(
        "INSERT INTO site_privacy_notices (site_id, version, body_html, effective_at) " +
          "SELECT ?, COALESCE((SELECT MAX(version) FROM site_privacy_notices WHERE site_id = ?), 0) + 1, ?, ? " +
          "RETURNING version",
      )
      .bind(siteId, siteId, bodyHtml, effectiveAt)
      .all<{ version: number }>();
    if (!result.success)
      throw new Error(`D1 failed to append a privacy notice: ${result.error ?? "unknown error"}`);
    const version = result.results?.[0]?.version;
    if (typeof version !== "number")
      throw new Error("D1 returned no version while appending a privacy notice");
    return version;
  }

  async setState(input: {
    siteId: string;
    expectedRevision: number;
    state: "published" | "unpublished";
    at: string;
    snapshot: unknown | null;
  }): Promise<number> {
    const statements: D1Statement[] = [
      this.database
        .prepare(
          "UPDATE sites SET state = ?, revision = revision + 1, updated_at = ?, " +
            "published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END " +
            "WHERE id = ? AND revision = ?",
        )
        .bind(input.state, input.at, input.state, input.at, input.siteId, input.expectedRevision),
    ];
    if (input.state === "published")
      statements.push(
        // Guarded on the update's own count: a publish that lost the revision race appends no
        // history row, so the history cannot claim a version that never served.
        this.database
          .prepare(
            "INSERT INTO site_publications (site_id, version, published_at, snapshot_json) " +
              "SELECT ?, COALESCE((SELECT MAX(version) FROM site_publications WHERE site_id = ?), 0) + 1, ?, ? " +
              "WHERE changes() > 0",
          )
          .bind(input.siteId, input.siteId, input.at, JSON.stringify(input.snapshot ?? null)),
      );
    const results = await this.runBatch(statements, "change a site's publication state");
    const [updated] = results;
    if (!updated) throw new Error("D1 returned no result while publishing a site");
    return changedRows(updated, "change a site's publication state");
  }

  async recordConsent(consent: {
    id: string;
    siteId: string;
    noticeVersion: number;
    actorRef: string;
    acceptedAt: string;
    answers: Record<string, string>;
  }): Promise<boolean> {
    const result = await this.database
      .prepare(
        "INSERT INTO site_consents (id, site_id, notice_version, actor_ref, accepted_at, answers_json) " +
          "VALUES (?,?,?,?,?,?) ON CONFLICT (site_id, actor_ref) DO NOTHING",
      )
      .bind(
        consent.id,
        consent.siteId,
        consent.noticeVersion,
        consent.actorRef,
        consent.acceptedAt,
        JSON.stringify(consent.answers),
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to record consent: ${result.error ?? "unknown error"}`);
    return changedRows(result, "record consent") > 0;
  }

  async listConsents(siteId: string, limit: number) {
    return this.rows<{
      id: string;
      notice_version: number;
      actor_ref: string;
      accepted_at: string;
    }>(
      "SELECT id, notice_version, actor_ref, accepted_at FROM site_consents WHERE site_id = ? ORDER BY accepted_at DESC, id DESC LIMIT ?",
      siteId,
      limit,
    ).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        noticeVersion: row.notice_version,
        actorRef: row.actor_ref,
        acceptedAt: row.accepted_at,
      })),
    );
  }

  async listPublications(siteId: string) {
    return this.rows<{ version: number; published_at: string }>(
      "SELECT version, published_at FROM site_publications WHERE site_id = ? ORDER BY version DESC",
      siteId,
    ).then((rows) => rows.map((row) => ({ version: row.version, publishedAt: row.published_at })));
  }

  /**
   * Run a batch and classify whatever goes wrong, however it arrives.
   *
   * A constraint failure reaches this adapter two different ways depending on the driver: some
   * report `success: false` on the offending statement, and D1 **rejects the whole call**. Both
   * are handled here rather than at each call site, because the one that rejects is the one a
   * unit test with a well-behaved fake never produces — which is exactly how a taken public
   * address came to surface as a 500 instead of the 409 the form can act on.
   *
   * The unique index is the arbiter of a taken address rather than a read before the write: two
   * organizers claiming one address at the same moment would both pass a read, and only the index
   * can decide. The application error is raised here so the transport translates one thing.
   */
  private async runBatch<T>(
    statements: D1Statement[],
    operation: string,
  ): Promise<Array<D1WriteResult & { results?: T[] }>> {
    let results: Array<D1WriteResult & { results?: T[] }>;
    try {
      results = await this.database.batch<T>(statements);
    } catch (error) {
      // ERROR-INTENT: classified and rethrown, never dropped — a unique-index refusal becomes the
      // application error the transport turns into a 409, and everything else keeps its message.
      if (/unique/i.test(String(error))) throw new SiteSlugTakenError();
      throw new Error(`D1 failed to ${operation}: ${String(error)}`);
    }
    const failed = results.find((result) => !result.success);
    if (failed) {
      if (/unique/i.test(failed.error ?? "")) throw new SiteSlugTakenError();
      throw new Error(`D1 failed to ${operation}: ${failed.error ?? "unknown error"}`);
    }
    return results;
  }
}
