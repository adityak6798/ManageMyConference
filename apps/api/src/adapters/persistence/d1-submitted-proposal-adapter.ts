import {
  MASKED_SUBMITTER_NAME,
  ProposalStatusConfigurationError,
  type ProposalStatus,
  type ProposalStatusAudit,
  type ProposalSubmitter,
  type SubmittedProposal,
  type SubmittedProposalInterface,
} from "../../application/cfp/submitted-proposal-interface";
interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T>(): Promise<D1Result<T>>;
}
export interface D1ProposalDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

type ProposalRow = {
  id: string;
  event_id: string;
  answers_json: string;
  form_fields_json: string;
  status: ProposalStatus;
};
type SnapshotField = {
  id: string;
  type: "short_text" | "long_text" | "email" | "select";
  label: string;
};
type AuditRow = {
  id: string;
  event_id: string;
  proposal_id: string;
  from_status: ProposalStatus;
  to_status: ProposalStatus;
  actor_id: string;
  occurred_at: string;
};
type StatusRow = { key: string; label: string; sort_order: number };
/**
 * Field ids and labels that name a person rather than the proposal. The submitter's name is not
 * a field *type* the CFP builder offers, so it is recognised by identity — an explicit id first,
 * then a labelled text field — and never guessed from arbitrary prose.
 */
const NAME_FIELD_IDS = ["name", "full_name", "fullname", "speaker_name", "submitter_name"];
/**
 * Deliberately anchored. A loose `/name/i` would also claim "Session name" or "Track name" and
 * hide the proposal's own title from the review queue.
 */
const PERSON_NAME_LABEL = /^(?:your |speaker |submitter |presenter |contact |full )?name$/i;
const isNameField = (field: SnapshotField) =>
  NAME_FIELD_IDS.includes(field.id.toLowerCase()) ||
  (field.type === "short_text" && PERSON_NAME_LABEL.test(field.label.trim()));

/**
 * The submitter, read out of the stored answers using the published form's own field types.
 *
 * The email comes from the first `email`-typed field that carries a value, which is what makes
 * the contact address available to organizers without ever putting it in `answers`. Without one
 * there is no submitter at all: a name with no address cannot identify a speaker.
 */
const submitterOf = (
  fields: readonly SnapshotField[],
  answers: Record<string, string>,
): ProposalSubmitter | null => {
  const email = fields
    .filter((field) => field.type === "email")
    .map((field) => answers[field.id]?.trim())
    .find((value): value is string => Boolean(value));
  if (!email) return null;
  const name = fields
    .filter(isNameField)
    .map((field) => answers[field.id]?.trim())
    .find((value): value is string => Boolean(value));
  // A form that never asked for a name still identifies its submitter by address, which is
  // more honest than inventing one out of the local part.
  return { name: name ?? email, email };
};

const proposal = (row: ProposalRow): SubmittedProposal => {
  const answers = JSON.parse(row.answers_json) as Record<string, string>;
  const snapshot = JSON.parse(row.form_fields_json) as SnapshotField[];
  const fields = snapshot.length
    ? snapshot
    : Object.keys(answers).map((id) => ({
        id,
        label: id.replaceAll("_", " "),
        type: (id.includes("email")
          ? "email"
          : id === "title" || NAME_FIELD_IDS.includes(id.toLowerCase())
            ? "short_text"
            : "long_text") as "email" | "short_text" | "long_text",
      }));
  const visibleAnswers = fields.flatMap((field) => {
    const value = answers[field.id]?.trim();
    return value && field.type !== "email" && !isNameField(field)
      ? [{ fieldId: field.id, label: field.label, type: field.type, value }]
      : [];
  });
  const title =
    visibleAnswers.find(({ fieldId }) => fieldId === "title") ??
    visibleAnswers.find(({ type }) => type === "short_text" || type === "select");
  const abstract =
    visibleAnswers.find(({ fieldId }) => fieldId === "abstract") ??
    visibleAnswers.find(({ type, fieldId }) => type === "long_text" && fieldId !== title?.fieldId);
  const submitter = submitterOf(fields, answers);
  return {
    id: row.id,
    eventId: row.event_id,
    title: title?.value || `Proposal ${row.id}`,
    abstract: abstract?.value || "See submitted answers.",
    submitterName: submitter?.name ?? MASKED_SUBMITTER_NAME,
    submitter,
    answers: visibleAnswers,
    status: row.status,
  };
};
const audit = (row: AuditRow): ProposalStatusAudit => ({
  id: row.id,
  eventId: row.event_id,
  proposalId: row.proposal_id,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  actorId: row.actor_id,
  occurredAt: row.occurred_at,
});

