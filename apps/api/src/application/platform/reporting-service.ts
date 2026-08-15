/**
 * Saved reports, their share links, their schedules, and the PII decision all four share.
 *
 * Issue #196's reporting area. Four rules govern everything below, and each one is the answer to
 * a way the surface could otherwise leak.
 *
 * **A report is a question, never a stored answer.** Running one reads live rows through
 * `PlatformSources`, so it can never show a row the caller's role could not open — and a share
 * link resolves live too, which is what makes revoking the link the whole of revoking access. A
 * stored result set would be a copy of private data sitting outside every rule that protects the
 * original.
 *
 * **PII is masked by default, on the way out, in one place.** `runQuery` masks; the screen, the
 * CSV, the XLSX, the JSON and a share link all go through it. Unmasking needs the `reports:pii`
 * capability *and* an explicit request *and* leaves an audit record. An export that a scoped role
 * can generate but not read on screen is exactly the hole this closes, and the reason the
 * decision is made before the rows are formatted rather than after.
 *
 * **A share link is a capability URL, and `DEBT-012` says what that costs.** This one ships what
 * that entry says the next capability URL must: revocation, an expiry, a view limit, an optional
 * password, and only the token's digest in storage. The view limit is decremented in the same
 * statement that reads the row, so two concurrent resolves of a one-view link cannot both win.
 *
 * **Delivery is a link, not a message.** A schedule sends an expiring share URL. That keeps
 * scheduled reports inside platform rather than requiring a new `communication_deliveries`
 * trigger type — a pinned CHECK whose widening is a table rebuild in another lane's block.
 *
 * @spec PRD-OPS-001 PRD-IAM-002 ARC-DOM-001
 */
import { type Actor, type Capability, requireEventCapability } from "../identity/actor";
import type { AuditRecorder } from "./audit-service";
import {
  type CapabilityLink,
  type CapabilityLinkStore,
  MAX_CAPABILITY_LINK_HOURS,
  spendCapabilityLink,
} from "./capability-link";
import {
  DEFAULT_REPORT_PAGE,
  datasetOf,
  MAX_REPORT_PAGE,
  REPORT_CATALOGUE,
  REPORT_OPERATORS,
  type ReportDatasetKey,
  type ReportQuery,
  type ReportResult,
  runQuery,
  validateQuery,
} from "./report-catalogue";
import { readReportRows } from "./report-rows";
import type { PlatformSources } from "./sources";

export class ReportNotFoundError extends Error {}
export class ReportNameTakenError extends Error {
  constructor() {
    super("A report with that name already exists on this event.");
  }
}
export class ReportConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("This report changed while you were editing it. Reload and reapply your changes.");
  }
}
export class ReportInvalidError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
/** The caller asked for unmasked personal data and does not hold `reports:pii`. */
export class ReportPiiDeniedError extends Error {
  constructor() {
    super("Reading unmasked personal data needs the reports:pii capability.");
  }
}
/** The link is gone, expired, out of views, or the password was wrong — one answer for all four. */
export class ReportShareUnavailableError extends Error {
  constructor() {
    super("That share link is not available.");
  }
}

