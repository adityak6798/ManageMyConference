/*
 * Console chrome: sidebar navigation, event switcher, topbar identity.
 *
 * The shell owns navigation only. Pages own their own data so a slow workspace
 * never blocks the frame from painting.
 */

import type { EventDto, SessionDto } from "@greenroom/contracts";
import type { ReactNode } from "react";
import { InstanceMarker } from "./InstanceMarker";
import { useLinkProps } from "./router";
import { IconGlobe, IconSearch } from "./ui/icons";

export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  count?: number;
};
export type NavGroup = { heading?: string; items: NavItem[] };
export type Persona = "organizer" | "reviewer" | "speaker" | "public";

const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

export function AppShell({
  session,
  events,
  selectedEventId,
  onSelectEvent,
  onSwitchPersona,
  onOpenSearch,
  onSignOut,
  onSignOutEverywhere,
  busy,
  groups,
  activePath,
  publicHref,
  overlay,
  children,
}: {
  session: SessionDto;
  events: EventDto[];
  selectedEventId: string;
  onSelectEvent: (eventId: string) => void;
  onSwitchPersona: (persona: Persona) => void;
  /**
   * Opens the command palette. Absent when no event is selected, because there is nothing to
   * search — the control is then not rendered at all rather than rendered and refusing.
   */
  onOpenSearch?: () => void;
  /**
   * Absent for a demo persona, which is switched rather than signed out — the switcher below
   * is that deployment's way to change identity, and offering both would imply the personas
   * are accounts. Present only when the shell was told this session was signed in for.
   */
  onSignOut?: () => void;
  /**
   * Present under exactly the same condition as `onSignOut`, and absent for a persona for the
   * same reason: a demo persona holds no session record to revoke, and the API refuses it.
   */
  onSignOutEverywhere?: () => void;
  busy: boolean;
  groups: NavGroup[];
  activePath: string;
  publicHref: string | null;
  /**
   * Chrome that sits above the whole console rather than inside a page — the command palette.
   *
   * Rendered as a sibling of `main` and not within it, because a modal dialog nested inside the
   * landmark it is covering makes the landmark contain the thing that renders it inert.
   */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const linkProps = useLinkProps();
  const selectedEvent = events.find(({ id }) => id === selectedEventId);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <aside className="sidebar">
        <div className="brandmark">
          <span className="glyph" aria-hidden="true">
            G
          </span>
          <span className="wordmark">Greenroom</span>
        </div>

        {events.length > 0 ? (
          <label className="event-switcher">
            <span>Event</span>
            <select
              id="event-switcher"
              aria-label="Event workspace"
              value={selectedEventId}
              onChange={(changeEvent) => onSelectEvent(changeEvent.target.value)}
            >
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <nav aria-label="Workspace navigation">
          {groups.map((group) => (
            <div className="nav-group" key={group.heading ?? "primary"}>
              {group.heading ? <h2>{group.heading}</h2> : null}
              {group.items.map((item) => {
                // Only the deepest matching route is current, so /agenda does not
                // light up while the user is on /agenda/rooms.
                const current = activePath.split("?")[0] === item.href.split("?")[0];
                return (
                  <a
                    key={item.href}
                    className="nav-item"
                    aria-current={current ? "page" : undefined}
                    {...linkProps(item.href)}
                  >
                    {item.icon}
                    {item.label}
                    {item.count === undefined ? null : <span className="count">{item.count}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="page">
        <header className="topbar">
          <p className="visually-hidden">
            {selectedEvent ? `${selectedEvent.name} workspace` : "Greenroom workspace"}
          </p>
          <InstanceMarker />
          <span className="spacer" />

          {onOpenSearch ? (
            <button
              type="button"
              className="secondary topbar-search"
              onClick={onOpenSearch}
              // The chord is declared rather than only drawn, so it is discoverable to a screen
              // reader too. The button is what makes the palette reachable at all; the hint is
              // how somebody learns the faster way.
              aria-keyshortcuts="Meta+K Control+K"
            >
              <IconSearch size={15} />
              {/*
                The label and the hint collapse away on a narrow topbar, leaving the icon and the
                same accessible name. The bar is one sticky row by design, and it was already at
                the edge of a 390px viewport before this control joined it.
              */}
              <span className="topbar-search-label">Search</span>
              <kbd>⌘K</kbd>
            </button>
          ) : null}

          {publicHref ? (
            <a className="btn secondary" href={publicHref} target="_blank" rel="noreferrer">
              <IconGlobe size={15} />
              View public site
            </a>
          ) : null}

          <label className="identity">
            <span className="visually-hidden">Signed-in role</span>
            <span className="avatar" aria-hidden="true">
              {initials(session.actor.name)}
            </span>
            <select
              aria-label="Signed-in role"
              value={session.actor.persona}
              disabled={busy}
              onChange={(changeEvent) => onSwitchPersona(changeEvent.target.value as Persona)}
            >
              {personas.map((persona) => (
                <option key={persona} value={persona}>
                  {persona.charAt(0).toUpperCase() + persona.slice(1)}
                </option>
              ))}
            </select>
          </label>

          {onSignOut ? (
            <button type="button" className="secondary" disabled={busy} onClick={onSignOut}>
              Sign out
            </button>
          ) : null}

          {/*
            Offered beside sign-out rather than behind a settings page, because the moment
            somebody wants it — a laptop left somewhere, a shared machine — is a moment they
            want it now. The label says what it does to every other device; "Sign out" alone
            would leave a reader guessing which of the two they just pressed.
          */}
          {onSignOutEverywhere ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={onSignOutEverywhere}
            >
              Sign out everywhere
            </button>
          ) : null}
        </header>

        {/* tabIndex={-1} makes the skip-link target programmatically focusable, not a tab stop. */}
        <main className="page-body" id="main" tabIndex={-1}>
          {children}
        </main>

        {overlay}
      </div>
    </div>
  );
}
