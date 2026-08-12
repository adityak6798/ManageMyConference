import { useEffect, useState } from "react";
import { readItinerary } from "./api/itinerary";

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

  return (
    <main className="pub-shell" tabIndex={-1}>
      <h1>{failure ? "Itinerary unavailable" : "Opening itinerary"}</h1>
      <p role="status">{failure ?? "Finding the event’s current public address…"}</p>
    </main>
  );
}