export interface ReportDefinition {
  readonly id: string;
  readonly eventId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string;
  readonly dataset: ReportDatasetKey;
  readonly query: ReportQuery;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

/**
 * A share link onto a report, projected from the shared capability-link primitive.
 *
 * `allowPii` is the report-specific half of the link's `scope`; everything else about it —
 * expiry, view limit, password, revocation, digest-only storage — belongs to the convention
 * rather than to reporting, which is why it lives in `capability-link.ts` and this is a
 * projection rather than a second table.
 */
export interface ReportShare {
  readonly id: string;
  readonly reportId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly viewLimit: number | null;
  readonly views: number;
  readonly allowPii: boolean;
  readonly revokedAt: string | null;
  readonly hasPassword: boolean;
}

/** The link as reporting reads it. `scope.allowPii` is the only part reporting interprets. */
export const shareOf = (link: CapabilityLink): ReportShare => ({
  id: link.id,
  reportId: link.resourceRef,
  createdBy: link.createdBy,
  createdAt: link.createdAt,
  expiresAt: link.expiresAt,
  viewLimit: link.viewLimit,
  views: link.views,
  allowPii: link.scope.allowPii === true,
  revokedAt: link.revokedAt,
  hasPassword: link.hasPassword,
});

/**
 * Freeze the creator's event-scoped read decision onto a capability link.
 *
 * A report remains live, but an anonymous visitor has no session actor for the owning domains to
 * authorize. The link is therefore a delegated, bounded actor: only capabilities the creator
 * held on this event and the exact field policies in force when it was minted. This is not an
 * impersonation — it carries no other event, actor-wide grant, or identity-management power.
 */
function delegatedScope(actor: Actor, eventId: string, allowPii: boolean) {
  const grants = actor.eventAccess.filter(({ eventId: candidate }) => candidate === eventId);
  return {
    allowPii,
    capabilities: [...new Set(grants.flatMap(({ capabilities }) => [...capabilities]))],
    fieldPolicies: [
      ...new Map(
        grants.flatMap(({ fieldPolicies }) => [...(fieldPolicies?.entries() ?? [])]),
      ).entries(),
    ],
  };
}

function delegatedActor(link: CapabilityLink): Actor | null {
  const known = new Set<Capability>([
    "events:read",
    "events:create",
    "events:settings:read",
    "events:settings:update",
    "communications:manage",
    "agenda:manage",
    "crm:manage",
    "content:read",
    "content:manage",
    "review:manage",
    "review:evaluate",
    "identity:manage",
    "reports:pii",
  ]);
  const capabilities = Array.isArray(link.scope.capabilities)
    ? link.scope.capabilities.filter(
        (value): value is Capability => typeof value === "string" && known.has(value as Capability),
      )
    : [];
  if (capabilities.length === 0) return null;
  const policies = Array.isArray(link.scope.fieldPolicies)
    ? link.scope.fieldPolicies.filter(
        (entry): entry is [string, "view" | "lock" | "hide"] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          (entry[1] === "view" || entry[1] === "lock" || entry[1] === "hide"),
      )
    : [];
  const granted = new Set(capabilities);
  return {
    id: `report-share:${link.id}`,
    name: "Shared report",
    persona: "public",
    organizations: [{ id: link.organizationId }],
    capabilities: granted,
    eventAccess: [
      {
        eventId: link.eventId,
        role: "custom",
        capabilities: granted,
        fieldPolicies: new Map(policies),
      },
    ],
  };
}

export interface ReportSchedule {
  readonly id: string;
  readonly reportId: string;
  readonly cadence: "daily" | "weekly" | "monthly";
  readonly minuteOfDay: number;
  readonly dayOfWeek: number | null;
  readonly dayOfMonth: number | null;
  readonly timezone: string;
  readonly recipients: readonly string[];
  readonly linkLifetimeHours: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly pausedAt: string | null;
  readonly lastFiredKey: string | null;
  /** Bounded authority fixed when the recurring instruction is created. */
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface ReportRun {
  readonly id: string;
  readonly scheduleId: string;
  readonly occurrenceKey: string;
  readonly ranAt: string;
  readonly outcome: "delivered" | "failed";
  readonly detail: string;
}

export interface ReportRepository {
  list(eventId: string): Promise<readonly ReportDefinition[]>;
  find(eventId: string, reportId: string): Promise<ReportDefinition | null>;
  /** By id alone, for the scheduler and the share resolver, neither of which holds an event. */
  findById(reportId: string): Promise<ReportDefinition | null>;
  create(report: ReportDefinition): Promise<void>;
  update(report: ReportDefinition, expectedRevision: number): Promise<number>;
  remove(eventId: string, reportId: string, expectedRevision: number): Promise<number>;

