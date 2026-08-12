/**
 * The agenda domain's public application interface.
 *
 * Everything another domain is allowed to know about the programme's shape in time. Nothing
 * outside `apps/api/src/application/agenda` and the agenda repositories reads `agenda_drafts`
 * or `agenda_publications`.
 */
import type { PlacedSessionTime } from "../../domain/agenda/agenda";
import type { Actor } from "../identity/actor";

export {
  AgendaConflictError,
  AgendaNotFoundError,
  AgendaPublicationConflictError,
  AgendaResourceInUseError,
  AgendaService,
} from "./agenda-service";
export type { SchedulePublishedEvent } from "../../domain/agenda/agenda";
export type { PublicSchedule } from "./agenda-repository";
export type { PlacedSessionTime as SessionSchedule } from "../../domain/agenda/agenda";

/**
 * What the content domain may ask the agenda about a session content owns.
 *
 * The speaker portal and the `.ics` export are built on this, because a session's time is a
 * fact about its placement rather than a column of its own. `AgendaService` implements it.
 */
export interface ContentAgendaInterface {
  /**
   * The published schedule in force, keyed by session id.
   *
   * The *published* snapshot, never the working draft: a speaker is told a time the organizer
   * has committed to, not one that moves under them as the board is dragged around. A session
   * the snapshot does not place, and every session of an event with no published schedule at
   * all, is absent, which is what "not scheduled yet" means wherever this is read.
   *
   * This is the agenda publication in force *now*, read on every call. It is not the site
   * publication: `/api/public/events/{slug}/schedule` and the event hub serve a projection
   * frozen at the last site publish, so republishing the agenda alone moves what this returns
   * while the public page stays where it was until the organizer publishes the site too
   * (`PRD-PUB-001`). Callers that must match the public programme byte for byte have to read
   * the publishing domain's projection instead of this.
   */
  publishedSessionSchedules(
    eventId: string,
  ): Promise<
    ReadonlyMap<
      string,
      PlacedSessionTime & { readonly revision: number; readonly revisedAt: string }
    >
  >;
  /**
   * Take a session off the board, dropping every draft placement that holds it.
   *
   * Called when content withdraws a session from the programme, so the agenda is never left
   * holding a placement for something that no longer exists. Authorization is the agenda's own:
   * the actor is checked for `agenda:manage` on the event exactly as a direct placement edit is.
   * Published snapshots are immutable by design (`PRD-AGD-001`), so the session leaves the
   * public schedule at the next agenda publication, not before.
   */
  unscheduleSession(actor: Actor | null, eventId: string, sessionId: string): Promise<void>;
}
