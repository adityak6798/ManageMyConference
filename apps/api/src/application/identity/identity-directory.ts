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
   * The people holding an **organizer** role on one event, with the address each can be reached
   * at.
   *
   * The counterpart of `listSpeakersForEvent`, and it exists for one caller: the scheduled notice
   * that a call for proposals has closed (issue #210) has to reach the people who run the event,
   * and had no way to learn who they are without reading `event_roles` and `identity_emails`.
   *
   * Deliberately narrower than `listAssignableOwnersForEvent`, which includes reviewers: a
   * reviewer does not need to be told the call closed, and that method carries no address anyway
   * because its result is projected into an API response. `email` is null when identity holds
   * none, exactly as the speaker list reports it. Addressing only — appearing here grants nothing.
   */
  listOrganizersForEvent(
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
  /**
   * One user's display name and the address they can be reached at, by id.
   *
   * The single-user counterpart of `listSpeakersForEvent`, added because a lifecycle message to
   * one named person — a reviewer who has just been given abstracts — otherwise had no way to
   * learn an address without reading `users` or `identity_emails`. Deliberately *not* folded
   * into `listReviewersForEvent`, whose result is projected into the review workspace response:
   * widening that would put every reviewer's address into an API payload as a side effect of
   * wanting one address on the server.
   *
   * `email` is null when identity holds no address for this user, exactly as
   * `listSpeakersForEvent` reports it. Null for a user who does not exist. Addressing only —
   * appearing here grants nothing.
   */
  findRecipient(userId: string): Promise<{ id: string; name: string; email: string | null } | null>;
}
