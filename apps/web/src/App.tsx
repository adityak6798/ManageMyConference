import type { EventDto } from "@greenroom/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, createEvent, listEvents, startDemoSession } from "./api/events";
import "./styles.css";

function readableError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} Reference: ${error.envelope.error.correlationId}`;
  }
  return "Something went wrong. Please retry; if it continues, contact support.";
}

// @spec PRD-EVT-001 PRD-IAM-002
export function App() {
  const [events, setEvents] = useState<EventDto[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; the attached rejection handler renders the failure.
    void listEvents()
      .then((loadedEvents) => {
        setEvents(loadedEvents);
        setSignedIn(true);
      })
      .catch((reason: unknown) => setError(readableError(reason)));
  }, []);

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createEvent({ name, timezone: "America/Los_Angeles" });
      setEvents(await listEvents());
      setName("");
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await startDemoSession("organizer");
      setSignedIn(true);
      setEvents(await listEvents());
    } catch (reason: unknown) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header>
        <p className="eyebrow">Project Greenroom</p>
        <h1>Your events</h1>
        <p>Create the conference workspace that will carry a proposal all the way to the stage.</p>
      </header>

      <section aria-labelledby="create-title">
        <h2 id="create-title">Create an event</h2>
        {!signedIn ? (
          <button type="button" onClick={signIn} disabled={busy}>
            Continue as demo organizer
          </button>
        ) : null}
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
            <button type="submit" disabled={busy || !signedIn}>
              {busy ? "Creating…" : "Create event"}
            </button>
          </div>
        </form>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="events-title">
        <h2 id="events-title">Event workspaces</h2>
        {events.length === 0 ? (
          <p className="empty">No events yet. Create the first workspace above.</p>
        ) : (
          <ul>
            {events.map((event) => (
              <li key={event.id}>
                <strong>{event.name}</strong>
                <span>{event.timezone}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
