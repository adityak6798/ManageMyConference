import type {
  CfpRepository,
  ProposalDraftCreate,
  ProposalOwnerWrite,
  ProposalSubmitWrite,
} from "../../application/cfp/cfp-repository";
import {
  CFP_DRAFT_STATUS,
  type CfpForm,
  type CfpSubmissionWindow,
  type ProposalSubmission,
} from "../../domain/cfp/cfp";
import { changedRows, type D1WriteResult } from "./d1-write-result";
export interface D1CfpDatabasePort {
  prepare(query: string): {
    bind(...values: unknown[]): ReturnType<D1CfpDatabasePort["prepare"]>;
    run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
    all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
  };
}

type FormRow = {
  event_id: string;
  title: string;
  description: string;
  fields_json: string;
  routing_json: string;
  status: CfpForm["status"];
  version: number;
  published_at: string | null;
  published_json: string | null;
  opens_at: string | null;
  closes_at: string | null;
};
type SubmissionRow = {
  id: string;
  event_id: string;
  cfp_version: number;
  idempotency_key: string;
  answers_json: string;
  form_fields_json: string;
  resolved_route_json: string | null;
  submitted_at: string;
  submitter_user_id: string | null;
  lifecycle: "draft" | "submitted";
  revision: number;
  updated_at: string | null;
  status: string;
};

/** Every column a proposal read needs, in one place so the four read paths cannot drift. */
const PROPOSAL_COLUMNS =
  "id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, resolved_route_json, submitted_at, submitter_user_id, lifecycle, revision, COALESCE(updated_at, submitted_at) AS updated_at, status";

/**
 * The call is taking submissions *now*, asked as a correlated subquery.
 *
 * Every proposal write carries it, and it is not a duplicate of the service's own check: the
 * service reads the form and then writes, and an organizer closing the call in between would
 * otherwise land an answer after the deadline it published. The two bound instants are the same
 * value; SQLite has no way to reuse one placeholder twice.
 *
 * The comparison is textual, which is only correct because migration `1201` requires both columns
 * to hold the canonical `toISOString()` shape and `CfpService` normalises through `Date` before
 * writing them.
 */
const OPEN_WINDOW_GUARD =
  "EXISTS (SELECT 1 FROM cfp_forms WHERE cfp_forms.event_id = ? AND json_extract(cfp_forms.published_json, '$.status') = 'open' AND (cfp_forms.opens_at IS NULL OR cfp_forms.opens_at <= ?) AND (cfp_forms.closes_at IS NULL OR cfp_forms.closes_at > ?))";

const submission = (row: SubmissionRow): ProposalSubmission => ({
  id: row.id,
  eventId: row.event_id,
  cfpVersion: row.cfp_version,
  idempotencyKey: row.idempotency_key,
  answers: JSON.parse(row.answers_json),
  fields: JSON.parse(row.form_fields_json),
  resolvedRoute: row.resolved_route_json ? JSON.parse(row.resolved_route_json) : null,
  submittedAt: row.submitted_at,
  submitterUserId: row.submitter_user_id,
  lifecycle: row.lifecycle,
  revision: row.revision,
  updatedAt: row.updated_at ?? row.submitted_at,
  status: row.status,
});

/**
 * The published snapshot as it is stored, with the window fields removed.
 *
 * The window is live state on the row and the snapshot is the form applicants are served. Writing
 * a copy of the window into the snapshot would create a second, silently stale answer to "when
 * does this close" — and the reads below overlay the columns anyway, so the copy could only ever
 * be wrong. See migration `1201`.
 */
const publishedSnapshot = (form: CfpForm) => {
  const { opensAt: _opensAt, closesAt: _closesAt, ...snapshot } = form;
  return JSON.stringify(snapshot);
};

