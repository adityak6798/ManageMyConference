/*
 * Which application this document is, decided before either one is fetched.
 *
 * The two roots are loaded on demand rather than both imported at the top. A visitor on a
 * public event page was being served the whole organizer console — every workspace module the
 * registry names, and everything each of those imports — because naming both roots statically
 * gives the bundler no way to know which one the pathname will pick. Measured on the demo
 * event's public page: 100 module requests before this, 40 after, against the smoke budget's
 * ceiling of 100 (`GAP-014`, issues #48 and #84).
 *
 * That budget is the reason the ceiling was reached, but it is not the reason this is right:
 * the public page is the one surface an ordinary visitor loads, and it has no business
 * downloading an organizer's console to render a schedule.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");
const container = root;

const isPublic =
  window.location.pathname.startsWith("/events/") ||
  window.location.pathname.startsWith("/embed/events/");

// ERROR-INTENT: bootstrapping cannot await, and there is no React tree yet to render a failure
// into — so the outcome is rendered into the document instead, by both branches below.
void (
  isPublic
    ? import("./PublicEventApp").then((module) => module.PublicEventApp)
    : import("./App").then((module) => module.App)
)
  .then((Root) => {
    createRoot(container).render(
      <StrictMode>
        <Root />
      </StrictMode>,
    );
  })
  .catch(() => {
    // A root that never arrives leaves a blank document, which reads as a broken deployment
    // rather than as a request to retry. The reason is deliberately not shown: it is a bundler
    // path, it means nothing to a visitor, and this text is served to anonymous readers.
    container.textContent = "Something went wrong. Please retry; if it continues, contact support.";
  });
