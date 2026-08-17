import {
  type EventDto,
  type EventTemplateDto,
  type InboxResponseDto,
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
import { AppShell, type NavGroup, type Persona, ShellSkeleton } from "./AppShell";
import { type ApiFailure, describeApiFailure } from "./api/config";
import {
  applyEventTemplate,
  EventTemplateApiError,
  getEventTemplate,
  listEventTemplates,
} from "./api/event-templates";
import { ApiError, createEvent, listAssignedEvents } from "./api/events";
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
import { getInbox } from "./api/platform";
import { PublicationApiError, updatePublicationSettings } from "./api/publication";
import { CommandPalette } from "./CommandPalette";
import { TimezoneField } from "./events/TimezoneField";
import { InstanceMarker } from "./InstanceMarker";
import { OverviewPage } from "./OverviewPage";
import { navigate, useLinkProps, useLocation } from "./router";
import "./styles.css";
import {
  IconBroadcast,
  IconCalendar,
  IconDashboard,
  IconForm,
  IconPlus,
  IconSend,
  IconSettings,
  IconSpeakers,
  IconWarning,
} from "./ui/icons";
import { Card, EmptyState, HubTabs, Notice, PageHeader, Refusal } from "./ui/primitives";
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
  NAV_GROUP_LABELS,
  NAV_GROUP_ORDER,
  workspaceForPath,
  workspacesForPersona,
} from "./workspaces/registry";

const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];

/**
 * The envelope behind a refusal, whichever client raised it.
 *
 * Only the unauthorized branch below still needs the code rather than the sentence;
 * `describeApiFailure` reads both shapes structurally for everything else.
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

class EventCreationConfigurationError extends Error {}

/**
 * One voice for every failure the shell owns, with the reference kept out of the sentence.
 *
 * `EventCreationConfigurationError` is the shell's own: it carries a sentence written for the
 * reader and no correlation id, because nothing went wrong on the wire — the event was created
 * and the configuration that was meant to follow it could not be.
 */
function describeShellFailure(reason: unknown, fallback: string): ApiFailure {
  if (reason instanceof EventCreationConfigurationError)
    return { message: reason.message, reference: null };
  return describeApiFailure(reason, fallback);
}

const UNEXPECTED = "Something went wrong. Please retry; if it continues, contact support.";

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

/**
 * Creating an event is a destination, not an anchor.
 *
 * It used to be `/settings#create-event`, which could not work: `navigate` strips the hash and
 * then scrolls to the top, so the link went to Settings and left the reader looking at a
 * different form, and pressing it again stacked a duplicate history entry each time.
 */
const NEW_EVENT_PATH = "/events/new";

const organizerHubs: readonly NavEntry[] = [
  {
    href: HUB_PATHS.program,
    label: "Program",
    group: "operate",
    order: 10,
    icon: <IconForm />,
  },
  {
    href: HUB_PATHS.people,
    label: "People",
    group: "operate",
    order: 20,
    icon: <IconSpeakers />,
  },
  {
    href: HUB_PATHS.schedule,
    label: "Schedule",
    group: "operate",
    order: 30,
    icon: <IconCalendar />,
  },
  {
    href: HUB_PATHS.communications,
    label: "Communications",
    group: "reach",
    order: 40,
    icon: <IconSend />,
  },
  {
    href: HUB_PATHS.publish,
    label: "Publish",
    group: "reach",
    order: 50,
    icon: <IconBroadcast />,
  },
  {
    href: HUB_PATHS.settings,
    label: "Settings",
    group: "admin",
    order: 100,
    icon: <IconSettings />,
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
    icon: <IconDashboard />,
  });
  if (role === "organizer" || role === "custom") return [overview("Overview")];
  // A reviewer and a speaker land on their own single workspace, so the shell adds nothing.
  if (role === "reviewer" || role === "speaker") return [];
  return [overview("Events")];
}

