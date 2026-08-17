/*
 * The attendee's own itinerary: starring sessions, keeping them across a reload, and
 * taking them away as calendar data.
 *
 * Two things are worth knowing before reading the hook.
 *
 * 1. **The token is the identity.** It is minted by the server on the first star, kept in
 *    `localStorage` against the event's id, and put in the request path. Nothing here
 *    reads a session, because `/api/public/*` has none to read — see `api/itinerary.ts`.
 * 2. **The starred set is optimistic and the server is the referee.** A star updates the
 *    screen immediately and saves in the background; the server answers with the list it
 *    actually stored, filtered to sessions the published projection still names, and that
 *    answer replaces the local one. So a session withdrawn since the last visit quietly
 *    leaves the itinerary rather than lingering as a link to a page that is gone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createItinerary, readItinerary, saveItinerary } from "../api/itinerary";
import { IconStar } from "../ui/icons";
import type { PublicSession } from "./model";

/*
 * Namespaced per event, by the event's **id** rather than its slug.
 *
 * One browser can hold an itinerary for each conference it visits, and the key has to
 * outlive a rename: the public slug is editable (see the publishing settings form in this
 * same change), so keying on it meant that the first time an organizer changed their public
 * address, every attendee's browser started looking under a key nothing had written and
 * their itinerary silently vanished — while the row it addressed was still perfectly
 * readable through its token.
 */
const tokenKey = (eventId: string) => `greenroom:itinerary:${eventId}`;

/**
 * `localStorage` throws rather than returning null in a partitioned or blocked context —
 * Safari's private mode, an embed in a third-party frame with storage access denied. An
 * attendee who cannot persist should still be able to star sessions for this visit, so
 * every access degrades to memory instead of taking the page down.
 */
function readToken(eventId: string): string | null {
  try {
    return window.localStorage.getItem(tokenKey(eventId));
  } catch {
    // ERROR-INTENT: storage is unavailable; the itinerary stays in memory for this visit.
    return null;
  }
}

/** Whether the token was actually persisted; false means this visit only. */
function writeToken(eventId: string, token: string): boolean {
  try {
    window.localStorage.setItem(tokenKey(eventId), token);
    return true;
  } catch {
    // ERROR-INTENT: as above — storage is unavailable, and the itinerary still works for
    // this visit. Reported rather than swallowed so the caller could say so if it wanted.
    return false;
  }
}

export interface ItineraryState {
  readonly slugs: readonly string[];
  readonly has: (slug: string) => boolean;
  readonly toggle: (slug: string) => void;
  readonly shareUrl: string | null;
  readonly failure: string | null;
  readonly ready: boolean;
}

/**
 * The starred set for one event.
 *
 * `adopted` guards against a slow save landing after a newer one: every write stamps a
 * generation, and a response from an older generation is discarded rather than resurrecting
 * a set the attendee has already moved past.
 */
export function useItinerary(eventSlug: string, eventId: string, enabled: boolean): ItineraryState {
  const [slugs, setSlugs] = useState<readonly string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  /** The in-flight mint, so concurrent first-stars join one rather than each making a row. */
  const minting = useRef<Promise<Awaited<ReturnType<typeof createItinerary>>> | null>(null);
  /*
   * Writes are serialised through this tail.
   *
   * Each save replaces the whole stored list, so two in flight at once are decided by which
   * response the server happens to handle last rather than by the order the attendee
   * starred. The generation counter below only stops a stale *response* being adopted
   * locally — it cannot stop a stale *request* landing last and overwriting storage, which
   * shows up as a star that survives on screen and is missing after a reload.
   */
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!enabled || !eventId || !eventSlug) return;
    /*
     * A `?plan=` link wins over whatever this browser already had, and is adopted into
     * storage so the next visit needs no link. That is what makes the share URL work as a
     * hand-off to a second device rather than as a read-only view: the itinerary has no
     * owner, so possession of the link is the whole of the claim to it.
     */
    const shared = new URLSearchParams(window.location.search).get("plan");
    const stored = shared || readToken(eventId);
    if (shared) writeToken(eventId, shared);
    setToken(stored);
    if (!stored) {
      setReady(true);
      return;
    }
    let live = true;
    const mine = ++generation.current;
    // ERROR-INTENT: effects cannot await; both outcomes are rendered below.
    void readItinerary(stored)
      .then((itinerary) => {
        if (!live || generation.current !== mine) return;
        setSlugs(itinerary.sessionSlugs);
        setReady(true);
      })
      .catch(() => {
        // ERROR-INTENT: a token for an event that has since been unpublished, or one the
        // server no longer knows, is indistinguishable by design. Start a fresh itinerary
        // rather than stranding the attendee on a dead one.
        if (!live || generation.current !== mine) return;
        setToken(null);
        setSlugs([]);
        setReady(true);
      });
    return () => {
      live = false;
    };
  }, [enabled, eventId, eventSlug]);

  const persist = useCallback(
    async (next: readonly string[]) => {
      const mine = ++generation.current;
      try {
        /*
         * Minting is guarded by a ref rather than by `token`, because `token` is state and
         * will still read null for a second star fired before the first mint resolves.
         * Two mints would leave an orphaned itinerary behind and move the browser onto the
         * second one — no visible data loss, since each mint sends the whole list, but a
         * row nobody can reach and a token that silently stopped being the live one.
         */
        let saved: Awaited<ReturnType<typeof saveItinerary>>;
        if (token) {
          saved = await saveItinerary(token, next);
        } else {
          // Whether *this* call is the one that started the mint. The creator's list is
          // exactly what the mint was sent, so it needs no second request; only a star that
          // joined an in-flight mint has to save, because it is not in that list.
          let creator = false;
          if (!minting.current) {
            creator = true;
            minting.current = createItinerary(eventSlug, next).then((created) => {
              writeToken(eventId, created.token);
              setToken(created.token);
              return created;
            });
          }
          const minted = await minting.current;
          saved = creator ? minted.itinerary : await saveItinerary(minted.token, next);
        }
        if (generation.current !== mine) return;
        setSlugs(saved.sessionSlugs);
        setFailure(null);
      } catch {
        // ERROR-INTENT: the star stays on screen for this visit and the message says the
        // saving failed, which is the honest split — reverting would lose a choice the
        // attendee made over a failure that is usually transient. The failed mint is
        // cleared so the next star can start an itinerary rather than joining a rejected
        // promise forever.
        minting.current = null;
        if (generation.current !== mine) return;
        setFailure("Your itinerary could not be saved, so it will not survive a reload.");
      }
    },
    [eventId, eventSlug, token],
  );

  const toggle = useCallback(
    (slug: string) => {
      setSlugs((current) => {
        const next = current.includes(slug)
          ? current.filter((candidate) => candidate !== slug)
          : [...current, slug];
        // Queued behind whatever is already in flight, so the last request to reach storage
        // is the last selection the attendee made. ERROR-INTENT: state updaters cannot
        // await, and `persist` renders both of its outcomes; the tail is reset to a resolved
        // promise either way so one failure cannot wedge every later write.
        writes.current = writes.current.then(
          () => persist(next),
          () => persist(next),
        );
        return next;
      });
    },
    [persist],
  );

  return {
    slugs,
    has: (slug: string) => slugs.includes(slug),
    toggle,
    shareUrl: token
      ? new URL(`/itineraries/${encodeURIComponent(token)}`, window.location.origin).toString()
      : null,
    failure,
    ready,
  };
}

