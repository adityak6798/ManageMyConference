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

/** The delivery exists but its current state does not permit the requested transition. */
export class CommunicationsConflictError extends Error {}
export class WebhookUnavailableError extends Error {}