  createSchedule(schedule: ReportSchedule): Promise<void>;
  listSchedules(reportId: string): Promise<readonly ReportSchedule[]>;
  removeSchedule(reportId: string, scheduleId: string): Promise<number>;
  /** Every schedule that is not paused, across every event; the cron tick's only read. */
  listDueSchedules(): Promise<readonly (ReportSchedule & { eventId: string })[]>;
  /** Durably claims one occurrence before delivery, answering false if it was already claimed. */
  claimRun(run: ReportRun, lastFiredKey: string): Promise<boolean>;
  /** Appends the delivery result after the external effect finishes. */
  recordRun(run: ReportRun): Promise<void>;
  listRuns(scheduleId: string, limit: number): Promise<readonly ReportRun[]>;
}

/**
 * How a report result becomes a file.
 *
 * A port rather than a direct import, because rendering a spreadsheet needs a library and the
 * transport may not reach an adapter. It takes a `ReportResult` and never a query, which is the
 * whole of why an export cannot bypass the field decision: the rows it is handed have already
 * been filtered by the caller's grants, redacted by their custom role and masked by the PII rule.
 */
export interface ReportExportRenderer {
  csv(result: ReportResult): string;
  xlsx(result: ReportResult, sheetName: string): Uint8Array;
}

/** How a schedule reaches somebody. Bound in the composition root; see the module comment. */
export interface ReportDeliveryPort {
  deliver(delivery: {
    readonly reportName: string;
    readonly recipients: readonly string[];
    readonly url: string;
    readonly expiresAt: string;
  }): Promise<void>;
}

export interface ReportingDependencies {
  repository: ReportRepository;
  /**
   * The capability-URL convention, shared with every other anonymous link in this product.
   *
   * A port rather than three more methods on `ReportRepository`, because the shape is not
   * reporting's: `DEBT-012`'s conditions hold for every link, and issue #189's `GAP-028` residual
   * addresses a speaker profile through this same store rather than a second one.
   */
  links: CapabilityLinkStore;
  sources: PlatformSources;
  audit: Pick<AuditRecorder, "record">;
  delivery?: ReportDeliveryPort | undefined;
  exports?: ReportExportRenderer | undefined;
  /** 32 random bytes and the digest storage keeps instead of them. */
  mintToken(): Promise<{ token: string; tokenHash: string }>;
  hash(value: string): Promise<string>;
  /** Where a share link is reachable, so no client assembles one. */
  shareBaseUrl: string;
  newId(): string;
  now(): Date;
}

const MAX_RECIPIENTS = 20;

export class ReportingService {
  constructor(private readonly dependencies: ReportingDependencies) {}

  /**
   * Who may open the reporting surface.
   *
   * `events:read` on this exact event, and nothing narrower — because every dataset is then
   * decided *again* by the domain that owns it. A reviewer reaching the reports screen sees the
   * datasets a reviewer can read and `unauthorized` for the rest, which is the same degradation
   * search and the inbox already do. A single stronger capability here would have made reporting
   * a way to ask questions the console itself refuses.
   */
  private authorize(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "events:read");
  }

  /**
   * May this caller see unmasked personal data, and did they ask?
   *
   * Both halves are required. Holding the capability is not a standing instruction to unmask —
   * a report shared or exported by somebody who happens to hold it would otherwise carry
   * addresses nobody decided to include.
   */
  private resolvePii(actor: Actor, eventId: string, requested: boolean): boolean {
    if (!requested) return false;
    if (
      !actor.eventAccess.some(
        (access) => access.eventId === eventId && access.capabilities.has("reports:pii"),
      )
    )
      throw new ReportPiiDeniedError();
    return true;
  }

  /** The catalogue a query builder renders, so the screen cannot offer what the service refuses. */
  catalogue() {
    return { datasets: REPORT_CATALOGUE, operators: REPORT_OPERATORS };
  }

  async list(actor: Actor | null, eventId: string) {
    this.authorize(actor, eventId);
    return this.dependencies.repository.list(eventId);
  }