// @spec PRD-ABS-001
export class D1SubmittedProposalAdapter implements SubmittedProposalInterface {
  constructor(private readonly database: D1ProposalDatabasePort) {}
  async list(eventId: string, status?: ProposalStatus) {
    const result = await this.database
      .prepare(
        `SELECT id, event_id, answers_json, form_fields_json, status FROM cfp_submissions WHERE event_id = ?${status ? " AND status = ?" : ""} ORDER BY submitted_at, id`,
      )
      .bind(eventId, ...(status ? [status] : []))
      .all<ProposalRow>();
    if (!result.success)
      throw new Error(`D1 failed to list proposals: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(proposal);
  }
  async find(eventId: string, proposalId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, answers_json, form_fields_json, status FROM cfp_submissions WHERE event_id = ? AND id = ? LIMIT 1",
      )
      .bind(eventId, proposalId)
      .all<ProposalRow>();
    if (!result.success)
      throw new Error(`D1 failed to find proposal: ${result.error ?? "unknown error"}`);
    return result.results?.[0] ? proposal(result.results[0]) : null;
  }
  async findMany(eventId: string, proposalIds: readonly string[]) {
    if (!proposalIds.length) return [];
    const placeholders = proposalIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(
        `SELECT id, event_id, answers_json, form_fields_json, status FROM cfp_submissions WHERE event_id = ? AND id IN (${placeholders}) ORDER BY submitted_at, id`,
      )
      .bind(eventId, ...proposalIds)
      .all<ProposalRow>();
    if (!result.success)
      throw new Error(`D1 failed to find proposals: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(proposal);
  }
  async listStatuses(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT key, label, sort_order FROM cfp_statuses WHERE event_id = ? ORDER BY sort_order, key",
      )
      .bind(eventId)
      .all<StatusRow>();
    if (!result.success)
      throw new Error(`D1 failed to list proposal statuses: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map((row) => ({
      key: row.key,
      label: row.label,
      sortOrder: row.sort_order,
    }));
  }
  async saveStatuses(
    eventId: string,
    statuses: readonly { key: string; label: string; sortOrder: number }[],
  ) {
    const placeholders = statuses.map(() => "?").join(", ");
    let results: D1Result<unknown>[];
    try {
      results = await this.database.batch([
        ...statuses.map((status) =>
          this.database
            .prepare(
              "INSERT INTO cfp_statuses (event_id, key, label, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT(event_id, key) DO UPDATE SET label = excluded.label, sort_order = excluded.sort_order",
            )
            .bind(eventId, status.key, status.label, status.sortOrder),
        ),
        this.database
          .prepare(`DELETE FROM cfp_statuses WHERE event_id = ? AND key NOT IN (${placeholders})`)
          .bind(eventId, ...statuses.map(({ key }) => key)),
      ]);
    } catch (error) {
      if (String(error).includes("CFP_STATUS_IN_USE"))
        throw new ProposalStatusConfigurationError(
          "Configured statuses must include every status currently in use",
        );
      throw error;
    }
    if (results.some(({ error }) => error?.includes("CFP_STATUS_IN_USE")))
      throw new ProposalStatusConfigurationError(
        "Configured statuses must include every status currently in use",
      );
    if (results.some((result) => !result.success))
      throw new Error("D1 failed to save proposal statuses");
  }
  async transitionAtomically(
    input: Parameters<SubmittedProposalInterface["transitionAtomically"]>[0],
  ) {
    if (!input.proposalIds.length) return [];
    if (!(await this.listStatuses(input.eventId)).some(({ key }) => key === input.toStatus))
      throw new ProposalStatusConfigurationError("Choose a configured proposal status");
    const current = await this.findMany(input.eventId, input.proposalIds);
    if (current.length !== input.proposalIds.length)
      throw new Error("Atomic proposal transition failed");
    const statements = current.flatMap((item, index) => [
      this.database
        .prepare(
          "INSERT INTO cfp_status_audit (id, event_id, proposal_id, from_status, to_status, actor_id, occurred_at) SELECT ?, event_id, id, status, ?, ?, ? FROM cfp_submissions WHERE event_id = ? AND id = ?",
        )
        .bind(
          input.auditIds[index],
          input.toStatus,
          input.actorId,
          input.occurredAt,
          input.eventId,
          item.id,
        ),
      this.database
        .prepare("UPDATE cfp_submissions SET status = ? WHERE event_id = ? AND id = ?")
        .bind(input.toStatus, input.eventId, item.id),
    ]);
    let results: D1Result<unknown>[];
    try {
      results = await this.database.batch(statements);
    } catch (error) {
      if (String(error).includes("CFP_STATUS_NOT_CONFIGURED"))
        throw new ProposalStatusConfigurationError("Choose a configured proposal status");
      throw error;
    }
    if (results.some(({ error }) => error?.includes("CFP_STATUS_NOT_CONFIGURED")))
      throw new ProposalStatusConfigurationError("Choose a configured proposal status");
    if (results.some((result) => !result.success))
      throw new Error("Atomic proposal transition failed");
    return current.map((item) => ({ ...item, status: input.toStatus }));
  }
  async listAudit(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, proposal_id, from_status, to_status, actor_id, occurred_at FROM cfp_status_audit WHERE event_id = ? ORDER BY occurred_at DESC",
      )
      .bind(eventId)
      .all<AuditRow>();
    if (!result.success)
      throw new Error(`D1 failed to list proposal audit: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(audit);
  }
}