/** Routes each persona can reach, in sidebar order. The first entry is its home. */
function routesFor(role: WorkspaceRole, canCreateEvent = false): NavEntry[] {
  // A custom role is capability-shaped rather than persona-shaped. Its discoverable surface is
  // the organizer catalogue; each module's own capability gate still decides whether it opens.
  if (role === "organizer" || role === "custom") {
    /*
     * Inbox and Reports are cross-hub utilities rather than another organizer job hub: one is
     * everything waiting, the other is a question asked of the whole event.
     *
     * `/search` is deliberately absent. It answers exactly the question the command palette
     * answers, from a keystroke available on every surface, and a second permanent nav item for
     * it only cost a row — the palette's "see all results" now carries the reader to the page.
     */
    const utilities = workspacesForPersona("organizer")
      .filter(({ path }) => path === "/inbox" || path === "/reports")
      .map((module) => ({
        href: module.path,
        label: module.label,
        group: module.group,
        order: module.order,
        icon: module.icon,
      }));
    const create: NavEntry[] = canCreateEvent
      ? [
          {
            href: NEW_EVENT_PATH,
            label: "Create another event",
            group: "admin",
            order: 90,
            icon: <IconPlus />,
          },
        ]
      : [];
    return [...shellRoutes(role), ...utilities, ...organizerHubs, ...create].sort(
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

type WaitingCounts = { inbox: number; program: number; schedule: number };

/** What the inbox says is still open, folded onto the destinations that can act on it. */
function countWaiting(answer: InboxResponseDto): WaitingCounts {
  const open = (key: keyof InboxResponseDto["categories"]) => {
    const category = answer.categories[key];
    return category.state === "ok"
      ? category.items.filter((item) => item.status === "open").length
      : 0;
  };
  const categories = Object.keys(answer.categories) as (keyof InboxResponseDto["categories"])[];
  return {
    inbox: categories.reduce((total, key) => total + open(key), 0),
    // Proposals waiting on a decision are Program's job; an unplaced session or a clash is
    // Schedule's. Nothing else in the inbox maps onto a single destination, so nothing else
    // gets a badge — a number beside a nav item is a promise that opening it shows those items.
    program: open("reviews"),
    schedule: open("programme"),
  };
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
  // The shell reports its own failures and no one else's: signing in, switching identity,
  // creating an event. It starts and finishes each of those, so it can keep the message
  // accurate by itself. A workspace that is mounted owns its failures — it renders them
  // beside the control that caused them, or, when a load fails, in place of itself.
  const [error, setError] = useState<ApiFailure | null>(null);
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
  /** What is waiting on this event, for the counts beside the nav items. */
  const [waiting, setWaiting] = useState<WaitingCounts | null>(null);
  /**
   * The command palette is global chrome rather than a route, so the shell owns whether it is
   * open. It is the only surface here that is not a workspace module, and the reason is that a
   * keystroke has to reach it from every one of them.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const linkProps = useLinkProps();
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

  /** A workspace renamed the event, or moved it to another zone. */
  const applyEventChange = useCallback((updated: EventDto) => {
    setEvents((current) =>
      current.map((event) => (event.id === updated.id ? { ...event, ...updated } : event)),
    );
  }, []);

  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; the attached handlers render the outcome.
    void loadShell()
      .catch(async (reason: unknown) => {
        if (envelopeOf(reason)?.error.code !== "UNAUTHORIZED") throw reason;
        setError(describeShellFailure(reason, UNEXPECTED));
        setDemoMode((await getAuthConfig()).demoMode);
      })
      .catch((reason: unknown) => setError(describeShellFailure(reason, UNEXPECTED)))
      .finally(() => setLoading(false));
  }, [loadShell]);

  const selectedEvent = events.find(({ id }) => id === selectedEventId);
  const query = selectedEventId ? `?event=${selectedEventId}` : "";

  /*
   * What is waiting, read once per event.
   *
   * The badge is declared, rendered and styled by the shell, and until now nobody ever supplied
   * one — so from anywhere but the Overview nothing told an organizer that eleven proposals were
   * waiting on them.
   */
  useEffect(() => {
    if (!selectedEventId || !session) {
      setWaiting(null);
      return;
    }
    let live = true;
    // A count is an accelerant, never the thing itself: a summary that does not come back leaves
    // the nav items unbadged and the console entirely usable.
    // ERROR-INTENT: reporting it would put a failure on screen about a number nobody asked for.
    void getInbox(selectedEventId)
      .then((answer) => {
        if (live) setWaiting(countWaiting(answer));
      })
      .catch(() => {
        if (live) setWaiting(null);
      });
    return () => {
      live = false;
    };
  }, [selectedEventId, session]);

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
      .catch((reason: unknown) =>
        setError(describeShellFailure(reason, "The template list could not be read.")),
      );
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
  /**
   * Whether identity can be switched at all.
   *
   * The switcher POSTs `/api/demo-session`, which answers 404 whenever DEMO_MODE is off — so on
   * a real deployment the most prominent control in the topbar returned "The requested resource
   * was not found." with a correlation id to an organizer who had not asked to become anybody.
   */
  const canSwitchPersona = session?.authentication === "demo";

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
  const canCreateEvent = Boolean(session?.capabilities.includes("events:create"));
  const allowed = useMemo(
    () => routesFor(activeRole, canCreateEvent),
    [activeRole, canCreateEvent],
  );

  /**
   * A legacy path that is about to become a hub URL.
   *
   * `renderPage` returns nothing while this is true. `/cfp` resolves through
   * `workspaceForPath`, so the console used to mount CfpWorkspace, fire its three reads, and
   * only then run the effect below — which navigates to `/program?tab=forms` and mounts the
   * whole thing again. One guard covers every caller, including the hrefs the API mints for
   * inbox items and search hits, without touching the API.
   */
  const pendingRedirect =
    (activeRole === "organizer" || activeRole === "custom") && !loading && session !== null
      ? hubTabForLegacyPath(path)
      : undefined;
  const redirecting = Boolean(pendingRedirect && path !== HUB_PATHS[pendingRedirect.hub]);

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
    // Not gated on the capability: an account that cannot create events is told so, by name,
    // rather than bounced to its home with nothing said.
    if (path === NEW_EVENT_PATH) return;
    /*
     * A route this persona's own module registered, whether or not the sidebar offers it.
     *
     * `allowed` is the *navigation* list, and using it as the reachability rule made every
     * addressable-but-unadvertised destination a dead end. `/search` is the one that mattered:
     * it is deliberately absent from the sidebar because the command palette answers the same
     * question from a keystroke — and the palette's own "See all results for …" option, the only
     * advertised way in, redirected to the overview. `renderPage` already refuses a module this
     * account cannot open by name, which is the answer a refusal owes the reader.
     */
    const addressable = workspaceForPath(path);
    const persona = activeRole === "custom" ? "organizer" : activeRole;
    if (
      allowed.some((route) => route.href === path) ||
      addressable?.personas.includes(persona as never) ||
      ((activeRole === "organizer" || activeRole === "custom") && hubTabForLegacyPath(path))
    )
      return;
    navigate(`${allowed[0]?.href ?? "/"}${query}`, { replace: true });
  }, [activeRole, allowed, loading, path, query, session]);

  // Creating an event is a form, and a form that is a destination owes the reader its first
  // field. The old `#create-event` anchor could not do this: `navigate` drops the hash.
  useEffect(() => {
    if (path !== NEW_EVENT_PATH) return;
    const focus = requestAnimationFrame(() => document.getElementById("event-name")?.focus());
    return () => cancelAnimationFrame(focus);
  }, [path]);

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
      // The whole workspace changes underneath, so move focus to the destination rather than
      // leaving keyboard and screen-reader users at the top of the document.
      requestAnimationFrame(() => {
        const main = document.getElementById("main");
        main?.setAttribute("tabindex", "-1");
        main?.focus({ preventScroll: true });
      });
    } catch (reason: unknown) {
      setError(describeShellFailure(reason, "The signed-in role could not be changed."));
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
      setError(describeShellFailure(reason, "You could not be signed out."));
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
      setError(describeShellFailure(reason, "The other sessions could not be ended."));
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
      setError(describeShellFailure(reason, "You could not be signed in."));
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
      setError(describeShellFailure(reason, "That event could not be created."));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <ShellSkeleton />;

  if (!session)
    return (
      <main className="page-body" style={{ maxWidth: 560, margin: "12vh auto" }}>
        <div>
          <InstanceMarker />
        </div>
        <PageHeader
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
                  className="secondary"
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
                  className="control"
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
              <button className="primary" type="submit" disabled={busy}>
                {challenge ? "Sign in" : "Email me a code"}
              </button>
              {challenge ? (
                <button
                  className="secondary"
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
              <Notice tone="error" reference={error.reference}>
                {error.message}
              </Notice>
            </div>
          ) : null}
        </Card>
      </main>
    );

  /*
   * An attendee identity gets a page, not a console.
   *
   * Every block of the shell — the nav, the event chip, the palette — is chrome for work this
   * account cannot do, and rendering it around a single refusal is the console telling somebody
   * they are nearly an organizer. They are not; they are in the wrong place, and the useful
   * thing is to say which access is missing and offer the way out.
   */
  if (activeRole === "public")
    return (
      <main className="page-body public-landing" id="main" tabIndex={-1}>
        <div className="brandmark">
          <span className="glyph" aria-hidden="true">
            G
          </span>
          <span className="wordmark">Greenroom</span>
        </div>
        <Card>
          <Refusal
            title="This account has no organizer workspace"
            capability="a seat on an event"
            grantedBy="An organizer of that event"
            action={
              hasAuthenticatedSession ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; endSession renders its own failure.
                    void endSession();
                  }}
                >
                  Sign out
                </button>
              ) : null
            }
          >
            An event's public schedule, sessions, speakers and call for proposals are published at
            their own address and need no account at all.
          </Refusal>
        </Card>
        {error ? (
          <Notice tone="error" reference={error.reference}>
            {error.message}
          </Notice>
        ) : null}
      </main>
    );

  // Each entry carries its own group and icon, so the sidebar is grouped by what a workspace
  // declares rather than by slicing a hand-ordered array at hard-coded indices.
  // Zero is not a count worth drawing: the badge means "this needs you", and a nav item
  // permanently reading 0 is the console asking to be ignored.
  const countFor = (href: string): number | undefined => {
    if (!waiting) return undefined;
    if (href === "/inbox") return waiting.inbox || undefined;
    if (href === HUB_PATHS.program) return waiting.program || undefined;
    if (href === HUB_PATHS.schedule) return waiting.schedule || undefined;
    return undefined;
  };
  const groups: NavGroup[] = NAV_GROUP_ORDER.flatMap((name) => {
    const items = allowed
      .filter((route) => route.group === name)
      .map((route) => {
        const count = countFor(route.href);
        return {
          href: `${route.href}${query}`,
          label: route.label,
          icon: route.icon,
          ...(count === undefined ? {} : { count }),
        };
      });
    if (items.length === 0) return [];
    const heading = NAV_GROUP_LABELS[name];
    return [
      {
        ...(heading ? { heading } : {}),
        ...(name === "admin" ? { pinned: true } : {}),
        items,
      },
    ];
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
        <Refusal
          title="Your role on this event does not open this workspace"
          capability="a role that includes this workspace"
          grantedBy="An organizer of this event"
        >
          Switch to an event you organize, or ask an organizer for the access.
        </Refusal>
      </Card>
    </>
  );

  function workspaceContext(access: WorkspaceAccess, event: EventDto): WorkspaceContext {
    return {
      ...access,
      event,
      query,
      agendaLoadFailure,
      reportAgendaLoadFailure,
      onPublicationChange: setPublication,
      onEventChanged: applyEventChange,
    };
  }

  /** Render a domain's workspace behind the header it declares for itself. */
  function renderWorkspace(workspace: WorkspaceModule, access: WorkspaceAccess) {
    if (!selectedEvent) return noAccess;
    const context = workspaceContext(access, selectedEvent);
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
    const context = workspaceContext(access, selectedEvent);
    const header = tab.header(context);
    const tabItems = tabs.map((item) => {
      const params = new URLSearchParams(locationQuery);
      params.set("tab", item.tab);
      if (selectedEventId) params.set("event", selectedEventId);
      return { id: item.tab, label: item.label, href: `${HUB_PATHS[item.hub]}?${params}` };
    });
    return (
      <>
        {/*
          No eyebrow. The hub is already named twice above this line — by the current sidebar
          item and by the selected tab — and a third copy of the word in small grey type over
          the page title is the ornament this rebuild exists to remove. The field stays on
          `WorkspaceHeader` so no domain module has to be edited, and it still names the tab
          strip for a reader who cannot see where they are.
        */}
        <PageHeader
          title={header.title}
          {...(header.subtitle ? { subtitle: header.subtitle } : {})}
        />
        {/*
          A strip of one is not a choice. Communications has exactly one visible tab, and the
          strip drew a lone selected chip under the page title that looked pressable and did
          nothing — a control offering the destination the reader is already standing on.
        */}
        {tabItems.length > 1 ? (
          <HubTabs
            items={tabItems}
            active={tab.tab}
            label={`${header.eyebrow ?? header.title} sections`}
          />
        ) : null}
        {canOpenTab(tab, access) ? (
          <Fragment key={`${selectedEvent.id}:${tab.hub}:${tab.tab}`}>
            {tab.render(context)}
          </Fragment>
        ) : (
          <Card>
            <Refusal
              title="Your role on this event does not open this section"
              capability="a role that includes this section"
              grantedBy="An organizer of this event"
            >
              Switch to an event you organize, or ask an organizer for the access.
            </Refusal>
          </Card>
        )}
      </>
    );
  }

  /**
   * Name an organization the reader can recognise.
   *
   * "Organization 2" was the console reading out an array index. The session payload carries
   * organization *ids* and no names — that is the contract, not an oversight here — so the
   * useful name is the one the reader already knows: the event they are in, or an event they
   * already have in that organization. The id is the last resort, and it is truncated because
   * a full UUID in an option label is not a name either.
   */
  function organizationLabel(organizationId: string) {
    if (selectedEvent && organizationId === selectedEvent.organizationId)
      return "Current organization";
    const sibling = events.find((event) => event.organizationId === organizationId);
    return sibling
      ? `The organization behind ${sibling.name}`
      : `Organization ${organizationId.slice(0, 8)}`;
  }

  function renderCreateEvent() {
    if (!session?.capabilities.includes("events:create"))
      return (
        <>
          <PageHeader title="Create an event" />
          <Card>
            <Refusal
              capability="permission to create events"
              grantedBy="An organization owner"
              title="This account cannot create events"
            >
              Every other event you already have a seat on stays reachable from the switcher at the
              top of the console.
            </Refusal>
          </Card>
        </>
      );
    return (
      <>
        <PageHeader
          title="Create an event"
          subtitle="Proposals, reviews, speakers, files, the agenda, and publication history are never copied from another event."
        />
        <Card>
          <form className="stack settings-event-form" onSubmit={submit}>
            {/*
              Offered only when there is a choice to make. One organization is not a decision,
              and a select with one option is a control that teaches the reader nothing.
            */}
            {session.organizations.length > 1 ? (
              <div className="field">
                <label htmlFor="event-organization">Organization</label>
                <select
                  id="event-organization"
                  className="control"
                  value={createOrganizationId}
                  onChange={(event) => setCreateOrganizationId(event.target.value)}
                  required
                >
                  {session.organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organizationLabel(organization.id)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="event-name">Event name</label>
              <input
                id="event-name"
                className="control"
                value={createName}
                onChange={(changeEvent) => setCreateName(changeEvent.target.value)}
                placeholder="Greenroom Summit"
                required
                maxLength={120}
              />
            </div>
            <TimezoneField
              id="event-timezone"
              value={createTimezone}
              onChange={setCreateTimezone}
              disabled={busy}
              label="Event timezone"
              hint="Defaults to this browser's zone. Change it before creating if the event runs elsewhere."
            />
            <div className="field">
              <label htmlFor="event-slug">Public address</label>
              <div className="input-prefix">
                <span aria-hidden="true">/events/</span>
                <input
                  id="event-slug"
                  className="control"
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
                  className="control"
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
                  className="control"
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
                  className="control"
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
                  The newest version is used. If part of the setup cannot be applied, you can review
                  and retry it from Templates.
                </p>
              </div>
            ) : null}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create event"}
            </button>
          </form>
        </Card>
      </>
    );
  }

  function renderPage() {
    // The location's own search string, not the shell's `query` — that one is the selected
    // event, and the token lives in the link the organizer sent. Answered before the
    // no-event guard below, because the majority invitee has no event yet: they used to be
    // told to "switch the signed-in role from the top right", where there is no role to
    // switch to, and this page was dead code for exactly the people it was written for.
    if (path === ACCEPT_INVITATION_PATH)
      return (
        <AcceptInvitationPage
          search={location.split("?")[1] ?? ""}
          durableSession={hasDurableSession}
        />
      );

    // A legacy path is one effect away from being a hub URL. Mounting the old workspace for a
    // frame fires its reads and then throws them away.
    if (redirecting) return null;

    if (path === NEW_EVENT_PATH) return renderCreateEvent();

    if (!selectedEvent)
      return (
        <>
          <PageHeader title="No event workspace" />
          <Card>
            <EmptyState
              icon={<IconCalendar size={20} />}
              title="This account has no event assigned"
              action={
                canCreateEvent ? (
                  <a className="btn primary" {...linkProps(NEW_EVENT_PATH)}>
                    Create an event
                  </a>
                ) : null
              }
            >
              An organizer of an existing event can invite you to it, or you can start one of your
              own.
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
      // Every hub tab is a domain contribution, Settings > Event included. The shell used to
      // keep an escape hatch here and render a second copy of that form from its own state —
      // one without the success announcement and without the empty-name guard, which is why
      // saving an event name looked like it had done nothing.
      if (activeTab) return renderHubTab(activeTab, access, tabs);
    }
    const workspace = workspaceForPath(path);
    if (workspace)
      return canOpen(workspace, access) ? renderWorkspace(workspace, access) : noAccess;

    // The shell's own surface. A domain adds neither a case here nor an entry above.
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
      // A reviewer or a speaker has no overview; the allowlist redirect below is one effect
      // away from their own workspace. Mounting the organizer dashboard for that frame would
      // fire its whole fan-out at an identity that cannot read any of it.
      return null;
    }

    return (
      <>
        <PageHeader title="Page not found" />
        <Card>
          <EmptyState icon={<IconWarning size={20} />} title="That workspace does not exist">
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
      demoMode={canSwitchPersona}
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
      {...(error
        ? {
            alert: (
              <Notice
                tone="error"
                reference={error.reference}
                onDismiss={() => setError(null)}
                dismissLabel="Dismiss this message"
              >
                {error.message}
              </Notice>
            ),
          }
        : {})}
      {...(selectedEvent
        ? {
            overlay: (
              <CommandPalette
                eventId={selectedEvent.id}
                access={{
                  session,
                  activeRole,
                  capabilities: activeEventCapabilities,
                  isEventOrganizer,
                }}
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
              />
            ),
          }
        : {})}
    >
      {renderPage()}
    </AppShell>
  );
}