  async save(
    actor: Actor | null,
    eventId: string,
    input: {
      name: string;
      description?: string | undefined;
      dataset: string;
      fields?: readonly string[] | undefined;
      filters?:
        | readonly { field: string; operator: string; value?: string | undefined }[]
        | undefined;
      groupBy?: string | undefined;
      sort?: { field: string; direction: string } | undefined;
      limit?: number | undefined;
      reportId?: string | undefined;
      expectedRevision?: number | undefined;
    },
  ): Promise<ReportDefinition> {
    const authorized = this.authorize(actor, eventId);
    const name = input.name.trim();
    if (name.length < 1 || name.length > 120)
      throw new ReportInvalidError("A report name is 1 to 120 characters.", {
        name: ["A report name is 1 to 120 characters."],
      });
    // Validated against the catalogue before anything is stored, so a saved definition can never
    // be one the runner would refuse — including one a natural-language draft produced.
    const query = validateQuery({ ...input, offset: 0 });
    const now = this.dependencies.now().toISOString();
    const organizationId = (await this.dependencies.sources.events.organizationOf(eventId)) ?? "";

    if (!input.reportId) {
      const report: ReportDefinition = {
        id: this.dependencies.newId(),
        eventId,
        organizationId,
        name,
        description: (input.description ?? "").trim().slice(0, 400),
        dataset: query.dataset,
        query,
        createdBy: authorized.id,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      await this.dependencies.repository.create(report);
      return report;
    }

    const existing = await this.dependencies.repository.find(eventId, input.reportId);
    if (!existing) throw new ReportNotFoundError("That report was not found");
    if (existing.revision !== input.expectedRevision)
      throw new ReportConflictError(existing.revision);
    const next: ReportDefinition = {
      ...existing,
      name,
      description: (input.description ?? existing.description).trim().slice(0, 400),
      dataset: query.dataset,
      query,
      updatedAt: now,
      revision: existing.revision + 1,
    };
    if ((await this.dependencies.repository.update(next, existing.revision)) === 0)
      throw new ReportConflictError(existing.revision);
    return next;
  }

  /** Duplicate keeps the question and takes a new name, so an experiment cannot clobber a saved one. */
  async duplicate(actor: Actor | null, eventId: string, reportId: string, name: string) {
    const existing = await this.requireReport(actor, eventId, reportId);
    return this.save(actor, eventId, {
      name,
      description: existing.description,
      dataset: existing.dataset,
      fields: existing.query.fields,
      filters: existing.query.filters.map(({ field, operator, value }) => ({
        field,
        operator,
        ...(value === undefined ? {} : { value }),
      })),
      ...(existing.query.groupBy ? { groupBy: existing.query.groupBy } : {}),
      ...(existing.query.sort ? { sort: existing.query.sort } : {}),
      limit: existing.query.limit,
    });
  }

  async remove(actor: Actor | null, eventId: string, reportId: string, expectedRevision: number) {
    this.authorize(actor, eventId);
    if ((await this.dependencies.repository.remove(eventId, reportId, expectedRevision)) === 0) {
      const existing = await this.dependencies.repository.find(eventId, reportId);
      if (!existing) throw new ReportNotFoundError("That report was not found");
      throw new ReportConflictError(existing.revision);
    }
  }

  private async requireReport(actor: Actor | null, eventId: string, reportId: string) {
    this.authorize(actor, eventId);
    const report = await this.dependencies.repository.find(eventId, reportId);
    if (!report) throw new ReportNotFoundError("That report was not found");
    return report;
  }

  /**
   * Run a saved report, or an ad-hoc query, for this caller.
   *
   * Answers a `SourceOutcome`-shaped result rather than throwing when a dataset's owning domain
   * refuses: a reviewer opening a report over the CRM is being told "not yours", which is the
   * authorization model working rather than a failure.
   */
  async run(
    actor: Actor | null,
    eventId: string,
    input: {
      reportId?: string | undefined;
      dataset?: string | undefined;
      fields?: readonly string[] | undefined;
      filters?:
        | readonly { field: string; operator: string; value?: string | undefined }[]
        | undefined;
      groupBy?: string | undefined;
      sort?: { field: string; direction: string } | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
      includePii?: boolean | undefined;
    },
  ): Promise<
    | {
        readonly state: "ok";
        readonly report: ReportDefinition | null;
        readonly result: ReportResult;
      }
    | { readonly state: "unauthorized"; readonly report: ReportDefinition | null }
    | { readonly state: "failed"; readonly reason: unknown }
  > {
    const authorized = this.authorize(actor, eventId);
    const report = input.reportId ? await this.requireReport(actor, eventId, input.reportId) : null;
    const query = report
      ? {
          ...report.query,
          limit: Math.min(input.limit ?? report.query.limit, report.query.limit),
          offset: input.offset ?? 0,
        }
      : validateQuery({ ...input, dataset: input.dataset ?? "" });
    const includePii = this.resolvePii(authorized, eventId, input.includePii ?? false);
    if (includePii)
      // Audited before the rows are read, so an unmasked read that then failed is still a record
      // of somebody having asked.
      await this.dependencies.audit.record({
        organizationId: report?.organizationId ?? "",
        eventId,
        action: "report.pii_read",
        targetType: "report",
        targetId: report?.id ?? query.dataset,
        idempotencyKey: `report-pii:${eventId}:${report?.id ?? query.dataset}:${this.dependencies.now().toISOString()}`,
      });

    const rows = await readReportRows(this.dependencies.sources, query.dataset, actor, eventId);
    if (rows.state === "unauthorized") return { state: "unauthorized", report };
    if (rows.state === "failed") return { state: "failed", reason: rows.reason };
    return { state: "ok", report, result: runQuery(query, rows.value, { includePii }) };
  }

  /**
   * The report as a file.
   *
   * A *format* applied to the run, never a second query — which is what makes "the export goes
   * through the same field-access decision as the screen" true by construction rather than by
   * discipline. `includePii` is refused here exactly as it is on screen, so a scoped role cannot
   * generate a download carrying what its own board withholds.
   */
  async export(
    actor: Actor | null,
    eventId: string,
    input: { reportId: string; format: "csv" | "xlsx" | "json"; includePii?: boolean | undefined },
  ): Promise<
    | {
        readonly state: "ok";
        readonly contentType: string;
        readonly filename: string;
        readonly body: string | Uint8Array;
      }
    | { readonly state: "unauthorized" }
    | { readonly state: "failed"; readonly reason: unknown }
  > {
    const answer = await this.run(actor, eventId, {
      reportId: input.reportId,
      limit: MAX_REPORT_PAGE,
      ...(input.includePii === undefined ? {} : { includePii: input.includePii }),
    });
    if (answer.state !== "ok") return answer;
    const name = (answer.report?.name ?? "report").replaceAll(/[^A-Za-z0-9_-]+/g, "-");
    if (input.format === "json")
      return {
        state: "ok",
        contentType: "application/json; charset=utf-8",
        filename: `${name}.json`,
        body: JSON.stringify({
          // Versioned, so a consumer that stored yesterday's file can tell what it holds.
          schemaVersion: 1,
          report: { name: answer.report?.name ?? "Ad-hoc report", dataset: answer.result.dataset },
          ...answer.result,
        }),
      };
    const renderer = this.dependencies.exports;
    if (!renderer)
      return { state: "failed", reason: new Error("Report export renderer is not configured") };
    if (input.format === "csv")
      return {
        state: "ok",
        contentType: "text/csv; charset=utf-8",
        filename: `${name}.csv`,
        body: renderer.csv(answer.result),
      };
    return {
      state: "ok",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `${name}.xlsx`,
      body: renderer.xlsx(answer.result, answer.report?.name ?? "Report"),
    };
  }

  /*
   * ---- share links -------------------------------------------------------
   */

  async createShare(
    actor: Actor | null,
    eventId: string,
    reportId: string,
    input: {
      lifetimeHours: number;
      viewLimit?: number | undefined;
      password?: string | undefined;
      allowPii?: boolean | undefined;
    },
  ): Promise<{ share: ReportShare; url: string; token: string }> {
    const authorized = this.authorize(actor, eventId);
    const report = await this.requireReport(actor, eventId, reportId);
    const allowPii = this.resolvePii(authorized, eventId, input.allowPii ?? false);
    const lifetime = Math.min(Math.max(input.lifetimeHours, 1), MAX_CAPABILITY_LINK_HOURS);
    const now = this.dependencies.now();
    const { token, tokenHash } = await this.dependencies.mintToken();
    const link: CapabilityLink = {
      id: this.dependencies.newId(),
      kind: "report",
      resourceRef: reportId,
      organizationId: report.organizationId,
      eventId,
      createdBy: authorized.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + lifetime * 3_600_000).toISOString(),
      viewLimit: input.viewLimit ?? null,
      views: 0,
      revokedAt: null,
      hasPassword: Boolean(input.password),
      // The only report-specific part of a link. Fixed at mint time because the person opening
      // it is anonymous and cannot be asked to hold `reports:pii`.
      scope: delegatedScope(authorized, eventId, allowPii),
    };
    const share = shareOf(link);
    await this.dependencies.links.create({
      ...link,
      tokenHash,
      passwordHash: input.password ? await this.dependencies.hash(input.password) : null,
    });
    await this.dependencies.audit.record({
      organizationId: report.organizationId,
      eventId,
      action: allowPii ? "report.shared_with_pii" : "report.shared",
      targetType: "report-share",
      targetId: share.id,
      idempotencyKey: `report-share:${share.id}`,
    });
    // The token is returned once and never again: only its digest is stored, exactly as the
    // itinerary and the invitation do.
    return { share, url: `${this.dependencies.shareBaseUrl}/reports/${token}`, token };
  }

