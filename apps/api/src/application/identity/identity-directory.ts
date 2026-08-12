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
   * The people holding a speaker role on one event, with the address each can be reached at.
   *
   * Communications needs this to send to an event's speakers without reading `event_roles`,
   * `users` or content's `speaker_profiles`. `email` is null for a speaker whose identity has no
   * address linked — a real state in demo data and for a speaker provisioned before login — and
   * the caller is expected to report them as unreachable rather than fabricate an address.
   */
  listSpeakersForEvent(
    eventId: string,
  ): Promise<readonly { id: string; name: string; email: string | null }[]>;
  /**
   * The staff of one event — its organizers and reviewers, each listed once. This is the
   * authority on who may be assigned ownership of that event's work; callers must not read
   * `event_roles` or `users` themselves.
   */
  listAssignableOwnersForEvent(eventId: string): Promise<readonly AssignableOwner[]>;
  grantOrganizer(eventId: string, userId: string): Promise<void>;
  provisionSpeaker(userId: string, name: string, eventId: string): Promise<void>;
}
