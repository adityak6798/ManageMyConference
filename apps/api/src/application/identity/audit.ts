/**
 * The identity-access audit vocabulary.
 *
 * An audit row exists so that a question asked afterwards — "who ended my session?", "who added
 * this person to my organization?", "was that demo persona refused?" — has an answer that is not
 * a log line in a retention window. It is a durable record, which is why every writer in this
 * domain batches the row with the state change it describes: an audit row cannot claim something
 * that did not happen, and a state change cannot happen unaudited.
 *
 * Two things are deliberately *not* here.
 *
 * A credential never reaches an audit row. No `id_token`, no `code_verifier`, no `state_proof`,
 * no session token, no cookie value. `detail` carries the shape of an action and never the
 * secret that authorized it.
 *
 * The Google callback's refusals are not audited, and that is a decision rather than an
 * omission. A refused sign-in has no state change to batch a row with, and a best-effort write
 * that fails would either turn a refusal into a 500 or be silently dropped — a record that is
 * durable only when nothing goes wrong is not a record. Those refusals stay in the structured
 * log (`auth.google.refused`), which is what `docs/architecture/authorization.md` and `ADR-005`
 * say and where an operator should look for them.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */

/**
 * The closed vocabulary, matching the CHECK constraint in `1002_identity_audit_events.sql`.
 * Extending it is a SQLite table rebuild, so both halves are declared for the identity lane as
 * a whole rather than per pull request.
 */
export type AuditAction =
  | "session.issued"
  | "session.signed_out"
  | "session.revoked_all"
  | "membership.invited"
  | "membership.invitation_revoked"
  | "membership.accepted"
  | "membership.removed"
  | "membership.role_changed"
  | "event_role.granted"
  | "event_role.revoked"
  | "api_client.created"
  | "api_client.rotated"
  | "api_client.revoked";

/** A refusal is recorded as such; it is the row an operator most often goes looking for. */
export type AuditOutcome = "succeeded" | "refused";

/**
 * What kind of caller acted. Issue #99's cross-domain timeline also carries `agent`;
 * identity-access has no agent-initiated action, so this domain's column admits the three that
 * occur.
 */
export type AuditSource = "human" | "api" | "system";

/**
 * The part of an audit row that comes from the request rather than from the action.
 *
 * `actorUserId` is null when nothing authenticated — a refusal recorded before an actor
 * resolved is still a refusal worth keeping.
 */
export interface AuditContext {
  correlationId: string;
  actorUserId: string | null;
  source: AuditSource;
}

/** The part of an audit row that comes from the action. */
export interface AuditEntry {
  action: AuditAction;
  outcome: AuditOutcome;
  occurredAt: number;
  subjectUserId?: string;
  organizationId?: string;
  eventId?: string;
  /** Serialized as JSON. The shape of the action only — never a credential. */
  detail?: Record<string, unknown>;
}