  async listShares(actor: Actor | null, eventId: string, reportId: string) {
    await this.requireReport(actor, eventId, reportId);
    return (await this.dependencies.links.list("report", reportId)).map(shareOf);
  }

  async revokeShare(actor: Actor | null, eventId: string, reportId: string, shareId: string) {
    const report = await this.requireReport(actor, eventId, reportId);
    const changed = await this.dependencies.links.revoke(
      "report",
      reportId,
      shareId,
      this.dependencies.now().toISOString(),
    );
    if (changed > 0)
      await this.dependencies.audit.record({
        organizationId: report.organizationId,
        eventId,
        action: "report.share_revoked",
        targetType: "report-share",
        targetId: shareId,
        idempotencyKey: `report-share-revoked:${shareId}`,
      });
    return changed;
  }

  /**
   * Resolve a share link, spending one of its views.
   *
   * Anonymous. The link is the credential, so every refusal — unknown token, revoked, expired,
   * out of views, wrong password — is one indistinguishable answer, and the view is spent by the
   * same statement that checks liveness so a one-view link cannot be resolved twice.
   *
   * **The share policy decides PII, not the visitor.** A link created without `allowPii` serves
   * masked values however it is asked, which is what makes "redact by default" true of the half
   * of this surface that has no actor at all.
   */
  async resolveShare(
    token: string,
    password?: string,
  ): Promise<{ report: ReportDefinition; result: ReportResult }> {
    // The convention's own spend-and-check, so every consumer refuses identically. It throws
    // `CapabilityLinkUnavailableError`, which this method re-raises as its own type — the caller
    // sees one refusal whatever went wrong, and the transport translates one thing.
    const link = await spendCapabilityLink(this.dependencies.links, this.dependencies.hash, {
      token,
      password,
      now: this.dependencies.now().toISOString(),
    }).catch(() => {
      // ERROR-INTENT: every refusal collapses to one answer on purpose — telling an unknown token
      // from an expired, revoked, spent or wrong-password one would say whether a guess landed.
      throw new ReportShareUnavailableError();
    });
    if (link.kind !== "report") throw new ReportShareUnavailableError();
    const share = shareOf(link);
    const report = await this.dependencies.repository.findById(share.reportId);
    if (!report) throw new ReportShareUnavailableError();
    /*
     * The frozen delegated actor is deliberately narrower than the creator: one event, the
     * capabilities and field policies present when the link was minted, and no actor-wide grant.
     * Every owning domain still authorizes its own read; the capability URL supplies the bounded
     * authority an anonymous request otherwise cannot carry.
     */
    const reader = delegatedActor(link);
    if (!reader) throw new ReportShareUnavailableError();
    const rows = await readReportRows(
      this.dependencies.sources,
      report.dataset,
      reader,
      report.eventId,
    );
    if (rows.state !== "ok") throw new ReportShareUnavailableError();
    return {
      report,
      result: runQuery(report.query, rows.value, { includePii: share.allowPii }),
    };
  }

