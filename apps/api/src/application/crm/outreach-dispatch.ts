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
 * Communications publishes exactly this pair, and the composition root binds them to it.
 *
 * No actor travels with the message. That is the delivering domain's published contract for
 * cross-domain callers: the trust boundary sits one level up, in the already-authorized action
 * that decided to send. The CRM authorizes three ways before it gets here — the organization,
 * the event-scoped capability, and that the event belongs to the organization.
 *
 * @spec PRD-CRM-001 ARC-DOM-001
 */
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
 * Both methods raise `OutreachRejectedError` when the message cannot be delivered as described —
 * an unknown template, or a request the dispatcher considers incoherent. That is a CRM error
 * class on purpose: converting the delivering domain's exceptions belongs to the adapter that
 * binds this port, so nothing in the CRM has to know what those exceptions are.
 *
 * `prepare` resolves the template and writes nothing, so an unknown template key is reported on
 * the screen showing what will be sent rather than after the first message is queued.
 */
export interface OutreachDispatchPort {
  prepare(message: OutreachMessage): Promise<void>;
  send(message: OutreachMessage): Promise<OutreachDelivery>;
}

export interface OutreachDelivery {
  readonly deliveryId: string;
  /**
   * False when this idempotency key already had a delivery and nothing new was written.
   *
   * Load-bearing rather than informational: re-sending a campaign converges on the original
   * delivery by design, and reporting that as a fresh send told the organizer a message had
   * been queued that had not, and appended a second "Sent" entry for one message.
   */
  readonly created: boolean;
}
