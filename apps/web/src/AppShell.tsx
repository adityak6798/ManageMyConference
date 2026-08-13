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
import { IconGlobe } from "./ui/icons";

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
  busy,
  groups,
  activePath,
  publicHref,
  children,
}: {
  session: SessionDto;
  events: EventDto[];
  selectedEventId: string;
  onSelectEvent: (eventId: string) => void;
  onSwitchPersona: (persona: Persona) => void;
  busy: boolean;
  groups: NavGroup[];
  activePath: string;
  publicHref: string | null;
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
        </header>

        {/* tabIndex={-1} makes the skip-link target programmatically focusable, not a tab stop. */}
        <main className="page-body" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