  /*
   * ---- schedules ---------------------------------------------------------
   */

  async createSchedule(
    actor: Actor | null,
    eventId: string,
    reportId: string,
    input: {
      cadence: "daily" | "weekly" | "monthly";
      minuteOfDay: number;
      dayOfWeek?: number | undefined;
      dayOfMonth?: number | undefined;
      timezone: string;
      recipients: readonly string[];
      linkLifetimeHours?: number | undefined;
    },
  ): Promise<ReportSchedule> {
    const authorized = this.authorize(actor, eventId);
    await this.requireReport(actor, eventId, reportId);
    const recipients = [...new Set(input.recipients.map((value) => value.trim().toLowerCase()))]
      .filter(Boolean)
      .slice(0, MAX_RECIPIENTS);
    if (recipients.length === 0)
      throw new ReportInvalidError("A schedule needs at least one recipient.", {
        recipients: ["A schedule needs at least one recipient."],
      });
    if (input.recipients.length > MAX_RECIPIENTS)
      throw new ReportInvalidError(`A schedule sends to at most ${MAX_RECIPIENTS} addresses.`, {
        recipients: [`A schedule sends to at most ${MAX_RECIPIENTS} addresses.`],
      });
    if (!isKnownTimezone(input.timezone))
      throw new ReportInvalidError("That is not a timezone this deployment can resolve.", {
        timezone: ["Choose a timezone such as Europe/London."],
      });
    const schedule: ReportSchedule = {
      id: this.dependencies.newId(),
      reportId,
      cadence: input.cadence,
      minuteOfDay: Math.min(Math.max(input.minuteOfDay, 0), 1439),
      dayOfWeek: input.cadence === "weekly" ? (input.dayOfWeek ?? 1) : null,
      // Capped at 28 so a monthly schedule fires in February, which is the whole reason the
      // column's CHECK stops there rather than at 31.
      dayOfMonth:
        input.cadence === "monthly" ? Math.min(Math.max(input.dayOfMonth ?? 1, 1), 28) : null,
      timezone: input.timezone,
      recipients,
      linkLifetimeHours: Math.min(Math.max(input.linkLifetimeHours ?? 72, 1), 720),
      createdBy: authorized.id,
      createdAt: this.dependencies.now().toISOString(),
      pausedAt: null,
      lastFiredKey: null,
      scope: delegatedScope(authorized, eventId, false),
    };
    await this.dependencies.repository.createSchedule(schedule);
    return schedule;
  }

