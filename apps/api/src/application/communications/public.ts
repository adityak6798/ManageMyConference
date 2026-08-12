/**
 * The communications-integrations domain's public application interface.
 *
 * Everything another domain is allowed to know about outbound delivery. Nothing outside
 * `apps/api/src/application/communications` and the communications repositories writes
 * `communication_deliveries`, `delivery_attempts` or `projection_state` (`PRD-INT-001`).
 *
 * ## Why enqueue takes no actor
 *
 * `CommunicationsService.trigger(actor, …)` is shaped for the organizer POST that created it:
 * it demands an `Actor` holding `communications:manage` in the owning organization. The
 * deliveries this domain exists to send are not organizer POSTs. A speaker welcome follows
 * acceptance, a task reminder follows a cron tick, a schedule confirmation follows publication —
 * two of those three have no request actor at all, and the third's actor holds `review:manage`
 * or `agenda:manage` rather than `communications:manage`. Requiring an actor there would force
 * every caller either to fabricate one or to widen its own operators' capabilities, and a
 * fabricated actor is an authorization check that has stopped meaning anything.
 *
 * So `enqueue` is a **system-trust** surface, and the trust boundary sits one level up: the
 * lifecycle action that calls it has already authorized its own caller. Accepting a proposal
 * checks `review:manage` before it decides anything; the scheduled outbox tick is not a request.
 * `enqueue` is not reachable from the transport — every HTTP path into this domain goes through
 * `CommunicationsService`, which authorizes first and then calls `enqueue` itself — so nothing
 * an unauthenticated request can reach gained a capability by this module existing.
 *
 * What `enqueue` does still enforce is *coherence*: the event must belong to the organization,
 * the template version must exist, and the channel must match the trigger. Those are integrity
 * rules rather than authorization, and a lifecycle caller that gets them wrong should fail
 * loudly rather than write an undeliverable row.
 *
 * @spec PRD-COM-001 PRD-INT-001 ARC-FLOW-002
 */
import type {
  Delivery,
  DeliveryChannel,
  DeliveryState,
  TriggerType,
} from "../../domain/communications/delivery";

export { CommunicationsService } from "./communications-service";
/**
 * The inbound Accelevents registration sync, composed by the transport alongside the service
 * above. Its typed failure is exported with it because the route module translates that failure
 * into a 502 — the registration platform being unreachable is neither our bug nor the caller's
 * mistake, and it must not be reported as either.
 */
export { AccelEventsSyncService, AccelEventsUnavailableError } from "./accelevents-sync";
export {
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
} from "./errors";
export type {
  DeliveryChannel,
  DeliveryState,
  TriggerType,
} from "../../domain/communications/delivery";

/**
 * One delivery a lifecycle event wants sent.
 *
 * `idempotencyKey` is the whole of the duplicate-suppression contract and it is the caller's
 * job to make it deterministic: the key is unique per organization, so `speaker-invite:{eventId}:
 * {profileId}` enqueued twice returns the first delivery rather than sending twice. Re-running
 * acceptance, a retried request, and a cron tick that fires every minute all depend on that.
 */
export interface DeliveryRequest {
  readonly organizationId: string;
  readonly eventId: string;
  /** Deterministic, organization-unique. Re-enqueueing the same key returns the first delivery. */
  readonly idempotencyKey: string;
  readonly triggerType: TriggerType;
  readonly channel: DeliveryChannel;
  /** Who or what receives this: `speaker:{profileId}`, or the projected resource's reference. */
  readonly recipientRef: string;
  /** The snapshot the template renders against. Retained as sent, never re-resolved on retry. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Required for `email`; resolves to the current version unless `templateVersion` pins one. */
  readonly templateKey?: string | undefined;
  readonly templateVersion?: number | undefined;
  /** Required for projection channels; supersedes any lower version for the same resource. */
  readonly projectionVersion?: number | undefined;
}

/**
 * What a caller learns about the delivery it enqueued.
 *
 * Deliberately narrower than the domain's `Delivery`: a lifecycle caller needs to correlate and
 * to report, not to reason about leases, attempt counts or backoff. `state` is `queued` on a
 * fresh enqueue and whatever the original reached when an idempotency key is reused.
 */
export interface EnqueuedDelivery {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly state: DeliveryState;
  /**
   * False when this key already had a delivery and nothing new was written.
   *
   * Worth checking before telling anyone a message is on its way: the enqueue succeeded either
   * way, but only a `created` delivery will actually be sent by the outbox.
   */
  readonly created: boolean;
}

/**
 * A delivery resolved and identified but **not yet written**, for a caller that must commit it
 * inside its own durable batch.
 *
 * Treat it as opaque: it is exactly the row communications will write, and the only supported
 * thing to do with it is hand it to a `PreparedDeliveryWriter`. Its shape is this domain's to
 * change.
 */
export type PreparedDelivery = Delivery;

/**
 * Renders a prepared delivery into a caller's own storage statements.
 *
 * Generic in the statement type so this application module stays free of any database's types:
 * the composition root binds it to the concrete one and hands the bound writer to the domain
 * that needs it. The SQL and the table names stay inside communications' adapter — the caller
 * appends opaque statements to a batch it already had, and never learns a column name.
 */
export type PreparedDeliveryWriter<TStatement> = (
  prepared: PreparedDelivery,
) => readonly TStatement[];

/**
 * The cross-domain enqueue surface. `CommunicationsService` implements it.
 *
 * Throws `CommunicationsInputError` when the request is incoherent (email without a template,
 * projection channel without a version, template channel mismatch, event outside the
 * organization) and `CommunicationsNotFoundError` when a named template version does not exist.
 * Both are caller mistakes; neither is retryable by repeating the same call.
 *
 * Two shapes, because two situations:
 *
 * - `enqueue` writes the delivery itself and returns it. Right for anything that follows a
 *   committed change — acceptance, a task request, a cron tick — where the idempotency key makes
 *   a repeat of the whole action converge on one delivery.
 * - `prepareEnqueue` resolves the template, assigns identity and timestamps, and writes nothing.
 *   Right when the delivery must commit *with* the fact that caused it: `agenda_publications`
 *   and its `EVT-SCHEDULE-PUBLISHED` record have to survive or fail together, or a crash between
 *   two statements leaves a published schedule nobody is ever told about. The caller passes the
 *   result through a `PreparedDeliveryWriter` and appends the statements to its own batch. The
 *   insert takes `ON CONFLICT (organization_id, idempotency_key) DO NOTHING`, so a retried
 *   command still produces exactly one delivery — while a malformed one still fails the batch
 *   rather than vanishing.
 *
 *   Two things a caller of `prepareEnqueue` should know. It returns the **existing** delivery
 *   when one already holds that key, so a retried command ends up referencing the row the first
 *   attempt created rather than an id that will never be written. And if you must be certain
 *   which delivery a durable record refers to, resolve it by idempotency key: two callers
 *   preparing the same key concurrently both see no existing row, and only one insert wins.
 */
export interface CommunicationsEnqueue {
  enqueue(request: DeliveryRequest): Promise<EnqueuedDelivery>;
  prepareEnqueue(request: DeliveryRequest): Promise<PreparedDelivery>;
}
