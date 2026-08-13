/**
 * The unified audit timeline.
 *
 * Nine domains change things and each one already tells somebody: review notifies a reviewer,
 * content notifies a speaker, the agenda announces a publication. What none of them could do was
 * put those facts in one ordered list, because there was nowhere platform-owned to put them and
 * no shape they agreed on. This is that shape and that place.
 *
 * **Two ways to write, for two situations**, copied from communications' proven pattern for the
 * same reason it exists there:
 *
 * - `record(...)` writes the record itself. Right for anything that follows a change that is
 *   already durable — an acceptance, an assignment, a decision — where losing the record is bad
 *   but failing the request that already succeeded is worse. It therefore **never throws**; it
 *   reports and returns.
 * - `prepare(...)` resolves and identifies a record and writes nothing. Right when the record
 *   must commit *with* the fact that caused it: a schedule publication and the audit row saying
 *   who published it have to survive or fail together, or a crash between the two statements
 *   leaves a published schedule nobody can account for. The caller renders it through a
 *   `PreparedAuditWriter` and appends the statements to a batch it already had — so the SQL and
 *   the column names stay in platform's adapter and the caller never learns either.
 *
 * The idempotency key is derived from the *fact*, never from the attempt, which is what makes a
 * replayed command produce one record. Storage enforces it rather than trusting this service:
 * `UNIQUE(organization_id, idempotency_key)`.
 *
 * @spec PRD-OPS-003 ARC-DOM-001
 */
import { type Actor, CapabilityDeniedError, hasEventRoleCapability } from "../identity/actor";
import { requireEventCapability } from "../identity/actor";

/**
 * Who or what performed the action.
 *
 * `human` and `system` are the only two anything produces today — a request that resolved a
 * session, and a consequence with no request behind it. `api` and `agent` are declared because
 * the vocabulary is what other lanes will record against, and a reader must be able to tell a
 * person from a program; nothing in this repository writes either yet, and the surface says so.
 */
export type AuditSource = "human" | "api" | "agent" | "system";

export interface AuditRecordInput {
  readonly organizationId: string;
  readonly eventId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** Derived from the fact, never from the attempt. Unique within the organization. */
  readonly idempotencyKey: string;
  /** Overrides the request's own actor. Used only where the writer knows better. */
  readonly actor?: {
    readonly id: string | null;
    readonly name: string;
    readonly source: AuditSource;
  };
  readonly occurredAt?: string;
}

export interface AuditRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly source: AuditSource;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string | null;
  readonly idempotencyKey: string;
}

/**
 * A record resolved and identified but **not yet written**, for a caller that must commit it
 * inside its own durable batch.
 *
 * Treat it as opaque: it is exactly the row platform will write, and the only supported thing to
 * do with it is hand it to a `PreparedAuditWriter`.
 */
export type PreparedAuditRecord = AuditRecord;

/**
 * Renders a prepared record into a caller's own storage statements.
 *
 * Generic in the statement type so this application module stays free of any database's types:
 * the composition root binds it to the concrete one and hands the bound writer to whatever needs
 * it.
 */
export type PreparedAuditWriter<TStatement> = (
  prepared: PreparedAuditRecord,
) => readonly TStatement[];

export interface AuditPage {
  readonly records: readonly AuditRecord[];
  readonly nextCursor: string | null;
}

export interface AuditRecordStore {
  /**
   * Appends one record, answering whether this call wrote it.
   *
   * A key that is already present is a no-op rather than a second row, and `false` rather than a
   * failure — a replayed command converging is the intended behaviour, not an error.
   */
  append(record: AuditRecord): Promise<boolean>;
  page(
    eventId: string,
    page: { limit: number; before?: { occurredAt: string; id: string } },
  ): Promise<{ items: readonly AuditRecord[]; hasMore: boolean }>;
}

/**
 * Whose request this is, for the length of one request.
 *
 * The Worker constructs every service inside `fetch`, so one of these exists per invocation and
 * two concurrent requests cannot see each other's. It is a mutable holder rather than a
 * parameter because the writers that need it — the lifecycle ports the composition root binds —
 * are called from deep inside domains that have no business being told about auditing.
 */
export interface RequestIdentity {
  set(identity: { actor: Actor | null; correlationId: string | null }): void;
  actor(): Actor | null;
  correlationId(): string | null;
}

export function createRequestIdentity(): RequestIdentity {
  let current: { actor: Actor | null; correlationId: string | null } = {
    actor: null,
    correlationId: null,
  };
  return {
    set(identity) {
      current = identity;
    },
    actor: () => current.actor,
    correlationId: () => current.correlationId,
  };
}

export interface AuditRecorderDependencies {
  readonly store: AuditRecordStore;
  readonly identity: RequestIdentity;
  readonly newId: () => string;
  readonly now: () => Date;
  /**
   * Where a failed append goes.
   *
   * `record` never throws, so this is the only way a lost record is visible. It is required
   * rather than optional for exactly that reason.
   */
  readonly report: (error: unknown, context: Record<string, unknown>) => void;
}

