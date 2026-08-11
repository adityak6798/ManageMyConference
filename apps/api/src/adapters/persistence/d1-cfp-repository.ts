import type { CfpRepository } from "../../application/cfp/cfp-repository";
import type { CfpForm, ProposalSubmission } from "../../domain/cfp/cfp";
export interface D1CfpDatabasePort {
  prepare(query: string): {
    bind(...values: unknown[]): ReturnType<D1CfpDatabasePort["prepare"]>;
    run<T = unknown>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
    all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
  };
}

type FormRow = {
  event_id: string;
  title: string;
  description: string;
  fields_json: string;
  status: CfpForm["status"];
  version: number;
  published_at: string | null;
  published_json: string | null;
};
type SubmissionRow = {
  id: string;
  event_id: string;
  cfp_version: number;
  idempotency_key: string;
  answers_json: string;
  form_fields_json: string;
  submitted_at: string;
};
export class D1CfpRepository implements CfpRepository {
  constructor(private readonly database: D1CfpDatabasePort) {}
  async findForm(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, title, description, fields_json, status, version, published_at, published_json FROM cfp_forms WHERE event_id = ? LIMIT 1",
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
          status: row.status,
          version: row.version,
          publishedAt: row.published_at,
          publishedStatus: row.status === "draft" ? null : row.status,
        }
      : null;
  }
  async findPublished(eventId: string): Promise<CfpForm | null> {
    const result = await this.database
      .prepare("SELECT published_json FROM cfp_forms WHERE event_id = ? LIMIT 1")
      .bind(eventId)
      .all<{ published_json: string | null }>();
    if (!result.success)
      throw new Error(`D1 failed to find published CFP: ${result.error ?? "unknown error"}`);
    const value = result.results?.[0]?.published_json;
    if (!value) return null;
    const snapshot = JSON.parse(value) as Partial<CfpForm>;
    // A snapshot without its fields silently produces a form nobody can submit, and the
    // failure only surfaces as a 500 deep inside submission. Reject it at the boundary.
    if (!Array.isArray(snapshot.fields))
      throw new Error(
        `Published CFP snapshot for event ${eventId} is missing its fields array; republish the form`,
      );
    return snapshot as CfpForm;
  }
  async saveForm(form: CfpForm) {
    const result = await this.database
      .prepare(
        "INSERT INTO cfp_forms (event_id, title, description, fields_json, status, version, published_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET title=excluded.title, description=excluded.description, fields_json=excluded.fields_json, status=excluded.status, version=excluded.version, published_at=excluded.published_at",
      )
      .bind(
        form.eventId,
        form.title,
        form.description,
        JSON.stringify(form.fields),
        form.status,
        form.version,
        form.publishedAt,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save CFP: ${result.error ?? "unknown error"}`);
  }
  async savePublished(form: CfpForm, updateEditable: boolean): Promise<void> {
    const result = await this.database
      .prepare(
        "UPDATE cfp_forms SET published_json = ?, title = CASE WHEN ? THEN ? ELSE title END, description = CASE WHEN ? THEN ? ELSE description END, fields_json = CASE WHEN ? THEN ? ELSE fields_json END, status = CASE WHEN ? THEN ? ELSE status END, version = CASE WHEN ? THEN ? ELSE version END, published_at = CASE WHEN ? THEN ? ELSE published_at END WHERE event_id = ?",
      )
      .bind(
        JSON.stringify(form),
        updateEditable,
        form.title,
        updateEditable,
        form.description,
        updateEditable,
        JSON.stringify(form.fields),
        updateEditable,
        form.status,
        updateEditable,
        form.version,
        updateEditable,
        form.publishedAt,
        form.eventId,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to publish CFP: ${result.error ?? "unknown error"}`);
  }
  async findSubmission(eventId: string, key: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, submitted_at FROM cfp_submissions WHERE event_id = ? AND idempotency_key = ? LIMIT 1",
      )
      .bind(eventId, key)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to find submission: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row
      ? {
          id: row.id,
          eventId: row.event_id,
          cfpVersion: row.cfp_version,
          idempotencyKey: row.idempotency_key,
          answers: JSON.parse(row.answers_json),
          fields: JSON.parse(row.form_fields_json),
          submittedAt: row.submitted_at,
        }
      : null;
  }
  async findSubmissionById(eventId: string, proposalId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, submitted_at FROM cfp_submissions WHERE event_id = ? AND id = ? LIMIT 1",
      )
      .bind(eventId, proposalId)
      .all<SubmissionRow>();
    if (!result.success)
      throw new Error(`D1 failed to find submission by ID: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row
      ? {
          id: row.id,
          eventId: row.event_id,
          cfpVersion: row.cfp_version,
          idempotencyKey: row.idempotency_key,
          answers: JSON.parse(row.answers_json),
          fields: JSON.parse(row.form_fields_json),
          submittedAt: row.submitted_at,
        }
      : null;
  }
  async createSubmission(submission: ProposalSubmission) {
    const result = await this.database
      .prepare(
        "INSERT OR IGNORE INTO cfp_submissions (id, event_id, cfp_version, idempotency_key, answers_json, form_fields_json, submitted_at) SELECT ?, ?, ?, ?, ?, ?, ? FROM cfp_forms WHERE event_id = ? AND json_extract(published_json, '$.status') = 'open' AND CAST(json_extract(published_json, '$.version') AS INTEGER) = ?",
      )
      .bind(
        submission.id,
        submission.eventId,
        submission.cfpVersion,
        submission.idempotencyKey,
        JSON.stringify(submission.answers),
        JSON.stringify(submission.fields),
        submission.submittedAt,
        submission.eventId,
        submission.cfpVersion,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create submission: ${result.error ?? "unknown error"}`);
    return this.findSubmission(submission.eventId, submission.idempotencyKey);
  }
}
