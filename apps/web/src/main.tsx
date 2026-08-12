import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PublicEventApp, StableItineraryRedirect } from "./PublicEventApp";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");

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

createRoot(root).render(
  <StrictMode>
    {window.location.pathname.startsWith("/itineraries/") ? (
      <StableItineraryRedirect token={itineraryToken ?? ""} />
    ) : window.location.pathname.startsWith("/events/") ||
      window.location.pathname.startsWith("/embed/events/") ? (
      <PublicEventApp />
    ) : (
      <App />
    )}
  </StrictMode>,
);
