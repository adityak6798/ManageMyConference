import {
  type EventDto,
  type EventTemplateDto,
  resolveTimezone,
  type SessionDto,
} from "@greenroom/contracts";
import {
  type FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AcceptInvitationPage } from "./AcceptInvitationPage";
import { AppShell, type NavGroup, type Persona } from "./AppShell";
import {
  applyEventTemplate,
  EventTemplateApiError,
  getEventTemplate,
  listEventTemplates,
} from "./api/event-templates";
import { ApiError, createEvent, listAssignedEvents, updateEvent } from "./api/events";
import {
  getAuthConfig,
  getSession,
  IdentityApiError,
  requestLoginCode,
  revokeAllSessions,
  signOut,
  startDemoSession,
  verifyLoginCode,
} from "./api/identity";
import { PublicationApiError, updatePublicationSettings } from "./api/publication";
import { CommandPalette } from "./CommandPalette";
import { TimezoneField } from "./events/TimezoneField";
import { InstanceMarker } from "./InstanceMarker";
import { OverviewPage } from "./OverviewPage";
import { navigate, useLocation } from "./router";
import "./styles.css";
import {
  IconCalendar,
  IconDashboard,
  IconForm,
  IconGlobe,
  IconSend,
  IconSettings,
  IconSpeakers,
} from "./ui/icons";
import { Card, EmptyState, HubTabs, Notice, PageHeader } from "./ui/primitives";
import type {
  HubTabModule,
  NavGroupName,
  WorkspaceAccess,
  WorkspaceContext,
  WorkspaceHub,
  WorkspaceModule,
  WorkspaceRole,
} from "./workspaces/contract";
import { HUB_PATHS } from "./workspaces/contract";
import {
  assertNoDuplicateWorkspaces,
  canOpen,
  canOpenTab,
  hubTabForLegacyPath,
  hubTabForSelection,
  hubTabsFor,
  NAV_GROUP_ORDER,
  workspaceForPath,
  workspacesForPersona,
} from "./workspaces/registry";

const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];

/**
 * The envelope behind a refusal, whichever client raised it.
 *
 * Every API client in `api/` declares its own error class — that is what keeps a domain's
 * failures its own — and every one of them carries the same envelope. The shell talks to two of
 * them, so it asks for the envelope rather than for a class, and a third client added later
 * costs one line here instead of a silently generic message.
 */
function envelopeOf(error: unknown) {
  if (
    error instanceof ApiError ||
    error instanceof IdentityApiError ||
    error instanceof PublicationApiError ||
    error instanceof EventTemplateApiError
  )
    return error.envelope;
  return null;
}

function readableError(error: unknown): string {
  const envelope = envelopeOf(error);
  if (envelope) return `${envelope.error.message} Reference: ${envelope.error.correlationId}`;
  if (error instanceof EventCreationConfigurationError) return error.message;
  return "Something went wrong. Please retry; if it continues, contact support.";
}

class EventCreationConfigurationError extends Error {}

interface NavEntry {
  href: string;
  label: string;
  group: NavGroupName;
  order: number;
  icon: ReactNode;
}

/**
 * Where an invitation link lands.
 *
 * Reachable by every signed-in persona and listed in nobody's sidebar: an invitee is usually
 * being offered a reviewer or speaker role, and those personas can reach neither `/settings` nor
 * the members workspace — which requires `identity:manage`, the thing somebody being invited does
 * not yet have. A permanent nav entry for a once-ever action would be clutter, so the route is
 * addressable without being advertised.
 */
const ACCEPT_INVITATION_PATH = "/invitations/accept";