  async listSchedules(actor: Actor | null, eventId: string, reportId: string) {
    await this.requireReport(actor, eventId, reportId);
    const schedules = await this.dependencies.repository.listSchedules(reportId);
    return Promise.all(
      schedules.map(async (schedule) => ({
        schedule,
        runs: await this.dependencies.repository.listRuns(schedule.id, 10),
      })),
    );
  }

  async removeSchedule(actor: Actor | null, eventId: string, reportId: string, scheduleId: string) {
    await this.requireReport(actor, eventId, reportId);
    return this.dependencies.repository.removeSchedule(reportId, scheduleId);
  }

  /**
   * One cron tick: fire every schedule whose occurrence has arrived and has not been recorded.
   *
   * The occurrence key is derived from the *wall clock in the schedule's own timezone* rather
   * than from the tick, which is what makes "once per occurrence" true across a retry, a
   * double-scheduled minute, and a DST transition — the key for 09:00 local is the same string
   * however many UTC instants map to it, and `report_runs`' unique index is the arbiter.
   *
   * Never throws. A failing delivery is recorded as `failed` and the next schedule still runs;
   * one broken recipient list must not stop every other report in the deployment.
   */
  async tick(): Promise<{ fired: number; failed: number }> {
    const now = this.dependencies.now();
    let fired = 0;
    let failed = 0;
    for (const schedule of await this.dependencies.repository.listDueSchedules()) {
      const key = occurrenceKey(schedule, now);
      if (!key || key === schedule.lastFiredKey) continue;
      const report = await this.dependencies.repository.findById(schedule.reportId);
      if (!report) continue;
      const runId = this.dependencies.newId();
      const claim = {
        id: runId,
        scheduleId: schedule.id,
        occurrenceKey: key,
        ranAt: now.toISOString(),
        // If the worker disappears, listRuns projects the unmatched durable claim as this
        // truthful failure, while a retry still cannot deliver the occurrence twice.
        outcome: "failed" as const,
        detail: "Delivery did not complete.",
      };
      if (!(await this.dependencies.repository.claimRun(claim, key))) continue;
      let outcome: "delivered" | "failed" = "delivered";
      let detail = "";
      let issuedLinkId: string | null = null;
      try {
        const { token } = await this.dependencies.mintToken();
        const expiresAt = new Date(
          now.getTime() + schedule.linkLifetimeHours * 3_600_000,
        ).toISOString();
        issuedLinkId = this.dependencies.newId();
        await this.dependencies.links.create({
          id: issuedLinkId,
          kind: "report",
          resourceRef: report.id,
          organizationId: report.organizationId,
          eventId: report.eventId,
          createdBy: schedule.createdBy,
          createdAt: now.toISOString(),
          expiresAt,
          viewLimit: null,
          views: 0,
          revokedAt: null,
          hasPassword: false,
          // A scheduled link never carries unmasked personal data. Unmasking is an act somebody
          // performs, and nobody is present when a cron tick fires.
          scope: schedule.scope,
          tokenHash: await this.dependencies.hash(token),
          passwordHash: null,
        });
        await this.dependencies.delivery?.deliver({
          reportName: report.name,
          recipients: schedule.recipients,
          url: `${this.dependencies.shareBaseUrl}/reports/${token}`,
          expiresAt,
        });
      } catch (error) {
        // ERROR-INTENT: recorded as a failed run rather than rethrown — the operational inbox
        // reads these rows, and letting one schedule's failure abort the tick would silently
        // skip every schedule after it.
        outcome = "failed";
        detail = error instanceof Error ? error.message : String(error);
        if (issuedLinkId)
          try {
            await this.dependencies.links.revoke(
              "report",
              report.id,
              issuedLinkId,
              now.toISOString(),
            );
          } catch (revokeError) {
            // ERROR-INTENT: the failed run must still be recorded. Add the cleanup failure to its
            // operator-facing detail so an orphaned capability can be found and revoked by id.
            detail += `; failed to revoke unused link ${issuedLinkId}: ${
              revokeError instanceof Error ? revokeError.message : String(revokeError)
            }`;
          }
      }
      await this.dependencies.repository.recordRun({
        ...claim,
        outcome,
        detail: detail.slice(0, 400),
      });
      if (outcome === "delivered") fired += 1;
      else failed += 1;
    }
    return { fired, failed };
  }
}

/** Does this deployment's `Intl` know the zone? A schedule in an unresolvable zone never fires. */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    // ERROR-INTENT: an unknown zone is the answer, not a fault — `Intl` signals it by throwing.
    return false;
  }
}