export class D1CfpRepository implements CfpRepository {
  /** The most calls one deadline read will name, kept under D1's 100-parameter ceiling. */
  private static readonly DEADLINE_CHUNK = 90;
  constructor(private readonly database: D1CfpDatabasePort) {}
  async findForm(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, title, description, fields_json, routing_json, status, version, published_at, published_json, opens_at, closes_at FROM cfp_forms WHERE event_id = ? LIMIT 1",
      )
      .bind(eventId)
      .all<FormRow>();
    if (!result.success)
      throw new Error(`D1 failed to find CFP: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row
      ? {
          eventId: row.event_id,
          title: row.title,
          description: row.description,
          fields: JSON.parse(row.fields_json),
          routing: JSON.parse(row.routing_json || "[]"),
          status: row.status,
          version: row.version,
          publishedAt: row.published_at,
          publishedStatus: row.status === "draft" ? null : row.status,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
        }
      : null;
  }
  async findPublished(eventId: string): Promise<CfpForm | null> {
    const result = await this.database
      .prepare(
        "SELECT published_json, opens_at, closes_at FROM cfp_forms WHERE event_id = ? LIMIT 1",
      )
      .bind(eventId)
      .all<{ published_json: string | null; opens_at: string | null; closes_at: string | null }>();
    if (!result.success)
      throw new Error(`D1 failed to find published CFP: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    if (!row?.published_json) return null;
    const snapshot = JSON.parse(row.published_json) as Partial<CfpForm>;
    // A snapshot without its fields silently produces a form nobody can submit, and the
    // failure only surfaces as a 500 deep inside submission. Reject it at the boundary.
    if (!Array.isArray(snapshot.fields))
      throw new Error(
        `Published CFP snapshot for event ${eventId} is missing its fields array; republish the form`,
      );
    // The window is overlaid from the columns, never read from the snapshot — which is why a
    // snapshot written before migration `1201` needs no backfill.
    return { ...snapshot, opensAt: row.opens_at, closesAt: row.closes_at } as CfpForm;
  }
  async saveForm(form: CfpForm, expectedVersion: number) {
    const statement =
      expectedVersion === 0
        ? "INSERT OR IGNORE INTO cfp_forms (event_id, title, description, fields_json, routing_json, status, version, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        : "UPDATE cfp_forms SET title = ?, description = ?, fields_json = ?, routing_json = ?, status = ?, version = ?, published_at = ? WHERE event_id = ? AND version = ?";
    const values =
      expectedVersion === 0
        ? [
            form.eventId,
            form.title,
            form.description,
            JSON.stringify(form.fields),
            JSON.stringify(form.routing ?? []),
            form.status,
            form.version,
            form.publishedAt,
          ]
        : [
            form.title,
            form.description,
            JSON.stringify(form.fields),
            JSON.stringify(form.routing ?? []),
            form.status,
            form.version,
            form.publishedAt,
            form.eventId,
            expectedVersion,
          ];
    const result = await this.database
      .prepare(statement)
      .bind(...values)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save CFP: ${result.error ?? "unknown error"}`);
    return changedRows(result, "save CFP") === 1;
  }
  async savePublished(form: CfpForm, updateEditable: boolean, expectedVersion: number) {
    const result = await this.database
      .prepare(
        "UPDATE cfp_forms SET published_json = ?, title = CASE WHEN ? THEN ? ELSE title END, description = CASE WHEN ? THEN ? ELSE description END, fields_json = CASE WHEN ? THEN ? ELSE fields_json END, routing_json = CASE WHEN ? THEN ? ELSE routing_json END, status = CASE WHEN ? THEN ? ELSE status END, version = CASE WHEN ? THEN ? ELSE version END, published_at = CASE WHEN ? THEN ? ELSE published_at END WHERE event_id = ? AND version = ?",
      )
      .bind(
        publishedSnapshot(form),
        updateEditable,
        form.title,
        updateEditable,
        form.description,
        updateEditable,
        JSON.stringify(form.fields),
        updateEditable,
        JSON.stringify(form.routing ?? []),
        updateEditable,
        form.status,
        updateEditable,
        form.version,
        updateEditable,
        form.publishedAt,
        form.eventId,
        expectedVersion,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to publish CFP: ${result.error ?? "unknown error"}`);
    return changedRows(result, "publish CFP") === 1;
  }
  async saveWindow(eventId: string, window: CfpSubmissionWindow) {
    const result = await this.database
      .prepare("UPDATE cfp_forms SET opens_at = ?, closes_at = ? WHERE event_id = ?")
      .bind(window.opensAt, window.closesAt, eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save the CFP window: ${result.error ?? "unknown error"}`);
    return changedRows(result, "save the CFP window") === 1;
  }
  async findAnonymousSubmission(eventId: string, key: string) {
    const result = await this.database
      .prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM cfp_submissions WHERE event_id = ? AND idempotency_key = ? AND submitter_user_id IS NULL AND lifecycle = 'submitted' LIMIT 1`,
      )
      .bind(eventId, key)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to find submission: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? submission(row) : null;
  }
  async findOwnedProposalByKey(eventId: string, key: string, submitterUserId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM cfp_submissions WHERE event_id = ? AND idempotency_key = ? AND submitter_user_id = ? LIMIT 1`,
      )
      .bind(eventId, key, submitterUserId)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to find an owned proposal: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? submission(row) : null;
  }
  async findSubmissionById(eventId: string, proposalId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM cfp_submissions WHERE event_id = ? AND id = ? AND lifecycle = 'submitted' LIMIT 1`,
      )
      .bind(eventId, proposalId)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to find submission by ID: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? submission(row) : null;
  }
  async findProposalForOwner(eventId: string, proposalId: string, submitterUserId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM cfp_submissions WHERE event_id = ? AND id = ? AND submitter_user_id = ? LIMIT 1`,
      )
      .bind(eventId, proposalId, submitterUserId)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to find an owned proposal: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? submission(row) : null;
  }
  async listProposalsForOwner(eventId: string, submitterUserId: string) {
    const result = await this.database
      .prepare(
        `SELECT ${PROPOSAL_COLUMNS} FROM cfp_submissions WHERE event_id = ? AND submitter_user_id = ? ORDER BY submitted_at, id`,
      )
      .bind(eventId, submitterUserId)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to list owned proposals: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(submission);
  }
  /**
   * The calls closing inside a window, and who still has a draft on each (issue #210).
   *
   * Two reads rather than one join, and the shape is the reason: a call with fifty drafts would
   * come back as fifty rows carrying the same deadline, and the caller wants one message per
   * *account* rather than one per draft. So the deadlines are read first, bounded, and the draft
   * holders are grouped per call in a second statement over exactly those event ids.
   *
   * **`published_json IS NOT NULL` is the "is published" fact, and `published_at` is not.** A call
   * nobody published has no applicants and no deadline anybody has seen, so a message about it
   * would announce something that was never offered — but the column that survives says so is the
   * snapshot, not the timestamp. `CfpService.save` sets `publishedAt: null` on *every* draft save
   * and `saveForm` writes it straight through, so a filter on `published_at` goes blind the first
   * time an organizer edits a published call's description: the scheduler then reports
   * `considered: 0`, which is indistinguishable from "nothing was due", and no draft holder or
   * organizer is ever told about that deadline again. `OPEN_WINDOW_GUARD` above already reads the
   * snapshot for the same reason.
   *
   * The second statement counts **drafts only** — `lifecycle = 'draft'` — so an account that has
   * submitted everything it wrote is absent rather than reminded, which is half of the acceptance
   * this exists for.
   */
  async listDeadlineNotices(window: { from: string; to: string }, limit: number) {
    /*
     * D1 binds at most 100 parameters per statement, and the draft-holder read below binds one per
     * call. The caller's own batch limit is smaller than that today, but it lives in another file
     * and nothing tied the two together — so the ceiling is enforced here, where the statement
     * that would break is. Truncating rather than throwing is right for a scheduler: the calls
     * this drops are still closing, and the next tick reads again.
     */
    const capped = Math.min(limit, D1CfpRepository.DEADLINE_CHUNK);
    const calls = await this.database
      .prepare(
        "SELECT event_id, closes_at FROM cfp_forms WHERE published_json IS NOT NULL AND closes_at IS NOT NULL AND closes_at >= ? AND closes_at < ? ORDER BY closes_at, event_id LIMIT ?",
      )
      .bind(window.from, window.to, capped)
      .all<{ event_id: string; closes_at: string }>();
    if (!calls.success)
      throw new Error(`D1 failed to list closing calls: ${calls.error ?? "unknown error"}`);
    const rows = calls.results ?? [];
    if (rows.length === 0) return [];
    const holders = await this.database
      .prepare(
        `SELECT event_id, submitter_user_id, COUNT(*) AS drafts FROM cfp_submissions WHERE lifecycle = 'draft' AND submitter_user_id IS NOT NULL AND event_id IN (${rows
          .map(() => "?")
          .join(", ")}) GROUP BY event_id, submitter_user_id ORDER BY event_id, submitter_user_id`,
      )
      .bind(...rows.map(({ event_id }) => event_id))
      .all<{ event_id: string; submitter_user_id: string; drafts: number }>();
    if (!holders.success)
      throw new Error(`D1 failed to list draft holders: ${holders.error ?? "unknown error"}`);
    const byEvent = new Map<string, { userId: string; draftCount: number }[]>();
    for (const row of holders.results ?? [])
      byEvent.set(row.event_id, [
        ...(byEvent.get(row.event_id) ?? []),
        { userId: row.submitter_user_id, draftCount: Number(row.drafts) },
      ]);
    return rows.map((row) => ({
      eventId: row.event_id,
      closesAt: row.closes_at,
      draftHolders: byEvent.get(row.event_id) ?? [],
    }));
  }
  async createSubmission(proposal: ProposalSubmission) {
    const result = await this.database
      .prepare(
        `INSERT OR IGNORE INTO cfp_submissions (id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, resolved_route_json, submitted_at, updated_at, status, lifecycle, submitter_user_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ? FROM cfp_forms WHERE event_id = ? AND json_extract(published_json, '$.status') = 'open' AND CAST(json_extract(published_json, '$.version') AS INTEGER) = ? AND (opens_at IS NULL OR opens_at <= ?) AND (closes_at IS NULL OR closes_at > ?)`,
      )
      .bind(
        proposal.id,
        proposal.eventId,
        proposal.cfpVersion,
        proposal.idempotencyKey,
        JSON.stringify(proposal.answers),
        JSON.stringify(proposal.fields),
        proposal.resolvedRoute ? JSON.stringify(proposal.resolvedRoute) : null,
        proposal.submittedAt,
        proposal.updatedAt ?? proposal.submittedAt,
        proposal.resolvedRoute?.status ?? "submitted",
        proposal.submitterUserId ?? null,
        proposal.eventId,
        proposal.cfpVersion,
        proposal.submittedAt,
        proposal.submittedAt,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create submission: ${result.error ?? "unknown error"}`);
    // Converged on an *anonymous, submitted* row, never on whatever else holds that key. An
    // `INSERT OR IGNORE` is skipped for a duplicate key regardless of who owns it, so an unscoped
    // read here is how a guest submission gets answered with somebody's draft.
    return this.findAnonymousSubmission(proposal.eventId, proposal.idempotencyKey);
  }
  async createDraft(draft: ProposalDraftCreate) {
    const result = await this.database
      .prepare(
        `INSERT OR IGNORE INTO cfp_submissions (id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, resolved_route_json, submitted_at, updated_at, status, lifecycle, submitter_user_id, revision) SELECT ?, ?, ?, ?, ?, '[]', NULL, ?, ?, '${CFP_DRAFT_STATUS}', 'draft', ?, 1 WHERE ${OPEN_WINDOW_GUARD}`,
      )
      .bind(
        draft.id,
        draft.eventId,
        draft.cfpVersion,
        draft.idempotencyKey,
        JSON.stringify(draft.answers),
        draft.submittedAt,
        draft.updatedAt ?? draft.submittedAt,
        draft.submitterUserId,
        draft.eventId,
        draft.at,
        draft.at,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create a proposal draft: ${result.error ?? "unknown error"}`);
    // Scoped to this account, so a key another account already holds converges on nothing and the
    // caller is refused rather than handed a stranger's proposal. `CfpService.createDraft` also
    // namespaces the stored key by owner, which is what keeps two accounts from colliding at all.
    return this.findOwnedProposalByKey(draft.eventId, draft.idempotencyKey, draft.submitterUserId);
  }
  async saveProposalAnswers(write: ProposalOwnerWrite) {
    const result = await this.database
      .prepare(
        `UPDATE cfp_submissions SET answers_json = ?, form_fields_json = ?, cfp_version = ?, revision = revision + 1, updated_at = ? WHERE event_id = ? AND id = ? AND submitter_user_id = ? AND revision = ? AND lifecycle = ? AND ${OPEN_WINDOW_GUARD}`,
      )
      .bind(
        JSON.stringify(write.answers),
        // The snapshot moves with the answers. See `ProposalOwnerWrite`: a projection reads an
        // answer by looking its field up here, so answers written against a newer form under an
        // older snapshot read as an empty proposal.
        JSON.stringify(write.fields),
        write.cfpVersion,
        write.updatedAt,
        write.eventId,
        write.proposalId,
        write.submitterUserId,
        write.expectedRevision,
        // Which snapshot is right was decided from a read before this write; naming the lifecycle
        // here is what stops that decision being applied to a row that has since moved on.
        write.lifecycle,
        write.eventId,
        write.at,
        write.at,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save proposal answers: ${result.error ?? "unknown error"}`);
    return changedRows(result, "save proposal answers") === 1;
  }
  async submitProposal(write: ProposalSubmitWrite) {
    const result = await this.database
      .prepare(
        `UPDATE cfp_submissions SET answers_json = ?, form_fields_json = ?, resolved_route_json = ?, cfp_version = ?, status = ?, lifecycle = 'submitted', submitted_at = ?, revision = revision + 1, updated_at = ? WHERE event_id = ? AND id = ? AND submitter_user_id = ? AND revision = ? AND lifecycle = 'draft' AND ${OPEN_WINDOW_GUARD}`,
      )
      .bind(
        JSON.stringify(write.answers),
        JSON.stringify(write.fields),
        write.resolvedRoute ? JSON.stringify(write.resolvedRoute) : null,
        write.cfpVersion,
        write.status,
        write.submittedAt,
        write.updatedAt,
        write.eventId,
        write.proposalId,
        write.submitterUserId,
        write.expectedRevision,
        write.eventId,
        write.at,
        write.at,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to submit a proposal: ${result.error ?? "unknown error"}`);
    return changedRows(result, "submit a proposal") === 1;
  }
}
