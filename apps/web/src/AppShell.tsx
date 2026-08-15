/*
 * Console chrome: sidebar navigation, event switcher, topbar identity.
 *
 * The shell owns navigation only. Pages own their own data so a slow workspace
 * never blocks the frame from painting.
 */

import type { EventDto, SessionDto } from "@greenroom/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  createEventHref,
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
  /** A deliberate organizer action beside the switcher, absent without creation capability. */
  createEventHref?: string;
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const mobileNavTrigger = useRef<HTMLButtonElement>(null);
  const mobileNav = useRef<HTMLElement>(null);

  const closeMobileNav = useCallback((restoreFocus = false) => {
    setMobileNavOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileNavTrigger.current?.focus());
  }, []);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(max-width: 780px)");
    const update = () => setMobileLayout(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (mobileLayout || !mobileNavOpen) return;
    setMobileNavOpen(false);
  }, [mobileLayout, mobileNavOpen]);

  useEffect(() => {
    if (!mobileLayout || !mobileNavOpen) return;
    const app = mobileNav.current?.parentElement;
    const page = app?.querySelector<HTMLElement>(".page");
    const skipLink = app?.querySelector<HTMLElement>(".skip-link");
    if (page) page.inert = true;
    if (skipLink) skipLink.inert = true;
    requestAnimationFrame(() =>
      mobileNav.current?.querySelector<HTMLElement>("select, a, button")?.focus(),
    );
    return () => {
      if (page) page.inert = false;
      if (skipLink) skipLink.inert = false;
    };
  }, [mobileLayout, mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMobileNav(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobileNav, mobileNavOpen]);

  const roleControl = (
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
  );

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <aside
        ref={mobileNav}
        className="sidebar"
        id="workspace-navigation"
        data-mobile-open={mobileNavOpen || undefined}
        aria-hidden={mobileLayout && !mobileNavOpen ? true : undefined}
        aria-label="Workspace"
      >
        <div className="brandmark">
          <span className="glyph" aria-hidden="true">
            G
          </span>
          <span className="wordmark">Greenroom</span>
        </div>

        {events.length > 0 ? (
          <div className="event-switcher-stack">
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
            {createEventHref ? (
              <a className="sidebar-create-event" {...linkProps(createEventHref)}>
                <span aria-hidden="true">+</span> Create another event
              </a>
            ) : null}
          </div>
        ) : null}

        <nav aria-label="Workspace navigation">
          {groups.map((group) => (
            <div className="nav-group" key={group.heading ?? "primary"}>
              {group.heading ? <h2>{group.heading}</h2> : null}
              {group.items.map((item) => {
                // Only the deepest matching route is current, so /agenda does not
                // light up while the user is on /agenda/rooms.
                const current = activePath.split("?")[0] === item.href.split("?")[0];
                const navigation = linkProps(item.href);
                return (
                  <a
                    key={item.href}
                    className="nav-item"
                    aria-current={current ? "page" : undefined}
                    href={navigation.href}
                    onClick={(event) => {
                      navigation.onClick(event);
                      closeMobileNav();
                      if (mobileLayout)
                        requestAnimationFrame(() => document.getElementById("main")?.focus());
                    }}
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

      <button
        type="button"
        className="nav-scrim"
        aria-label="Close workspace navigation"
        tabIndex={mobileNavOpen ? 0 : -1}
        data-visible={mobileNavOpen || undefined}
        onClick={() => closeMobileNav(true)}
      />

      <div className="page">
        <header className="topbar">
          <button
            ref={mobileNavTrigger}
            type="button"
            className="secondary mobile-nav-toggle"
            aria-label="Open workspace navigation"
            aria-controls="workspace-navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <p className="visually-hidden">
            {selectedEvent ? `${selectedEvent.name} workspace` : "Greenroom workspace"}
          </p>
          {mobileLayout ? null : <InstanceMarker />}
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

          {publicHref && !mobileLayout ? (
            <a className="btn secondary" href={publicHref} target="_blank" rel="noreferrer">
              <IconGlobe size={15} />
              View public site
            </a>
          ) : null}

          {mobileLayout ? (
            <details className="account-menu">
              <summary aria-label={`Account actions for ${session.actor.persona}`}>
                <span className="avatar" aria-hidden="true">
                  {initials(session.actor.name)}
                </span>
                <span>{session.actor.persona}</span>
              </summary>
              <div className="account-popover">
                <InstanceMarker />
                {roleControl}
                {publicHref ? (
                  <a className="btn secondary" href={publicHref} target="_blank" rel="noreferrer">
                    <IconGlobe size={15} />
                    View public site
                  </a>
                ) : null}
                {onSignOut ? (
                  <button type="button" className="secondary" disabled={busy} onClick={onSignOut}>
                    Sign out
                  </button>
                ) : null}
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
              </div>
            </details>
          ) : (
            roleControl
          )}

          {!mobileLayout && onSignOut ? (
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
          {!mobileLayout && onSignOutEverywhere ? (
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
