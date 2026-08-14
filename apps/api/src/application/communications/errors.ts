/**
 * The typed failures the communications domain raises, in one module so `public.ts` can publish
 * them without importing the service — the same shape CRM uses, and the reason a cross-domain
 * caller can `catch` them without pulling the service's construction into its module graph.
 *
 * @spec PRD-COM-001 PRD-INT-001
 */

/** The request cannot be enqueued as written: unusable channel/trigger pairing, absent template. */
export class CommunicationsInputError extends Error {}

/** The named template key or version does not exist in this organization. */
export class CommunicationsNotFoundError extends Error {}

/**
 * A lifecycle message has no template in this organization **after** provisioning was attempted.
 *
 * Told apart from every other not-found because of what it means rather than what it is. A
 * missing lifecycle template is not transient: it is permanent and total for that organization,
 * and — since `notifyLifecycle` must swallow a failed message rather than fail the committed
 * action that caused it — it looks identical to success from every surface an organizer can see.
 * That was issue #217's real damage. Now that defaults are provisioned on resolution, reaching
 * this is a configuration fault an operator has to be told about, so the composition root
 * recognizes this type and puts it on the event's own timeline.
 *
 * A subclass, so every caller and transport that already answers 404 to a missing template
 * continues to.
 */
export class MessageTemplateMissingError extends CommunicationsNotFoundError {
  constructor(
    readonly organizationId: string,
    readonly templateKey: string,
    readonly templateVersion: number | undefined,
  ) {
    super(
      templateVersion === undefined
        ? `No "${templateKey}" template exists in organization ${organizationId}, and provisioning the defaults did not create one`
        : `Version ${templateVersion} of "${templateKey}" does not exist in organization ${organizationId}`,
    );
  }
}

/**
 * This event has already sent as many messages as it may to one **unverified** address.
 *
 * Issue #132. A guest CFP proposal carries an address a form answer supplied and nobody proved
 * control of, so a hundred guest proposals naming one victim would turn an organizer's decision
 * run into a hundred messages to a stranger. The cap bounds that at `UNVERIFIED_RECIPIENT_CAP`
 * per `(event, address)`.
 *
 * Its own type rather than a conflict, because the caller that catches it wants something
 * specific: the lifecycle path records it on the event's timeline, so an organizer learns their
 * decision message did not go out. **The action that caused it always succeeds** — a proposal is
 * never refused because somebody else mail-bombed that address.
 *
 * No transport translates it, and none needs to: `recipientTrust` is absent from every request
 * schema, so a capped delivery is unreachable over HTTP. Said here rather than left implied,
 * because the obvious reading of a typed error is that some route answers it.
 */
export class UnverifiedRecipientCapError extends Error {
  constructor(
    readonly eventId: string,
    readonly cap: number,
  ) {
    super(
      `This event has already sent ${cap} messages to that address, and it is an address nobody has proved they control. Nothing further will be sent to it for this event.`,
    );
  }
}

/** The delivery exists but its current state does not permit the requested transition. */
export class CommunicationsConflictError extends Error {}
export class WebhookUnavailableError extends Error {}
