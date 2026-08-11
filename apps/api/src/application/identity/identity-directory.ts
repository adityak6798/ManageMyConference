import type { Actor } from "./actor";
import type { DemoPersona } from "./demo-session";

/**
 * A user another domain may name as the owner of event-scoped work.
 *
 * Appearing here is an addressing fact, never a grant: a reviewer listed for an event still
 * holds no `crm:manage` capability on it, and a user listed for one event is absent from every
 * other event's list.
 */
export interface AssignableOwner {
  readonly id: string;
  readonly name: string;
}

// @spec PRD-IAM-001 PRD-IAM-002
export interface IdentityDirectory {
  findByPersona(persona: DemoPersona): Promise<Actor | null>;
  isReviewerForEvent(userId: string, eventId: string): Promise<boolean>;
  isSpeakerForEvent(userId: string, eventId: string): Promise<boolean>;
  listReviewersForEvent(eventId: string): Promise<readonly { id: string; name: string }[]>;
  /**
   * The staff of one event — its organizers and reviewers, each listed once. This is the
   * authority on who may be assigned ownership of that event's work; callers must not read
   * `event_roles` or `users` themselves.
   */
  listAssignableOwnersForEvent(eventId: string): Promise<readonly AssignableOwner[]>;
  grantOrganizer(eventId: string, userId: string): Promise<void>;
  provisionSpeaker(userId: string, name: string, eventId: string): Promise<void>;
}
