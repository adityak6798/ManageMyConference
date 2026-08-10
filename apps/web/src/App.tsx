import type { EventDto, SessionDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createEvent, getSession, listEvents, startDemoSession } from "./api/events";
import "./styles.css";
import { CrmWorkspace } from "./CrmWorkspace";

type Persona = "organizer" | "reviewer" | "speaker" | "public";
const personas: Persona[] = ["organizer", "reviewer", "speaker", "public"];
const navByRole: Record<Persona, string[]> = {
  organizer: ["Overview", "Event settings", "People", "Publishing"],
  reviewer: ["Review assignments"],
  speaker: ["Speaker tasks", "My sessions"],
  public: ["Published event"],
};

function readableError(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message} Reference: ${error.envelope.error.correlationId}`;
  return "Something went wrong. Please retry; if it continues, contact support.";
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

  const loadShell = useCallback(async () => {
    const currentSession = await getSession();
    const loadedEvents = currentSession.capabilities.includes("events:read")
      ? await listEvents()
      : [];
    setSession(currentSession);
    setEvents(loadedEvents);
    setSelectedEventId((current) => current || loadedEvents[0]?.id || "");
  }, []);

  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; the attached handlers render the outcome.
    void loadShell()
      .catch((reason: unknown) => setError(readableError(reason)))
      .finally(() => setLoading(false));
  }, [loadShell]);

  const selectedEvent = events.find(({ id }) => id === selectedEventId);
  const activeRole = useMemo<Persona>(() => {
    if (!session) return "public";
    return (
      session.eventAccess.find(({ eventId }) => eventId === selectedEventId)?.role ??
      session.actor.persona
    );
  }, [selectedEventId, session]);

  async function switchPersona(persona: Persona) {
    setBusy(true);
    setError(null);
    try {
      await startDemoSession(persona);
      setSelectedEventId("");
      await loadShell();
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const organizationId = session?.organizations[0]?.id;
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      const event = await createEvent({ organizationId, name, timezone: "America/Los_Angeles" });
      setEvents(await listEvents());
      setSelectedEventId(event.id);
      setName("");
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main>
        <p role="status" className="state-card">
          Loading your workspace…
        </p>
      </main>
    );

  return (
    <main>
      <header className="masthead">
        <div>
          <p className="eyebrow">Project Greenroom</p>
          <h1>Conference operations</h1>
        </div>
        <label className="identity-switcher">
          Demo identity
          <select
            aria-label="Demo identity"
            value={session?.actor.persona ?? ""}
            disabled={busy}
            onChange={(event) => {
              // ERROR-INTENT: React event handlers cannot await; switchPersona renders failures.
              void switchPersona(event.target.value as Persona);
            }}
          >
            <option value="" disabled>
              Choose a role
            </option>
            {personas.map((persona) => (
              <option key={persona} value={persona}>
                {persona.charAt(0).toUpperCase() + persona.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && !session ? (
        <section className="state-card">
          <h2>Choose a demo workspace</h2>
          <p>Use a seeded identity to see the exact access available to each role.</p>
          <div className="persona-actions">
            {personas.map((persona) => (
              <button
                key={persona}
                type="button"
                disabled={busy}
                onClick={() => {
                  // ERROR-INTENT: React event handlers cannot await; switchPersona renders failures.
                  void switchPersona(persona);
                }}
              >
                Continue as {persona}
              </button>
            ))}
          </div>
          <p role="alert" className="error">
            {error}
          </p>
        </section>
      ) : null}

      {session ? (
        <div className="shell">
          <aside>
            <p className="signed-in">
              Signed in as <strong>{session.actor.name}</strong>
              <span>{activeRole}</span>
            </p>
            <label htmlFor="event-switcher">Event workspace</label>
            <select
              id="event-switcher"
              value={selectedEventId}
              onChange={(event) => setSelectedEventId(event.target.value)}
            >
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
            <nav aria-label="Workspace navigation">
              <ul>
                {navByRole[activeRole].map((item) => (
                  <li key={item}>
                    <a href={`#${item.toLowerCase().replaceAll(" ", "-")}`}>{item}</a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
          <div className="workspace">
            <section>
              <p className="eyebrow">{activeRole} workspace</p>
              <h2>{selectedEvent?.name ?? "No accessible events"}</h2>
              {selectedEvent ? (
                <p>{selectedEvent.timezone}</p>
              ) : (
                <p className="empty">This identity has no event workspace assigned.</p>
              )}
            </section>
            {session.capabilities.includes("events:create") ? (
              <section aria-labelledby="create-title">
                <h2 id="create-title">Create an event</h2>
                <form onSubmit={submit}>
                  <label htmlFor="event-name">Event name</label>
                  <div className="form-row">
                    <input
                      id="event-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Greenroom Summit"
                      required
                      maxLength={120}
                    />
                    <button type="submit" disabled={busy}>
                      {busy ? "Creating…" : "Create event"}
                    </button>
                  </div>
                </form>
              </section>
            ) : (
              <section className="denied">
                <h2>Role-limited access</h2>
                <p>
                  You can use the navigation for your assigned work. Organization and event settings
                  stay restricted to organizers.
                </p>
              </section>
            )}
            {selectedEvent &&
            session.capabilities.includes("crm:manage") &&
            session.eventAccess
              .find(({ eventId }) => eventId === selectedEvent.id)
              ?.capabilities.includes("crm:manage") ? (
              <CrmWorkspace eventId={selectedEvent.id} ownerId={session.actor.id} />
            ) : null}
            {error ? (
              <p role="alert" className="error">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
