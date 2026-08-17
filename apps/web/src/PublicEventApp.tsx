import { useEffect, useState } from "react";
import { readItinerary } from "./api/itinerary";
import "./public-event.css";
import "./styles/public-pages.css";
import { PageSkeleton } from "./public-event/cards";

export { PublicEventApp } from "./public-event/PublicEventApp";

/** Resolve a capability before looking up the event, so a public-address change cannot break it. */
export function StableItineraryRedirect({ token }: { token: string }) {
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setFailure(null);
    if (!token) {
      setFailure("This itinerary was not found or is no longer available.");
      return;
    }
    let live = true;
    // ERROR-INTENT: React effects cannot await; failure is rendered and success navigates.
    void readItinerary(token)
      .then((itinerary) => {
        if (!live) return;
        window.location.replace(
          `/events/${encodeURIComponent(itinerary.eventSlug)}/itinerary?plan=${encodeURIComponent(token)}`,
        );
      })
      .catch(() => {
        if (live) setFailure("This itinerary was not found or is no longer available.");
      });
    return () => {
      live = false;
    };
  }, [token]);

  /*
   * The hand-off page for the whole itinerary feature, and until now the only surface in the
   * product wearing `pub-shell` — a class name that appears nowhere else and matches no rule in
   * any stylesheet, so an attendee opening a shared itinerary link landed on unstyled text.
   */
  return (
    <div className="public-shell">
      <header>
        <a className="brand" href="/">
          Greenroom
        </a>
      </header>
      <main className="pub-state" tabIndex={-1}>
        {failure ? (
          <>
            <h1>This itinerary is not available</h1>
            <p className="pub-note" role="status">
              {failure} An itinerary link expires when the event it belongs to stops being
              published, and whoever shared it can send a new one.
            </p>
          </>
        ) : (
          <>
            <h1>Opening your itinerary</h1>
            <p className="pub-note">Finding the event’s current public address.</p>
            <PageSkeleton label="Opening your itinerary" />
          </>
        )}
      </main>
    </div>
  );
}
