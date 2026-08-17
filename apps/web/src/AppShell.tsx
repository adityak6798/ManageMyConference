/*
 * Console chrome: sidebar navigation, the event chip, the topbar.
 *
 * The shell answers three questions and owns nothing else. **Which event am I in** is the chip in
 * the topbar, present at every width — it used to live in the sidebar, which below 780px is a
 * closed drawer, so nothing on a phone named the event the organizer was about to email. **What
 * needs me now** is the count beside a nav item. **Where do I go next** is the nav itself, in four
 * blocks whose captions are separate from their ids.
 *
 * Pages own their own data so a slow workspace never blocks the frame from painting.
 */

import type { EventDto, SessionDto } from "@greenroom/contracts";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { InstanceMarker } from "./InstanceMarker";
import { useFocusTrap } from "./platform/focus-trap";
import { useLinkProps } from "./router";
import { Select, useDismissOnOutsidePointerDown } from "./ui/fields";
import { IconClose, IconGlobe, IconMenu, IconSearch } from "./ui/icons";
import { Card } from "./ui/primitives";

/**
 * Where the console stops being a sidebar-and-page and becomes a drawer-and-page.
 *
 * One number, so the media query the layout is drawn by and the query the shell asks cannot
 * disagree — they did, and the result was a phone painting the desktop topbar and swapping it
 * out after mount. `styles/platform.css` and `styles/shell.css` restate it as a literal; the
 * comment beside each names this constant.
 */
export const MOBILE_BREAKPOINT = 780;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** What is waiting behind this destination. Absent means "nothing to say", not zero. */
  count?: number;
};
export type NavGroup = {
  heading?: string;
  items: NavItem[];
  /** Pushed to the foot of the sidebar under a hairline. Administration, not navigation. */
  pinned?: boolean;
};
export type Persona = "organizer" | "reviewer" | "speaker" | "public";

const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];

const personaLabel = (persona: Persona) => persona.charAt(0).toUpperCase() + persona.slice(1);

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

