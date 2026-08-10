import type {
  ProposalStatus,
  ProposalStatusAudit,
  SubmittedProposal,
  SubmittedProposalInterface,
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
  organization_id: string;
  event_id: string;
  title: string;
  abstract: string;
  submitter_name: string;
  status: ProposalStatus;
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
const proposal = (row: ProposalRow): SubmittedProposal => ({
  id: row.id,
  organizationId: row.organization_id,
  eventId: row.event_id,
  title: row.title,
  abstract: row.abstract,
  submitterName: row.submitter_name,
  status: row.status,
});
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
        `SELECT id, organization_id, event_id, title, abstract, submitter_name, status FROM cfp_submissions WHERE event_id = ?${status ? " AND status = ?" : ""} ORDER BY title`,
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
        "SELECT id, organization_id, event_id, title, abstract, submitter_name, status FROM cfp_submissions WHERE event_id = ? AND id = ? LIMIT 1",
      )
      .bind(eventId, proposalId)
      .all<ProposalRow>();
    if (!result.success)
      throw new Error(`D1 failed to find proposal: ${result.error ?? "unknown error"}`);
    return result.results?.[0] ? proposal(result.results[0]) : null;
  }
  async transitionAtomically(
    input: Parameters<SubmittedProposalInterface["transitionAtomically"]>[0],
  ) {
    if (!input.proposalIds.length) return [];
    const current = await Promise.all(input.proposalIds.map((id) => this.find(input.eventId, id)));
    if (current.some((item) => !item)) throw new Error("Atomic proposal transition failed");
    const statements = (current as SubmittedProposal[]).flatMap((item, index) => [
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
    const results = await this.database.batch(statements);
    if (results.some((result) => !result.success))
      throw new Error("Atomic proposal transition failed");
    return (current as SubmittedProposal[]).map((item) => ({ ...item, status: input.toStatus }));
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
