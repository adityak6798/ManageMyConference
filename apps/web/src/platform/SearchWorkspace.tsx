/**
 * The full-page search surface behind `/search`.
 *
 * The palette and this page answer the same question and read the same route; what differs is
 * what they are for. The palette is a keystroke that gets an operator out of where they are,
 * so it is a single list optimized for Arrow-and-Enter. This is a linkable, reloadable surface
 * an organizer can leave open while they work through what it found, so it keeps the sections
 * apart, names the ones their role cannot read, and renders every hit as a real anchor that
 * middle-click and "open in new tab" both honour.
 *
 * @spec PRD-OPS-001
 */
import {
  SEARCH_QUERY_MIN_LENGTH,
  type SearchResponseDto,
  type SearchResultDto,
  type SearchSectionKey,
} from "@greenroom/contracts";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { ResponseContractError } from "../api/config";
import { PlatformApiError, searchEvent } from "../api/platform";
import { useLinkProps } from "../router";
import { Card, EmptyState, Notice, Pill } from "../ui/primitives";

const SECTION_LABELS: Readonly<Record<SearchSectionKey, string>> = {
  content: "Sessions, speakers and tasks",
  review: "Proposals",
  agenda: "Agenda",
  communications: "Deliveries",
  crm: "Contacts",
};

const SECTION_ORDER: readonly SearchSectionKey[] = [
  "content",
  "review",
  "agenda",
  "communications",
  "crm",
];

const KIND_LABELS: Readonly<Record<SearchResultDto["kind"], string>> = {
  session: "Session",
  speaker: "Speaker",
  proposal: "Proposal",
  task: "Task",
  "agenda-item": "Agenda",
  delivery: "Delivery",
  contact: "Contact",
};

function describeFailure(reason: unknown): string {
  if (reason instanceof PlatformApiError)
    return `${reason.envelope.error.message} Reference: ${reason.envelope.error.correlationId}`;
  if (reason instanceof ResponseContractError) return reason.message;
  return "Search is unavailable right now. Please retry.";
}

export function SearchWorkspace({ eventId }: { eventId: string }) {
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState<SearchResponseDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submitted rather than typed, so an explicit search is one request. Answers are still
  // numbered: two submissions in quick succession can land out of order.
  const issued = useRef(0);
  const linkProps = useLinkProps();

  // Nothing here clears itself when the event changes, and nothing needs to: the shell renders
  // each workspace keyed by the selected event, so switching remounts this with empty state
  // rather than leaving the previous event's hits — and their previous event's links — on screen.

  const run = useCallback(
    async (query: string) => {
      const generation = ++issued.current;
      setBusy(true);
      setError(null);
      try {
        const result = await searchEvent(eventId, query);
        if (generation === issued.current) setAnswer(result);
      } catch (reason: unknown) {
        if (generation === issued.current) {
          setAnswer(null);
          setError(describeFailure(reason));
        }
      } finally {
        if (generation === issued.current) setBusy(false);
      }
    },
    [eventId],
  );

  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const query = draft.trim();
    if (query.length < SEARCH_QUERY_MIN_LENGTH) {
      setAnswer(null);
      setError(`Search for at least ${SEARCH_QUERY_MIN_LENGTH} characters.`);
      return;
    }
    // ERROR-INTENT: handlers cannot await; run() renders both outcomes into its own state.
    void run(query);
  }

  const unauthorized = answer
    ? SECTION_ORDER.filter((key) => answer.sections[key].state === "unauthorized")
    : [];
  const failed = answer
    ? SECTION_ORDER.filter((key) => answer.sections[key].state === "failed")
    : [];
  const total = answer
    ? SECTION_ORDER.reduce((count, key) => {
        const section = answer.sections[key];
        return section.state === "ok" ? count + section.results.length : count;
      }, 0)
    : 0;

  return (
    <>
      <Card title="Search this event" labelledBy="search-title">
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="event-search">
              Sessions, speakers, proposals, agenda, deliveries and contacts
            </label>
            <div className="form-row">
              <input
                id="event-search"
                type="search"
                autoComplete="off"
                value={draft}
                placeholder="Keynote, an address, a room…"
                onChange={(changeEvent) => setDraft(changeEvent.target.value)}
              />
              <button type="submit" disabled={busy}>
                {busy ? "Searching…" : "Search"}
              </button>
            </div>
          </div>
        </form>
        {/*
          `aria-live` without `role="status"`: a workspace's own action feedback already owns
          the page's one status region, and a second is the trap `ACC-AGENDA` records.
        */}
        <p className="palette-announce" aria-live="polite">
          {busy
            ? "Searching…"
            : answer
              ? `${total} ${total === 1 ? "match" : "matches"} for “${answer.query}”.`
              : "Enter a search to begin."}
        </p>
        {/* A failure is announced by the notice's own `alert` role, so the polite region above
            deliberately does not repeat it — two announcements of one event read as two. */}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Card>

      {answer && unauthorized.length > 0 ? (
        <Notice tone="info">
          Not available to your role on this event:{" "}
          {unauthorized.map((key) => SECTION_LABELS[key]).join(", ")}.
        </Notice>
      ) : null}

      {answer && failed.length > 0 ? (
        <Notice tone="error">
          These could not be searched just now:{" "}
          {failed.map((key) => SECTION_LABELS[key]).join(", ")}. Every other section below is
          complete.
        </Notice>
      ) : null}

      {answer
        ? SECTION_ORDER.map((key) => {
            const section = answer.sections[key];
            if (section.state !== "ok" || section.results.length === 0) return null;
            return (
              <Card key={key} title={SECTION_LABELS[key]} labelledBy={`search-${key}`}>
                <ul className="plain-list">
                  {section.results.map((result) => (
                    <li key={`${result.kind}:${result.id}`}>
                      <a {...linkProps(result.href)}>{result.title}</a>{" "}
                      <Pill>{KIND_LABELS[result.kind]}</Pill>
                      {result.subtitle ? <span className="sub">{result.subtitle}</span> : null}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })
        : null}

      {answer && total === 0 ? (
        <Card>
          <EmptyState title={`No matches for “${answer.query}”`}>
            Search covers only the parts of this event your role can already open, so a record you
            cannot see will not appear here either.
          </EmptyState>
        </Card>
      ) : null}
    </>
  );
}
