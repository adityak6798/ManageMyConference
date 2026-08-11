import type { EventDto, SessionDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AgendaWorkspace } from "./AgendaWorkspace";
import { AppShell, type NavGroup, type Persona } from "./AppShell";
import { CommunicationsApiError } from "./api/communications";
import { ContentApiError } from "./api/content";
import {
  ApiError,
  createEvent,
  getSession,
  listEvents,
  listPublicEvents,
  startDemoSession,
} from "./api/events";
import { CfpWorkspace } from "./CfpWorkspace";
import { CommunicationsWorkspace } from "./CommunicationsWorkspace";
import { ContentWorkspace } from "./ContentWorkspace";
import { CrmWorkspace } from "./CrmWorkspace";
import { OverviewPage } from "./OverviewPage";
import { PublishingWorkspace } from "./PublishingWorkspace";
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "./ReviewWorkspace";
import { getPublicationSummary } from "./api/publication";
import { navigate, useLocation } from "./router";
import "./styles.css";
import {
  IconCalendar,
  IconDashboard,
  IconForm,
  IconGlobe,
  IconReview,
  IconSend,
  IconSessions,
  IconSettings,
  IconSpeakers,
  IconTask,
} from "./ui/icons";
import { Card, EmptyState, Notice, PageHeader } from "./ui/primitives";

const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];

function readableError(error: unknown): string {
  if (
    error instanceof ApiError ||
    error instanceof ContentApiError ||
    error instanceof CommunicationsApiError
  )
    return `${error.message} Reference: ${error.envelope.error.correlationId}`;
  return "Something went wrong. Please retry; if it continues, contact support.";
}

/** Routes each persona can reach, in sidebar order. The first entry is its home. */
function routesFor(role: Persona, capabilities: string[]): { href: string; label: string }[] {
  if (role === "organizer")
    return [
      { href: "/", label: "Overview" },
      { href: "/abstracts", label: "Abstracts" },
      { href: "/sessions", label: "Sessions & speakers" },
      { href: "/agenda", label: "Agenda" },
      { href: "/cfp", label: "Call for proposals" },
      { href: "/speakers", label: "Speaker CRM" },
      { href: "/communications", label: "Communications" },
      { href: "/publishing", label: "Publishing" },
      { href: "/settings", label: "Event settings" },
    ];
  if (role === "reviewer") return [{ href: "/reviews", label: "Review assignments" }];
  if (role === "speaker") return [{ href: "/portal", label: "Speaker portal" }];
  return capabilities.length ? [{ href: "/", label: "Events" }] : [{ href: "/", label: "Events" }];
}