/* --------------------------- calendar export --------------------------- */

/** RFC 5545 escaping: commas, semicolons and backslashes are separators in a property. */
const escapeText = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");

const stamp = (iso: string) => `${iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;

/**
 * Fold a content line to 75 octets, as RFC 5545 requires.
 *
 * Skipping this is the usual reason a generated `.ics` imports everywhere except the one
 * calendar the attendee actually uses: a long SUMMARY or DESCRIPTION silently truncates.
 */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  /*
   * Measured in UTF-8 octets and split on whole characters. The spec counts octets, so a
   * title in any non-Latin script exceeds the limit long before its `.length` does; and
   * slicing by UTF-16 code unit can land between the halves of a surrogate pair, which
   * turns an emoji or a rarer CJK character into two replacement characters in the file
   * the attendee imports. Continuation lines carry a leading space and so may hold 74.
   */
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const width = encoder.encode(character).length;
    // The first line may fill 75; every continuation spends one octet on its own space.
    const limit = parts.length === 0 ? 75 : 74;
    if (octets + width > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += character;
    octets += width;
  }
  if (current) parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
}

/**
 * The itinerary as an iCalendar document.
 *
 * Only sessions the projection has actually placed become events — an unscheduled session
 * has no start, and an event without one is not a calendar entry any client will accept.
 * `UID` is derived from the event and session slugs so re-importing an updated itinerary
 * updates the same entries instead of duplicating them.
 */
export function itineraryCalendar(
  eventName: string,
  eventSlug: string,
  sessions: readonly PublicSession[],
  now: string,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greenroom//Attendee itinerary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(eventName)}`,
  ];
  for (const session of sessions) {
    if (!session.startsAt || !session.endsAt) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.slug}.${eventSlug}@greenroom`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(session.startsAt)}`,
      `DTEND:${stamp(session.endsAt)}`,
      `SUMMARY:${escapeText(session.title)}`,
      ...(session.room ? [`LOCATION:${escapeText(session.room)}`] : []),
      ...(session.abstract ? [`DESCRIPTION:${escapeText(session.abstract)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  // CRLF throughout, per the spec — some importers reject a document that uses bare LF.
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** A star, and the only control on a public page that writes anything. */
export function StarButton({
  session,
  itinerary,
}: {
  session: PublicSession;
  itinerary: ItineraryState;
}) {
  const starred = itinerary.has(session.slug);
  return (
    <button
      type="button"
      className={starred ? "pub-star is-on" : "pub-star"}
      aria-pressed={starred}
      // The visible label is a symbol, so the accessible name has to carry both the action
      // and which session it applies to — a grid of forty identical "Add" buttons is not
      // navigable by voice or by a screen reader's control list.
      aria-label={
        starred
          ? `Remove ${session.title} from my itinerary`
          : `Add ${session.title} to my itinerary`
      }
      onClick={() => itinerary.toggle(session.slug)}
    >
      {/*
        One shape, two states: the outline is the offer and the fill is the answer, and the fill
        is painted by CSS from `is-on` rather than by a second glyph. The star used to be a
        font-rendered ★/☆ at 22px, which rendered differently on every platform and whose hollow
        state read as a disabled control on a card full of live links.
      */}
      <IconStar />
    </button>
  );
}
