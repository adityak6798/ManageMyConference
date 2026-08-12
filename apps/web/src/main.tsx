/*
 * Which application this document is, decided before the console is fetched.
 *
 * A visitor on a public event page was being served the whole organizer console — every
 * workspace module the registry names, and everything each of those imports — because naming
 * both roots statically gives the bundler no way to know which one the pathname will pick.
 * Measured on the demo event's public page: 100 module requests before this, 40 after, against
 * the smoke budget's ceiling of 100 (`GAP-014`, issues #48 and #84).
 *
 * That budget is the reason the ceiling was reached, but it is not the reason this is right:
 * the public page is the one surface an ordinary visitor loads, and it has no business
 * downloading an organizer's console to render a schedule. An attendee's itinerary is public
 * in exactly the same sense and is served from the same module, so it takes the same path.
 *
 * Only the console is deferred. Keeping the public roots in the entry costs an organizer a
 * little more to download — they are signed in and reading their own console — and buys the
 * visitor a first paint that is already styled: a dynamically imported root brings its
 * stylesheet with it, so `index.html` would carry no `<link>` at all and the public page would
 * paint unstyled before its CSS arrived. The measured request count is the same either way.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PublicEventApp, StableItineraryRedirect } from "./PublicEventApp";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");
const container = root;

const itineraryMatch = window.location.pathname.match(/^\/itineraries\/([^/]+)\/?$/);
let itineraryToken: string | null = null;
if (itineraryMatch) {
  try {
    itineraryToken = decodeURIComponent(itineraryMatch[1] ?? "");
  } catch {
    // ERROR-INTENT: malformed external paths are rendered as unavailable itineraries below.
    itineraryToken = "";
  }
}

const isItinerary = window.location.pathname.startsWith("/itineraries/");
const isPublic =
  isItinerary ||
  window.location.pathname.startsWith("/events/") ||
  window.location.pathname.startsWith("/embed/events/");

/** Built only on the path that renders it, so the console pays nothing for it. */
const publicRoot = () =>
  isItinerary ? <StableItineraryRedirect token={itineraryToken ?? ""} /> : <PublicEventApp />;

// ERROR-INTENT: bootstrapping cannot await, and there is no React tree yet to render a failure
// into — so the outcome is rendered into the document instead. This covers the console's
// deferred load, which is the fetch that can fail after this module is running; a public root
// that throws while *this* module is evaluating faults before any handler exists, exactly as it
// did when both roots were static imports.
void (isPublic ? Promise.resolve(publicRoot()) : import("./App").then(({ App }) => <App />))
  .then((element) => {
    createRoot(container).render(<StrictMode>{element}</StrictMode>);
  })
  .catch((reason: unknown) => {
    // A root that never arrives leaves a blank document, which reads as a broken deployment
    // rather than as a request to retry. The reason is deliberately not shown here: it is a
    // bundler path, it means nothing to a visitor, and this text is served to anonymous readers.
    container.textContent = "Something went wrong. Please retry; if it continues, contact support.";
    // It is not swallowed either. Rethrowing in a fresh task, after the message is on screen,
    // hands the failure to the platform's own reporting — the dev overlay, `window.onerror`,
    // whatever a deployment has attached — which a handled rejection would otherwise silence,
    // leaving an operator debugging a blank page with nothing at all to go on.
    setTimeout(() => {
      throw reason;
    });
  });