// @spec PRD-EVT-001 PRD-IAM-001 PRD-IAM-002
export function App() {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [publication, setPublication] = useState<{ slug: string; state: string } | null>(null);
  const location = useLocation();
  const path = location.split("?")[0] ?? "/";

  const loadShell = useCallback(async () => {
    const currentSession = await getSession();
    const loadedEvents = currentSession.capabilities.includes("events:read")
      ? await listEvents()
      : currentSession.actor.persona === "public"
        ? await listPublicEvents()
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

  const reportError = useCallback((reason: unknown) => setError(readableError(reason)), []);

  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; the attached handlers render the outcome.
    void loadShell()
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
  // Scoped to the selected event on purpose. The actor-level capability set is the union
  // of every event the actor can touch, so testing it would let an organizer of event A
  // mount event B's workspace and fire its requests.
  const canReadContent = activeEventCapabilities.includes("content:read");

  const allowed = useMemo(
    () => routesFor(activeRole, activeEventCapabilities),
    [activeRole, activeEventCapabilities],
  );

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
  useEffect(() => setError(null), [path, selectedEventId]);

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
      setSelectedEventId(created.id);
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
          title="Choose a demo workspace"
          subtitle="Each seeded identity sees exactly the access its role grants."
        />
        <Card>
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
          {error ? (
            <div style={{ marginTop: "var(--s-4)" }}>
              <Notice tone="error">{error}</Notice>
            </div>
          ) : null}
        </Card>
      </main>
    );

  const icons: Record<string, React.ReactNode> = {
    "/": <IconDashboard size={16} />,
    "/abstracts": <IconReview size={16} />,
    "/sessions": <IconSessions size={16} />,
    "/agenda": <IconCalendar size={16} />,
    "/cfp": <IconForm size={16} />,
    "/speakers": <IconSpeakers size={16} />,
    "/communications": <IconSend size={16} />,
    "/publishing": <IconGlobe size={16} />,
    "/settings": <IconSettings size={16} />,
    "/reviews": <IconReview size={16} />,
    "/portal": <IconTask size={16} />,
  };

  const groups: NavGroup[] =
    activeRole === "organizer"
      ? [
          {
            items: allowed
              .slice(0, 1)
              .map((r) => ({ href: `${r.href}${query}`, label: r.label, icon: icons[r.href] })),
          },
          {
            heading: "Program",
            items: allowed
              .slice(1, 5)
              .map((r) => ({ href: `${r.href}${query}`, label: r.label, icon: icons[r.href] })),
          },
          {
            heading: "Audience",
            items: allowed
              .slice(5)
              .map((r) => ({ href: `${r.href}${query}`, label: r.label, icon: icons[r.href] })),
          },
        ]
      : [
          {
            items: allowed.map((r) => ({
              href: `${r.href}${query}`,
              label: r.label,
              icon: icons[r.href],
            })),
          },
        ];

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
          Switch to an event you organize, or change demo identity from the top right.
        </EmptyState>
      </Card>
    </>
  );

  function renderPage() {
    if (!selectedEvent)
      return (
        <>
          <PageHeader title="No event workspace" />
          <Card>
            <EmptyState title="This identity has no event assigned">
              Switch demo identity from the top right to see an assigned workspace.
            </EmptyState>
          </Card>
        </>
      );

    switch (path) {
      case "/":
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
      case "/cfp":
        return (
          <>
            <PageHeader
              eyebrow="Program"
              title="Call for proposals"
              subtitle="Compose the public submission form, then publish it."
            />
            <CfpWorkspace
              key={`${selectedEvent.id}:${session?.actor.id}:${activeRole}`}
              eventId={selectedEvent.id}
              organizer={activeRole === "organizer"}
            />
          </>
        );
      case "/abstracts":
        return activeEventCapabilities.includes("review:manage") ? (
          <>
            <PageHeader
              eyebrow="Program"
              title="Abstracts"
              subtitle="Triage submissions, assign reviewers, and record decisions."
            />
            <OrganizerReviewWorkspace
              key={`${selectedEventId}:${session?.actor.id}:organizer-review`}
              eventId={selectedEventId}
            />
          </>
        ) : (
          noAccess
        );
      case "/reviews":
        return activeEventCapabilities.includes("review:evaluate") ? (
          <>
            <PageHeader
              eyebrow="Reviewer"
              title="Review assignments"
              subtitle="Score each assigned proposal against the evaluation plan."
            />
            <ReviewerWorkspace
              key={`${selectedEventId}:${session?.actor.id}:reviewer-review`}
              eventId={selectedEventId}
            />
          </>
        ) : (
          noAccess
        );
      case "/sessions":
      case "/portal":
        // The route allowlist redirect is an effect, so it runs *after* children mount and
        // fire their requests. Every workspace must therefore gate on capability itself.
        return canReadContent ? (
          <>
            <PageHeader
              eyebrow={activeRole === "speaker" ? "Speaker" : "Program"}
              title={activeRole === "speaker" ? "Speaker portal" : "Sessions & speakers"}
              subtitle={
                activeRole === "speaker"
                  ? "Your profile, onboarding tasks, private uploads, and sessions."
                  : "Accepted content, speaker records, tasks, and assets."
              }
            />
            <ContentWorkspace
              key={`${selectedEventId}:${session?.actor.id}:${activeRole}`}
              eventId={selectedEventId}
              role={activeRole === "speaker" ? "speaker" : "organizer"}
              onError={reportError}
            />
          </>
        ) : (
          noAccess
        );
      case "/agenda":
        return activeEventCapabilities.includes("agenda:manage") ? (
          <>
            <PageHeader
              eyebrow="Program"
              title="Agenda"
              subtitle="Place sessions across rooms and time slots, then publish the schedule."
            />
            {/* The whole event, not only its id: the board renders every time on its
                grid in the event's own timezone. */}
            <AgendaWorkspace key={selectedEvent.id} event={selectedEvent} onError={setError} />
          </>
        ) : (
          noAccess
        );
      case "/speakers":
        return activeEventCapabilities.includes("crm:manage") ? (
          <>
            <PageHeader
              eyebrow="Audience"
              title="Speaker CRM"
              subtitle="Track prospects through outreach and convert them into speakers."
            />
            <CrmWorkspace eventId={selectedEvent.id} ownerId={session?.actor.id ?? ""} />
          </>
        ) : (
          noAccess
        );
      case "/communications":
        return session?.capabilities.includes("communications:manage") && isEventOrganizer ? (
          <>
            <PageHeader
              eyebrow="Audience"
              title="Communications"
              subtitle="Outbound delivery history with queued, retrying, sent, and failed states."
            />
            <CommunicationsWorkspace event={selectedEvent} onError={reportError} />
          </>
        ) : (
          noAccess
        );
      case "/publishing":
        return activeEventCapabilities.includes("events:settings:read") ? (
          <>
            <PageHeader
              eyebrow="Audience"
              title="Publishing"
              subtitle="Compose the public projection, publish it as an immutable snapshot, and embed it."
            />
            <PublishingWorkspace
              key={`${selectedEvent.id}:${session?.actor.id}`}
              eventId={selectedEvent.id}
              eventName={selectedEvent.name}
              canPublish={activeEventCapabilities.includes("events:settings:update")}
              onPublicationChange={setPublication}
            />
          </>
        ) : (
          noAccess
        );
      case "/settings":
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
      default:
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
