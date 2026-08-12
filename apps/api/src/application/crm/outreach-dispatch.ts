/**
 * How the CRM asks for a message to be delivered.
 *
 * CRM owns this interface, not communications, and it holds no import of that domain. Bulk
 * outreach is a CRM command whose delivery is somebody else's job, so the boundary is declared
 * on the side that needs it and bound in the composition root — the same shape the speaker
 * conversion port has, inverted. A CRM that imported the communications service directly would
 * be coupled to its authorization model as well as its data, which is precisely the coupling
 * `ARC-DOM-001` and issue #92 exist to prevent.
 *
 * `prepare` writes nothing. It exists so the preview an organizer approves is resolved by the
 * same code path that will send, rather than by a client-side guess at what would happen.
 *
 * The actor travels with the message because this send is something a person pressed, not a
 * lifecycle event: the delivering domain is entitled to re-check its own capability rather than
 * take the CRM's word for it. An implementation that does not need one is free to ignore it.
 *
 * @spec PRD-CRM-001 ARC-DOM-001
 */
import type { Actor } from "../identity/actor";

export interface OutreachMessage {
  readonly organizationId: string;
  readonly eventId: string;
  /** Deterministic, so re-sending a campaign to the same contact converges on one delivery. */
  readonly idempotencyKey: string;
  readonly templateKey: string;
  readonly templateVersion?: number | undefined;
  readonly recipientRef: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * `send` raises `OutreachRejectedError` when the message cannot be delivered as described — an
 * unknown template, or a request the dispatcher considers incoherent. That is a CRM error class
 * on purpose: converting the delivering domain's exceptions belongs to the adapter that binds
 * this port, so nothing in the CRM has to know what those exceptions are.
 *
 * There is deliberately no `prepare`. The preview an organizer approves resolves recipients and
 * checks authorization, and stops there, because the only delivery entry point available today
 * writes: a preview bound to it would queue the very messages it claims to be previewing. When
 * communications publishes a resolve-without-writing call, the preview can also confirm the
 * template — until then it does not pretend to.
 */
export interface OutreachDispatchPort {
  send(actor: Actor, message: OutreachMessage): Promise<{ readonly deliveryId: string }>;
}
