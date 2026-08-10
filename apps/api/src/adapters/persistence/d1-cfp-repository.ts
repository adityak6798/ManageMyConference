import type { CfpRepository } from "../../application/cfp/cfp-repository";
import type { CfpForm, ProposalSubmission } from "../../domain/cfp/cfp";
interface D1DatabasePort {
  prepare(query: string): {
    bind(...values: unknown[]): ReturnType<D1DatabasePort["prepare"]>;
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
};
type SubmissionRow = {
  id: string;
  event_id: string;
  cfp_version: number;
  idempotency_key: string;
  answers_json: string;
  submitted_at: string;
};
export class D1CfpRepository implements CfpRepository {
  constructor(private readonly database: D1DatabasePort) {}
  async findForm(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT event_id, title, description, fields_json, status, version, published_at FROM cfp_forms WHERE event_id = ? LIMIT 1",
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
        }
      : null;
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
  async findSubmission(eventId: string, key: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, cfp_version, idempotency_key, answers_json, submitted_at FROM cfp_submissions WHERE event_id = ? AND idempotency_key = ? LIMIT 1",
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
          submittedAt: row.submitted_at,
        }
      : null;
  }
  async createSubmission(submission: ProposalSubmission) {
    const result = await this.database
      .prepare(
        "INSERT OR IGNORE INTO cfp_submissions (id, event_id, cfp_version, idempotency_key, answers_json, submitted_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        submission.id,
        submission.eventId,
        submission.cfpVersion,
        submission.idempotencyKey,
        JSON.stringify(submission.answers),
        submission.submittedAt,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create submission: ${result.error ?? "unknown error"}`);
    return (await this.findSubmission(submission.eventId, submission.idempotencyKey)) ?? submission;
  }
}