/** The wall-clock parts of `instant` in `timezone`, which is what an occurrence is named by. */
export function wallClock(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    weekday: weekdays.indexOf(value("weekday")),
  };
}

/**
 * The occurrence this instant falls in, or null when the schedule is not due.
 *
 * Named by local date rather than by the tick's instant, so a retried tick, a doubled minute and a
 * DST transition all resolve to the same string — and `report_runs`' unique index turns "the same
 * string" into "one delivery". A schedule whose local time has passed within this tick's minute is
 * due; one whose hour and minute have not arrived is not.
 */
export function occurrenceKey(
  schedule: Pick<
    ReportSchedule,
    "cadence" | "minuteOfDay" | "dayOfWeek" | "dayOfMonth" | "timezone"
  >,
  now: Date,
): string | null {
  if (!isKnownTimezone(schedule.timezone)) return null;
  const local = wallClock(now, schedule.timezone);
  const minutes = local.hour * 60 + local.minute;
  if (minutes < schedule.minuteOfDay) return null;
  if (schedule.cadence === "weekly" && local.weekday !== schedule.dayOfWeek) return null;
  if (schedule.cadence === "monthly" && Number(local.day) !== schedule.dayOfMonth) return null;
  return `${schedule.cadence}:${local.year}-${local.month}-${local.day}`;
}

/** Exported so a screen can offer the same default page size the service applies. */
export const REPORT_PAGE_DEFAULT = DEFAULT_REPORT_PAGE;
export { datasetOf };