const organizerHubs: readonly NavEntry[] = [
  {
    href: HUB_PATHS.program,
    label: "Program",
    group: "Program",
    order: 10,
    icon: <IconForm size={16} />,
  },
  {
    href: HUB_PATHS.people,
    label: "People",
    group: "Program",
    order: 20,
    icon: <IconSpeakers size={16} />,
  },
  {
    href: HUB_PATHS.schedule,
    label: "Schedule",
    group: "Program",
    order: 30,
    icon: <IconCalendar size={16} />,
  },
  {
    href: HUB_PATHS.communications,
    label: "Communications",
    group: "Audience",
    order: 40,
    icon: <IconSend size={16} />,
  },
  {
    href: HUB_PATHS.publish,
    label: "Publish",
    group: "Audience",
    order: 50,
    icon: <IconGlobe size={16} />,
  },
  {
    href: HUB_PATHS.settings,
    label: "Settings",
    group: "Audience",
    order: 60,
    icon: <IconSettings size={16} />,
  },
];

/**
 * The persona-specific surfaces the shell owns itself. Organizer job hubs are composed below;
 * every role-specific entry still comes from a domain workspace module.
 *
 * `/` is the shell's because what it shows depends on the persona rather than on a domain.
 */
function shellRoutes(role: WorkspaceRole): NavEntry[] {
  const overview = (label: string): NavEntry => ({
    href: "/",
    label,
    group: "home",
    order: 0,
    icon: <IconDashboard size={16} />,
  });
  if (role === "organizer" || role === "custom") return [overview("Overview")];
  // A reviewer and a speaker land on their own single workspace, so the shell adds nothing.
  if (role === "reviewer" || role === "speaker") return [];
  return [overview("Events")];
}

