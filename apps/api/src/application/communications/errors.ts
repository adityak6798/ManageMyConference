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

/** The delivery exists but its current state does not permit the requested transition. */
export class CommunicationsConflictError extends Error {}