/** Bounded because an unbounded page is how one request becomes the most expensive in the product. */
export const AUDIT_PAGE_LIMIT_MAX = 50;

/**
 * The idempotency key for a lifecycle fact.
 *
 * Lives here rather than in the composition root because it is a rule, not wiring, and a rule
 * nothing can test is a rule that drifts. The uniqueness constraint behind it is
 * `(organization_id, idempotency_key)`, so the **event** has to be in the key: several targets a
 * domain reports are only unique within an event — a reviewer's round number, a proposal id — and
 * an event-less key silently dropped the second event's record on an organization running two
 * conferences, with no log line, because a converged replay and a lost record look identical to
 * `ON CONFLICT DO NOTHING`.
 *
 * `occurrence` is for a fact that can genuinely happen again to the same target. A decision that
 * is reversed and then reinstated is three things that happened; without it the third re-derives
 * the first's key and never reaches the log.
 */
export function lifecycleAuditKey(entry: {
  readonly action: string;
  readonly eventId: string;
  readonly targetId: string;
  readonly occurrence?: string | undefined;
}): string {
  return [
    "audit",
    entry.action,
    entry.eventId,
    entry.targetId,
    ...(entry.occurrence ? [entry.occurrence] : []),
  ].join(":");
}

export class AuditRecorder {
  constructor(private readonly dependencies: AuditRecorderDependencies) {}

  /**
   * Resolve and identify a record without writing it.
   *
   * The actor comes from the request unless the caller names one. A record with no request
   * behind it is `system` and carries a null id — a cron tick has no identity, and inventing one
   * would put a name on the timeline that never did anything.
   */
  prepare(input: AuditRecordInput): PreparedAuditRecord {
    const actor = this.dependencies.identity.actor();
    const attribution = input.actor ?? {
      id: actor?.id ?? null,
      name: actor?.name ?? "System",
      source: (actor ? "human" : "system") satisfies AuditSource,
    };
    return {
      id: this.dependencies.newId(),
      organizationId: input.organizationId,
      eventId: input.eventId,
      occurredAt: input.occurredAt ?? this.dependencies.now().toISOString(),
      actorId: attribution.id,
      actorName: attribution.name,
      source: attribution.source,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      correlationId: this.dependencies.identity.correlationId(),
      idempotencyKey: input.idempotencyKey,
    };
  }

  /**
   * Write a record for a change that has already committed.
   *
   * **Never throws.** Every caller is a lifecycle consequence, and failing there would report a
   * failure for work that succeeded — the same reasoning `SpeakerNotificationPort` documents.
   * A lost record is reported through `report` with everything needed to reconstruct it by hand.
   */
  async record(input: AuditRecordInput): Promise<void> {
    const prepared = this.prepare(input);
    try {
      await this.dependencies.store.append(prepared);
    } catch (error) {
      // ERROR-INTENT: reported rather than raised — the change this describes is already durable,
      // and failing it now would undo nothing and report a failure for work that succeeded.
      this.dependencies.report(error, {
        eventId: prepared.eventId,
        action: prepared.action,
        targetId: prepared.targetId,
        idempotencyKey: prepared.idempotencyKey,
      });
    }
  }

  /**
   * The timeline for one event, newest first.
   *
   * Gated on `events:settings:read`: the log names who did what to an event, which is the
   * organizer's own administrative view of it rather than something every role on the event may
   * read. The page is bounded and the cursor is `(occurred_at, id)`, so two records written in
   * the same millisecond still page deterministically.
   */
  async timeline(
    actor: Actor | null,
    eventId: string,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<AuditPage> {
    const authorized = requireEventCapability(actor, eventId, "events:settings:read");
    // The role is part of the predicate, not just the capability. Publishing's own check for the
    // same capability does this and cites `ARC-AUTH-001` for why: a capability held through some
    // other role on the event would otherwise open the administrative log, and this is the
    // surface where that mistake would be least visible.
    if (!hasEventRoleCapability(authorized, eventId, "organizer", "events:settings:read"))
      throw new CapabilityDeniedError("The activity timeline is an organizer view of this event");
    const limit = Math.min(Math.max(1, page.limit), AUDIT_PAGE_LIMIT_MAX);
    const before = page.cursor ? decodeCursor(page.cursor) : undefined;
    const result = await this.dependencies.store.page(eventId, {
      limit,
      ...(before ? { before } : {}),
    });
    const last = result.items.at(-1);
    return {
      records: result.items,
      nextCursor: result.hasMore && last ? `${last.occurredAt}~${last.id}` : null,
    };
  }
}

/** The cursor is two opaque halves the caller got from us; an unusable one starts from the top. */
function decodeCursor(cursor: string): { occurredAt: string; id: string } | undefined {
  const separator = cursor.indexOf("~");
  if (separator <= 0) return undefined;
  const occurredAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  return id ? { occurredAt, id } : undefined;
}