/** The first paint of the console, in the shape the console actually has. */
export function ShellSkeleton({ label = "Loading your workspace" }: { label?: string }) {
  return (
    <div className="app">
      {/*
        The chrome is drawn for real where it is already known — the brandmark, the nav glyphs,
        the grid itself — and only what depends on the session is a bar. A chromeless <main>
        holding one sentence used to be the whole first frame, so the console arrived twice: once
        as a paragraph and once as an application.
      */}
      <aside className="sidebar" aria-hidden="true">
        <div className="sidebar-head">
          <div className="brandmark">
            <span className="glyph">G</span>
            <span className="wordmark">Greenroom</span>
          </div>
        </div>
        <div className="event-chip is-loading">
          <span className="skeleton" style={{ width: "100%", height: "1.75rem" }} />
        </div>
        <nav className="sidebar-nav">
          {Array.from({ length: 6 }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
            <span className="nav-item is-loading" key={row}>
              <span className="skeleton" style={{ width: "20px", height: "20px" }} />
              <span className="skeleton" style={{ width: `${64 - (row % 3) * 12}%` }} />
            </span>
          ))}
        </nav>
      </aside>
      <div className="page">
        {/* No `aria-hidden` on a landmark: the bars inside carry no text, so there is nothing
            for a reader to be told about, and hiding a banner is how a landmark disappears from
            the rotor for the frame it exists. */}
        <header className="topbar">
          <span className="skeleton" style={{ width: "180px", height: "1.5rem" }} />
          <span className="spacer" />
          <span className="skeleton" style={{ width: "96px", height: "1.5rem" }} />
        </header>
        <main className="page-body" id="main" tabIndex={-1}>
          {/* One polite announcement for the whole wait, and it never takes up space. */}
          <p role="status" className="visually-hidden">
            {label}
          </p>
          {[0, 1].map((card) => (
            <Card key={card}>
              <div className="skeleton-rows" aria-hidden="true">
                {[0, 1, 2].map((row) => (
                  <span className="skeleton-row" key={row}>
                    <span
                      className="skeleton"
                      style={{ width: `${68 - ((row + card) % 3) * 12}%`, height: "1rem" }}
                    />
                    <span className="skeleton" style={{ width: "18%", height: "0.75rem" }} />
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </main>
      </div>
    </div>
  );
}

/**
 * Which event this console is pointed at, and how to point it somewhere else.
 *
 * The tile carries the event's initial, the name sets at 13/semibold, and the timezone sets as a
 * measure under it — because every time on every surface behind this chip is in that zone, and an
 * organizer reading 09:45 has to know whose morning it is.
 */
function EventChip({
  events,
  selectedEventId,
  onSelectEvent,
}: {
  events: EventDto[];
  selectedEventId: string;
  onSelectEvent: (eventId: string) => void;
}) {
  const selected = events.find(({ id }) => id === selectedEventId);
  if (!selected) return null;
  return (
    <div className="event-chip">
      <span className="event-chip-tile" aria-hidden="true">
        {initials(selected.name).slice(0, 1)}
      </span>
      <Select
        className="event-chip-select"
        label="Event workspace"
        labelHidden
        size="sm"
        value={selectedEventId}
        onChange={onSelectEvent}
        options={events.map((event) => ({
          value: event.id,
          label: event.name,
          hint: event.timezone,
        }))}
      />
      <span className="figure event-chip-zone">{selected.timezone}</span>
    </div>
  );
}

/**
 * Everything about who is signed in, behind one control.
 *
 * Deliberately not the `Menu` primitive, and this is the one place in the console that is not.
 * `Menu` is a WAI-ARIA menu: its children are `menuitem`s and nothing else may live among them,
 * and what belongs here is an identity block, a deployment badge and — on a demo deployment — a
 * role picker, none of which is an item to choose. What the `<details>` element it replaces got
 * wrong was behaviour rather than markup: it closed on neither Escape nor an outside press, and
 * Tab walked straight out of it. Those three come from the same hooks the primitives use.
 */
function AccountMenu({
  session,
  busy,
  demoMode,
  onSwitchPersona,
  onSignOut,
  onSignOutEverywhere,
}: {
  session: SessionDto;
  busy: boolean;
  demoMode: boolean;
  onSwitchPersona: (persona: Persona) => void;
  onSignOut?: (() => void) | undefined;
  onSignOutEverywhere?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutsidePointerDown(rootRef, open, dismiss);
  useFocusTrap(popoverRef, open);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  return (
    <div className="account" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="account-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={`Account and access for ${session.actor.name}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(session.actor.name)}
        </span>
        <span className="account-trigger-name">{session.actor.name}</span>
      </button>
      {open ? (
        <div className="account-popover" id={popoverId} ref={popoverRef}>
          <div className="account-identity">
            <span className="avatar" aria-hidden="true">
              {initials(session.actor.name)}
            </span>
            <div className="account-identity-text">
              <p className="account-name">{session.actor.name}</p>
              <p className="account-role">{personaLabel(session.actor.persona as Persona)}</p>
            </div>
          </div>

          <InstanceMarker />

          {/*
            Offered only on a demo deployment, because it POSTs `/api/demo-session` — a route that
            answers 404 whenever DEMO_MODE is off. It was the most prominent control on the page,
            and on a real deployment pressing it returned "The requested resource was not found."
            with a correlation id, to an organizer who had not asked to become anybody else.
          */}
          {demoMode ? (
            <Select
              className="account-persona"
              label="Demo role"
              size="sm"
              value={session.actor.persona}
              disabled={busy}
              onChange={(persona) => onSwitchPersona(persona as Persona)}
              options={personas.map((persona) => ({
                value: persona,
                label: personaLabel(persona),
              }))}
            />
          ) : null}

          {onSignOut || onSignOutEverywhere ? <hr className="account-divider" /> : null}

          {onSignOut ? (
            <button
              type="button"
              className="ghost account-action"
              disabled={busy}
              onClick={() => {
                close(false);
                onSignOut();
              }}
            >
              Sign out
            </button>
          ) : null}

          {/*
            Offered here rather than behind a settings page, because the moment somebody wants it
            — a laptop left somewhere, a shared machine — is a moment they want it now. It reads
            as the destructive half of the pair, under the divider, because it is.
          */}
          {onSignOutEverywhere ? (
            <button
              type="button"
              className="danger account-action"
              disabled={busy}
              onClick={() => {
                close(false);
                onSignOutEverywhere();
              }}
            >
              Sign out everywhere
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({
  session,
  events,
  selectedEventId,
  onSelectEvent,
  demoMode = false,
  onSwitchPersona,
  onOpenSearch,
  onSignOut,
  onSignOutEverywhere,
  busy,
  groups,
  activePath,
  publicHref,
  alert,
  overlay,
  children,
}: {
  session: SessionDto;
  events: EventDto[];
  selectedEventId: string;
  onSelectEvent: (eventId: string) => void;
  /**
   * Whether this deployment can switch identity at all. The persona picker is offered only for a
   * demo session, because on any other one the request behind it does not exist — it answers 404.
   * Absent means no, which is the answer that cannot mislead.
   */
  demoMode?: boolean;
  onSwitchPersona: (persona: Persona) => void;
  /**
   * Opens the command palette. Absent when no event is selected, because there is nothing to
   * search — the control is then not rendered at all rather than rendered and refusing.
   */
  onOpenSearch?: () => void;
  /** Present only when the shell was told this session was signed in for. */
  onSignOut?: () => void;
  /**
   * Present under a stricter condition than `onSignOut`: a demo persona holds no session record
   * to revoke, and the API refuses it.
   */
  onSignOutEverywhere?: () => void;
  busy: boolean;
  groups: NavGroup[];
  activePath: string;
  publicHref: string | null;
  /**
   * A message about the console itself — a failed identity switch, a refused create — pinned
   * directly under the topbar.
   *
   * It used to be the last child after the entire page body, so on a long surface like the agenda
   * board the answer to a button press painted thousands of pixels below the button.
   */
  alert?: ReactNode;
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Read before the first paint rather than after it. Starting at `false` meant a phone painted
  // the desktop topbar and then swapped it, which is a layout shift on every single load.
  const [mobileLayout, setMobileLayout] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false),
  );
  const mobileNavTrigger = useRef<HTMLButtonElement>(null);
  const mobileNav = useRef<HTMLElement>(null);

  const closeMobileNav = useCallback((restoreFocus = false) => {
    setMobileNavOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileNavTrigger.current?.focus());
  }, []);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(MOBILE_QUERY);
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
      mobileNav.current?.querySelector<HTMLElement>("a, button")?.focus(),
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

  // The page behind the drawer is `inert`, so Tab leaving the drawer left the reader operating
  // browser chrome with nothing on the page reachable. Same trap the palette uses.
  useFocusTrap(mobileNav, mobileLayout && mobileNavOpen);

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
        <div className="sidebar-head">
          <div className="brandmark">
            <span className="glyph" aria-hidden="true">
              G
            </span>
            <span className="wordmark">Greenroom</span>
          </div>
          {/* Only drawn while the sidebar is a drawer: a panel that covers the page owes the
              reader a way out that is not a keystroke and not a guess at where the page edge is. */}
          <button
            type="button"
            className="ghost sidebar-close"
            aria-label="Close workspace navigation"
            onClick={() => closeMobileNav(true)}
          >
            <IconClose />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Workspace navigation">
          {groups.map((group) => (
            <div
              className={group.pinned ? "nav-group is-pinned" : "nav-group"}
              key={group.heading ?? (group.pinned ? "pinned" : "primary")}
            >
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
                    {item.count === undefined ? null : (
                      <span className="count figure">
                        <span className="visually-hidden">{item.count} waiting</span>
                        <span aria-hidden="true">{item.count}</span>
                      </span>
                    )}
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
            <IconMenu />
          </button>

          {/* The one thing on every surface that says which event this is. Never hidden. */}
          <EventChip
            events={events}
            selectedEventId={selectedEventId}
            onSelectEvent={onSelectEvent}
          />

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
              <IconSearch />
              {/*
                The label and the hint collapse away on a narrow topbar, leaving the icon and the
                same accessible name. The bar is one sticky row by design.
              */}
              <span className="topbar-search-label">Search</span>
              <kbd>⌘K</kbd>
            </button>
          ) : null}

          {publicHref ? (
            <a
              className="btn secondary topbar-public"
              href={publicHref}
              target="_blank"
              rel="noreferrer"
            >
              <IconGlobe />
              <span className="topbar-public-label">View public site</span>
            </a>
          ) : null}

          <AccountMenu
            session={session}
            busy={busy}
            demoMode={demoMode}
            onSwitchPersona={onSwitchPersona}
            onSignOut={onSignOut}
            onSignOutEverywhere={onSignOutEverywhere}
          />
        </header>

        {/* Sticky under the topbar, so the answer to a press stays with the control that made
            it however far the surface behind scrolls. */}
        {alert ? <div className="page-alert">{alert}</div> : null}

        {/* tabIndex={-1} makes the skip-link target programmatically focusable, not a tab stop. */}
        <main className="page-body" id="main" tabIndex={-1}>
          {children}
        </main>

        {overlay}
      </div>
    </div>
  );
}
