export class ProspectNotFoundError extends Error {}
export class ProspectContactRequiredError extends Error {}
export class ProspectAlreadyConvertedError extends Error {}

/**
 * The requested owner is not on the identity directory's list of users assignable on this event:
 * unknown, or eligible only on another event. A caller's input problem, never a server fault, so
 * it carries the field errors the transport renders next to the owner control instead of letting
 * the `crm_prospects.owner_id` foreign key surface as a 500.
 */
export class ProspectOwnerNotEligibleError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("Prospect owner is not assignable on this event");
  }
}