/** Routes each persona can reach, in sidebar order. The first entry is its home. */
function routesFor(role: WorkspaceRole): NavEntry[] {
  // A custom role is capability-shaped rather than persona-shaped. Its discoverable surface is
  // the organizer catalogue; each module's own capability gate still decides whether it opens.
  if (role === "organizer" || role === "custom") {
    // Search and Inbox are cross-hub utilities rather than another organizer job hub. Keeping
    // their routes discoverable also gives command-palette and overview links a full-page target.
    const utilities = workspacesForPersona("organizer")
      .filter(({ path }) => path === "/search" || path === "/inbox")
      .map((module) => ({
        href: module.path,
        label: module.label,
        group: module.group,
        order: module.order,
        icon: module.icon,
      }));
    return [...shellRoutes(role), ...utilities, ...organizerHubs].sort(
      (left, right) => left.order - right.order,
    );
  }
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
export function App({
  session: probedSession,
  realSession = false,
}: {
  /**
   * The session the landing root already read on this page load, when the console was reached
   * through it. Asking again would be a second round trip for an answer this document is
   * holding, so it is spent once here and never again — every later read (a persona switch, a
   * created event) has to see the session the server has now, not the one it had at boot.
   */
  session?: SessionDto;
  /**
   * A hint from the landing root for the case where the session read has not landed yet.
   *
   * The authority is `session.authentication`, which the server reports on every read — this is
   * only what the shell believes for the frame before the first one arrives. It used to be the
   * authority, and that was wrong twice: a deep link mounts this component directly with nobody
   * to pass it, and on a demo deployment with Google configured it was hard-coded false, so a
   * genuinely signed-in user was never offered a sign-out on any page at all.
   */
  realSession?: boolean;
} = {}) {
  const [session, setSession] = useState<SessionDto | null>(null);
  const probed = useRef(probedSession ?? null);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createOrganizationId, setCreateOrganizationId] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createStartsOn, setCreateStartsOn] = useState("");
  const [createEndsOn, setCreateEndsOn] = useState("");
  const [createMode, setCreateMode] = useState<"empty" | "template">("empty");
  const [createTemplateId, setCreateTemplateId] = useState("");
  const [createTemplates, setCreateTemplates] = useState<EventTemplateDto[]>([]);
  /** Retained after a failed response so retrying one intent adopts the event already written. */
  const createIdempotencyKey = useRef(crypto.randomUUID());
  /*
   * The new event's timezone, asked for rather than assumed.
   *
   * It used to be the literal `America/Los_Angeles` on every create, so an organizer in Berlin
   * got a Pacific event and only found out from the times on the public site. The default is
   * this browser's own zone, which is a guess the organizer can see and change before saving —
   * unlike the constant, which they could not.
   */
  const [createTimezone, setCreateTimezone] = useState(
    () => resolveTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC",
  );
  const [settingsName, setSettingsName] = useState("");
  const [settingsTimezone, setSettingsTimezone] = useState("");
  /** Whatever the server said about `timezone`, rendered on the control it refused. */
  const [timezoneErrors, setTimezoneErrors] = useState<string[]>([]);
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
  /**
   * The command palette is global chrome rather than a route, so the shell owns whether it is
   * open. It is the only surface here that is not a workspace module, and the reason is that a
   * keystroke has to reach it from every one of them.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const path = location.split("?")[0] ?? "/";
  /*
   * The one flag the Google callback sets, and only on the sign-in that provisioned a brand new
   * workspace. It names no identity, it is a same-origin literal in the callback rather than
   * anything the caller supplied, and it lasts exactly as long as the organizer stays on the
   * overview — which is as long as advice about an empty workspace is worth reading.
   */
  const welcome = new URLSearchParams(location.split("?")[1] ?? "").get("welcome") === "1";
  const locationQuery = useMemo(
    () => new URLSearchParams(location.split("?")[1] ?? ""),
    [location],
  );

  const loadShell = useCallback(async () => {
    const primed = probed.current;
    probed.current = null;
    const [currentSession, loadedEvents] = await Promise.all([
      primed ? Promise.resolve(primed) : getSession(),
      listAssignedEvents(),
    ]);
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
        if (envelopeOf(reason)?.error.code !== "UNAUTHORIZED") throw reason;
        setError(readableError(reason));
        setDemoMode((await getAuthConfig()).demoMode);
      })
      .catch((reason: unknown) => setError(readableError(reason)))
      .finally(() => setLoading(false));
  }, [loadShell]);

  const selectedEvent = events.find(({ id }) => id === selectedEventId);
  const query = selectedEventId ? `?event=${selectedEventId}` : "";

  useEffect(() => {
    setSettingsName(selectedEvent?.name ?? "");
    setSettingsTimezone(selectedEvent?.timezone ?? "");
  }, [selectedEvent]);

  useEffect(() => {
    if (!session?.organizations.length) return;
    setCreateOrganizationId((current) => current || session.organizations[0]?.id || "");
  }, [session]);

  useEffect(() => {
    if (createMode !== "template" || !createOrganizationId) return;
    // ERROR-INTENT: the effect cannot return a promise; the chain terminates by rendering any
    // template-list failure through the shell error state below.
    void listEventTemplates(createOrganizationId)
      .then((templates) => {
        const active = templates.filter(({ state }) => state === "active");
        setCreateTemplates(active);
        setCreateTemplateId((current) =>
          active.some(({ id }) => id === current) ? current : (active[0]?.id ?? ""),
        );
      })
      .catch((reason: unknown) => setError(readableError(reason)));
  }, [createMode, createOrganizationId]);

  /**
   * Is there something to sign out *of*?
   *
   * The server answers this on every session read, so the console no longer depends on having
   * been reached through the landing page to know it — a deep link, a reload, and a demo
   * deployment that also offers Google all arrive at the same answer. The prop is the fallback
   * for the frame before the first read lands, and for an API old enough not to send the field.
   */
  const hasAuthenticatedSession = session?.authentication
    ? session.authentication === "session" || session.authentication === "demo"
    : realSession;
  const hasDurableSession = session?.authentication
    ? session.authentication === "session"
    : realSession;

  const activeRole = useMemo<WorkspaceRole>(() => {
    if (!session) return "public";
    const roles = session.eventAccess
      .filter(({ eventId }) => eventId === selectedEventId)
      .map(({ role }) => role);
    if (roles.includes("organizer")) return "organizer";
    if (roles.includes("speaker")) return "speaker";
    return (roles[0] as WorkspaceRole) ?? session.actor.persona;
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

  // Old bookmarks remain useful after the information architecture changes. Preserve all
  // unrelated query state (especially the selected event) while replacing only the tab.
  useEffect(() => {
    if (loading || !session || (activeRole !== "organizer" && activeRole !== "custom")) return;
    const target = hubTabForLegacyPath(path);
    if (!target || path === HUB_PATHS[target.hub]) return;
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    params.set("tab", target.tab);
    navigate(`${HUB_PATHS[target.hub]}?${params.toString()}`, { replace: true });
  }, [activeRole, loading, location, path, session]);

  // A persona that cannot reach the current route lands on its own home rather than
  // an empty frame — switching identity used to leave the page blank.
  useEffect(() => {
    if (loading || !session) return;
    if (path === ACCEPT_INVITATION_PATH) return;
    if (
      allowed.some((route) => route.href === path) ||
      ((activeRole === "organizer" || activeRole === "custom") && hubTabForLegacyPath(path))
    )
      return;
    navigate(`${allowed[0]?.href ?? "/"}${query}`, { replace: true });
  }, [activeRole, allowed, loading, path, query, session]);

  // A failure raised for one surface, or for one event, must not follow the user to the
  // next one — switching event keeps the same path, so both axes have to clear it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing is keyed on the destination.
  useEffect(() => {
    setError(null);
    setAgendaLoadFailure(null);
  }, [path, selectedEventId]);

  // Cmd/Ctrl+K from anywhere in the console. Registered on the document rather than on a
  // container because the point of the shortcut is that no particular surface has to have
  // focus, and cancelled while a text field is not the target would be the wrong rule — an
  // operator typing into the agenda's filter still means "search the event" by this chord.
  //
  // Bound to whether there is an event to search, because the palette is only mounted when
  // there is one: an unconditional handler would swallow the browser's own Cmd+K on an
  // identity with no assigned event and then render nothing, which is worse than not
  // claiming the chord at all.
  useEffect(() => {
    if (!selectedEventId) return;
    function onKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key.toLowerCase() !== "k" || !(keyEvent.metaKey || keyEvent.ctrlKey)) return;
      keyEvent.preventDefault();
      setPaletteOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedEventId]);

  // A palette left open across an event switch would be searching the event the operator just
  // left, and its results would carry the previous event's links.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing is keyed on the destination.
  useEffect(() => setPaletteOpen(false), [selectedEventId]);

  // The aggregate owns the server-assigned public slug, and clears it while events switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clearing is keyed on the destination.
  useEffect(() => setPublication(null), [selectedEventId]);
  const handlePublicationChange = useCallback(
    (summary: { slug: string; state: string } | null) => setPublication(summary),
    [],
  );

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

  /**
   * End a real session and go back to "/".
   *
   * A full document load rather than a client-side navigation: this console is mounted around
   * a session that no longer exists, and "/" has to be decided again from the API rather than
   * re-rendered from state that outlived its cookie.
   */
  async function endSession() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      window.location.assign("/");
    } catch (reason: unknown) {
      setError(readableError(reason));
      setBusy(false);
    }
  }

  /**
   * End every session this account holds, this browser's included, and go back to "/".
   *
   * Same full document load as `endSession`, for the same reason. The count the API answers is
   * deliberately not shown afterwards: the surface that could show it is the one being torn
   * down, and a number on the landing page would outlive the action it describes.
   */
  async function endEverySession() {
    setBusy(true);
    setError(null);
    try {
      await revokeAllSessions();
      window.location.assign("/");
    } catch (reason: unknown) {
      setError(readableError(reason));
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
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    params.set("event", eventId);
    navigate(`${path}?${params.toString()}`, { replace: true });
  }

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const organizationId = createOrganizationId;
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createEvent(
        {
          organizationId,
          name: createName,
          timezone: createTimezone,
        },
        createIdempotencyKey.current,
      );
      let configurationFailure: unknown;
      try {
        await updatePublicationSettings(created.id, {
          slug: createSlug,
          startsOn: createStartsOn,
          endsOn: createEndsOn,
        });
        if (createMode === "template") {
          const detail = await getEventTemplate(createTemplateId);
          const version = detail.versions[0];
          if (!version)
            throw new EventCreationConfigurationError(
              "The selected template has no captured version. Choose another template or create an empty event.",
            );
          const application = await applyEventTemplate(created.id, {
            templateId: detail.template.id,
            version: version.version,
            destination: { startsOn: createStartsOn, endsOn: createEndsOn },
          });
          if (application.outcome !== "applied")
            throw new EventCreationConfigurationError(
              `The event was created, but its template application was ${application.outcome}. Open Templates to repair the reported categories.`,
            );
        }
      } catch (reason) {
        // ERROR-INTENT: retain this failure only until the newly created event is refreshed and
        // selected; it is rethrown into the outer UI error boundary immediately afterward.
        configurationFailure = reason;
      }
      const [refreshedSession, refreshedEvents] = await Promise.all([
        getSession(),
        listAssignedEvents(),
      ]);
      setSession(refreshedSession);
      setEvents(refreshedEvents);
      // Selecting an event means the switcher *and* the address bar, always: a URL still
      // carrying the previous event silently undoes the switch on the next reload or when
      // the link is shared. There is one way to select an event, and this is it.
      selectEvent(created.id);
      if (configurationFailure) throw configurationFailure;
      setCreateName("");
      setCreateSlug("");
      setCreateStartsOn("");
      setCreateEndsOn("");
      setCreateMode("empty");
      setCreateTemplateId("");
      createIdempotencyKey.current = crypto.randomUUID();
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submitSettings(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selectedEvent) return;
    setBusy(true);
    setError(null);
    setTimezoneErrors([]);
    try {
      const updated = await updateEvent(selectedEvent.id, {
        name: settingsName,
        timezone: settingsTimezone,
      });
      setEvents((current) => current.map((event) => (event.id === updated.id ? updated : event)));
      // The server canonicalizes, so the control shows the id that was actually stored rather
      // than the alias that was sent.
      setSettingsTimezone(updated.timezone);
    } catch (reason: unknown) {
      // A refusal the server attached to a field belongs on that field. Anything else stays a
      // page-level message, which is where it was already going.
      setTimezoneErrors(envelopeOf(reason)?.error.fieldErrors?.timezone ?? []);
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
        <div>
          <InstanceMarker />
        </div>
        <PageHeader
          eyebrow="Project Greenroom"
          title={demoMode ? "Demo mode: choose a workspace role" : "Sign in to Greenroom"}
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
              {challenge ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setChallenge("");
                    setCode("");
                    setError(null);
                  }}
                >
                  Request a new code
                </button>
              ) : null}
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

  function renderHubTab(tab: HubTabModule, access: WorkspaceAccess, tabs: readonly HubTabModule[]) {
    if (!selectedEvent) return noAccess;
    const context: WorkspaceContext = {
      ...access,
      event: selectedEvent,
      query,
      agendaLoadFailure,
      reportAgendaLoadFailure,
      onPublicationChange: setPublication,
    };
    const header = tab.header(context);
    const tabItems = tabs.map((item) => {
      const params = new URLSearchParams(locationQuery);
      params.set("tab", item.tab);
      if (selectedEventId) params.set("event", selectedEventId);
      return { id: item.tab, label: item.label, href: `${HUB_PATHS[item.hub]}?${params}` };
    });
    return (
      <>
        <PageHeader {...header} />
        <HubTabs
          items={tabItems}
          active={tab.tab}
          label={`${header.eyebrow ?? header.title} sections`}
        />
        {canOpenTab(tab, access) ? (
          <Fragment key={`${selectedEvent.id}:${tab.hub}:${tab.tab}`}>
            {tab.render(context)}
          </Fragment>
        ) : (
          <Card>
            <EmptyState title="Your role on this event does not include this section">
              Switch to an event you organize, or ask an administrator for the required access.
            </EmptyState>
          </Card>
        )}
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
    const hub = (Object.entries(HUB_PATHS).find(([, hubPath]) => hubPath === path)?.[0] ??
      null) as WorkspaceHub | null;
    if (hub) {
      const tabs = hubTabsFor(hub, activeRole === "custom" ? "organizer" : activeRole);
      const requestedTab = locationQuery.get("tab");
      const persona = activeRole === "custom" ? "organizer" : activeRole;
      const activeTab = hubTabForSelection(hub, requestedTab, persona) ?? tabs[0];
      // The shell still owns event creation state; its settings form is rendered below, now as
      // the Event tab. Every other hub tab is a domain contribution.
      if (activeTab && !(hub === "settings" && activeTab.tab === "event"))
        return renderHubTab(activeTab, access, tabs);
    }
    const workspace = workspaceForPath(path);
    if (workspace)
      return canOpen(workspace, access) ? renderWorkspace(workspace, access) : noAccess;

    // The shell's own two surfaces. A domain adds neither a case here nor an entry above.
    if (path === "/") {
      if (activeRole === "organizer" || activeRole === "custom")
        return (
          <OverviewPage
            event={selectedEvent}
            query={query}
            welcome={welcome}
            onPublicationChange={handlePublicationChange}
          />
        );
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
    // The location's own search string, not the shell's `query` — that one is the selected
    // event, and the token lives in the link the organizer sent.
    if (path === ACCEPT_INVITATION_PATH)
      return <AcceptInvitationPage search={location.split("?")[1] ?? ""} />;
    if (path === "/settings")
      return (
        <>
          <PageHeader
            eyebrow="Settings"
            title="Event settings"
            subtitle={`${selectedEvent.name} · ${selectedEvent.timezone}`}
          />
          <HubTabs
            label="Settings sections"
            active="event"
            items={hubTabsFor("settings", activeRole === "custom" ? "organizer" : activeRole).map(
              (item) => {
                const params = new URLSearchParams(locationQuery);
                params.set("tab", item.tab);
                if (selectedEventId) params.set("event", selectedEventId);
                return { id: item.tab, label: item.label, href: `${HUB_PATHS.settings}?${params}` };
              },
            )}
          />
          {activeEventCapabilities.includes("events:settings:update") ? (
            <Card
              title="Current event"
              hint="Update the name and timezone used throughout this workspace."
              labelledBy="current-event-title"
            >
              <form className="stack settings-event-form" onSubmit={submitSettings}>
                <div className="field">
                  <label htmlFor="settings-event-name">Current event name</label>
                  <input
                    id="settings-event-name"
                    value={settingsName}
                    onChange={(changeEvent) => setSettingsName(changeEvent.target.value)}
                    required
                    maxLength={120}
                  />
                </div>
                <TimezoneField
                  id="settings-event-timezone"
                  value={settingsTimezone}
                  onChange={setSettingsTimezone}
                  errors={timezoneErrors}
                  disabled={busy}
                />
                <button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save event settings"}
                </button>
              </form>
            </Card>
          ) : null}
          {session?.capabilities.includes("events:create") ? (
            <Card
              title="Create another event"
              hint="Start fresh or use a template for the reusable setup."
              labelledBy="create-title"
            >
              <form className="stack settings-event-form" onSubmit={submit}>
                <p className="hint" id="create-event">
                  Proposals, reviews, speakers, files, the agenda, and publication history are
                  never copied from another event.
                </p>
                <div className="field">
                  <label htmlFor="event-organization">Organization</label>
                  <select
                    id="event-organization"
                    value={createOrganizationId}
                    onChange={(event) => setCreateOrganizationId(event.target.value)}
                    required
                  >
                    {session.organizations.map((organization, index) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.id === selectedEvent.organizationId
                          ? "Current organization"
                          : `Organization ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="event-name">Event name</label>
                  <input
                    id="event-name"
                    value={createName}
                    onChange={(changeEvent) => setCreateName(changeEvent.target.value)}
                    placeholder="Greenroom Summit"
                    required
                    maxLength={120}
                  />
                </div>
                {/* Named apart from the settings control above it: both are on this page. */}
                <TimezoneField
                  id="event-timezone"
                  value={createTimezone}
                  onChange={setCreateTimezone}
                  disabled={busy}
                  label="New event timezone"
                  hint="Defaults to this browser's zone. Change it before creating if the event runs elsewhere."
                />
                <div className="field">
                  <label htmlFor="event-slug">Public address</label>
                  <div className="input-prefix">
                    <span aria-hidden="true">/events/</span>
                    <input
                      id="event-slug"
                      value={createSlug}
                      onChange={(event) => setCreateSlug(event.target.value)}
                      placeholder="greenroom-summit"
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      required
                    />
                  </div>
                  <p className="hint">
                    Use lowercase letters, numbers, and hyphens. If this address is already taken,
                    choose another.
                  </p>
                </div>
                <div className="field-grid two">
                  <div className="field">
                    <label htmlFor="event-starts-on">Starts</label>
                    <input
                      id="event-starts-on"
                      type="date"
                      value={createStartsOn}
                      onChange={(event) => setCreateStartsOn(event.target.value)}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="event-ends-on">Ends</label>
                    <input
                      id="event-ends-on"
                      type="date"
                      min={createStartsOn}
                      value={createEndsOn}
                      onChange={(event) => setCreateEndsOn(event.target.value)}
                      required
                    />
                  </div>
                </div>
                <fieldset className="field">
                  <legend>Starting configuration</legend>
                  <label className="choice-row">
                    <input
                      type="radio"
                      name="create-mode"
                      value="empty"
                      checked={createMode === "empty"}
                      onChange={() => setCreateMode("empty")}
                    />
                    Empty event
                  </label>
                  <label className="choice-row">
                    <input
                      type="radio"
                      name="create-mode"
                      value="template"
                      checked={createMode === "template"}
                      onChange={() => setCreateMode("template")}
                    />
                    Apply a selected template
                  </label>
                </fieldset>
                {createMode === "template" ? (
                  <div className="field">
                    <label htmlFor="event-template">Template</label>
                    <select
                      id="event-template"
                      value={createTemplateId}
                      onChange={(event) => setCreateTemplateId(event.target.value)}
                      required
                    >
                      {createTemplates.length ? null : (
                        <option value="">No active templates available</option>
                      )}
                      {createTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                    <p className="hint">
                      The newest version is used. If part of the setup cannot be applied, you can
                      review and retry it from Templates.
                    </p>
                  </div>
                ) : null}
                <button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create event"}
                </button>
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
      {...(session.capabilities.includes("events:create")
        ? { createEventHref: `/settings${query}#create-event` }
        : {})}
      onSwitchPersona={(persona) => {
        // ERROR-INTENT: handlers cannot await; switchPersona renders failures.
        void switchPersona(persona);
      }}
      {...(hasAuthenticatedSession
        ? {
            onSignOut: () => {
              // ERROR-INTENT: handlers cannot await; endSession renders its own failure.
              void endSession();
            },
          }
        : {})}
      {...(hasDurableSession
        ? {
            onSignOutEverywhere: () => {
              // ERROR-INTENT: handlers cannot await; endEverySession renders its own failure.
              void endEverySession();
            },
          }
        : {})}
      {...(selectedEvent ? { onOpenSearch: () => setPaletteOpen(true) } : {})}
      busy={busy}
      groups={groups}
      activePath={path}
      publicHref={publicHref}
      {...(selectedEvent
        ? {
            overlay: (
              <CommandPalette
                eventId={selectedEvent.id}
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
              />
            ),
          }
        : {})}
    >
      {renderPage()}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </AppShell>
  );
}
