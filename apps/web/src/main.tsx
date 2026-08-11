import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PublicEventApp } from "./PublicEventApp";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");

createRoot(root).render(
  <StrictMode>
    {window.location.pathname.startsWith("/events/") ||
    window.location.pathname.startsWith("/embed/events/") ? (
      <PublicEventApp />
    ) : (
      <App />
    )}
  </StrictMode>,
);
