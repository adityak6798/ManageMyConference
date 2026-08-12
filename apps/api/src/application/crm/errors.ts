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

/* The organization-wide directory. */

export class ContactNotFoundError extends Error {}
export class SegmentNotFoundError extends Error {}

/**
 * A second live contact already holds this address in this organization. Refused as a named
 * field rather than left to the partial unique index, so the organizer is told to merge rather
 * than shown a 500 — the directory's whole point is that a person appears once.
 */
export class ContactEmailTakenError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("A contact with this email already exists in this organization");
  }
}

export class SegmentNameTakenError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("A segment with this name already exists in this organization");
  }
}

/**
 * The merge as asked for is not performable: the primary is one of the duplicates, a named
 * record belongs to another organization or has already been merged away. Refused whole, because
 * a partially applied merge is the one outcome that loses history.
 */
export class ContactMergeInvalidError extends Error {}

/** The uploaded file cannot be read as a contact sheet at all — no header, wrong columns. */
export class ContactImportInvalidError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("The contact file could not be read");
  }
}

/**
 * Two sourcings of one contact into one event raced, and this is the loser.
 *
 * The service checks for an existing link first, but that check and the write are not one
 * operation, so a double-submitted "Add to event" reaches the primary key. A conflict the
 * caller can understand — and retrying reads the link the winner wrote — rather than a fault.
 */
export class ContactAlreadySourcedError extends Error {}

/** Outreach that would send to nobody: an empty segment, or ids that match no live contact. */
export class OutreachRecipientsEmptyError extends Error {}

/**
 * The dispatcher refused the message as described — an unknown template key, or a delivery
 * request it considers incoherent.
 *
 * CRM's own error rather than the delivering domain's, because the CRM must not import that
 * domain's error classes to translate them. The composition root binds the port and converts
 * whatever the dispatcher raises into this, which is what keeps `OutreachDispatchPort` a
 * boundary rather than a re-export.
 */
export class OutreachRejectedError extends Error {}

/**
 * The named event is not part of the named organization. Its own refusal rather than a plain
 * denial: it is the boundary that keeps an organization-wide grant from reaching sideways into
 * another organization's event, so it should be legible in a log as exactly that.
 */
export class EventOutsideOrganizationError extends Error {}
