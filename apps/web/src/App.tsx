import type { EventDto, SessionDto } from "@greenroom/contracts";
import {
  type FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppShell, type NavGroup, type Persona } from "./AppShell";
import {
  ApiError,
  createEvent,
  getAuthConfig,
  getSession,
  listAssignedEvents,
  listEvents,
  requestLoginCode,
  startDemoSession,
  verifyLoginCode,
} from "./api/events";
import { getPublicationSummary } from "./api/publication";
import { OverviewPage } from "./OverviewPage";
import { navigate, useLocation } from "./router";
import "./styles.css";
import { IconDashboard, IconSettings } from "./ui/icons";
import { Card, EmptyState, Notice, PageHeader } from "./ui/primitives";
import type {
  NavGroupName,
  WorkspaceAccess,
  WorkspaceContext,
  WorkspaceModule,
} from "./workspaces/contract";
import {
  assertNoDuplicateWorkspaces,
  canOpen,
  NAV_GROUP_ORDER,
  workspaceForPath,
  workspacesForPersona,
} from "./workspaces/registry";

const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];

function readableError(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message} Reference: ${error.envelope.error.correlationId}`;
  return "Something went wrong. Please retry; if it continues, contact support.";
}

interface NavEntry {
  href: string;
  label: string;
  group: NavGroupName;
  order: number;
  icon: ReactNode;
}

/**
 * The two surfaces the shell owns itself. Every other entry comes from a domain's workspace
 * module, so adding a domain adds no line to this file.
 *
 * `/` is the shell's because what it shows depends on the persona rather than on a domain,
 * and `/settings` is the shell's because its create-event form is the shell's own state.
 */
function shellRoutes(role: Persona): NavEntry[] {
  const overview = (label: string): NavEntry => ({
    href: "/",
    label,
    group: "home",
    order: 0,
    icon: <IconDashboard size={16} />,
  });
  if (role === "organizer")
    return [
      overview("Overview"),
      {
        href: "/settings",
        label: "Event settings",
        group: "Audience",
        order: 8,
        icon: <IconSettings size={16} />,
      },
    ];
  // A reviewer and a speaker land on their own single workspace, so the shell adds nothing.
  if (role === "reviewer" || role === "speaker") return [];
  return [overview("Events")];
}

/** Routes each persona can reach, in sidebar order. The first entry is its home. */
function routesFor(role: Persona): NavEntry[] {
  const domains = workspacesForPersona(role).map((module) => ({
    href: module.path,
    label: module.label,
    group: module.group,
    order: module.order,
    icon: module.icon,
  }));
  return [...shellRoutes(role), ...domains].sort((left, right) => left.order - right.order);
}

// Two domains claiming one route would otherwise mean whichever module the registry reached
// first quietly wins, with the other workspace never rendering and nothing saying so.
assertNoDuplicateWorkspaces();

// @spec PRD-EVT-001 PRD-IAM-001 PRD-IAM-002
export function App() {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [name, setName] = useState("");
  // The shell reports its own failures and no one else's: signing in, switching identity,
  // creating an event. It starts and finishes each of those, so it can keep the message
  // accurate by itself. A workspace that is mounted owns its failures — it renders them
  // beside the control that caused them, or, when a load fails, in place of itself.
  const [error, setError] = useState<string | null>(null);
  // The one exception, and only for a failure to *load*: until a draft arrives the agenda
  // board has no surface of its own to render one in, so it hands the message here and the
  // /agenda route renders it above the board. Nothing else reports to the shell.
  const [agendaLoadFailure, setAgendaLoadFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [publication, setPublication] = useState<{ slug: string; state: string } | null>(null);
  const location = useLocation();
  const path = location.split("?")[0] ?? "/";

  const loadShell = useCallback(async () => {
    const currentSession = await getSession();
    const loadedEvents = currentSession.capabilities.includes("events:read")
      ? await listEvents()
      : currentSession.actor.persona === "public"
        ? await listAssignedEvents()
        : [];
    setSession(currentSession);
    setEvents(loadedEvents);
    // Read the requested event from the live URL rather than from render state, so this
    // callback stays stable and the shell is not refetched on every navigation.
    const requested = new URLSearchParams(window.location.search).get("event");
    setSelectedEventId((current) => {
      const candidate = requested ?? current;
      return loadedEvents.some(({ id }) => id === candidate)
        ? candidate
        : loadedEvents[0]?.id || "";
    });
    return currentSession;
  }, []);

  /** Stable, so the board's load effect is not re-run by a re-render of the shell. */
  const reportAgendaLoadFailure = useCallback(
    (message: string) => setAgendaLoadFailure(message),
    [],
  );

  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; the attached handlers render the outcome.
    void loadShell()
      .catch(async (reason: unknown) => {
        if (!(reason instanceof ApiError) || reason.envelope.error.code !== "UNAUTHORIZED")
          throw reason;
        setError(readableError(reason));
        setDemoMode((await getAuthConfig()).demoMode);
      })
      .catch((reason: unknown) => setError(readableError(reason)))
      .finally(() => setLoading(false));
  }, [loadShell]);

  const selectedEvent = events.find(({ id }) => id === selectedEventId);
  const query = selectedEventId ? `?event=${selectedEventId}` : "";

  const activeRole = useMemo<Persona>(() => {
    if (!session) return "public";
    const roles = session.eventAccess
      .filter(({ eventId }) => eventId === selectedEventId)
      .map(({ role }) => role);
    if (roles.includes("organizer")) return "organizer";
    if (roles.includes("speaker")) return "speaker";
    return (roles[0] as Persona) ?? session.actor.persona;
  }, [selectedEventId, session]);

  const activeEventCapabilities = useMemo(
    () => [
      ...new Set(
        session?.eventAccess
          .filter(({ eventId }) => eventId === selectedEventId)
          .flatMap(({ capabilities }) => capabilities) ?? [],
      ),
    ],
    [session, selectedEventId],
  );

  /**
   * Route-level gates. The allowlist redirect below is an effect, so it runs only after
   * children have mounted and fired their requests — each surface has to refuse on its
   * own rather than rely on being navigated away from.
   */
  const isEventOrganizer = Boolean(
    session?.eventAccess.some(
      ({ eventId, role }) => eventId === selectedEventId && role === "organizer",
    ),
  );
  const allowed = useMemo(() => routesFor(activeRole), [activeRole]);

  // A persona that cannot reach the current route lands on its own home rather than
  // an empty frame — switching identity used to leave the page blank.
  useEffect(() => {
    if (loading || !session) return;
    if (allowed.some((route) => route.href === path)) return;
    navigate(`${allowed[0]?.href ?? "/"}${query}`, { replace: true });
  }, [allowed, loading, path, query, session]);

  // A failure raised for one surface, or for one event, must not follow the user to the
  // next one — switching event keeps the same path, so both axes have to clear it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing is keyed on the destination.
  useEffect(() => {
    setError(null);
    setAgendaLoadFailure(null);
  }, [path, selectedEventId]);

  // The public slug is server-assigned, so it has to be read rather than guessed.
  useEffect(() => {
    // Drop the previous event's slug immediately; keeping it while the next request is in
    // flight would point "View public site" at the event the organizer just left.
    setPublication(null);
    if (!selectedEventId || !isEventOrganizer) return;
    let active = true;
    // ERROR-INTENT: the outbound link is convenience only. getPublicationSummary catches
    // its own failures and resolves to null, so the link is simply not offered.
    void getPublicationSummary(selectedEventId).then((summary) => {
      if (active) setPublication(summary);
    });
    return () => {
      active = false;
    };
  }, [selectedEventId, isEventOrganizer]);

  async function switchPersona(persona: Persona) {
    setBusy(true);
    setError(null);
    setAgendaLoadFailure(null);
    try {
      await startDemoSession(persona);
      await loadShell();
      // Disabling the select while the switch is in flight drops focus to <body>, and the
      // whole workspace changes underneath. Move focus to the destination so keyboard and
      // screen-reader users land on the new surface instead of at the top of the document.
      requestAnimationFrame(() => {
        const main = document.getElementById("main");
        main?.setAttribute("tabindex", "-1");
        main?.focus({ preventScroll: true });
      });
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submitLogin(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!challenge) {
        setChallenge((await requestLoginCode(email)).challenge);
      } else {
        await verifyLoginCode(challenge, code);
        await loadShell();
      }
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  function selectEvent(eventId: string) {
    setSelectedEventId(eventId);
    navigate(`${path}?event=${eventId}`, { replace: true });
  }

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const organizationId = session?.organizations[0]?.id;
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createEvent({
        organizationId,
        name,
        timezone: "America/Los_Angeles",
      });
      const [refreshedSession, refreshedEvents] = await Promise.all([getSession(), listEvents()]);
      setSession(refreshedSession);
      setEvents(refreshedEvents);
      // Selecting an event means the switcher *and* the address bar, always: a URL still
      // carrying the previous event silently undoes the switch on the next reload or when
      // the link is shared. There is one way to select an event, and this is it.
      selectEvent(created.id);
      setName("");
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="page-body">
        <p role="status" className="notice">
          Loading your workspace…
        </p>
      </main>
    );

  if (!session)
    return (
      <main className="page-body" style={{ maxWidth: 560, margin: "12vh auto" }}>
        <PageHeader
          eyebrow="Project Greenroom"
          title={demoMode ? "Choose a workspace role" : "Sign in to Greenroom"}
          subtitle={
            demoMode
              ? "Each seeded identity sees exactly the access its role grants."
              : "Use the email address connected to your event account."
          }
        />
        <Card>
          {demoMode ? (
            <div className="persona-actions">
              {personas.map((persona) => (
                <button
                  key={persona}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; switchPersona renders failures.
                    void switchPersona(persona);
                  }}
                >
                  Continue as {persona}
                </button>
              ))}
            </div>
          ) : (
            <form onSubmit={submitLogin}>
              <div className="field">
                <label htmlFor={challenge ? "login-code" : "login-email"}>
                  {challenge ? "Six-digit code" : "Email address"}
                </label>
                <input
                  id={challenge ? "login-code" : "login-email"}
                  type={challenge ? "text" : "email"}
                  inputMode={challenge ? "numeric" : undefined}
                  autoComplete={challenge ? "one-time-code" : "email"}
                  value={challenge ? code : email}
                  onChange={(event) =>
                    challenge ? setCode(event.target.value) : setEmail(event.target.value)
                  }
                  required
                />
              </div>
              <button type="submit" disabled={busy}>
                {challenge ? "Sign in" : "Email me a code"}
              </button>
            </form>
          )}
          {error ? (
            <div style={{ marginTop: "var(--s-4)" }}>
              <Notice tone="error">{error}</Notice>
            </div>
          ) : null}
        </Card>
      </main>
    );

  // Each entry carries its own group and icon, so the sidebar is grouped by what a workspace
  // declares rather than by slicing a hand-ordered array at hard-coded indices.
  const groups: NavGroup[] = NAV_GROUP_ORDER.flatMap((name) => {
    const items = allowed
      .filter((route) => route.group === name)
      .map((route) => ({ href: `${route.href}${query}`, label: route.label, icon: route.icon }));
    if (items.length === 0) return [];
    return [name === "home" ? { items } : { heading: name, items }];
  });

  // Only offer the link once the event is actually published under a known slug.
  const publicHref = publication?.state === "published" ? `/events/${publication.slug}` : null;

  /**
   * Shown when a surface refuses. The route stays in this persona's allowlist, so the
   * redirect effect will not move them — rendering nothing would strand the user on a
   * blank page with the nav item still highlighted.
   */
  const noAccess = (
    <>
      <PageHeader title="No access to this workspace" subtitle={selectedEvent?.name} />
      <Card>
        <EmptyState title="Your role on this event does not include this workspace">
          Switch to an event you organize, or change the signed-in role from the top right.
        </EmptyState>
      </Card>
    </>
  );

  /** Render a domain's workspace behind the header it declares for itself. */
  function renderWorkspace(workspace: WorkspaceModule, access: WorkspaceAccess) {
    if (!selectedEvent) return noAccess;
    const context: WorkspaceContext = {
      ...access,
      event: selectedEvent,
      query,
      agendaLoadFailure,
      reportAgendaLoadFailure,
      onPublicationChange: setPublication,
    };
    const { eyebrow, title, subtitle } = workspace.header(context);
    return (
      <>
        <PageHeader
          {...(eyebrow ? { eyebrow } : {})}
          title={title}
          {...(subtitle ? { subtitle } : {})}
        />
        <Fragment key={selectedEvent.id}>{workspace.render(context)}</Fragment>
      </>
    );
  }

  function renderPage() {
    if (!selectedEvent)
      return (
        <>
          <PageHeader title="No event workspace" />
          <Card>
            <EmptyState title="This identity has no event assigned">
              Switch the signed-in role from the top right to see an assigned workspace.
            </EmptyState>
          </Card>
        </>
      );

    const access: WorkspaceAccess = {
      session,
      activeRole,
      capabilities: activeEventCapabilities,
      isEventOrganizer,
    };
    const workspace = workspaceForPath(path);
    if (workspace)
      return canOpen(workspace, access) ? renderWorkspace(workspace, access) : noAccess;

    // The shell's own two surfaces. A domain adds neither a case here nor an entry above.
    if (path === "/") {
      if (activeRole === "organizer") return <OverviewPage event={selectedEvent} query={query} />;
      return (
        <>
          <PageHeader title={selectedEvent.name} subtitle="Attendee view" />
          <Card>
            {/* The public slug is only readable by an organizer, so this identity cannot
                be told whether the event is published — say what is true instead of
                guessing either way. */}
            <EmptyState title="This event has a public site of its own">
              Its schedule, sessions, speakers, and call for proposals are published at a separate
              address. An organizer can copy that link from the workspace.
            </EmptyState>
          </Card>
        </>
      );
    }
    if (path === "/settings")
      return (
        <>
          <PageHeader
            eyebrow="Configure"
            title="Event settings"
            subtitle={`${selectedEvent.name} · ${selectedEvent.timezone}`}
          />
          {session?.capabilities.includes("events:create") ? (
            <Card title="Create an event" labelledBy="create-title">
              <form onSubmit={submit}>
                <div className="field">
                  <label htmlFor="event-name">Event name</label>
                  <div className="form-row">
                    <input
                      id="event-name"
                      value={name}
                      onChange={(changeEvent) => setName(changeEvent.target.value)}
                      placeholder="Greenroom Summit"
                      required
                      maxLength={120}
                    />
                    <button type="submit" disabled={busy}>
                      {busy ? "Creating…" : "Create event"}
                    </button>
                  </div>
                </div>
              </form>
            </Card>
          ) : (
            <Card>
              <EmptyState title="Organizers only">
                Organization and event settings stay restricted to organizers.
              </EmptyState>
            </Card>
          )}
        </>
      );

    return (
      <>
        <PageHeader title="Page not found" />
        <Card>
          <EmptyState title="That workspace does not exist">
            Use the navigation to return to a surface your role can reach.
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <AppShell
      session={session}
      events={events}
      selectedEventId={selectedEventId}
      onSelectEvent={selectEvent}
      onSwitchPersona={(persona) => {
        // ERROR-INTENT: handlers cannot await; switchPersona renders failures.
        void switchPersona(persona);
      }}
      busy={busy}
      groups={groups}
      activePath={path}
      publicHref={publicHref}
    >
      {renderPage()}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </AppShell>
  );
}
