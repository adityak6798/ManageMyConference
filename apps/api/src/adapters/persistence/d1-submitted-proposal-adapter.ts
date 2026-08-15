import {
  MASKED_SUBMITTER_NAME,
  type ProposalStatus,
  type ProposalStatusAudit,
  ProposalStatusConfigurationError,
  type ProposalSubmitter,
  type SubmittedProposal,
  type SubmittedProposalInterface,
} from "../../application/cfp/submitted-proposal-interface";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
  /**
   * What the driver says the statement touched.
   *
   * Optional here because most reads never look at it; a *write* whose correctness depends on it
   * goes through `changedRows`, which refuses a missing count rather than guessing. The contract
   * is the repository's rather than this adapter's — see `d1-write-result.ts` (#133, then #202).
   */
  meta?: { changes?: number };
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
  participants_json: string;
  track_id: string | null;
  format_id: string | null;
  form_fields_json: string;
  status: ProposalStatus;
  submitter_user_id: string | null;
};
type SnapshotField = {
  id: string;
  type: "short_text" | "long_text" | "email" | "select";
  label: string;
  choices?: readonly { id: string; label: string; active: boolean }[];
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
 * Field ids that name a person and nothing else. The submitter's name is not a field *type* the
 * CFP builder offers, so it is recognised by identity and never guessed from arbitrary prose.
 * `name` is deliberately absent: see `AMBIGUOUS_NAME_FIELD_ID`.
 */
const PERSON_NAME_FIELD_IDS = ["full_name", "fullname", "speaker_name", "submitter_name"];
/**
 * The one id a label may overrule. `name` is as ordinary an id for a field labelled "Session
 * name" as for the applicant's own name, so it alone defers to a label that says the field
 * names something other than a person.
 */
const AMBIGUOUS_NAME_FIELD_ID = "name";
/** Every id that identifies a name field, used when a submission has no stored form snapshot. */
const NAME_FIELD_IDS = [AMBIGUOUS_NAME_FIELD_ID, ...PERSON_NAME_FIELD_IDS];
/**
 * Deliberately anchored: a person's name, and nothing that merely contains the word. Qualifiers
 * stack ("Your full name") because organizers write labels, not identifiers.
 */
const PERSON_NAME_LABEL =
  /^(?:(?:your|speaker|submitter|presenter|contact|full|preferred|first|last)\s+)*names?$/i;
/**
 * A label that names the proposal, the event, or an organization rather than a person — the
 * only thing that overrules `AMBIGUOUS_NAME_FIELD_ID`.
 */
const OBJECT_NAME_LABEL =
  /\b(?:session|talk|proposal|abstract|title|track|workshop|event|room|project|product|company|organisation|organization|team)(?:['’]s)?\s+names?\b/i;
/**
 * Is this field the submitter's own name, and therefore organizer-only?
 *
 * A label that names a person always wins, and an id that can only be a person's name is
 * trusted whatever the label says — an id rule that a loose label check could veto was how
 * `{id: "speaker_name", label: "Speaker's name"}` leaked an applicant's name into the reviewer
 * queue. Only the ambiguous bare `name` id defers, and only to a label that explicitly names
 * something else, so `{id: "name", label: "Session name"}` stays visible.
 */
const isNameField = (field: SnapshotField) => {
  const label = field.label.trim();
  if (PERSON_NAME_LABEL.test(label)) return true;
  if (PERSON_NAME_FIELD_IDS.includes(field.id.toLowerCase())) return true;
  return field.id.toLowerCase() === AMBIGUOUS_NAME_FIELD_ID && !OBJECT_NAME_LABEL.test(label);
};

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
  const fields: SnapshotField[] = snapshot.length
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
    const displayed = field.choices?.find(({ id }) => id === value)?.label ?? value;
    return value && field.type !== "email" && !isNameField(field)
      ? [{ fieldId: field.id, label: field.label, type: field.type, value: displayed ?? value }]
      : [];
  });
  const title =
    visibleAnswers.find(({ fieldId }) => fieldId === "title") ??
    visibleAnswers.find(({ type }) => type === "short_text" || type === "select");
  const abstract =
    visibleAnswers.find(({ fieldId }) => fieldId === "abstract") ??
    visibleAnswers.find(({ type, fieldId }) => type === "long_text" && fieldId !== title?.fieldId);
  // A track is a real CFP classification only when the published form declares the reserved
  // `track` select field. A free-text answer that happens to be labelled "Track" is display data,
  // not a stable vocabulary review may silently distribute against.
  const track = visibleAnswers.find(
    ({ fieldId, type }) => fieldId.trim().toLowerCase() === "track" && type === "select",
  )?.value;
  const choiceLabel = (fieldId: "track" | "format", choiceId: string | null) =>
    fields
      .find(({ id }) => id.trim().toLowerCase() === fieldId)
      ?.choices?.find(({ id }) => id === choiceId)?.label ?? null;
  const submitter = submitterOf(fields, answers);
  return {
    id: row.id,
    eventId: row.event_id,
    title: title?.value || `Proposal ${row.id}`,
    abstract: abstract?.value || "See submitted answers.",
    ...(row.track_id ? { trackId: row.track_id } : {}),
    ...(row.format_id
      ? {
          formatId: row.format_id,
          formatLabel: choiceLabel("format", row.format_id) ?? row.format_id,
        }
      : {}),
    ...(row.participants_json && row.participants_json !== "[]"
      ? { participants: JSON.parse(row.participants_json) }
      : {}),
    ...(row.track_id
      ? { track: choiceLabel("track", row.track_id) ?? row.track_id }
      : track
        ? { track }
        : {}),
    submitterName: submitter?.name ?? MASKED_SUBMITTER_NAME,
    submitter,
    submitterUserId: row.submitter_user_id,
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

/**
 * The predicate that keeps an unsubmitted draft out of every organizer and reviewer projection.
 *
 * It is on **every** read and write below rather than on the two that seemed to need it. A proposal
 * a submitter is still writing has no place in triage, in a reviewer's queue, in a status count or
 * in an accept/decline — and the failure of forgetting one is silent: the draft simply appears,
 * looking like a submission nobody sent (`GAP-025`'s lesson about siblings).
 *
 * Two things assert it, because one of them is not enough. `d1-cfp-account-binding.integration.test.ts`
 * drives each of these paths against a real draft and proves it is invisible; and
 * `cfp-draft-isolation.test.ts` reads *this file* and fails if any statement naming
 * `cfp_submissions` omits the predicate — which is the half that catches a fifth path added later,
 * since a hand-written enumeration cannot.
 *
 * A draft additionally carries `status = 'cfp:draft'`, a value no configured triage status can
 * equal because `proposalStatusSchema` forbids the colon, so a status-filtered read could not reach
 * one even without this. Both are deliberate; migration `1201` says why.
 */
const SUBMITTED_ONLY = "lifecycle = 'submitted'";

// @spec PRD-ABS-001
export class D1SubmittedProposalAdapter implements SubmittedProposalInterface {
  constructor(private readonly database: D1ProposalDatabasePort) {}
  async list(eventId: string, status?: ProposalStatus) {
    const result = await this.database
      .prepare(
        `SELECT id, event_id, answers_json, participants_json, track_id, format_id, form_fields_json, status, submitter_user_id FROM cfp_submissions WHERE event_id = ? AND ${SUBMITTED_ONLY}${status ? " AND status = ?" : ""} ORDER BY submitted_at, id`,
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
        `SELECT id, event_id, answers_json, participants_json, track_id, format_id, form_fields_json, status, submitter_user_id FROM cfp_submissions WHERE event_id = ? AND id = ? AND ${SUBMITTED_ONLY} LIMIT 1`,
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
        `SELECT id, event_id, answers_json, participants_json, track_id, format_id, form_fields_json, status, submitter_user_id FROM cfp_submissions WHERE event_id = ? AND id IN (${placeholders}) AND ${SUBMITTED_ONLY} ORDER BY submitted_at, id`,
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
          `INSERT INTO cfp_status_audit (id, event_id, proposal_id, from_status, to_status, actor_id, occurred_at) SELECT ?, event_id, id, status, ?, ?, ? FROM cfp_submissions WHERE event_id = ? AND id = ? AND ${SUBMITTED_ONLY}`,
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
        .prepare(
          `UPDATE cfp_submissions SET status = ? WHERE event_id = ? AND id = ? AND ${SUBMITTED_ONLY}`,
        )
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
    /*
     * The affected-row count, on the same reading `d1-content-repository.ts` applies (#202).
     *
     * This method answers with `current` rewritten to the new status — objects it constructed,
     * not rows it read back — so a statement that matched nothing would report every proposal
     * transitioned and every audit row written. Both statements are conditional on
     * `WHERE event_id = ? AND id = ?`, and both were built from a read that happened before the
     * batch, so the gap is real even though nothing in the product deletes a submission: the
     * `INSERT … SELECT` writes no audit row when its subject is not there, and a transition
     * whose audit trail is missing is precisely the claim this domain must not make.
     *
     * **Be exact about what this refuses, because it is the report rather than the write.** The
     * batch has already returned by the time this runs, so D1 has committed it — unlike every
     * other throw in this method, which fires on a batch D1 rolled back. What is refused is the
     * *answer*: over several proposals, one whose row vanished in the read-to-batch gap leaves
     * the others durably transitioned, and this refuses to hand back a list claiming all of them
     * moved.
     *
     * **A retry does not heal it, and an earlier draft of this comment said it did.** Two things
     * stop it. `ReviewService.decide` and this method both re-read the proposals and refuse a
     * missing one *before* the batch, so the same request answers "Proposal not found" rather
     * than reaching the write. And `cfp_status_audit` carries no uniqueness beyond its own
     * primary key while every call mints fresh `auditIds`, so a retry that did run would append
     * a second audit row for one transition rather than converging on the first. This is
     * therefore a report an operator has to act on, not a transient to retry, which is what the
     * message says. Reachability is near zero — nothing in the product deletes a submission —
     * and the alternative to refusing is answering with a list that claims a transition that did
     * not happen, which is the whole of what #202 is about.
     */
    const changes = results.map((result, index) =>
      changedRows(
        result as D1WriteResult,
        index % 2 === 0 ? "record a proposal status audit row" : "transition a proposal",
      ),
    );
    if (changes.some((count) => count === 0))
      throw new Error(
        "A proposal in this transition matched no submission. The batch has committed, so the " +
          "other proposals moved; this needs checking rather than retrying, because the retry " +
          "refuses on the missing proposal before reaching the write.",
      );
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
