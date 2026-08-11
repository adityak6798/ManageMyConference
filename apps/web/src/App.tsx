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
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "./ReviewWorkspace";
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

  async function switchPersona(persona: Persona) {
    setBusy(true);
    setError(null);
    try {
      await startDemoSession(persona);
      await loadShell();
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
    "/settings": <IconGlobe size={16} />,
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

  const publicHref = selectedEvent ? "/events/greenroom-demo-summit" : null;

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
            <PageHeader title={selectedEvent.name} subtitle="Published event" />
            <Card>
              <EmptyState title="Browse the published event">
                <a href="/events/greenroom-demo-summit">Open the public event page</a>
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
        ) : null;
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
        ) : null;
      case "/sessions":
      case "/portal":
        return (
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
              eventId={selectedEventId}
              role={activeRole === "speaker" ? "speaker" : "organizer"}
              onError={reportError}
            />
          </>
        );
      case "/agenda":
        return activeEventCapabilities.includes("agenda:manage") ? (
          <>
            <PageHeader
              eyebrow="Program"
              title="Agenda"
              subtitle="Place sessions across rooms and time slots, then publish the schedule."
            />
            <AgendaWorkspace key={selectedEvent.id} eventId={selectedEvent.id} onError={setError} />
          </>
        ) : null;
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
        ) : null;
      case "/communications":
        return session?.capabilities.includes("communications:manage") ? (
          <>
            <PageHeader
              eyebrow="Audience"
              title="Communications"
              subtitle="Outbound delivery history with queued, retrying, sent, and failed states."
            />
            <CommunicationsWorkspace event={selectedEvent} onError={reportError} />
          </>
        ) : null;
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
