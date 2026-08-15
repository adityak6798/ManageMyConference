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
import { PublicReportApp } from "./PublicReportApp";
import { PublicSiteApp } from "./PublicSiteApp";

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
  /^\/sites\/[^/]+/.test(window.location.pathname) ||
  window.location.pathname.startsWith("/reports/") ||
  window.location.pathname.startsWith("/events/") ||
  window.location.pathname.startsWith("/embed/events/");

/** Built only on the path that renders it, so the console pays nothing for it. */
const publicRoot = () =>
  isItinerary ? (
    <StableItineraryRedirect token={itineraryToken ?? ""} />
  ) : window.location.pathname.startsWith("/sites/") ? (
    <PublicSiteApp />
  ) : window.location.pathname.startsWith("/reports/") ? (
    <PublicReportApp />
  ) : (
    <PublicEventApp />
  );

/*
 * The two paths whose application cannot be decided here.
 *
 * "/" is the marketing page for a visitor and the console's home for an organizer, and the
 * session cookie is `httpOnly`, so this module cannot tell which by reading anything it has.
 * Only the API knows. `LandingRoot` therefore owns the decision: it renders immediately, and
 * swaps itself for the console if the probe comes back with a session.
 *
 * Both dynamic imports are started in the same tick, so the probe leaves as soon as the small
 * identity module lands rather than waiting for the whole landing surface behind it — and
 * neither module is in the entry chunk, which is what keeps `/events/*` paying nothing for a
 * surface it never renders.
 *
 * **What this costs, stated rather than omitted.** An organizer opening "/" now waits for the
 * session probe to answer before the console chunk is even requested, where before it was
 * fetched in the entry's first tick. That is one round trip plus a chunk fetch added to the
 * critical path of the page they load most. It could be removed by starting `import("./App")`
 * beside the probe — at the price of pushing ~300 kB of organizer console at every anonymous
 * visitor who lands on the marketing page, which is the exact cost this split exists to avoid.
 * The trade is deliberate: the signed-out visitor is the one who has not chosen to be here yet.
 */
const landingPaths = new Set(["/", "/signin"]);
const landingRoot = () => {
  const bootstrap = import("./api/identity").then(({ probeIdentity }) => probeIdentity());
  return import("./landing/LandingPage").then(({ LandingRoot }) => (
    <LandingRoot bootstrap={bootstrap} />
  ));
};
const isLanding =
  !isPublic && landingPaths.has(window.location.pathname.replace(/\/+$/, "") || "/");

/*
 * What the catch below covers, and what it cannot.
 *
 * It covers the console's deferred load, which is the fetch that can fail after this module is
 * already running. A public root that throws while *this* module is evaluating faults before any
 * handler exists at all — exactly as it did when both roots were static imports.
 */
// ERROR-INTENT: bootstrapping cannot await, and there is no React tree yet to render a failure
// into, so the outcome is rendered into the document and the reason rethrown for the platform.
void (
  isPublic
    ? Promise.resolve(publicRoot())
    : isLanding
      ? landingRoot()
      : import("./App").then(({ App }) => <App />)
)
  .then((element) => {
    createRoot(container).render(<StrictMode>{element}</StrictMode>);
  })
  .catch((reason: unknown) => {
    // A root that never arrives leaves a blank document, which reads as a broken deployment
    // rather than as a request to retry. The reason is deliberately not shown: it is a bundler
    // path, it means nothing to a visitor, and this text is served to anonymous readers.
    container.textContent = "Something went wrong. Please retry; if it continues, contact support.";
    // It is not swallowed either. Rethrowing in a fresh task, after the message is on screen,
    // hands the failure to the platform's own reporting — the dev overlay, `window.onerror`,
    // whatever a deployment has attached — which a handled rejection would otherwise silence,
    // leaving an operator debugging a blank page with nothing at all to go on.
    setTimeout(() => {
      throw reason;
    });
  });
